import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { InvokeResult } from "@agent-software/core";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BcCallFn, BcCallInput } from "../src/backends/extension";
import {
  createSeededRng,
  planNavDwell,
  planPaginationGap,
  planTextScrollStep,
  planThinkPause,
} from "../src/natural";
import { PAGE_HELPERS_SOURCE, PAGE_HELPERS_VERSION } from "../src/page-helpers";
import { createPageHelperHandler } from "../src/page-runner";

type Call = { op: string; input: Record<string, unknown> };

type MockOptions = {
  chars?: number;
  url?: string;
  readback?: string;
  locate?: Record<string, string>;
  /** Runs inside the mocked `navigate`, so a test can advance its fake clock over a slow load. */
  onNavigate?: () => void;
  /** Tab a session nav lands on, as the backend picks it (#45 session tab reuse). */
  sessionTab?: string;
};

/**
 * Minimal page-helper invoker: serves the helper expressions the pacing hooks read and lets the
 * test set the document text length, the current URL, and the typed readback.
 */
function makeMock(options: MockOptions = {}) {
  const calls: Call[] = [];
  let url = options.url ?? "https://a.test/1";
  let installed = false;
  const ok = (value: unknown): InvokeResult => ({ ok: true, data: { value } });

  const evaluate = (input: Record<string, unknown>): InvokeResult => {
    const expr = String(input["expression"] ?? "");
    if (expr.includes(PAGE_HELPERS_SOURCE)) installed = true;
    if (!installed && expr.includes("__BC_NEED_INSTALL__")) return ok("__BC_NEED_INSTALL__");
    if (expr.includes("__bc.locate")) {
      const label = /__bc\.locate\("([^"]*)"/.exec(expr)?.[1] ?? "";
      const ref = options.locate?.[label];
      return ref ? ok(ref) : { ok: false, error: { code: "EXECUTION_FAILED", message: `NO_MATCH: ${label}` } };
    }
    // A normal page: the bot-challenge probe answers its complete `{skip,url}` readback.
    if (expr.includes("responseStatus") && expr.includes("visibleSelectors")) return ok(JSON.stringify({ skip: true, url }));
    if (expr.includes("location.href, __bc.chars()")) return ok(`${url}\n${options.chars ?? 0}\n`);
    if (expr.includes("location.href, __bc.wall()")) return ok(`${url}\n`);
    if (expr.includes("__bc.chars()")) return ok(options.chars ?? 0);
    if (expr.includes("__bc.point")) {
      const detail = JSON.stringify({
        x: 350,
        y: 220,
        hidden: false,
        inView: true,
        box: { left: 250, top: 200, width: 200, height: 40 },
        rect: { left: 250, top: 200, width: 200, height: 40 },
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
      return ok(expr.includes("__bc.baseline()") ? `${url}\n${detail}` : detail);
    }
    if (expr.includes("__bc.baseline")) return ok(url);
    if (expr.includes("__bc.checkWait")) return ok(JSON.stringify({ matched: true, url, wall: "" }));
    if (expr.includes("__bc.value")) return ok(options.readback ?? "v");
    if (expr.includes("__bc.armInputProbe")) return ok("armed");
    if (expr.includes("__bc.readInputProbe")) return ok(JSON.stringify({ mousedown: 1, mouseup: 1 }));
    if (expr.includes("__bc.focusForType")) return ok("focused");
    if (expr.includes("__bc.guard")) return ok("ok");
    if (expr.includes("__bc.verifyRef")) return ok("e3");
    if (expr.includes("__bc.hitCheck")) return ok(JSON.stringify({ ok: true }));
    if (expr.includes("__bc.text")) return ok(`# Page | ${url}\n\nhello`);
    return ok("ok");
  };

  const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
    calls.push({ op, input });
    if (op === "evaluate") return evaluate(input);
    if (op === "navigate") {
      url = String(input["url"] ?? url);
      options.onNavigate?.();
      const tab = input["targetId"] ?? (input["sessionKey"] ? options.sessionTab : undefined);
      return { ok: true, data: { loaded: true, url, ...(tab ? { targetId: tab } : {}) } };
    }
    if (op === "execute_cdp") return { ok: true, data: { result: {} } };
    return { ok: true, data: {} };
  };

  return { calls, invoke, getUrl: () => url };
}

