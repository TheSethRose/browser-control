import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { InvokeResult } from "@agent-software/core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { createPageHelperHandler } from "../src/page-runner";

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

describe("page-runner natural motion integration", () => {
  type CdpCall = { method: string; params: Record<string, unknown>; targetId?: string };
  type Invoke = (op: string, input?: Record<string, unknown>) => Promise<InvokeResult>;
  const val = (value: string): InvokeResult => ({ ok: true, data: { value } });

  /** Main-frame page with one 200x40 button (e1) in a 1280x800 viewport; off-screen targets scroll by wheel delta. */
  function makeNaturalMock(opts: {
    inView?: boolean;
    scrollDeltaPerWheel?: number;
    draggable?: boolean;
    failAtMouseMoveIndex?: number;
    failMessage?: string;
  } = {}) {
    const cdpCalls: CdpCall[] = [];
    const evalExprs: string[] = [];
    const sleeps: number[] = [];
    let currentTop = opts.inView === false ? 1200 : 200;
    let mouseMoveCount = 0;
    const makeDetail = (forceInView: boolean) => {
      const inView = forceInView || (currentTop >= 16 && currentTop + 40 <= 784);
      const top = forceInView ? 380 : currentTop;
      return JSON.stringify({
        x: 350, y: Math.round(top + 20), hidden: false, inView,
        box: { left: 250, top: inView ? top : 0, width: 200, height: inView ? 40 : 0 },
        rect: { left: 250, top, width: 200, height: 40 },
        viewport: { width: 1280, height: 800 }, stickyTop: 0, stickyBottom: 0,
        scroller: { kind: "document", box: { left: 0, top: 0, width: 1280, height: 800 }, point: { x: 640, y: 400 } },
      });
    };
    const invoke: Invoke = async (op, input = {}) => {
      if (op === "get_browser_status") return { ok: true, data: { connected: true } };
      if (op === "evaluate") {
        const expr = String(input["expression"] ?? "");
        evalExprs.push(expr);
        const base = expr.includes("__bc.baseline()");
        if (expr.includes("__bc.verifyRef")) return val("e1");
        if (expr.includes("__bc.hitCheck")) return val('{"ok":true}');
        // Points left of x=200 sit over a nested scroller; anything else is over the document.
        const sp = /__bc\.pageScrollPoint\((\d+), (\d+)\)/.exec(expr);
        if (sp) return val(JSON.stringify(Number(sp[1]) >= 200 ? { x: Number(sp[1]), y: Number(sp[2]) } : { x: 640, y: 400 }));
        if (expr.includes("__bc.dragInfo")) {
          return val(JSON.stringify({
            sx: 120, sy: 200, dx: 520, dy: 460, draggable: opts.draggable === true, listMeta: null,
          }));
        }
        if (expr.includes("__bc.point")) {
          const noScroll = expr.includes('"noScroll":true');
          if (!noScroll && !expr.includes('"detail":true')) return val(base ? "https://a.test/ 350 220 visible" : "350 220 visible");
          return val(base ? `https://a.test/\n${makeDetail(!noScroll)}` : makeDetail(!noScroll));
        }
        if (expr.includes("__bc.readInputProbe")) return val('{"mousedown":1,"mouseup":1}');
        if (expr.includes("__bc.setTypedValue")) return val("__not_typed__");
        if (expr.includes("__bc.cellInfo")) return val("__not_cell__");
        if (expr.includes("__bc.focusForType")) return val("focused");
        if (expr.includes("__bc.value")) return val("hello");
        if (expr.includes("__bc.hit(")) return val("https://a.test/\nhit: button#ok");
        return val("ok");
      }
      if (op === "execute_cdp") {
        const params = (input["params"] ?? {}) as Record<string, unknown>;
        cdpCalls.push({ method: String(input["method"]), params, targetId: input["targetId"] as string | undefined });
        if (params["type"] === "mouseMoved" && opts.failAtMouseMoveIndex !== undefined && ++mouseMoveCount === opts.failAtMouseMoveIndex) {
          return { ok: false, error: { code: "EXECUTION_FAILED", message: opts.failMessage ?? "DIALOG_OPEN: alert open" } };
        }
        if (params["type"] === "mouseWheel") currentTop -= opts.scrollDeltaPerWheel ?? Number(params["deltaY"] ?? 0);
        return { ok: true, data: { result: {} } };
      }
      return { ok: true, data: {} };
    };
    const ofType = (type: string, from = 0) => cdpCalls.slice(from).filter((c) => c.params["type"] === type);
    const handler = (seed: number, wrap?: (next: Invoke) => Invoke) =>
      createPageHelperHandler(wrap ? wrap(invoke) : invoke, undefined, undefined, {
        sleep: async (ms) => { sleeps.push(ms); }, rng: createSeededRng(seed), now: () => 0,
        bcCall: async () => ({ value: "https://a.test/\nhit: button#ok" }),
      });
    return { invoke, cdpCalls, evalExprs, sleeps, ofType, handler };
  }

  async function withNaturalOn<T>(fn: () => Promise<T>): Promise<T> {
    const xdg = await mkdtemp(join(tmpdir(), "bc-nat-on-"));
    tempDirs.push(xdg);
    const prevEnv = process.env["BROWSER_CONTROL_NATURAL"];
    const prevXdg = process.env["XDG_CONFIG_HOME"];
    delete process.env["BROWSER_CONTROL_NATURAL"];
    process.env["XDG_CONFIG_HOME"] = xdg;
    try {
      return await fn();
    } finally {
      if (prevEnv === undefined) delete process.env["BROWSER_CONTROL_NATURAL"];
      else process.env["BROWSER_CONTROL_NATURAL"] = prevEnv;
      if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = prevXdg;
    }
  }

  test("natural click emits multiple mouseMoved events, nonzero dwell/hold, and zero mouseWheel when in view; --fast emits legacy 3-event sequence", async () => {
    await withNaturalOn(async () => {
      const nat = makeNaturalMock({ inView: true });
      expect((await nat.handler(77)("click", { ref: "e1", quiet: true })).ok).toBe(true);
      const moves = nat.ofType("mouseMoved");
      const presses = nat.ofType("mousePressed");
      expect(moves.length).toBeGreaterThanOrEqual(4);
      expect(moves.length).toBeLessThanOrEqual(29);
      expect(presses).toHaveLength(1);
      expect(nat.ofType("mouseReleased")).toHaveLength(1);
      expect(nat.ofType("mouseWheel")).toHaveLength(0);
      // Last move matches the press point inside the inset box [260..440] x [208..232].
      const last = moves.at(-1)!.params;
      expect([presses[0]!.params["x"], presses[0]!.params["y"]]).toEqual([last["x"], last["y"]]);
      expect(Number(last["x"])).toBeGreaterThanOrEqual(260);
      expect(Number(last["x"])).toBeLessThanOrEqual(440);
      expect(Number(last["y"])).toBeGreaterThanOrEqual(208);
      expect(Number(last["y"])).toBeLessThanOrEqual(232);
      // Dwell + press hold are the last two sleeps.
      const [dwellMs, holdMs] = nat.sleeps.slice(-2) as [number, number];
      expect(dwellMs).toBeGreaterThanOrEqual(45);
      expect(dwellMs).toBeLessThanOrEqual(115);
      expect(holdMs).toBeGreaterThanOrEqual(55);
      expect(holdMs).toBeLessThanOrEqual(130);

      const fast = makeNaturalMock({ inView: true });
      expect((await fast.handler(77)("click", { ref: "e1", fast: true, quiet: true })).ok).toBe(true);
      const fastMouse = fast.cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
      expect(fastMouse.map((e) => e.params["type"])).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
      expect(fastMouse[0]!.params).toEqual({ type: "mouseMoved", x: 350, y: 220 });
      expect(fast.sleeps).toHaveLength(0);
    });
  });

  test("off-screen target emits eased mouseWheel events and falls back to instant scrollIntoView when stagnant", async () => {
    await withNaturalOn(async () => {
      const instant = (m: ReturnType<typeof makeNaturalMock>) => m.evalExprs.some((e) => e.includes('__bc.point("e1", {"detail":true})'));
      const ok = makeNaturalMock({ inView: false });
      expect((await ok.handler(123)("click", { ref: "e1", quiet: true })).ok).toBe(true);
      expect(ok.ofType("mouseWheel").length).toBeGreaterThanOrEqual(4);
      expect(instant(ok)).toBe(false);
      // Wheel does not move the page: stop after one flick and scroll instantly.
      const stuck = makeNaturalMock({ inView: false, scrollDeltaPerWheel: 0 });
      expect((await stuck.handler(123)("click", { ref: "e1", quiet: true })).ok).toBe(true);
      expect(stuck.ofType("mouseWheel").length).toBeGreaterThanOrEqual(4);
      expect(stuck.ofType("mouseWheel").length).toBeLessThanOrEqual(12);
      expect(instant(stuck)).toBe(true);
    });
  });

  test("S1: never presses without a passing post-hover hitCheck; a covered point retries before pressing", async () => {
    await withNaturalOn(async () => {
      const hitAfter = (n: number, res: InvokeResult) => (next: Invoke): Invoke => {
        let seen = 0;
        return async (op, inp = {}) =>
          op === "evaluate" && String(inp["expression"]).includes("__bc.hitCheck") && ++seen === n ? res : next(op, inp);
      };
      const stale = makeNaturalMock({ inView: true });
      const gone: InvokeResult = { ok: false, error: { code: "EXECUTION_FAILED", message: "JS_EXCEPTION: Error: STALE_REF: e1 is gone" } };
      const r1 = await stale.handler(7, hitAfter(2, gone))("click", { ref: "e1", quiet: true });
      expect(!r1.ok && r1.error.message).toContain("STALE_REF");
      expect(stale.ofType("mousePressed")).toHaveLength(0);

      const covered = makeNaturalMock({ inView: true });
      const h = covered.handler(7, hitAfter(2, val('{"ok":false,"reason":"covered by tooltip"}')));
      expect((await h("click", { ref: "e1", quiet: true })).ok).toBe(true);
      expect(covered.evalExprs.filter((e) => e.includes("__bc.hitCheck")).length).toBeGreaterThanOrEqual(3);
      const last = covered.ofType("mouseMoved").at(-1)!.params;
      const press = covered.ofType("mousePressed")[0]!.params;
      expect([press["x"], press["y"]]).toEqual([last["x"], last["y"]]);
    });
  });

  test("S3: cross-origin frame clicks use legacy instant scroll and 3-event click", async () => {
    await withNaturalOn(async () => {
      const m = makeNaturalMock({ inView: true });
      let tag = "";
      const h = m.handler(11, (next) => async (op, inp = {}) => {
        const expr = String(inp["expression"] ?? "");
        if (op === "list_targets") return { ok: true, data: { targets: [{ targetId: "IF1", url: "https://x.test/", parentFrameId: "TOP" }] } };
        if (inp["method"] === "Page.getFrameTree") return { ok: true, data: { result: { frameTree: { frame: { id: "TOP" } } } } };
        if (expr.includes("__bc.snapshot")) return val('# P | https://a.test/\n# 1 cross-origin iframe(s)\n- button "Go" [e1]');
        if (expr.includes("__bc.frames()")) return val('[{"i":1,"src":"https://x.test/","title":"X"}]');
        if (expr.includes("__bc.tagFrames")) { tag = /\["([^"]+)"\]/.exec(expr)?.[1] ?? ""; return val("1"); }
        if (expr.includes("__bc.frameTag")) return val(tag);
        if (expr.includes("__bc.frameOffset")) return val("100 50");
        if (inp["targetId"] === "IF1" && expr.includes("__bc.point")) { expect(expr).not.toContain('"detail":true'); return val("40 30 visible"); }
        return next(op, inp);
      });
      await h("snap", {});
      expect((await h("click", { ref: "f1:e1", quiet: true })).ok).toBe(true);
      const mouse = m.cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
      expect(mouse.map((e) => e.params["type"])).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
      expect([mouse[0]!.params["x"], mouse[0]!.params["y"]]).toEqual([140, 80]);
      expect(m.sleeps).toHaveLength(0);
    });
  });

  test("S4: pointer state isolates implicit CDP tabs, strips @<id> frames, updates on --fast, and clears on dialog", async () => {
    await withNaturalOn(async () => {
      let activeTab = "TAB-A", failMove = 0;
      const m = makeNaturalMock({ inView: true });
      const h = m.handler(19, (next) => async (op, inp = {}) => {
        if (op === "get_browser_status") return { ok: true, data: { connected: true, activeTargetId: activeTab } };
        if ((inp["params"] as Record<string, unknown> | undefined)?.["type"] === "mouseMoved" && failMove > 0 && --failMove === 0) {
          return { ok: false, error: { code: "EXECUTION_FAILED", message: "DIALOG_OPEN: alert" } };
        }
        return next(op, inp);
      });
      const movesOf = async (input: Record<string, unknown>, target?: string) => {
        const from = m.cdpCalls.length;
        const r = await h("click", { quiet: true, ...input }, target);
        return { r, moves: m.ofType("mouseMoved", from) };
      };
      await movesOf({ xy: [900, 500], fast: true });
      activeTab = "TAB-B";
      expect((await movesOf({ xy: [901, 500] })).moves.length).toBeGreaterThanOrEqual(4);
      activeTab = "TAB-A";
      expect((await movesOf({ xy: [901, 500] })).moves).toHaveLength(1);
      await movesOf({ xy: [300, 300], fast: true }, "extension:42@7");
      expect((await movesOf({ xy: [301, 300] }, "extension:42")).moves).toHaveLength(1);
      failMove = 2;
      const cut = await movesOf({ xy: [100, 100] });
      expect(cut.r.ok).toBe(false);
      const at = cut.moves[0]!.params;
      expect((await movesOf({ xy: [Number(at["x"]), Number(at["y"])] })).moves.length).toBeGreaterThanOrEqual(4);
    });
  });

  test("S5: document scroll reuses the resting pointer only when pageScrollPoint confirms it", async () => {
    await withNaturalOn(async () => {
      for (const [rest, wheelAt] of [[[80, 300], [640, 400]], [[900, 500], [900, 500]]] as const) {
        const m = makeNaturalMock({ inView: false });
        const h = m.handler(31);
        await h("click", { xy: rest, fast: true, quiet: true });
        const from = m.cdpCalls.length;
        expect((await h("click", { ref: "e1", quiet: true })).ok).toBe(true);
        const wheels = m.ofType("mouseWheel", from);
        expect(wheels.length).toBeGreaterThanOrEqual(4);
        for (const w of wheels) expect([w.params["x"], w.params["y"]]).toEqual([...wheelAt]);
        const firstWheel = m.cdpCalls.indexOf(wheels[0]!);
        expect(m.ofType("mouseMoved", from).some((c) => m.cdpCalls.indexOf(c) < firstWheel)).toBe(rest[0] < 200);
      }
    });
  });

  test("off-screen target wheels from the resting pointer when already inside the viewport", async () => {
    await withNaturalOn(async () => {
      const mock = makeNaturalMock({ inView: false });
      const handler = createPageHelperHandler(mock.invoke, undefined, undefined, {
        sleep: async (ms) => { mock.sleeps.push(ms); },
        rng: createSeededRng(123),
        now: () => 0,
      });

      // Establish a resting pointer inside the viewport over the document scroller (x >= 200), far from
      // scroller.point (640, 400); pageScrollPoint confirms it, so the wheel reuses it without moving.
      expect((await handler("hover", { xy: [240, 260], quiet: true })).ok).toBe(true);
      const beforeClick = mock.cdpCalls.length;

      const res = await handler("click", { ref: "e1", quiet: true });
      expect(res.ok).toBe(true);

      const clickMouse = mock.cdpCalls
        .slice(beforeClick)
        .filter((c) => c.method === "Input.dispatchMouseEvent");
      const firstWheelIdx = clickMouse.findIndex((c) => c.params["type"] === "mouseWheel");
      expect(firstWheelIdx).toBe(0);
      expect(clickMouse[0]!.params["x"]).toBe(240);
      expect(clickMouse[0]!.params["y"]).toBe(260);
      // Zero mouseMoved events between the last pointer position and the first mouseWheel.
      expect(clickMouse.slice(0, firstWheelIdx).filter((c) => c.params["type"] === "mouseMoved")).toHaveLength(0);
      // Still moves to the scrolled-into-view target and clicks it afterward.
      expect(clickMouse.slice(firstWheelIdx).some((c) => c.params["type"] === "mouseMoved")).toBe(true);
      expect(clickMouse.some((c) => c.params["type"] === "mousePressed")).toBe(true);
      expect(clickMouse.some((c) => c.params["type"] === "mouseReleased")).toBe(true);
    });
  });

  test("natural hover, drag, key hold, dialog abort, and typing switch-off behave per spec", async () => {
    await withNaturalOn(async () => {
      // Hover: multiple moves, zero presses.
      const hov = makeNaturalMock({ inView: true });
      const hHov = createPageHelperHandler(hov.invoke, undefined, undefined, {
        sleep: async (ms) => { hov.sleeps.push(ms); },
        rng: createSeededRng(88),
        now: () => 0,
      });
      expect((await hHov("hover", { xy: [500, 300], quiet: true })).ok).toBe(true);
      const hovEvents = hov.cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
      expect(hovEvents.length).toBeGreaterThanOrEqual(4);
      expect(hovEvents.every((e) => e.params["type"] === "mouseMoved")).toBe(true);

      // Drag: path to source, press, curved drag moves with buttons: 1, release.
      const drg = makeNaturalMock({ inView: true, draggable: false });
      const hDrg = createPageHelperHandler(drg.invoke, undefined, undefined, {
        sleep: async (ms) => { drg.sleeps.push(ms); },
        rng: createSeededRng(99),
        now: () => 0,
      });
      expect((await hDrg("drag", { from: "e1", to: "e2", quiet: true })).ok).toBe(true);
      const drgEvents = drg.cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
      const pressIdx = drgEvents.findIndex((e) => e.params["type"] === "mousePressed");
      const relIdx = drgEvents.findIndex((e) => e.params["type"] === "mouseReleased");
      expect(pressIdx).toBeGreaterThanOrEqual(3);
      expect(relIdx - pressIdx).toBeGreaterThanOrEqual(4);
      for (let i = pressIdx + 1; i < relIdx; i++) {
        expect(drgEvents[i]!.params["type"]).toBe("mouseMoved");
        expect(drgEvents[i]!.params["buttons"]).toBe(1);
      }

      // Key: hold 35–85 ms.
      const ky = makeNaturalMock({ inView: true });
      const hKey = createPageHelperHandler(ky.invoke, undefined, undefined, {
        sleep: async (ms) => { ky.sleeps.push(ms); },
        rng: createSeededRng(101),
        now: () => 0,
      });
      expect((await hKey("key", { key: "Enter", quiet: true })).ok).toBe(true);
      expect(ky.sleeps).toHaveLength(1);
      expect(ky.sleeps[0]!).toBeGreaterThanOrEqual(35);
      expect(ky.sleeps[0]!).toBeLessThanOrEqual(85);

      // Abort immediately on DIALOG_OPEN during trajectory.
      const dlg = makeNaturalMock({ inView: true, failAtMouseMoveIndex: 2, failMessage: "DIALOG_OPEN: alert" });
      const hDlg = createPageHelperHandler(dlg.invoke, undefined, undefined, {
        sleep: async (ms) => { dlg.sleeps.push(ms); },
        rng: createSeededRng(77),
        now: () => 0,
      });
      const dlgRes = await hDlg("click", { ref: "e1", quiet: true });
      expect(dlgRes.ok).toBe(false);
      const dlgEvents = dlg.cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
      expect(dlgEvents).toHaveLength(2);
      expect(dlgEvents.some((e) => e.params["type"] === "mousePressed")).toBe(false);
    });

    // Global switch off also disables natural typing (uses Input.insertText instead of human keystrokes).
    const offMock = makeNaturalMock({ inView: true });
    const hOff = createPageHelperHandler(offMock.invoke, undefined, undefined, {
      sleep: async (ms) => { offMock.sleeps.push(ms); },
      rng: createSeededRng(55),
    });
    const prev = process.env["BROWSER_CONTROL_NATURAL"];
    process.env["BROWSER_CONTROL_NATURAL"] = "off";
    try {
      const res = await hOff("type", { ref: "e1", text: "hello", quiet: true });
      expect(res.ok).toBe(true);
      expect(offMock.cdpCalls.some((c) => c.method === "Input.insertText")).toBe(true);
      expect(offMock.sleeps).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env["BROWSER_CONTROL_NATURAL"];
      else process.env["BROWSER_CONTROL_NATURAL"] = prev;
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
      // A given point is kept only when it is over the document, not the nested scroller.
      expect(JSON.parse(bc.pageScrollPoint(500, 400))).toEqual(sp);
      expect(JSON.parse(bc.pageScrollPoint(sp.x + 1, sp.y))).toEqual({ x: sp.x + 1, y: sp.y });

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

  const baseStyle = { display: "block", visibility: "visible", opacity: "1", position: "static", overflowY: "visible", overflowX: "visible" };
  const mkRect = (l: number, t: number, w: number, h: number) => ({ x: l, y: t, left: l, top: t, right: l + w, bottom: t + h, width: w, height: h });
  const mkEl = (over: Record<string, any> = {}) => {
    const rect = over.rect ?? mkRect(0, 0, 100, 40);
    const el: any = {
      nodeType: 1, tagName: "BUTTON", localName: "button", id: "", className: "", disabled: false, isConnected: true,
      innerText: "Act", textContent: "Act", labels: [], rect, scrollIntoView() {},
      getBoundingClientRect() { return this.rect; }, getClientRects() { return this.rects ?? [this.rect]; },
      getRootNode() { return this.rootNode ?? this.ownerDocument; },
      getAttribute: () => null, closest: () => null, matches: () => true,
      contains(o: any) { return o === el; }, querySelectorAll: () => [], querySelector: () => null, parentElement: null, ...over,
    };
    return el;
  };
  const mkDoc = (over: Record<string, any> = {}) => ({
    title: "V10", hidden: true, body: { innerText: "", querySelectorAll: () => [] },
    documentElement: { scrollTop: 0, scrollLeft: 0, scrollHeight: 800, clientHeight: 800 },
    scrollingElement: { scrollTop: 0, scrollLeft: 0, scrollHeight: 800, clientHeight: 800 },
    images: [], querySelectorAll: () => [], querySelector: () => null, createTreeWalker: () => ({ nextNode: () => null }),
    ...over,
  });
  async function withV10(doc: any, styleOf: (el: any) => any, run: (bc: any) => Promise<void> | void) {
    const keys = ["__bc", "document", "location", "getComputedStyle", "innerWidth", "innerHeight", "scrollX", "scrollY", "NodeFilter"];
    const prev: Record<string, any> = Object.fromEntries(keys.map((k) => [k, (globalThis as any)[k]]));
    try {
      delete (globalThis as any).__bc;
      Object.assign(globalThis, {
        document: doc, getComputedStyle: styleOf, innerWidth: 1000, innerHeight: 800, scrollX: 0, scrollY: 0,
        location: { href: "https://v10.test/", origin: "https://v10.test", pathname: "/", hostname: "v10.test" },
        NodeFilter: { SHOW_ELEMENT: 1 },
      });
      new Function(PAGE_HELPERS_SOURCE)();
      await run((globalThis as any).__bc);
    } finally {
      delete (globalThis as any).__bc;
      for (const k of keys) prev[k] === undefined ? delete (globalThis as any)[k] : ((globalThis as any)[k] = prev[k]);
    }
  }

  test("S1: clips box against overflow:hidden wrappers, outer scrollers, and client areas", async () => {
    const outer = mkEl({ tagName: "DIV", localName: "div", rect: mkRect(50, 50, 200, 200), clientLeft: 10, clientTop: 10, clientWidth: 160, clientHeight: 160, scrollHeight: 800, scrollWidth: 160, scrollTop: 0, scrollLeft: 0 });
    const clipWrap = mkEl({ tagName: "DIV", localName: "div", rect: mkRect(60, 60, 160, 120), clientLeft: 0, clientTop: 0, clientWidth: 160, clientHeight: 120, parentElement: outer });
    const inner = mkEl({ tagName: "DIV", localName: "div", rect: mkRect(60, 60, 160, 300), clientLeft: 0, clientTop: 0, clientWidth: 160, clientHeight: 300, scrollHeight: 900, scrollWidth: 160, scrollTop: 0, scrollLeft: 0, parentElement: clipWrap });
    const hiddenBtn = mkEl({ id: "hid", rect: mkRect(80, 190, 100, 40), parentElement: inner });
    const partialBtn = mkEl({ id: "part", rect: mkRect(80, 165, 160, 40), parentElement: inner });
    const doc = mkDoc({ querySelectorAll: (s: string) => (s.includes("button") ? [hiddenBtn, partialBtn] : []), elementFromPoint: () => partialBtn });
    for (const e of [outer, clipWrap, inner, hiddenBtn, partialBtn]) e.ownerDocument = doc;
    outer.parentElement = doc.body;
    const styleOf = (el: any) => el === outer || el === inner ? { ...baseStyle, overflowY: "auto", overflowX: "auto" }
      : el === clipWrap ? { ...baseStyle, overflowY: "hidden", overflowX: "hidden" } : baseStyle;
    await withV10(doc, styleOf, async (bc) => {
      bc.snapshot();
      const r1 = JSON.parse(await bc.point("e1", { noScroll: true, detail: true }));
      expect(r1.inView).toBe(false);
      expect(r1.box.height).toBe(0);
      const r2 = JSON.parse(await bc.point("e2", { noScroll: true, detail: true }));
      expect(r2.inView).toBe(false);
      expect(r2.box).toEqual({ left: 80, top: 165, width: 140, height: 15 });
    });
  });

  test("S2: detail point hit-tests clipped visible fragment; legacy keeps bbox center", async () => {
    const wrapped = mkEl({ tagName: "A", localName: "a", id: "wrap", rect: mkRect(0, 100, 600, 40), rects: [mkRect(400, 100, 200, 20), mkRect(0, 120, 200, 20)] });
    const tall = mkEl({ id: "tall", rect: mkRect(100, -300, 200, 500) });
    const bg = mkEl({ tagName: "DIV", localName: "div", id: "bg" });
    const doc = mkDoc({
      querySelectorAll: (s: string) => (s.includes("button") ? [wrapped, tall] : []),
      elementFromPoint: (x: number, y: number) =>
        x >= 400 && x <= 600 && y >= 100 && y <= 120 ? wrapped : x >= 100 && x <= 300 && y >= 0 && y <= 200 ? tall : y < 0 ? null : bg,
    });
    for (const e of [wrapped, tall, bg]) e.ownerDocument = doc;
    await withV10(doc, () => baseStyle, async (bc) => {
      bc.snapshot();
      const dWrap = JSON.parse(await bc.point("e1", { detail: true }));
      expect({ inView: dWrap.inView, x: dWrap.x, y: dWrap.y, box: dWrap.box }).toEqual({ inView: true, x: 500, y: 110, box: { left: 400, top: 100, width: 200, height: 20 } });
      await expect(bc.point("e1")).rejects.toThrow(/NOT_ACTIONABLE/);
      const dTall = JSON.parse(await bc.point("e2", { noScroll: true, detail: true }));
      expect({ inView: dTall.inView, x: dTall.x, y: dTall.y, box: dTall.box }).toEqual({ inView: true, x: 200, y: 100, box: { left: 100, top: 0, width: 200, height: 200 } });
    });
  });

  test("S3 & S4: same-origin iframe hitCheck verifies parent and findScroller keeps frame box/offsets aligned", async () => {
    const modal = mkEl({ tagName: "DIALOG", localName: "dialog", id: "ov" });
    let covered = true;
    const iframeEl: any = mkEl({ tagName: "IFRAME", localName: "iframe", id: "f1", rect: mkRect(100, 50, 400, 300), clientLeft: 2, clientTop: 2 });
    const childBtn = mkEl({ id: "cbtn", rect: mkRect(20, 500, 100, 40) });
    const cRoot = { scrollTop: 40, scrollLeft: 0, scrollHeight: 1200, clientHeight: 296, scrollWidth: 396, clientWidth: 396 };
    const childDoc: any = mkDoc({
      defaultView: { innerWidth: 396, innerHeight: 296, frameElement: iframeEl, parent: globalThis },
      documentElement: cRoot, scrollingElement: cRoot,
      querySelectorAll: (s: string) => (s.includes("button") ? [childBtn] : []),
      elementFromPoint: (x: number, y: number) => (x >= 20 && x <= 120 && y >= 500 && y <= 540 ? childBtn : null),
    });
    childBtn.ownerDocument = childDoc;
    iframeEl.contentDocument = childDoc;
    let walked = false;
    const topDoc = mkDoc({
      createTreeWalker: () => ({ nextNode: () => (walked ? null : ((walked = true), iframeEl)) }),
      elementFromPoint: () => (covered ? modal : iframeEl),
    });
    iframeEl.ownerDocument = modal.ownerDocument = topDoc;
    await withV10(topDoc, () => baseStyle, async (bc) => {
      bc.snapshot();
      expect(JSON.parse(bc.hitCheck("e1", 172, 572)).ok).toBe(false);
      covered = false;
      expect(JSON.parse(bc.hitCheck("e1", 172, 572))).toEqual({ ok: true });
      const off = JSON.parse(await bc.point("e1", { noScroll: true, detail: true }));
      expect(off.inView).toBe(false);
      expect(off.scroller).toMatchObject({ kind: "element", box: { left: 102, top: 52, width: 396, height: 296 }, scrollTop: 40 });
    });
  });

  test("S5: shadow DOM deep hit in pageScrollPoint and composed parent in findScroller", async () => {
    const outerScroll = mkEl({ tagName: "DIV", localName: "div", rect: mkRect(0, 0, 400, 400), clientWidth: 400, clientHeight: 400, scrollHeight: 1500, scrollWidth: 400, scrollTop: 10, scrollLeft: 0 });
    const host = mkEl({ tagName: "DIV", localName: "div", parentElement: outerScroll });
    const shadowScroller = mkEl({ tagName: "DIV", localName: "div", scrollHeight: 1000, clientHeight: 200, scrollWidth: 200, clientWidth: 200 });
    const shadowBtn = mkEl({ id: "sbtn", rect: mkRect(20, 600, 100, 40) });
    const sr: any = { host, querySelectorAll: (s: string) => (s.includes("button") ? [shadowBtn] : []), elementFromPoint: (x: number, y: number) => (x === 500 && y === 400 ? shadowScroller : shadowBtn) };
    host.shadowRoot = sr;
    shadowScroller.rootNode = shadowBtn.rootNode = sr;
    const bg = mkEl({ tagName: "MAIN", localName: "main" });
    let walked = false;
    const doc = mkDoc({
      documentElement: { scrollTop: 0, scrollLeft: 0, scrollHeight: 2000, clientHeight: 800 },
      scrollingElement: { scrollTop: 0, scrollLeft: 0, scrollHeight: 2000, clientHeight: 800 },
      createTreeWalker: () => ({ nextNode: () => (walked ? null : ((walked = true), host)) }),
      elementFromPoint: (x: number, y: number) => (x === 500 && y === 400 ? host : bg),
    });
    for (const e of [outerScroll, host, shadowScroller, shadowBtn, bg, sr]) e.ownerDocument = doc;
    outerScroll.parentElement = bg.parentElement = doc.body;
    await withV10(doc, (el) => (el === outerScroll || el === shadowScroller ? { ...baseStyle, overflowY: "auto" } : baseStyle), async (bc) => {
      bc.snapshot();
      const sp = JSON.parse(bc.pageScrollPoint());
      expect(sp).not.toBeNull();
      expect(sp).not.toEqual({ x: 500, y: 400 });
      const off = JSON.parse(await bc.point("e1", { noScroll: true, detail: true }));
      expect(off.inView).toBe(false);
      expect(off.scroller).toMatchObject({ kind: "element", scrollTop: 10 });
    });
  });
});

describe("wrapper --fast forwarding and natural subcommand", () => {
  const WRAPPER = resolve(import.meta.dir, "../.agents/skills/browser-control/scripts/browser-control-daemon");
  type Recorded = { method: string; path: string; query: string; body: string };
  const seen: Recorded[] = [];
  let dir = "";
  let xdg = "";
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bc-nat-wrap-"));
    xdg = await mkdtemp(join(tmpdir(), "bc-nat-xdg-"));
    server = Bun.serve({
      unix: join(dir, "sock"),
      fetch(req) {
        const url = new URL(req.url);
        return (async () => {
          const body = req.method === "GET" ? "" : await req.text();
          seen.push({ method: req.method, path: url.pathname, query: url.search, body });
          return Response.json({ ok: true, data: { value: "ok" } });
        })();
      },
    });
  });

  afterAll(async () => {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  });

  async function bc(args: string[], extraEnv: Record<string, string | undefined> = {}) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, BROWSER_CONTROL_DAEMON_DIR: dir, XDG_CONFIG_HOME: xdg, ...extraEnv })) {
      if (v !== undefined) env[k] = v;
    }
    const proc = Bun.spawn(["bash", WRAPPER, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { code: await proc.exited, stdout, stderr };
  }

  async function call(...args: string[]): Promise<Recorded> {
    const before = seen.length;
    const res = await bc(args);
    expect(res.code).toBe(0);
    const made = seen.slice(before).filter((r) => r.path !== "/status");
    expect(made).toHaveLength(1);
    return made[0]!;
  }

  test("forwards --fast on click, hover, select, drag, key, do, nav, text, script", async () => {
    expect(JSON.parse((await call("click", "--fast", "e1")).body)).toEqual({ ref: "e1", fast: true });
    expect(JSON.parse((await call("click", "--fast", "--xy", "10,20")).body)).toEqual({ xy: [10, 20], fast: true });
    expect(JSON.parse((await call("hover", "--fast", "e1")).body)).toEqual({ ref: "e1", fast: true });
    expect(JSON.parse((await call("hover", "--fast", "--xy", "10,20")).body)).toEqual({ xy: [10, 20], fast: true });
    expect(JSON.parse((await call("select", "--fast", "e8", "US")).body)).toEqual({ ref: "e8", option: "US", fast: true });
    expect(JSON.parse((await call("drag", "--fast", "e1", "e2")).body)).toEqual({ from: "e1", to: "e2", fast: true });
    expect(JSON.parse((await call("key", "--fast", "Enter")).body)).toEqual({ key: "Enter", fast: true });
    expect(JSON.parse((await call("do", "--fast", '[{"key":"Tab"}]')).body)).toEqual({ steps: [{ key: "Tab" }], fast: true });
    expect(new URLSearchParams((await call("nav", "--fast", "https://example.test/")).query).get("fast")).toBe("1");
    expect(JSON.parse((await call("text", "--fast", "--scroll")).body)).toEqual({ all: false, scroll: true, fast: true });
    expect(JSON.parse((await call("script", "--fast", "return 1")).body)).toEqual({ code: "return 1", fast: true });
  });

  test("natural [on|off|status] reads and writes XDG_CONFIG_HOME/browser-control/natural atomically", async () => {
    const stDefault = await bc(["natural", "status"], { BROWSER_CONTROL_NATURAL: undefined });
    expect(stDefault.code).toBe(0);
    expect(JSON.parse(stDefault.stdout).data).toMatchObject({ natural: "on", source: "default" });

    const off = await bc(["natural", "off"], { BROWSER_CONTROL_NATURAL: undefined });
    expect(off.code).toBe(0);
    expect(JSON.parse(off.stdout).data.natural).toBe("off");
    expect((await readFile(join(xdg, "browser-control", "natural"), "utf8")).trim()).toBe("off");

    const stFile = await bc(["natural"], { BROWSER_CONTROL_NATURAL: undefined });
    expect(JSON.parse(stFile.stdout).data).toMatchObject({ natural: "off", source: "file" });

    const stEnv = await bc(["natural", "status"], { BROWSER_CONTROL_NATURAL: "on" });
    expect(JSON.parse(stEnv.stdout).data).toMatchObject({ natural: "on", source: "env" });

    const on = await bc(["natural", "on"], { BROWSER_CONTROL_NATURAL: undefined });
    expect(on.code).toBe(0);
    expect((await readFile(join(xdg, "browser-control", "natural"), "utf8")).trim()).toBe("on");

    const bad = await bc(["natural", "maybe"], { BROWSER_CONTROL_NATURAL: undefined });
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("INPUT_INVALID");
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
