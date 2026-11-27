import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSeededRng,
  isNaturalEnabled,
  pickClickPoint,
  planClickTiming,
  planKeyHold,
  planPointerPath,
  planWheelScroll,
  synthesizeStartPoint,
} from "../src/natural";
import { PAGE_HELPERS_SOURCE, PAGE_HELPERS_VERSION } from "../src/page-helpers";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("natural planners — seeded determinism and bounds", () => {
  test("createSeededRng and every planner are deterministic for a given seed", () => {
    const runAll = (seed: number) => {
      const rng = createSeededRng(seed);
      return {
        start: synthesizeStartPoint({ x: 500, y: 300 }, { width: 1280, height: 800 }, rng),
        path: planPointerPath({ from: { x: 100, y: 120 }, to: { x: 720, y: 490 }, rng }),
        clickPt: pickClickPoint({ left: 100, top: 200, width: 140, height: 40 }, rng),
        timing: planClickTiming(2, rng),
        keyHold: planKeyHold(rng),
        wheel: planWheelScroll(1150, rng),
      };
    };

    expect(runAll(42)).toEqual(runAll(42));
    expect(runAll(42)).not.toEqual(runAll(43));
  });

  test("planPointerPath obeys short-move bypass, duration, bow, step cap, and viewport bounds", () => {
    const rng = createSeededRng(1001);

    // Short move (< 3 px): 1 step, 0 ms, exact landing.
    const tiny = planPointerPath({ from: { x: 200, y: 300 }, to: { x: 201.5, y: 301.2 }, rng });
    expect(tiny.steps).toEqual([{ x: 201.5, y: 301.2, delayMs: 0 }]);
    expect(tiny.durationMs).toBe(0);
    expect(tiny.overshot).toBe(false);
    expect(tiny.bowPx).toBe(0);

    // No prior pointer: synthesized start is never (0,0) and inside viewport.
    for (let i = 0; i < 200; i++) {
      const plan = planPointerPath({ to: { x: 20, y: 20 }, viewport: { width: 1280, height: 800 }, rng });
      expect(plan.start.x === 0 && plan.start.y === 0).toBe(false);
      expect(plan.start.x).toBeGreaterThanOrEqual(1);
      expect(plan.start.x).toBeLessThan(1280);
      expect(plan.start.y).toBeGreaterThanOrEqual(1);
      expect(plan.start.y).toBeLessThan(800);
      expect(plan.steps.at(-1)!.x).toBe(20);
      expect(plan.steps.at(-1)!.y).toBe(20);
    }

    // Sweep distances across [15, 1100] px.
    let shortDurSum = 0;
    let longDurSum = 0;
    const samples = 400;
    for (let i = 0; i < samples; i++) {
      const d = i % 2 === 0 ? 60 : 750;
      const to = { x: 100 + d, y: 350 };
      const plan = planPointerPath({ from: { x: 100, y: 350 }, to, viewport: { width: 1280, height: 800 }, rng });
      if (d === 60) shortDurSum += plan.durationMs;
      else longDurSum += plan.durationMs;

      expect(plan.durationMs).toBeGreaterThanOrEqual(90);
      expect(plan.durationMs).toBeLessThanOrEqual(460);
      expect(plan.arcSteps).toBeLessThanOrEqual(24);
      expect(plan.steps.length).toBeLessThanOrEqual(29);
      expect(Math.abs(plan.bowPx)).toBeLessThanOrEqual(110);
      expect(Math.abs(plan.bowPx)).toBeGreaterThanOrEqual(Math.min(0.05 * d, 110) - 0.15);
      expect(Math.abs(plan.bowPx)).toBeLessThanOrEqual(Math.min(0.16 * d, 110) + 0.15);
      expect(plan.steps.at(-1)!.x).toBe(to.x);
      expect(plan.steps.at(-1)!.y).toBe(to.y);

      const stepDelaySum = plan.steps.reduce((acc, s) => acc + s.delayMs, 0);
      expect(stepDelaySum).toBe(plan.totalDurationMs);
      for (const s of plan.steps) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThan(1280);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeLessThan(800);
      }
      if (plan.overshot) {
        expect(d).toBeGreaterThanOrEqual(220);
        expect(plan.overshootSteps).toBeGreaterThanOrEqual(3);
        expect(plan.overshootSteps).toBeLessThanOrEqual(5);
        expect(plan.overshootDurationMs).toBeGreaterThanOrEqual(45);
        expect(plan.overshootDurationMs).toBeLessThanOrEqual(85);
      } else {
        expect(plan.overshootSteps).toBe(0);
        expect(plan.overshootDurationMs).toBe(0);
      }
    }
    expect(longDurSum).toBeGreaterThan(shortDurSum);
  });

  test("overshoot rate is ~18% for distance >= 220 px and strictly 0 below 220 px", () => {
    const rng = createSeededRng(2026);
    const n = 2000;
    let overLong = 0;
    let overShort = 0;
    let overDisabled = 0;
    for (let i = 0; i < n; i++) {
      if (planPointerPath({ from: { x: 100, y: 200 }, to: { x: 520, y: 200 }, rng }).overshot) overLong++;
      if (planPointerPath({ from: { x: 100, y: 200 }, to: { x: 315, y: 200 }, rng }).overshot) overShort++;
      if (planPointerPath({ from: { x: 100, y: 200 }, to: { x: 600, y: 200 }, overshootProb: 0, rng }).overshot) overDisabled++;
    }
    const rate = overLong / n;
    expect(rate).toBeGreaterThan(0.14);
    expect(rate).toBeLessThan(0.22);
    expect(overShort).toBe(0);
    expect(overDisabled).toBe(0);
  });

  test("pickClickPoint stays inside the inset box and is center-weighted", () => {
    const rng = createSeededRng(3030);
    const wide = { left: 100, top: 200, width: 200, height: 50 };
    // mx = min(40, 10) = 10 -> [110, 290]; my = min(10, 8) = 8 -> [208, 242]
    let sumX = 0;
    let sumY = 0;
    let nearCenter = 0;
    const samples = 1000;
    for (let i = 0; i < samples; i++) {
      const p = pickClickPoint(wide, rng);
      expect(p.x).toBeGreaterThanOrEqual(110);
      expect(p.x).toBeLessThanOrEqual(290);
      expect(p.y).toBeGreaterThanOrEqual(208);
      expect(p.y).toBeLessThanOrEqual(242);
      sumX += p.x;
      sumY += p.y;
      if (Math.abs(p.x - 200) <= 45) nearCenter++;
    }
    expect(Math.abs(sumX / samples - 200)).toBeLessThan(6);
    expect(Math.abs(sumY / samples - 225)).toBeLessThan(2);
    // Triangular distribution puts ~75% of mass in the middle half (vs 50% for uniform).
    expect(nearCenter / samples).toBeGreaterThan(0.68);

    // Small box (< 14 px) uses 15% inset.
    const tiny = { left: 50, top: 60, width: 10, height: 10 };
    for (let i = 0; i < 200; i++) {
      const p = pickClickPoint(tiny, rng);
      expect(p.x).toBeGreaterThanOrEqual(51.5);
      expect(p.x).toBeLessThanOrEqual(58.5);
      expect(p.y).toBeGreaterThanOrEqual(61.5);
      expect(p.y).toBeLessThanOrEqual(68.5);
    }
  });

  test("planClickTiming and planKeyHold stay within spec bounds", () => {
    const rng = createSeededRng(4040);
    for (let i = 0; i < 500; i++) {
      const t = planClickTiming(3, rng);
      expect(t.dwellMs).toBeGreaterThanOrEqual(45);
      expect(t.dwellMs).toBeLessThanOrEqual(115);
      expect(t.holdsMs).toHaveLength(3);
      expect(t.gapsMs).toHaveLength(2);
      for (const h of t.holdsMs) {
        expect(h).toBeGreaterThanOrEqual(55);
        expect(h).toBeLessThanOrEqual(130);
      }
      for (const g of t.gapsMs) {
        expect(g).toBeGreaterThanOrEqual(65);
        expect(g).toBeLessThanOrEqual(135);
      }
      const kh = planKeyHold(rng);
      expect(kh).toBeGreaterThanOrEqual(35);
      expect(kh).toBeLessThanOrEqual(85);
    }
  });

  test("planWheelScroll obeys flick sizes, counts, <= 650 ms cap, and exact delta sum", () => {
    const rng = createSeededRng(5050);

    expect(planWheelScroll(0, rng)).toEqual({ flicks: [], totalDeltaY: 0, totalDurationMs: 0 });

    for (const requested of [120, -210, 320, 650, -900, 1450, -2200, 2720]) {
      for (let i = 0; i < 50; i++) {
        const plan = planWheelScroll(requested, rng);
        expect(plan.flicks.length).toBeGreaterThanOrEqual(1);
        expect(plan.flicks.length).toBeLessThanOrEqual(4);
        expect(plan.totalDurationMs).toBeLessThanOrEqual(650);

        let sumEvents = 0;
        let sumMs = 0;
        for (let fIdx = 0; fIdx < plan.flicks.length; fIdx++) {
          const f = plan.flicks[fIdx]!;
          if (Math.abs(requested) >= 280) {
            expect(Math.abs(f.deltaY)).toBeGreaterThanOrEqual(280);
            expect(Math.abs(f.deltaY)).toBeLessThanOrEqual(680);
          } else {
            expect(f.deltaY).toBe(requested);
          }
          expect(f.events.length).toBeGreaterThanOrEqual(4);
          expect(f.events.length).toBeLessThanOrEqual(12);
          let flickSum = 0;
          for (let eIdx = 0; eIdx < f.events.length; eIdx++) {
            const ev = f.events[eIdx]!;
            flickSum += ev.deltaY;
            sumMs += ev.delayMs;
            if (eIdx === 0) expect(ev.delayMs).toBe(0);
            else {
              expect(ev.delayMs).toBeGreaterThanOrEqual(15);
              expect(ev.delayMs).toBeLessThanOrEqual(19);
            }
          }
          expect(flickSum).toBe(f.deltaY);
          sumEvents += flickSum;
          if (fIdx < plan.flicks.length - 1) {
            expect(f.pauseAfterMs).toBeGreaterThanOrEqual(75);
            expect(f.pauseAfterMs).toBeLessThanOrEqual(175);
            sumMs += f.pauseAfterMs;
          } else {
            expect(f.pauseAfterMs).toBe(0);
          }
        }
        expect(sumEvents).toBe(requested);
        expect(plan.totalDeltaY).toBe(requested);
        expect(sumMs).toBe(plan.totalDurationMs);
      }
    }

    // Huge distances still cap at 4 flicks and <= 650 ms (caller uses scrollIntoView fallback).
    const huge = planWheelScroll(6000, rng);
    expect(huge.flicks.length).toBe(4);
    expect(huge.totalDurationMs).toBeLessThanOrEqual(650);
  });

  test("planPointerPath lands exactly on the supplied destination, even a fractional click point", () => {
    const rng = createSeededRng(7070);
    // A 0.02 x 0.02 px box around this point: rounding to (100, 50) would miss it.
    const dest = { x: 100.0274, y: 50.0336 };
    for (let i = 0; i < 50; i++) {
      const plan = planPointerPath({ from: { x: 420, y: 300 }, to: dest, rng });
      const last = plan.steps.at(-1)!;
      expect(last.x).toBe(100.0274);
      expect(last.y).toBe(50.0336);
      expect(last.x).toBeGreaterThan(100.0174);
      expect(last.x).toBeLessThan(100.0374);
    }

    // Short moves bypass the arc but still land on the exact destination.
    const short = planPointerPath({ from: { x: 100, y: 50 }, to: dest, rng });
    expect(short.steps).toHaveLength(1);
    expect(short.steps[0]!.x).toBe(100.0274);
    expect(short.steps[0]!.y).toBe(50.0336);
  });

  test("planPointerPath skips overshoot when viewport clamping leaves under 4 px of forward room", () => {
    const rng = createSeededRng(8080);
    for (let i = 0; i < 20; i++) {
      const plan = planPointerPath({
        from: { x: 100, y: 200 },
        to: { x: 1279, y: 200 },
        viewport: { width: 1280, height: 800 },
        overshootProb: 1,
        rng,
      });
      expect(plan.overshot).toBe(false);
      expect(plan.overshootSteps).toBe(0);
      expect(plan.overshootDurationMs).toBe(0);
      expect(plan.steps.at(-1)!.x).toBe(1279);
      expect(plan.steps.at(-1)!.y).toBe(200);
    }

    // With room along the approach, the same forced probability still overshoots.
    const roomy = planPointerPath({
      from: { x: 100, y: 200 },
      to: { x: 700, y: 200 },
      overshootProb: 1,
      rng,
    });
    expect(roomy.overshot).toBe(true);
    expect(roomy.overshootSteps).toBeGreaterThanOrEqual(3);
  });

  test("synthesizeStartPoint keeps the minimum offset when only one side has room", () => {
    const rng = createSeededRng(9090);
    const viewport = { width: 300, height: 220 };
    for (let i = 0; i < 200; i++) {
      const p = synthesizeStartPoint({ x: 170, y: 110 }, viewport, rng);
      expect(Math.abs(p.x - 170)).toBeGreaterThanOrEqual(119.95);
      expect(Math.abs(p.y - 110)).toBeGreaterThanOrEqual(79.95);
      expect(p.x).toBeGreaterThanOrEqual(12);
      expect(p.x).toBeLessThanOrEqual(288);
      expect(p.x === 0 && p.y === 0).toBe(false);
    }

    // No side has room for the minimum: farthest in-viewport point on each axis.
    const tight = synthesizeStartPoint({ x: 100, y: 60 }, { width: 200, height: 120 }, rng);
    expect(tight.x).toBe(188);
    expect(tight.y).toBe(108);
  });

  test("planWheelScroll never emits a zero-delta event for scrolls under 280 px", () => {
    const rng = createSeededRng(6060);
    for (const requested of [1, -1, 2, -7, 37, -120, 279]) {
      for (let i = 0; i < 20; i++) {
        const plan = planWheelScroll(requested, rng);
        expect(plan.flicks).toHaveLength(1);
        const flick = plan.flicks[0]!;
        expect(flick.deltaY).toBe(requested);
        expect(flick.events.length).toBeGreaterThanOrEqual(1);
        for (const ev of flick.events) expect(ev.deltaY).not.toBe(0);
        expect(flick.events.reduce((acc, ev) => acc + ev.deltaY, 0)).toBe(requested);
        expect(flick.durationMs).toBe(flick.events.reduce((acc, ev) => acc + ev.delayMs, 0));
        expect(plan.totalDeltaY).toBe(requested);
        expect(plan.totalDurationMs).toBe(flick.durationMs);
      }
    }
  });
});