/** Fake clock + sleeping recorder so pacing tests never really wait. */
function makeClock() {
  const sleeps: number[] = [];
  let clock = 0;
  return {
    sleeps,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    /** Think pauses (>= 160 ms) are the only sleeps this suite cares about besides nav waits. */
    thinkPauses: () => sleeps.filter((ms) => ms >= 160 && ms <= 420),
  };
}

type HandlerOptions = NonNullable<Parameters<typeof createPageHelperHandler>[3]>;

/** A pacing handler over a mock, wired to a fake clock. `rng` 0.5 makes each planner hit its midpoint. */
function pane(options: MockOptions = {}, extra: HandlerOptions = {}) {
  const mock = makeMock(options);
  const clock = makeClock();
  const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
    sleep: clock.sleep,
    rng: () => 0.5,
    now: clock.now,
    ...extra,
  });
  return { mock, clock, handle };
}

let cfgDir: string;
let prevNatural: string | undefined;
let prevXdg: string | undefined;

beforeEach(async () => {
  cfgDir = await mkdtemp(join(tmpdir(), "bc-pacing-"));
  prevNatural = process.env["BROWSER_CONTROL_NATURAL"];
  prevXdg = process.env["XDG_CONFIG_HOME"];
  delete process.env["BROWSER_CONTROL_NATURAL"];
  process.env["XDG_CONFIG_HOME"] = cfgDir;
});

afterEach(async () => {
  if (prevNatural === undefined) delete process.env["BROWSER_CONTROL_NATURAL"];
  else process.env["BROWSER_CONTROL_NATURAL"] = prevNatural;
  if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = prevXdg;
  await rm(cfgDir, { recursive: true, force: true });
});

describe("pacing planners — bounds and seeded determinism", () => {
  const PLANNERS = [
    { plan: (rng: () => number) => planThinkPause(rng), lo: 160, hi: 420 },
    { plan: (rng: () => number) => planNavDwell(4_000, rng), lo: 220, hi: 850 },
    { plan: (rng: () => number) => planPaginationGap(rng), lo: 1_600, hi: 2_800 },
  ];

  test("every planner stays in bounds and repeats for a seed", () => {
    for (const { plan, lo, hi } of PLANNERS) {
      for (let seed = 1; seed <= 200; seed++) {
        const value = plan(createSeededRng(seed));
        expect(value).toBeGreaterThanOrEqual(lo);
        expect(value).toBeLessThanOrEqual(hi);
        expect(plan(createSeededRng(seed))).toBe(value);
      }
    }
    expect(planPaginationGap(createSeededRng(11))).not.toBe(planPaginationGap(createSeededRng(12)));
  });

  test("think pause and nav dwell follow their formulas", () => {
    const rng = () => 0.5;
    expect(planThinkPause(rng)).toBe(290); // triangular(0.5, 160, 420)
    expect(planThinkPause(rng, 100)).toBe(190); // partial settling subtracts exactly
    expect(planThinkPause(rng, 5_000)).toBe(0); // a slow settle owes nothing
    expect(planNavDwell(0, rng)).toBe(220);
    expect(planNavDwell(4_000, rng)).toBe(548); // 220 + 0.08 * 4000 * 1.025
    expect(planNavDwell(1_000_000, rng)).toBe(850);
  });

  test("planTextScrollStep jitters 0.72–0.92 of the height with reading pauses", () => {
    let slow = 0;
    const samples = 4_000;
    const rng = createSeededRng(2026);
    for (let i = 0; i < samples; i++) {
      const step = planTextScrollStep(rng);
      expect(step.heightFactor).toBeGreaterThanOrEqual(0.72);
      expect(step.heightFactor).toBeLessThanOrEqual(0.92);
      const normal = step.pauseMs >= 140 && step.pauseMs <= 290;
      const long = step.pauseMs >= 320 && step.pauseMs <= 600;
      expect(normal || long).toBe(true);
      if (long) slow++;
    }
    const rate = slow / samples;
    expect(rate).toBeGreaterThan(0.06);
    expect(rate).toBeLessThan(0.14);

    const seedRun = (seed: number) =>
      Array.from({ length: 5 }, () => planTextScrollStep(createSeededRng(seed))).map((s) => s.pauseMs);
    expect(seedRun(3)).toEqual(seedRun(3));
  });
});

