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

  function makeNaturalMock(opts: {
    inView?: boolean;
    scrollDeltaPerWheel?: number;
    failAtMouseMoveIndex?: number;
    failMessage?: string;
    draggable?: boolean;
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
        x: 350,
        y: Math.round(top + 20),
        hidden: false,
        inView,
        box: { left: 250, top: inView ? top : 0, width: 200, height: inView ? 40 : 0 },
        rect: { left: 250, top, width: 200, height: 40 },
        viewport: { width: 1280, height: 800 },
        stickyTop: 0,
        stickyBottom: 0,
        scroller: {
          kind: "document",
          box: { left: 0, top: 0, width: 1280, height: 800 },
          scrollTop: 0,
          scrollLeft: 0,
          scrollHeight: 3000,
          clientHeight: 800,
          point: { x: 640, y: 400 },
        },
      });
    };

    const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
      if (op === "get_browser_status") return { ok: true, data: { connected: true } };
      if (op === "navigate") return { ok: true, data: { loaded: true, targetId: input["targetId"] } };
      if (op === "wait_for_event") return { ok: true, data: { found: false } };
      if (op === "evaluate") {
        const expr = String(input["expression"] ?? "");
        evalExprs.push(expr);
        if (expr.includes("__bc.verifyRef")) return { ok: true, data: { value: "e1" } };
        if (expr.includes("__bc.hitCheck")) return { ok: true, data: { value: JSON.stringify({ ok: true }) } };
        if (expr.includes("__bc.point")) {
          const isNoScroll = expr.includes('"noScroll":true');
          const isDetail = expr.includes('"detail":true') || isNoScroll;
          if (!isDetail) {
            return {
              ok: true,
              data: { value: expr.includes("__bc.baseline()") ? "https://a.test/ 350 220 visible" : "350 220 visible" },
            };
          }
          const detail = makeDetail(!isNoScroll);
          return {
            ok: true,
            data: { value: expr.includes("__bc.baseline()") ? `https://a.test/\n${detail}` : detail },
          };
        }
        if (expr.includes("__bc.dragInfo")) {
          return {
            ok: true,
            data: {
              value: JSON.stringify({
                sx: 120,
                sy: 200,
                dx: 520,
                dy: 460,
                draggable: opts.draggable === true,
                listMeta: null,
              }),
            },
          };
        }
        if (expr.includes("__bc.setTypedValue")) return { ok: true, data: { value: "__not_typed__" } };
        if (expr.includes("__bc.cellInfo")) return { ok: true, data: { value: "__not_cell__" } };
        if (expr.includes("__bc.focusForType")) return { ok: true, data: { value: "focused" } };
        if (expr.includes("__bc.value")) return { ok: true, data: { value: "hello" } };
        if (expr.includes("__bc.readInputProbe")) return { ok: true, data: { value: '{"mousedown":1,"mouseup":1}' } };
        if (expr.includes("__bc.hit(")) return { ok: true, data: { value: "https://a.test/\nhit: button#ok" } };
        if (expr.includes("__bc.diff")) return { ok: true, data: { value: "# no visible change yet" } };
        return { ok: true, data: { value: "ok" } };
      }
      if (op === "execute_cdp") {
        const method = String(input["method"]);
        const params = (input["params"] ?? {}) as Record<string, unknown>;
        cdpCalls.push({ method, params, targetId: input["targetId"] as string | undefined });
        if (method === "Input.dispatchMouseEvent" && params["type"] === "mouseMoved") {
          mouseMoveCount++;
          if (opts.failAtMouseMoveIndex !== undefined && mouseMoveCount === opts.failAtMouseMoveIndex) {
            return {
              ok: false,
              error: { code: "EXECUTION_FAILED", message: opts.failMessage ?? "DIALOG_OPEN: alert open" },
            };
          }
        }
        if (method === "Input.dispatchMouseEvent" && params["type"] === "mouseWheel") {
          const delta = opts.scrollDeltaPerWheel ?? Number(params["deltaY"] ?? 0);
          currentTop -= delta;
        }
        return { ok: true, data: { result: {} } };
      }
      return { ok: true, data: {} };
    };

    return { invoke, cdpCalls, evalExprs, sleeps };
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
      // Natural click on in-view element.
      const nat = makeNaturalMock({ inView: true });
      const handleNat = createPageHelperHandler(nat.invoke, undefined, undefined, {
        sleep: async (ms) => { nat.sleeps.push(ms); },
        rng: createSeededRng(77),
        now: () => 0,
      });

      const res = await handleNat("click", { ref: "e1", quiet: true });
      expect(res.ok).toBe(true);

      const mouseEvents = nat.cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
      const moves = mouseEvents.filter((e) => e.params["type"] === "mouseMoved");
      const presses = mouseEvents.filter((e) => e.params["type"] === "mousePressed");
      const releases = mouseEvents.filter((e) => e.params["type"] === "mouseReleased");
      const wheels = mouseEvents.filter((e) => e.params["type"] === "mouseWheel");

      expect(moves.length).toBeGreaterThanOrEqual(4);
      expect(moves.length).toBeLessThanOrEqual(29);
      expect(presses).toHaveLength(1);
      expect(releases).toHaveLength(1);
      expect(wheels).toHaveLength(0);
      // Last move matches pressed/released landing point inside inset box [260..440] x [208..232].
      const lastMove = moves.at(-1)!.params;
      expect(presses[0]!.params["x"]).toBe(lastMove["x"]);
      expect(presses[0]!.params["y"]).toBe(lastMove["y"]);
      expect(Number(lastMove["x"])).toBeGreaterThanOrEqual(260);
      expect(Number(lastMove["x"])).toBeLessThanOrEqual(440);
      expect(Number(lastMove["y"])).toBeGreaterThanOrEqual(208);
      expect(Number(lastMove["y"])).toBeLessThanOrEqual(232);
      // Dwell + press hold are the last two sleeps.
      const holdMs = nat.sleeps.at(-1)!;
      const dwellMs = nat.sleeps.at(-2)!;
      expect(dwellMs).toBeGreaterThanOrEqual(45);
      expect(dwellMs).toBeLessThanOrEqual(115);
      expect(holdMs).toBeGreaterThanOrEqual(55);
      expect(holdMs).toBeLessThanOrEqual(130);

      // --fast click emits exact legacy 3-event sequence with zero sleep.
      const fast = makeNaturalMock({ inView: true });
      const handleFast = createPageHelperHandler(fast.invoke, undefined, undefined, {
        sleep: async (ms) => { fast.sleeps.push(ms); },
        rng: createSeededRng(77),
        now: () => 0,
      });
      const fastRes = await handleFast("click", { ref: "e1", fast: true, quiet: true });
      expect(fastRes.ok).toBe(true);
      const fastMouse = fast.cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
      expect(fastMouse.map((e) => e.params["type"])).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
      expect(fastMouse[0]!.params).toEqual({ type: "mouseMoved", x: 350, y: 220 });
      expect(fast.sleeps).toHaveLength(0);
    });
  });

  test("off-screen target emits eased mouseWheel events and falls back to instant scrollIntoView when stagnant", async () => {
    await withNaturalOn(async () => {
      // Scrollable target moves into view via mouseWheel.
      const scrollOk = makeNaturalMock({ inView: false });
      const h1 = createPageHelperHandler(scrollOk.invoke, undefined, undefined, {
        sleep: async (ms) => { scrollOk.sleeps.push(ms); },
        rng: createSeededRng(123),
        now: () => 0,
      });
      const r1 = await h1("click", { ref: "e1", quiet: true });
      expect(r1.ok).toBe(true);
      const wheels1 = scrollOk.cdpCalls.filter(
        (c) => c.method === "Input.dispatchMouseEvent" && c.params["type"] === "mouseWheel",
      );
      expect(wheels1.length).toBeGreaterThanOrEqual(4);
      // Never needed instant scrollIntoView fallback because wheel brought it into view.
      expect(scrollOk.evalExprs.some((e) => e.includes('__bc.point("e1", {"detail":true})'))).toBe(false);

      // Stagnant page (wheel does not move rect.top) breaks after first flick and falls back to instant scrollIntoView.
      const stagnant = makeNaturalMock({ inView: false, scrollDeltaPerWheel: 0 });
      const h2 = createPageHelperHandler(stagnant.invoke, undefined, undefined, {
        sleep: async (ms) => { stagnant.sleeps.push(ms); },
        rng: createSeededRng(123),
        now: () => 0,
      });
      const r2 = await h2("click", { ref: "e1", quiet: true });
      expect(r2.ok).toBe(true);
      const wheels2 = stagnant.cdpCalls.filter(
        (c) => c.method === "Input.dispatchMouseEvent" && c.params["type"] === "mouseWheel",
      );
      expect(wheels2.length).toBeGreaterThanOrEqual(4);
      expect(wheels2.length).toBeLessThanOrEqual(12); // stopped after 1 flick
      expect(stagnant.evalExprs.some((e) => e.includes('__bc.point("e1", {"detail":true})'))).toBe(true);
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

  test("forwards --fast on click, hover, drag, key, do, nav, text, script", async () => {
    expect(JSON.parse((await call("click", "--fast", "e1")).body)).toEqual({ ref: "e1", fast: true });
    expect(JSON.parse((await call("click", "--fast", "--xy", "10,20")).body)).toEqual({ xy: [10, 20], fast: true });
    expect(JSON.parse((await call("hover", "--fast", "e1")).body)).toEqual({ ref: "e1", fast: true });
    expect(JSON.parse((await call("hover", "--fast", "--xy", "10,20")).body)).toEqual({ xy: [10, 20], fast: true });
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
