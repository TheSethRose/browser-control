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

/**
 * Minimal page-helper invoker: serves the helper expressions the pacing hooks read and lets the
 * test set the document text length, the current URL, and the typed readback.
 */
function makeMock(
  options: {
    chars?: number;
    url?: string;
    readback?: string;
    locate?: Record<string, string>;
    /** Runs inside the mocked `navigate`, so a test can advance its fake clock over a slow load. */
    onNavigate?: () => void;
  } = {},
) {
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
      return { ok: true, data: { loaded: true, url, ...(input["targetId"] ? { targetId: input["targetId"] } : {}) } };
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
  test("planThinkPause stays in 160–420 ms and subtracts settling time", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = createSeededRng(seed);
      const pause = planThinkPause(rng);
      expect(pause).toBeGreaterThanOrEqual(160);
      expect(pause).toBeLessThanOrEqual(420);
      // A settle longer than the planned pause owes nothing.
      expect(planThinkPause(createSeededRng(seed), 5_000)).toBe(0);
      // Partial settling subtracts exactly the elapsed time.
      expect(planThinkPause(createSeededRng(seed), 100)).toBe(pause - 100);
    }
    const a = [planThinkPause(createSeededRng(7)), planThinkPause(createSeededRng(7), 40)];
    const b = [planThinkPause(createSeededRng(7)), planThinkPause(createSeededRng(7), 40)];
    expect(a).toEqual(b);
  });

  test("planNavDwell follows clamp(220 + 0.08·chars·(0.8–1.25), 220, 850)", () => {
    const rng = () => 0.5;
    expect(planNavDwell(0, rng)).toBe(220);
    expect(planNavDwell(4_000, rng)).toBe(548); // 220 + 0.08 * 4000 * 1.025
    expect(planNavDwell(1_000_000, rng)).toBe(850);
    for (let seed = 1; seed <= 100; seed++) {
      const value = planNavDwell(seed * 137, createSeededRng(seed));
      expect(value).toBeGreaterThanOrEqual(220);
      expect(value).toBeLessThanOrEqual(850);
    }
  });

  test("planPaginationGap stays in 1.6–2.8 s and is seeded", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const gap = planPaginationGap(createSeededRng(seed));
      expect(gap).toBeGreaterThanOrEqual(1600);
      expect(gap).toBeLessThanOrEqual(2800);
    }
    expect(planPaginationGap(createSeededRng(11))).toBe(planPaginationGap(createSeededRng(11)));
    expect(planPaginationGap(createSeededRng(11))).not.toBe(planPaginationGap(createSeededRng(12)));
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
    const mock = makeMock();
    const clock = makeClock();
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
      sleep: clock.sleep,
      rng: () => 0.5,
      now: clock.now,
    });

    const res = await handle("do", { steps: [{ key: "Tab" }, { key: "Tab" }, { key: "Tab" }], quiet: true });
    expect(res.ok).toBe(true);
    // triangular(0.5, 160, 420) = 290 with this rng.
    expect(clock.thinkPauses()).toEqual([290, 290]);
  });

  test("no pause after a wait step, and a fast step skips its pause", async () => {
    const mock = makeMock();
    const clock = makeClock();
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
      sleep: clock.sleep,
      rng: () => 0.5,
      now: clock.now,
    });

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
    const mock = makeMock({ readback: "v", locate: { Email: "e3", Name: "e4" } });
    const clock = makeClock();
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
      sleep: clock.sleep,
      rng: () => 0.5,
      now: clock.now,
    });

    const res = await handle("do", { fill: { Email: "v", Name: "v" }, quiet: true });
    expect(res.ok).toBe(true);
    expect(clock.thinkPauses()).toEqual([290]);
  });

  test("--fast and natural off add no pauses anywhere", async () => {
    const mock = makeMock();
    const clock = makeClock();
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
      sleep: clock.sleep,
      rng: () => 0.5,
      now: clock.now,
    });

    const fast = await handle("do", { steps: [{ key: "Tab" }, { key: "Tab" }], fast: true, quiet: true });
    expect(fast.ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);

    process.env["BROWSER_CONTROL_NATURAL"] = "off";
    const off = await handle("do", { steps: [{ key: "Tab" }, { key: "Tab" }], quiet: true });
    expect(off.ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);
  });
});