describe("do/fill think pauses", () => {
  test("pauses 160–420 ms between steps but not after the last one", async () => {
    const { clock, handle } = pane();
    const res = await handle("do", { steps: [{ key: "Tab" }, { key: "Tab" }, { key: "Tab" }], quiet: true });
    expect(res.ok).toBe(true);
    // triangular(0.5, 160, 420) = 290 with this rng.
    expect(clock.thinkPauses()).toEqual([290, 290]);
  });

  test("skips the pause after a wait step and on a per-step fast", async () => {
    const { clock, handle } = pane();
    const waited = await handle("do", { steps: [{ key: "Tab" }, { wait: "Ready" }, { key: "Tab" }], quiet: true });
    expect(waited.ok).toBe(true);
    expect(clock.thinkPauses()).toEqual([290]);

    clock.sleeps.length = 0;
    const fastStep = await handle("do", {
      steps: [{ key: "Tab" }, { key: "Tab", fast: true }, { key: "Tab" }],
      quiet: true,
    });
    expect(fastStep.ok).toBe(true);
    expect(clock.thinkPauses()).toEqual([290]);
  });

  test("fill paces between fields", async () => {
    const { clock, handle } = pane({ readback: "v", locate: { Email: "e3", Name: "e4" } });
    const res = await handle("do", { fill: { Email: "v", Name: "v" }, quiet: true });
    expect(res.ok).toBe(true);
    // One think pause between the fields; typing v2's own 160 ms first-key settle stays inside each type.
    expect(clock.sleeps.filter((ms) => ms === 290)).toEqual([290]);
    expect(clock.sleeps.filter((ms) => ms === 160)).toHaveLength(2);
  });

  test("--fast and natural off add no pauses anywhere", async () => {
    const { clock, handle } = pane();
    const fast = await handle("do", { steps: [{ key: "Tab" }, { key: "Tab" }], fast: true, quiet: true });
    expect(fast.ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);

    process.env["BROWSER_CONTROL_NATURAL"] = "off";
    const off = await handle("do", { steps: [{ key: "Tab" }, { key: "Tab" }], quiet: true });
    expect(off.ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);
  });

  test("a malformed step is INPUT_INVALID, not a thrown TypeError", async () => {
    const { handle } = pane();
    const res = await handle("do", { steps: [null], quiet: true });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a failure");
    expect(res.error.code).toBe("INPUT_VALIDATION_FAILED");
    expect(res.error.message).toContain("INPUT_INVALID");
  });
});