describe("isNaturalEnabled switch precedence", () => {
  test("follows input.fast -> BROWSER_CONTROL_NATURAL -> XDG config file -> default on", async () => {
    const xdg = await mkdtemp(join(tmpdir(), "bc-nat-cfg-"));
    tempDirs.push(xdg);
    const cfgDir = join(xdg, "browser-control");
    const cfgFile = join(cfgDir, "natural");
    await mkdir(cfgDir, { recursive: true });

    const prevXdg = process.env["XDG_CONFIG_HOME"];
    const prevEnv = process.env["BROWSER_CONTROL_NATURAL"];
    process.env["XDG_CONFIG_HOME"] = xdg;
    delete process.env["BROWSER_CONTROL_NATURAL"];
    try {
      // 1. Default ON when neither env nor file exists.
      expect(isNaturalEnabled({})).toBe(true);

      // 2. Config file read per call without restart.
      await writeFile(cfgFile, "off\n");
      expect(isNaturalEnabled({})).toBe(false);
      await writeFile(cfgFile, "on\n");
      expect(isNaturalEnabled({})).toBe(true);

      // 3. Env overrides file.
      process.env["BROWSER_CONTROL_NATURAL"] = "off";
      expect(isNaturalEnabled({})).toBe(false);
      await writeFile(cfgFile, "off\n");
      process.env["BROWSER_CONTROL_NATURAL"] = "on";
      expect(isNaturalEnabled({})).toBe(true);

      // 4. input.fast === true overrides env and file.
      expect(isNaturalEnabled({ fast: true })).toBe(false);
    } finally {
      if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = prevXdg;
      if (prevEnv === undefined) delete process.env["BROWSER_CONTROL_NATURAL"];
      else process.env["BROWSER_CONTROL_NATURAL"] = prevEnv;
    }
  });
});