describe("post-nav dwell and pagination gap", () => {
  test("nav adds no sleep, reads add none, and the next input waits the dwell", async () => {
    const mock = makeMock({ chars: 4_000 });
    const clock = makeClock();
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
      sleep: clock.sleep,
      rng: () => 0.5,
      now: clock.now,
    });

    expect((await handle("nav", { url: "https://a.test/1" })).ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);

    expect((await handle("text", {})).ok).toBe(true);
    expect((await handle("snap", {})).ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);

    // dwell = 220 + 0.08 * 4000 * 1.025 = 548, nothing elapsed yet.
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps.at(0)).toBe(548);
  });

  test("dwell subtracts the time the agent already spent", async () => {
    const mock = makeMock({ chars: 4_000 });
    const clock = makeClock();
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
      sleep: clock.sleep,
      rng: () => 0.5,
      now: clock.now,
    });

    expect((await handle("nav", { url: "https://a.test/1" })).ok).toBe(true);
    clock.advance(300);
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps.at(0)).toBe(548 - 300);
  });

  test("a second same-host nav within 4 s waits out the pagination gap", async () => {
    const mock = makeMock({ chars: 4_000 });
    const clock = makeClock();
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
      sleep: clock.sleep,
      rng: () => 0.5,
      now: clock.now,
    });

    expect((await handle("nav", { url: "https://a.test/1" })).ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);

    // gap 2200 ms measured from the first nav at t=0, so this nav at t=500 owes 1700.
    clock.advance(500);
    expect((await handle("nav", { url: "https://a.test/2" })).ok).toBe(true);
    expect(clock.sleeps).toEqual([1_700]);

    // The dwell of the new page still applies before the next input.
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps).toEqual([1_700, 548, 60]);

    // Consumed: later inputs pay only their own key hold.
    const after = clock.sleeps.length;
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps.slice(after).every((ms) => ms <= 130)).toBe(true);
  });

  test("no gap for a different host, after 4 s, or with natural off", async () => {
    const mock = makeMock({ chars: 4_000 });
    const clock = makeClock();
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
      sleep: clock.sleep,
      rng: () => 0.5,
      now: clock.now,
    });

    expect((await handle("nav", { url: "https://a.test/1" })).ok).toBe(true);
    clock.advance(300);
    expect((await handle("nav", { url: "https://b.test/1" })).ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps.at(0)).toBe(548);

    // Same host again, but more than 4 s later.
    clock.sleeps.length = 0;
    clock.advance(4_500);
    expect((await handle("nav", { url: "https://b.test/2" })).ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);

    // Natural off: nav records nothing at all.
    process.env["BROWSER_CONTROL_NATURAL"] = "off";
    clock.sleeps.length = 0;
    expect((await handle("nav", { url: "https://b.test/3" })).ok).toBe(true);
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps).toHaveLength(0);
  });

  test("nav --fast skips the dwell", async () => {
    const mock = makeMock({ chars: 4_000 });
    const clock = makeClock();
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
      sleep: clock.sleep,
      rng: () => 0.5,
      now: clock.now,
    });

    expect((await handle("nav", { url: "https://a.test/1", fast: true })).ok).toBe(true);
    expect((await handle("key", { key: "Tab", quiet: true })).ok).toBe(true);
    expect(clock.sleeps.every((ms) => ms <= 130)).toBe(true);
  });

  test("nav takes the length from the attach-free probe, never an evaluate on an extension tab", async () => {
    const bcCalls: BcCallInput[] = [];
    const mock = makeMock({ chars: 4_000 });
    const clock = makeClock();
    const bcCall: BcCallFn = async (input) => {
      bcCalls.push(input);
      const values = input.steps.map((step) => {
        if (step.kind === "href") return "https://a.test/1";
        if (step.kind === "title") return "Page";
        if (step.kind !== "bc") return "";
        if (step.method === "chars") return 4_000;
        if (step.method === "text") return `# Page | https://a.test/1\n\n${"word ".repeat(600)}`;
        if (step.method === "query") return "";
        if (step.method === "settle") return "quiet";
        return "";
      });
      const kept = values.filter((_, i) => !input.steps[i]!.discard);
      return { value: input.join === undefined ? values.at(-1) : kept.join(input.join) };
    };
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
      bcCall,
      sleep: clock.sleep,
      rng: () => 0.5,
      now: clock.now,
    });

    expect((await handle("nav", { url: "https://a.test/1" }, "extension:42")).ok).toBe(true);
    // The char count rides inside the existing bc_call nav probe, so nothing attaches the debugger.
    expect(bcCalls.some((c) => c.steps.some((s) => s.kind === "bc" && s.method === "chars"))).toBe(true);
    expect(mock.calls.filter((c) => c.op === "evaluate")).toHaveLength(0);

    expect((await handle("key", { key: "Tab", quiet: true }, "extension:42")).ok).toBe(true);
    expect(clock.sleeps.at(0)).toBe(548);
  });

  test("the pagination clock starts at nav dispatch, not after a slow load", async () => {
    const clock = makeClock();
    let slowLoad = true;
    const mock = makeMock({
      chars: 4_000,
      onNavigate: () => {
        if (!slowLoad) return;
        slowLoad = false;
        clock.advance(1_000);
      },
    });
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
      sleep: clock.sleep,
      rng: () => 0.5,
      now: clock.now,
    });

    // Nav 1 dispatches at t=0 and finishes at t=1000; nav 2 dispatches at t=1500.
    expect((await handle("nav", { url: "https://a.test/1" })).ok).toBe(true);
    clock.advance(500);
    expect((await handle("nav", { url: "https://a.test/2" })).ok).toBe(true);
    // Gap 2200 ms from dispatch (t=0) leaves 700 ms, not 1700 as a post-load clock would.
    expect(clock.sleeps).toEqual([700]);
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
    const mock = makeMock({ chars: 4_000 });
    const clock = makeClock();
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
      sleep: clock.sleep,
      rng: () => 0.5,
      now: clock.now,
    });

    expect((await handle("nav", { url: "https://a.test/1" })).ok).toBe(true);
    clock.sleeps.length = 0;
    expect((await handle("hover", { ref: "e5" })).ok).toBe(true);
    expect(clock.sleeps.at(0)).toBe(548);
  });

  test("a malformed step is INPUT_INVALID, not a thrown TypeError", async () => {
    const mock = makeMock();
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, { now: () => 0 });
    const res = await handle("do", { steps: [null], quiet: true });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a failure");
    expect(res.error.code).toBe("INPUT_VALIDATION_FAILED");
    expect(res.error.message).toContain("INPUT_INVALID");
  });

  test("a fast step skips the nav dwell on that step", async () => {
    const mock = makeMock({ chars: 4_000 });
    const clock = makeClock();
    const handle = createPageHelperHandler(mock.invoke, undefined, undefined, {
      sleep: clock.sleep,
      rng: () => 0.5,
      now: clock.now,
    });

    expect((await handle("nav", { url: "https://a.test/1" })).ok).toBe(true);
    clock.sleeps.length = 0;
    // The fast step pays no dwell, and the `wait` after it is skipped by pacing, so nothing is owed.
    expect((await handle("do", { steps: [{ key: "Tab", fast: true }, { wait: "Ready" }], quiet: true })).ok).toBe(true);
    expect(clock.sleeps.filter((ms) => ms >= 220)).toEqual([]);
  });
});