describe("post-nav dwell and pagination gap", () => {
  test("nav and reads never sleep; the next input pays the dwell minus elapsed", async () => {
    const { clock, handle } = pane({ chars: 4_000 });
    expect((await handle("nav", { url: "https://a.test/1" })).ok).toBe(true);
    expect((await handle("text", {})).ok).toBe(true);
    expect((await handle("snap", {})).ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);

    // dwell = 220 + 0.08 * 4000 * 1.025 = 548; 300 ms of it was reading.
    clock.advance(300);
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps.at(0)).toBe(548 - 300);

    // Consumed: later inputs pay only their own key hold.
    clock.sleeps.length = 0;
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps.every((ms) => ms <= 130)).toBe(true);
  });

  test("pagination runs from nav dispatch and only for same-host navs under 4 s", async () => {
    let slowLoad = true;
    const { clock, handle } = pane({
      chars: 4_000,
      onNavigate: () => {
        if (!slowLoad) return;
        slowLoad = false;
        clock.advance(1_000);
      },
    });
    // Nav 1 dispatches at t=0 and finishes at t=1000; nav 2 dispatches at t=1500.
    expect((await handle("nav", { url: "https://a.test/1" })).ok).toBe(true);
    clock.advance(500);
    expect((await handle("nav", { url: "https://a.test/2" })).ok).toBe(true);
    // Gap 2200 ms from dispatch (t=0) leaves 700, not 1700 as a post-load clock would.
    expect(clock.sleeps).toEqual([700]);

    // The dwell of the new page still applies before the next input.
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps).toEqual([700, 548, 60]);

    // Different host, then the same host more than 4 s later: no gap.
    clock.sleeps.length = 0;
    clock.advance(300);
    expect((await handle("nav", { url: "https://b.test/1" })).ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);
    // The cross-host page still owes its full reading dwell before the first input.
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps.at(0)).toBe(548);
    clock.sleeps.length = 0;
    clock.advance(4_500);
    expect((await handle("nav", { url: "https://b.test/2" })).ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);
  });

  test("a session nav keeps its pagination clock though the backend picks its tab; --new-tab owes no gap", async () => {
    const { clock, handle } = pane({ sessionTab: "T-session" });
    const sessionKey = "abcdef12";
    expect((await handle("nav", { url: "https://a.test/1", sessionKey })).ok).toBe(true);
    clock.advance(500);
    expect((await handle("nav", { url: "https://a.test/2", sessionKey })).ok).toBe(true);
    expect(clock.sleeps).toEqual([1_700]);
    clock.sleeps.length = 0;
    expect((await handle("nav", { url: "https://a.test/3", newTab: true })).ok).toBe(true);
    expect(clock.sleeps).toEqual([]);
  });

  test("nav --fast and a per-step fast skip the dwell, and natural off records nothing", async () => {
    const { clock, handle } = pane({ chars: 4_000 });
    expect((await handle("nav", { url: "https://a.test/1", fast: true })).ok).toBe(true);
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps.every((ms) => ms <= 130)).toBe(true);

    clock.sleeps.length = 0;
    expect((await handle("nav", { url: "https://a.test/1" })).ok).toBe(true);
    // The fast step pays no dwell, and the `wait` after it is skipped by pacing, so nothing is owed.
    expect((await handle("do", { steps: [{ key: "Tab", fast: true }, { wait: "Ready" }], quiet: true })).ok).toBe(true);
    expect(clock.sleeps.filter((ms) => ms >= 220)).toEqual([]);

    process.env["BROWSER_CONTROL_NATURAL"] = "off";
    clock.sleeps.length = 0;
    expect((await handle("nav", { url: "https://a.test/2" })).ok).toBe(true);
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);
  });

  test("the nav probe is attach-free and only asks for the body length when pacing is on", async () => {
    const bcCalls: BcCallInput[] = [];
    const calls: Call[] = [];
    const { invoke } = makeMock({ chars: 4_000 });
    const clock = makeClock();
    const bcCall: BcCallFn = async (input) => {
      bcCalls.push(input);
      const values = input.steps.map((step) =>
        step.kind === "href" ? "https://a.test/1" : step.kind === "bc" && step.method === "chars" ? 4_000 : "",
      );
      const kept = values.filter((_, i) => !input.steps[i]!.discard);
      return { value: input.join === undefined ? values.at(-1) : kept.join(input.join) };
    };
    const handle = createPageHelperHandler(
      async (op, input = {}) => {
        calls.push({ op, input });
        return invoke(op, input);
      },
      undefined,
      undefined,
      { bcCall, sleep: clock.sleep, rng: () => 0.5, now: clock.now },
    );
    /** Whether the bc probe steps added since `from` asked for the body length. */
    const readChars = (from: number): boolean =>
      bcCalls.slice(from).some((c) => c.steps.some((s) => s.kind === "bc" && s.method === "chars"));

    const first = bcCalls.length;
    expect((await handle("nav", { url: "https://a.test/1" }, "extension:42")).ok).toBe(true);
    // The count rides inside the existing bc_call nav probe, so nothing attaches the debugger.
    expect(readChars(first)).toBe(true);
    expect(calls.filter((c) => c.op === "evaluate")).toHaveLength(0);
    expect((await handle("key", { key: "Tab", quiet: true }, "extension:42")).ok).toBe(true);
    expect(clock.sleeps.at(0)).toBe(548);

    // --fast and natural off pay no dwell, so they never read the body text at all.
    const fast = bcCalls.length;
    expect((await handle("nav", { url: "https://a.test/2", fast: true }, "extension:42")).ok).toBe(true);
    expect(readChars(fast)).toBe(false);
    process.env["BROWSER_CONTROL_NATURAL"] = "off";
    const off = bcCalls.length;
    expect((await handle("nav", { url: "https://a.test/3" }, "extension:42")).ok).toBe(true);
    expect(readChars(off)).toBe(false);
  });

  test("implicit targets on different tabs never share dwell state", async () => {
    let active = "target-A";
    const mock = makeMock({ chars: 4_000 });
    const clock = makeClock();
    const handle = createPageHelperHandler(
      async (op, input = {}) => {
        if (op === "get_browser_status") return { ok: true, data: { activeTargetId: active } };
        return mock.invoke(op, input);
      },
      undefined,
      undefined,
      { sleep: clock.sleep, rng: () => 0.5, now: clock.now },
    );

    // Nav on tab A, then switch tabs: tab B must not pay A's dwell.
    expect((await handle("nav", { url: "https://a.test/1" })).ok).toBe(true);
    active = "target-B";
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps.every((ms) => ms <= 130)).toBe(true);

    // Back on tab A the dwell is still owed, minus the time tab B's input took.
    active = "target-A";
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps.at(-2)).toBe(548 - 60);
  });

  test("hover pays the post-nav dwell before it moves the pointer", async () => {
    const { clock, handle } = pane({ chars: 4_000 });
    expect((await handle("nav", { url: "https://a.test/1" })).ok).toBe(true);
    clock.sleeps.length = 0;
    expect((await handle("hover", { ref: "e5" })).ok).toBe(true);
    expect(clock.sleeps.at(0)).toBe(548);
  });
});