describe("page-helpers v10 — point detail/noScroll, hitCheck, pageScrollPoint", () => {
  test("VERSION is 10 and new helpers work in isolated DOM", async () => {
    expect(PAGE_HELPERS_VERSION).toBe(10);

    const btn: any = {
      nodeType: 1,
      tagName: "BUTTON",
      localName: "button",
      id: "go",
      className: "",
      disabled: false,
      isConnected: true,
      innerText: "Go",
      textContent: "Go",
      labels: [],
      scrolled: false,
      rect: { x: 100, y: 1200, left: 100, top: 1200, right: 260, bottom: 1240, width: 160, height: 40 },
      scrollIntoView() {
        this.scrolled = true;
        this.rect = { x: 100, y: 380, left: 100, top: 380, right: 260, bottom: 420, width: 160, height: 40 };
      },
      getBoundingClientRect() { return this.rect; },
      getClientRects() { return [this.rect]; },
      getRootNode() { return doc; },
      getAttribute: () => null,
      closest: () => null,
      matches: () => true,
      contains(other: any) { return other === btn; },
      querySelectorAll: () => [],
      querySelector: () => null,
      parentElement: null,
    };
    const sidebar: any = {
      nodeType: 1,
      tagName: "DIV",
      localName: "div",
      scrollHeight: 2000,
      clientHeight: 400,
      scrollWidth: 200,
      clientWidth: 200,
      parentElement: null,
    };
    const mainBg: any = { nodeType: 1, tagName: "MAIN", localName: "main", parentElement: null };
    const doc: any = {
      title: "V10",
      hidden: true,
      body: { innerText: "Go", querySelectorAll: () => [] },
      documentElement: { lang: "en", scrollTop: 0, scrollLeft: 0, scrollHeight: 2400, clientHeight: 800 },
      scrollingElement: { scrollTop: 0, scrollLeft: 0, scrollHeight: 2400, clientHeight: 800 },
      images: [],
      querySelectorAll: (sel: string) => (sel.includes("button") ? [btn] : []),
      querySelector: () => null,
      createTreeWalker: () => ({ nextNode: () => null }),
      elementFromPoint(x: number, y: number) {
        if (x === 500 && y === 400) return sidebar; // center hits nested scroller
        if (x >= btn.rect.left && x <= btn.rect.right && y >= btn.rect.top && y <= btn.rect.bottom) return btn;
        return mainBg;
      },
    };
    btn.ownerDocument = doc;
    sidebar.parentElement = doc.body;
    mainBg.parentElement = doc.body;

    const prev: Record<string, any> = {};
    const keys = ["__bc", "document", "location", "getComputedStyle", "innerWidth", "innerHeight", "scrollX", "scrollY", "NodeFilter"];
    for (const k of keys) prev[k] = (globalThis as any)[k];

    try {
      delete (globalThis as any).__bc;
      (globalThis as any).document = doc;
      (globalThis as any).location = { href: "https://v10.test/", origin: "https://v10.test", pathname: "/", hostname: "v10.test" };
      (globalThis as any).getComputedStyle = (el: any) =>
        el === sidebar
          ? { display: "block", visibility: "visible", opacity: "1", position: "static", overflowY: "auto", overflowX: "hidden" }
          : { display: "block", visibility: "visible", opacity: "1", position: "static", overflowY: "visible", overflowX: "visible" };
      (globalThis as any).innerWidth = 1000;
      (globalThis as any).innerHeight = 800;
      (globalThis as any).scrollX = 0;
      (globalThis as any).scrollY = 0;
      (globalThis as any).NodeFilter = { SHOW_ELEMENT: 1 };

      new Function(PAGE_HELPERS_SOURCE)();
      const bc = (globalThis as any).__bc;
      expect(bc.v).toBe(10);
      bc.snapshot();

      // noScroll reports inView: false without calling scrollIntoView.
      const off = JSON.parse(await bc.point("e1", { noScroll: true, detail: true }));
      expect(off.inView).toBe(false);
      expect(btn.scrolled).toBe(false);
      expect(off.viewport).toEqual({ width: 1000, height: 800 });
      expect(off.scroller.kind).toBe("document");
      // pageScrollPoint skips center (500,400) because it hits nested scroller `sidebar`.
      const sp = JSON.parse(bc.pageScrollPoint());
      expect(sp).not.toBeNull();
      expect(sp).not.toEqual({ x: 500, y: 400 });

      // Default point() scrolls into view and returns legacy string for existing callers.
      const legacy = await bc.point("e1");
      expect(btn.scrolled).toBe(true);
      expect(legacy).toBe("180 400 hidden");

      // hitCheck matches inside button and reports miss outside.
      expect(JSON.parse(bc.hitCheck("e1", 180, 400))).toEqual({ ok: true });
      expect(JSON.parse(bc.hitCheck("e1", 10, 10)).ok).toBe(false);
    } finally {
      delete (globalThis as any).__bc;
      for (const k of keys) {
        if (prev[k] === undefined) delete (globalThis as any)[k];
        else (globalThis as any)[k] = prev[k];
      }
    }
  });
});

describe("synthesizeStartPoint off-screen target", () => {
  test("keeps the start inside the viewport when the destination is off-screen", () => {
    const viewport = { width: 1280, height: 720 };
    for (let seed = 1; seed <= 200; seed++) {
      const p = synthesizeStartPoint({ x: 1600, y: -300 }, viewport, createSeededRng(seed));
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(viewport.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(viewport.height);
    }
  });
});