describe("text --scroll pace", () => {
  const scrollPaceOf = (expr: string): { factors: number[]; pauses: number[] } | undefined => {
    const match = /"scrollPace":\{"factors":\[([^\]]*)\],"pauses":\[([^\]]*)\]\}/.exec(expr);
    if (!match) return undefined;
    const parse = (raw: string) => (raw.trim() === "" ? [] : raw.split(",").map(Number));
    return { factors: parse(match[1]!), pauses: parse(match[2]!) };
  };

  const lastScrollExpr = (mock: ReturnType<typeof makeMock>): string => {
    const expr = String(
      mock.calls.filter((c) => c.op === "evaluate").at(-1)?.input["expression"] ?? "",
    );
    return expr;
  };

  test("natural on plans jittered steps; --fast sends no plan and keeps the plain reader", async () => {
    const naturalMock = makeMock();
    const natural = createPageHelperHandler(naturalMock.invoke, undefined, undefined, {
      rng: createSeededRng(42),
      now: () => 0,
    });
    expect((await natural("text", { scroll: true })).ok).toBe(true);
    const plan = scrollPaceOf(lastScrollExpr(naturalMock));
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

    const fastMock = makeMock();
    const fast = createPageHelperHandler(fastMock.invoke, undefined, undefined, {
      rng: createSeededRng(42),
      now: () => 0,
    });
    expect((await fast("text", { scroll: true, fast: true })).ok).toBe(true);
    expect(scrollPaceOf(lastScrollExpr(fastMock))).toBeUndefined();
  });

  test("the in-page reader honors the provided plan and stays plain JavaScript", () => {
    expect(PAGE_HELPERS_SOURCE).toContain("opts.scrollPace");
    expect(PAGE_HELPERS_SOURCE).toContain("scrollPace.factors");
    expect(() => new Function(PAGE_HELPERS_SOURCE)).not.toThrow();
    // No debugger attach anywhere in the page helper.
    expect(PAGE_HELPERS_SOURCE).not.toContain("Runtime.enable");
  });

  test("the plan cycles past its 64 steps and the 200 px floor is fast-path only", () => {
    const source = PAGE_HELPERS_SOURCE;
    // Cycling, so a long read keeps its paced size and pause instead of dropping to 0.9x / 120 ms.
    expect(source).toContain("scrollIdx % fLen");
    expect(source).toContain("scrollIdx % pLen");
    // Paced steps use the planned length even in a short scroller; the floor stays in the fast path.
    expect(source).toContain("Number.isFinite(factor) ? Math.round(height * factor) : Math.max(200");
  });

  test("helpers v11 ships the attach-free chars reader and the extension copy matches", () => {
    expect(PAGE_HELPERS_VERSION).toBe(11);
    expect(PAGE_HELPERS_SOURCE).toContain("scrollRead, text, chars,");
    expect(() => new Function(PAGE_HELPERS_SOURCE)).not.toThrow();
    const shipped = readFileSync(new URL("../extension/page-helpers.js", import.meta.url), "utf8");
    expect(shipped).toBe(PAGE_HELPERS_SOURCE);
  });
});