describe("text --scroll pace", () => {
  const scrollPaceOf = (expr: string): { factors: number[]; pauses: number[] } | undefined => {
    const match = /"scrollPace":\{"factors":\[([^\]]*)\],"pauses":\[([^\]]*)\]\}/.exec(expr);
    if (!match) return undefined;
    const parse = (raw: string) => (raw.trim() === "" ? [] : raw.split(",").map(Number));
    return { factors: parse(match[1]!), pauses: parse(match[2]!) };
  };

  const lastScrollExpr = (mock: ReturnType<typeof makeMock>): string =>
    String(mock.calls.filter((c) => c.op === "evaluate").at(-1)?.input["expression"] ?? "");

  test("natural on plans jittered steps; --fast sends no plan and keeps the plain reader", async () => {
    const natural = pane({}, { rng: createSeededRng(42) });
    expect((await natural.handle("text", { scroll: true })).ok).toBe(true);
    const plan = scrollPaceOf(lastScrollExpr(natural.mock));
    expect(plan).toBeDefined();
    expect(plan!.factors).toHaveLength(64);
    expect(plan!.pauses).toHaveLength(64);
    for (const factor of plan!.factors) {
      expect(factor).toBeGreaterThanOrEqual(0.72);
      expect(factor).toBeLessThanOrEqual(0.92);
    }
    for (const pause of plan!.pauses) {
      expect((pause >= 140 && pause <= 290) || (pause >= 320 && pause <= 600)).toBe(true);
    }

    const fast = pane({}, { rng: createSeededRng(42) });
    expect((await fast.handle("text", { scroll: true, fast: true })).ok).toBe(true);
    expect(scrollPaceOf(lastScrollExpr(fast.mock))).toBeUndefined();
  });

  test("the plan cycles past its 64 steps and the 200 px floor is fast-path only", () => {
    const source = PAGE_HELPERS_SOURCE;
    // Cycling, so a long read keeps its paced size and pause instead of dropping to 0.9x / 120 ms.
    expect(source).toContain("scrollIdx % fLen");
    expect(source).toContain("scrollIdx % pLen");
    // Paced steps use the planned length even in a short scroller; the floor stays in the fast path.
    expect(source).toContain("Number.isFinite(factor) ? Math.round(height * factor) : Math.max(200");
  });

  test("helpers v13 ship the attach-free chars reader, stay plain JavaScript, and match the extension copy", () => {
    expect(PAGE_HELPERS_VERSION).toBe(13);
    expect(PAGE_HELPERS_SOURCE).toContain("scrollRead, text, chars,");
    expect(PAGE_HELPERS_SOURCE).toContain("opts.scrollPace");
    expect(PAGE_HELPERS_SOURCE).toContain("scrollPace.factors");
    expect(() => new Function(PAGE_HELPERS_SOURCE)).not.toThrow();
    // No debugger attach anywhere in the page helper.
    expect(PAGE_HELPERS_SOURCE).not.toContain("Runtime.enable");
    const shipped = readFileSync(new URL("../extension/page-helpers.js", import.meta.url), "utf8");
    expect(shipped).toBe(PAGE_HELPERS_SOURCE);
  });
});
