import { describe, expect, test } from "bun:test";
import type { InvokeResult } from "@agent-software/core";
import {
  buildChallengeProbeExpression,
  formatChallengeOutput,
  isSuspiciousSnapshot,
  matchProbeSelectorsFromRows,
  parseBcQueryRows,
  parseBcTextForProbe,
  type ChallengeProbe,
} from "../src/challenges";
import type { BcCallFn, BcCallInput } from "../src/backends/extension";
import { createPageHelperHandler } from "../src/page-runner";

type Call = { op: string; input: Record<string, unknown> };
const textOf = (res: InvokeResult) => (res.ok ? String((res.data as { value: unknown }).value) : res.error.message);

const LONG_BODY = "Normal article paragraph with real product details and documentation. ".repeat(40);

function cdpProbePayload(probe: ChallengeProbe): string {
  return JSON.stringify({ skip: false, probe });
}

function cdpSkipPayload(url = "https://normal.example/article"): string {
  return JSON.stringify({ skip: true, url });
}

/**
 * Fake CDP invoker that serves page-helper calls and returns scripted responses for the
 * bot-challenge probe expression (`buildChallengeProbeExpression`).
 */
function makeCdpHarness(options: {
  finalUrl?: string;
  postWaitUrl?: string;
  wall?: string;
  snapshotSequence?: string[];
  probeSequence?: Array<string | { error: string }>;
  diffSequence?: string[];
  stepUrls?: string[];
  locate?: Record<string, string>;
} = {}) {
  const calls: Call[] = [];
  const probeCalls: Call[] = [];
  const sleeps: number[] = [];
  let probeIdx = 0;
  let snapIdx = 0;
  let diffIdx = 0;
  let stepUrlIdx = 0;
  let waitedOnce = false;

  const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
    calls.push({ op, input });
    if (op === "get_browser_status") return { ok: true, data: { connected: true } };
    if (op === "navigate") return { ok: true, data: { loaded: true, frameId: "F1" } };
    if (op === "execute_cdp") return { ok: true, data: { result: {} } };
    if (op === "evaluate") {
      const expr = String(input["expression"] ?? "");
      // Challenge probe expression (contains probeSelectors / responseStatus, never __bc)
      if (expr.includes("responseStatus") && expr.includes("visibleSelectors")) {
        probeCalls.push({ op, input });
        const seq = options.probeSequence ?? [cdpSkipPayload(options.finalUrl)];
        const entry = seq[Math.min(probeIdx++, seq.length - 1)]!;
        if (typeof entry === "object" && "error" in entry) {
          return { ok: false, error: { code: "EXECUTION_FAILED", message: entry.error } };
        }
        return { ok: true, data: { value: entry } };
      }
      if (expr === "location.href") {
        const u = options.stepUrls?.[Math.min(stepUrlIdx, (options.stepUrls?.length ?? 1) - 1)] ?? options.finalUrl ?? "https://app.test/start";
        return { ok: true, data: { value: u } };
      }
      if (expr.includes("location.href, __bc.wall()")) {
        const u =
          waitedOnce && options.postWaitUrl
            ? options.postWaitUrl
            : options.stepUrls
              ? options.stepUrls[Math.min(stepUrlIdx++, options.stepUrls.length - 1)]!
              : (options.finalUrl ?? "https://app.test/page");
        const w = waitedOnce && options.postWaitUrl ? "" : (options.wall ?? "");
        return { ok: true, data: { value: `${u}\n${w}` } };
      }
      if (expr.includes("__bc.baseline")) return { ok: true, data: { value: options.finalUrl ?? "https://app.test/start" } };
      if (expr.includes("__bc.locate")) {
        const label = /__bc\.locate\("([^"]*)"/.exec(expr)?.[1] ?? "";
        return { ok: true, data: { value: options.locate?.[label] ?? "e1" } };
      }
      if (expr.includes("__bc.verifyRef")) return { ok: true, data: { value: "ok" } };
      if (expr.includes("__bc.point")) return { ok: true, data: { value: "100 100 visible" } };
      if (expr.includes("__bc.armInputProbe")) return { ok: true, data: { value: "armed" } };
      if (expr.includes("__bc.readInputProbe")) return { ok: true, data: { value: '{"mousedown":1,"mouseup":1}' } };
      if (expr.includes("__bc.diff")) {
        const seq = options.diffSequence ?? ['+ button "Next" [e2]'];
        return { ok: true, data: { value: seq[Math.min(diffIdx++, seq.length - 1)]! } };
      }
      if (expr.includes("__bc.snapshot")) {
        const seq = options.snapshotSequence ?? ['# Normal Page | https://app.test/\n- button "Save" [e1]'];
        return { ok: true, data: { value: seq[Math.min(snapIdx++, seq.length - 1)]! } };
      }
      return { ok: true, data: { value: "ok" } };
    }
    return { ok: true, data: {} };
  };

  const handle = createPageHelperHandler(invoke, undefined, undefined, {
    sleep: async (ms) => {
      sleeps.push(ms);
      waitedOnce = true;
    },
  });

  return { calls, probeCalls, sleeps, handle };
}

type FakeExtPage = {
  url: string;
  title: string;
  bodyText: string;
  truncatedTotal?: number;
  wall?: string;
  snapshot?: string;
  frames?: string[];
  scripts?: string[];
  selectorRows?: Array<Record<string, string>>;
  visibleSelectorRows?: Array<Record<string, string>>;
  hasAwsCaptcha?: boolean;
  httpStatus?: number;
};

/**
 * Fake extension harness: serves `bcCall` silently and records any `invoke("evaluate")` calls
 * so tests can prove normal pages never attach the debugger on extension tabs.
 */
function makeExtensionHarness(pages: FakeExtPage[], targetId = "extension:42") {
  const bcCalls: BcCallInput[] = [];
  const evalCalls: Call[] = [];
  const sleeps: number[] = [];
  let pageIdx = 0;

  const currentPage = () => pages[Math.min(pageIdx, pages.length - 1)]!;

  const formatRows = (sel: string, rows: Array<Record<string, string>>) =>
    [`# ${rows.length} row(s) for ${sel}`, ...rows.map((r) => JSON.stringify(r))].join("\n");

  const bcCall: BcCallFn = async (input) => {
    bcCalls.push(input);
    const p = currentPage();
    const values = input.steps.map((step) => {
      if (step.kind === "href") return p.url;
      if (step.kind === "title") return p.title;
      if (step.kind === "bc") {
        if (step.method === "settle") return "quiet";
        if (step.method === "wall") return p.wall ?? "";
        if (step.method === "snapshot") {
          return p.snapshot ?? `# ${p.title} | ${p.url}\n- button "Continue" [e1]`;
        }
        if (step.method === "text") {
          const trunc = p.truncatedTotal
            ? `\n# [truncated ${p.truncatedTotal - p.bodyText.length} of ${p.truncatedTotal} chars; narrow with --within <ref|css> or raise --max]`
            : "";
          return `# ${p.title} | ${p.url}\n\n${p.bodyText}${trunc}`;
        }
        if (step.method === "query") {
          const opts = (step.args?.[0] ?? {}) as { selector?: string; all?: boolean };
          const sel = String(opts.selector ?? "");
          if (sel === "iframe[src]") {
            return formatRows(sel, (p.frames ?? []).map((src) => ({ src })));
          }
          if (sel === "script[src]") {
            return formatRows(sel, (p.scripts ?? []).map((src) => ({ src })));
          }
          if (sel === "awswaf-captcha") {
            return formatRows(sel, p.hasAwsCaptcha ? [{ id: "" }] : []);
          }
          if (opts.all === false) {
            return formatRows(sel, p.visibleSelectorRows ?? []);
          }
          // Fast vendor selector check or full probeSelectors check
          return formatRows(sel, p.selectorRows ?? []);
        }
      }
      return "ok";
    });
    if (input.join !== undefined) {
      const kept = values.filter((_, i) => !input.steps[i]!.discard);
      return { value: kept.join(input.join) };
    }
    return { value: values[values.length - 1] };
  };

  const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
    if (op === "get_browser_status") {
      return {
        ok: true,
        data: {
          connected: true,
          backends: { active: "extension", extension: { available: true, activeTargetId: targetId } },
        },
      };
    }
    if (op === "navigate") {
      return { ok: true, data: { loaded: true, targetId, url: currentPage().url, title: currentPage().title, backend: "extension" } };
    }
    if (op === "evaluate") {
      evalCalls.push({ op, input });
      return { ok: true, data: { value: currentPage().httpStatus ?? 200 } };
    }
    return { ok: true, data: {} };
  };

  const handle = createPageHelperHandler(invoke, undefined, undefined, {
    bcCall,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (pageIdx < pages.length - 1) pageIdx++;
    },
  });

  return { bcCalls, evalCalls, sleeps, handle, advancePage: () => { if (pageIdx < pages.length - 1) pageIdx++; } };
}

describe("bot-challenge wiring: nav (CDP)", () => {
  test("non-interactive interstitial auto-waits (bounded), re-probes, and continues once cleared", async () => {
    const cfWaiting: ChallengeProbe = {
      url: "https://shop.example/items",
      title: "Just a moment...",
      text: "Checking if the site connection is secure",
      textLength: 41,
      selectors: ["#challenge-running"],
    };
    const cleared: ChallengeProbe = {
      url: "https://shop.example/items",
      title: "Catalog",
      text: LONG_BODY,
      textLength: LONG_BODY.length,
    };

    const h = makeCdpHarness({
      finalUrl: "https://shop.example/items",
      postWaitUrl: "https://shop.example/items",
      probeSequence: [cdpProbePayload(cfWaiting), cdpProbePayload(cfWaiting), cdpProbePayload(cleared)],
      snapshotSequence: ['# Catalog | https://shop.example/items\n- link "Shoes" [e1]'],
    });

    const res = await h.handle("nav", { url: "https://shop.example/items", snap: true });
    expect(res.ok).toBe(true);
    expect(h.sleeps).toEqual([500, 500]);
    expect(h.probeCalls).toHaveLength(3);
    expect(textOf(res)).not.toContain("CHALLENGE:");
    expect(textOf(res)).not.toContain("BLOCKED:");
    expect(textOf(res)).toContain('- link "Shoes" [e1]');
  });

  test("non-interactive interstitial that never clears stops after ~8s bound and reports CHALLENGE:", async () => {
    const cfWaiting: ChallengeProbe = {
      url: "https://shop.example/items",
      title: "Checking your browser",
      text: "Please wait while we verify your browser...",
      textLength: 43,
      selectors: ["#challenge-running"],
    };
    const h = makeCdpHarness({
      finalUrl: "https://shop.example/items",
      probeSequence: [cdpProbePayload(cfWaiting)],
    });

    const res = await h.handle("nav", { url: "https://shop.example/items" });
    expect(res.ok).toBe(true);
    const totalSlept = h.sleeps.reduce((a, b) => a + b, 0);
    expect(totalSlept).toBe(8_000);
    expect(textOf(res)).toStartWith("CHALLENGE: cloudflare ");
    expect(textOf(res)).toContain('remedy: run handoff "');
  });

  test("non-interactive interstitial that escalates to Turnstile interactive stops waiting immediately", async () => {
    const cfWaiting: ChallengeProbe = {
      url: "https://shop.example/items",
      title: "Just a moment...",
      text: "Checking your browser",
      selectors: ["#challenge-running"],
    };
    const cfInteractive: ChallengeProbe = {
      url: "https://shop.example/items",
      title: "Just a moment...",
      text: "Verify you are human by completing the action below.",
      selectors: [".cf-turnstile"],
      visibleSelectors: [".cf-turnstile"],
    };

    const h = makeCdpHarness({
      finalUrl: "https://shop.example/items",
      probeSequence: [cdpProbePayload(cfWaiting), cdpProbePayload(cfInteractive)],
    });

    const res = await h.handle("nav", { url: "https://shop.example/items" });
    expect(res.ok).toBe(true);
    expect(h.sleeps).toEqual([500]);
    expect(textOf(res)).toStartWith("CHALLENGE: cloudflare interactive");
    expect(textOf(res)).toContain('remedy: run handoff "Solve the security check on https://shop.example, then continue"');
  });

  test("interactive challenge (reCAPTCHA/hCaptcha/Turnstile) returns CHALLENGE: + remedy immediately with no retries", async () => {
    const recaptcha: ChallengeProbe = {
      url: "https://portal.example/search",
      title: "Security check",
      text: "Our systems have detected unusual traffic from your computer network.",
      frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=abc"],
    };
    const h = makeCdpHarness({
      finalUrl: "https://portal.example/search",
      probeSequence: [cdpProbePayload(recaptcha)],
    });

    const res = await h.handle("nav", { url: "https://portal.example/search", snap: true });
    expect(res.ok).toBe(true);
    expect(h.sleeps).toHaveLength(0);
    expect(h.probeCalls).toHaveLength(1);
    expect(textOf(res)).toStartWith("CHALLENGE: recaptcha ");
    expect(textOf(res)).toContain('remedy: run handoff "Solve the security check on https://portal.example, then continue"');
    // Must not run snapshot after detecting an interactive challenge wall
    expect(h.calls.some((c) => c.op === "evaluate" && String(c.input["expression"]).includes("__bc.snapshot"))).toBe(false);
  });

  test("block page returns BLOCKED: <vendor> and hard-stops with zero retries", async () => {
    const blocked: ChallengeProbe = {
      url: "https://store.example/",
      title: "Attention Required! | Cloudflare",
      text: "Sorry, you have been blocked. You are unable to access store.example. Cloudflare Ray ID: 123",
      selectors: ["#cf-error-details"],
    };
    const h = makeCdpHarness({
      finalUrl: "https://store.example/",
      probeSequence: [cdpProbePayload(blocked)],
    });

    const res = await h.handle("nav", { url: "https://store.example/", snap: true });
    expect(res.ok).toBe(false);
    expect(h.sleeps).toHaveLength(0);
    expect(h.probeCalls).toHaveLength(1);
    expect(textOf(res)).toStartWith("BLOCKED: cloudflare ");
    expect(textOf(res)).toContain("Do not retry");
    // Must not call snapshot or retry navigate
    expect(h.calls.filter((c) => c.op === "navigate")).toHaveLength(1);
    expect(h.calls.some((c) => c.op === "evaluate" && String(c.input["expression"]).includes("__bc.snapshot"))).toBe(false);
  });
});

describe("bot-challenge wiring: snap and do (CDP)", () => {
  test("snap on a normal page does ZERO extra work (no probe, no wait)", async () => {
    const h = makeCdpHarness({
      snapshotSequence: ['# Dashboard | https://app.test/dash\n- button "New project" [e1]\n- link "Settings" [e2]'],
    });
    const res = await h.handle("snap", {});
    expect(res.ok).toBe(true);
    expect(h.probeCalls).toHaveLength(0);
    expect(h.sleeps).toHaveLength(0);
    expect(textOf(res)).toContain('- button "New project" [e1]');
  });

  test("snap on a page that looks like a challenge reports CHALLENGE: or BLOCKED:, or auto-waits and refreshes", async () => {
    // 1. Interactive hCaptcha wall on snap
    const hInteractive = makeCdpHarness({
      snapshotSequence: ["# Security check | https://app.test/gate\n# WALL: captcha. Stop and hand this tab to the user; do not solve or bypass it."],
      probeSequence: [
        cdpProbePayload({
          url: "https://app.test/gate",
          title: "Security check",
          text: "Please verify you are a human",
          frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html"],
        }),
      ],
    });
    const r1 = await hInteractive.handle("snap", {});
    expect(r1.ok).toBe(true);
    expect(textOf(r1)).toStartWith("CHALLENGE: hcaptcha ");
    expect(textOf(r1)).toContain('remedy: run handoff "Solve the security check on https://app.test, then continue"');
    expect(hInteractive.sleeps).toHaveLength(0);

    // 2. Non-interactive interstitial on snap clears and refreshes snapshot
    const hAutoWait = makeCdpHarness({
      snapshotSequence: [
        "# Just a moment... | https://app.test/gate",
        '# Home | https://app.test/home\n- button "Shop now" [e1]',
      ],
      probeSequence: [
        cdpProbePayload({
          url: "https://app.test/gate",
          title: "Just a moment...",
          text: "Checking your browser",
          selectors: ["#challenge-running"],
        }),
        cdpSkipPayload("https://app.test/home"),
      ],
    });
    const r2 = await hAutoWait.handle("snap", {});
    expect(r2.ok).toBe(true);
    expect(hAutoWait.sleeps).toEqual([500]);
    expect(textOf(r2)).toContain('- button "Shop now" [e1]');
    expect(textOf(r2)).not.toContain("CHALLENGE:");

    // 3. Hard block on snap
    const hBlock = makeCdpHarness({
      snapshotSequence: ["# Access Denied | https://app.test/secret"],
      probeSequence: [
        cdpProbePayload({
          url: "https://app.test/secret",
          title: "Access Denied",
          text: 'Access Denied\nYou don\'t have permission to access "https://app.test/secret" on this server.\nReference #18.abc.1',
        }),
      ],
    });
    const r3 = await hBlock.handle("snap", {});
    expect(r3.ok).toBe(false);
    expect(textOf(r3)).toStartWith("BLOCKED: akamai ");
    expect(hBlock.sleeps).toHaveLength(0);
  });

  test("do steps that do NOT navigate do ZERO challenge probes", async () => {
    const h = makeCdpHarness({
      finalUrl: "https://app.test/form",
      stepUrls: ["https://app.test/form", "https://app.test/form"],
      diffSequence: ['+ text "Saved"'],
      locate: { Save: "e1", Close: "e2" },
    });
    const res = await h.handle("do", { steps: [{ click: "Save" }, { click: "Close" }] });
    expect(res.ok).toBe(true);
    expect(h.probeCalls).toHaveLength(0);
    expect(h.sleeps).toHaveLength(0);
  });

  test("do step that navigates into a non-interactive interstitial waits, clears, and finishes remaining steps", async () => {
    const h = makeCdpHarness({
      finalUrl: "https://app.test/step1",
      stepUrls: ["https://app.test/step2"],
      postWaitUrl: "https://app.test/step2",
      probeSequence: [
        cdpProbePayload({
          url: "https://app.test/step2",
          title: "Just a moment...",
          text: "Checking your browser",
          selectors: ["#challenge-running"],
        }),
        cdpSkipPayload("https://app.test/step2"),
      ],
      locate: { Next: "e1", Finish: "e2" },
    });

    const res = await h.handle("do", { steps: [{ click: "Next" }, { click: "Finish" }] });
    expect(res.ok).toBe(true);
    expect(h.sleeps).toEqual([500]);
    expect(textOf(res)).toContain("1. click e1");
    expect(textOf(res)).toContain("2. click e2");
  });

  test("do step that navigates into an interactive challenge or block stops immediately and skips remaining steps", async () => {
    const hChallenge = makeCdpHarness({
      finalUrl: "https://app.test/step1",
      stepUrls: ["https://app.test/verify"],
      probeSequence: [
        cdpProbePayload({
          url: "https://app.test/verify",
          title: "Just a moment...",
          text: "Verify you are human by completing the action below.",
          selectors: [".cf-turnstile"],
          visibleSelectors: [".cf-turnstile"],
        }),
      ],
      locate: { Submit: "e1", Next: "e2" },
    });
    const r1 = await hChallenge.handle("do", { steps: [{ click: "Submit" }, { click: "Next" }] });
    expect(r1.ok).toBe(false);
    expect(textOf(r1)).toStartWith("CHALLENGE: cloudflare interactive");
    expect(textOf(r1)).toContain('remedy: run handoff "');
    expect(textOf(r1)).toContain("# STOPPED:");
    expect(textOf(r1)).toContain("1 step(s) not run");
    expect(textOf(r1)).not.toContain("2. click");

    const hBlock = makeCdpHarness({
      finalUrl: "https://app.test/step1",
      stepUrls: ["https://app.test/denied"],
      probeSequence: [
        cdpProbePayload({
          url: "https://app.test/denied",
          status: 403,
          title: "403 Forbidden",
          text: "Forbidden",
        }),
      ],
      locate: { Submit: "e1", Next: "e2" },
    });
    const r2 = await hBlock.handle("do", { steps: [{ click: "Submit" }, { click: "Next" }] });
    expect(r2.ok).toBe(false);
    expect(textOf(r2)).toStartWith("BLOCKED: generic ");
    expect(textOf(r2)).toContain("1 step(s) not run");
    expect(hBlock.sleeps).toHaveLength(0);
  });
});

describe("bot-challenge wiring: extension tabs (silent bc_call tier)", () => {
  test("normal long page exits on the cheap silent check with ZERO full probe and ZERO debugger attach", async () => {
    const ext = makeExtensionHarness([
      {
        url: "https://docs.example/guide",
        title: "Developer Guide",
        bodyText: LONG_BODY.slice(0, 3000),
        truncatedTotal: 5_000,
      },
    ]);

    const res = await ext.handle("nav", { url: "https://docs.example/guide" }, "extension:42");
    expect(res.ok).toBe(true);
    expect(ext.evalCalls).toHaveLength(0); // Never attached chrome.debugger
    expect(ext.sleeps).toHaveLength(0);
    // Only 2 bc_calls: nav's settle+href+wall, and the 1 cheap silent gate (NO iframe/script/21-selector call!)
    expect(ext.bcCalls).toHaveLength(2);
    expect(
      ext.bcCalls.some((c) => c.steps.some((s) => s.kind === "bc" && s.method === "query" && JSON.stringify(s.args).includes("iframe[src]"))),
    ).toBe(false);
  });

  test("normal short page stays completely silent (ZERO debugger attach, ZERO waits)", async () => {
    const ext = makeExtensionHarness([
      {
        url: "http://127.0.0.1:49260/next",
        title: "Next",
        bodyText: "Next",
      },
    ]);

    const res = await ext.handle("nav", { url: "http://127.0.0.1:49260/next" }, "extension:42");
    expect(res.ok).toBe(true);
    expect(ext.evalCalls).toHaveLength(0);
    expect(ext.sleeps).toHaveLength(0);
    expect(textOf(res)).not.toContain("CHALLENGE:");
    expect(textOf(res)).not.toContain("BLOCKED:");
  });

  test("detects non-interactive, interactive, and block on extension tabs without new extension ops", async () => {
    // 1. Non-interactive -> clears on 2nd poll
    const extWait = makeExtensionHarness([
      {
        url: "https://shop.example/",
        title: "Just a moment...",
        bodyText: "Checking if the site connection is secure",
        selectorRows: [{ id: "challenge-running", cls: "", src: "", title: "" }],
      },
      {
        url: "https://shop.example/",
        title: "Shop Home",
        bodyText: LONG_BODY.slice(0, 3000),
        truncatedTotal: 4_000,
      },
    ]);
    const rWait = await extWait.handle("nav", { url: "https://shop.example/" }, "extension:42");
    expect(rWait.ok).toBe(true);
    expect(extWait.sleeps).toEqual([500]);
    expect(extWait.evalCalls).toHaveLength(0);
    expect(textOf(rWait)).not.toContain("CHALLENGE:");

    // 2. Interactive Turnstile
    const extTurnstile = makeExtensionHarness([
      {
        url: "https://shop.example/",
        title: "Just a moment...",
        bodyText: "Verify you are human by completing the action below.",
        selectorRows: [{ id: "", cls: "cf-turnstile", src: "", title: "" }],
        visibleSelectorRows: [{ id: "", cls: "cf-turnstile", src: "", title: "" }],
      },
    ]);
    const rTurnstile = await extTurnstile.handle("nav", { url: "https://shop.example/" }, "extension:42");
    expect(rTurnstile.ok).toBe(true);
    expect(extTurnstile.sleeps).toHaveLength(0);
    expect(extTurnstile.evalCalls).toHaveLength(0);
    expect(textOf(rTurnstile)).toStartWith("CHALLENGE: cloudflare interactive");
    expect(textOf(rTurnstile)).toContain('remedy: run handoff "Solve the security check on https://shop.example, then continue"');

    // 3. Hard block (Cloudflare)
    const extBlock = makeExtensionHarness([
      {
        url: "https://shop.example/",
        title: "Attention Required! | Cloudflare",
        bodyText: "Sorry, you have been blocked. Cloudflare Ray ID: abc",
        selectorRows: [{ id: "cf-error-details", cls: "", src: "", title: "" }],
      },
    ]);
    const rBlock = await extBlock.handle("nav", { url: "https://shop.example/" }, "extension:42");
    expect(rBlock.ok).toBe(false);
    expect(extBlock.sleeps).toHaveLength(0);
    expect(extBlock.evalCalls).toHaveLength(0);
    expect(textOf(rBlock)).toStartWith("BLOCKED: cloudflare ");
  });
});

describe("probe expression & pure helpers", () => {
  test("buildChallengeProbeExpression never references __bc and skips normal long pages in-page", () => {
    const expr = buildChallengeProbeExpression();
    expect(expr).not.toMatch(/\b__bc\b/);

    let queryAllCount = 0;
    const prev = {
      document: (globalThis as any).document,
      location: (globalThis as any).location,
      performance: (globalThis as any).performance,
      getComputedStyle: (globalThis as any).getComputedStyle,
    };
    try {
      (globalThis as any).location = { href: "https://docs.example/long" };
      (globalThis as any).performance = { getEntriesByType: () => [{ responseStatus: 200 }] };
      (globalThis as any).getComputedStyle = () => ({ display: "block", visibility: "visible" });
      (globalThis as any).document = {
        title: "Documentation",
        body: { innerText: LONG_BODY },
        querySelector: () => null,
        querySelectorAll: () => {
          queryAllCount++;
          return [];
        },
      };
      const skipped = JSON.parse(new Function(`return ${expr}`)());
      expect(skipped).toEqual({ skip: true, url: "https://docs.example/long" });
      expect(queryAllCount).toBe(0);

      // Short Cloudflare interstitial runs full probe and captures visible selectors + status
      const fakeEl = { getBoundingClientRect: () => ({ width: 300, height: 65 }) };
      (globalThis as any).performance = { getEntriesByType: () => [{ responseStatus: 403 }] };
      (globalThis as any).document = {
        title: "Just a moment...",
        body: { innerText: "Verify you are human by completing the action below." },
        querySelector: (s: string) => (s.includes("#challenge-running") ? fakeEl : null),
        querySelectorAll: (s: string) => (s === ".cf-turnstile" || s === "#challenge-running" ? [fakeEl] : []),
      };
      const full = JSON.parse(new Function(`return ${expr}`)());
      expect(full.skip).toBe(false);
      expect(full.probe.status).toBe(403);
      expect(full.probe.selectors).toContain(".cf-turnstile");
      expect(full.probe.visibleSelectors).toContain(".cf-turnstile");
    } finally {
      Object.assign(globalThis, prev);
    }
  });

  test("parseBcTextForProbe, parseBcQueryRows, matchProbeSelectorsFromRows, isSuspiciousSnapshot, formatChallengeOutput", () => {
    const parsed = parseBcTextForProbe(
      "# Docs | https://a.test/\n\nHello world\n# [truncated 2000 of 5000 chars; narrow with --within <ref|css> or raise --max]",
    );
    expect(parsed).toEqual({ text: "Hello world", textLength: 5000 });

    const rows = parseBcQueryRows('# 2 row(s) for x\n{"id":"px-captcha","cls":"cf-turnstile","src":"","title":""}\n{"id":"main-iframe","cls":"","src":"/_Incapsula_Resource?x","title":""}');
    const sels = matchProbeSelectorsFromRows(rows, true);
    expect(sels).toContain("#px-captcha");
    expect(sels).toContain("[id^='px-captcha']");
    expect(sels).toContain(".cf-turnstile");
    expect(sels).toContain("#main-iframe[src*='_Incapsula_Resource']");
    expect(sels).toContain("awswaf-captcha");

    expect(isSuspiciousSnapshot('# Parity Fixture | http://127.0.0.1/\n- button "Submit" [e1]')).toBe(false);
    expect(isSuspiciousSnapshot("# Just a moment... | https://a.test/\n- link \"Cloudflare\" [e1]")).toBe(true);
    expect(isSuspiciousSnapshot("# Page | https://a.test/\n# snap diff (5 refs unchanged)")).toBe(false);

    const out = formatChallengeOutput(
      { vendor: "cloudflare", kind: "interactive", reason: "title: Just a moment..." },
      "https://shop.example/cart",
    );
    expect(out).toStartWith("CHALLENGE: cloudflare ");
    expect(out).toContain('remedy: run handoff "Solve the security check on https://shop.example, then continue"');
  });
});

describe("script: page.handoff(message, {timeout})", () => {
  test("calls the existing handoff path on extension tabs and resolves with 'handoff: done'", async () => {
    let startedId = "";
    const extCalls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const waitInputs: Array<Record<string, unknown>> = [];

    const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
      if (op === "read_events") return { ok: true, data: { events: [] } };
      if (op === "wait_for_event") {
        waitInputs.push(input);
        return {
          ok: true,
          data: {
            found: true,
            event: { method: "bc.handoffDone", params: { tabId: 42, handoffId: startedId } },
            timedOut: false,
          },
        };
      }
      return { ok: true, data: {} };
    };
    const extensionRequest = async (op: string, params: Record<string, unknown> = {}) => {
      extCalls.push({ op, params });
      if (op === "handoff_start") startedId = String(params["handoffId"] ?? "");
      return { ok: true, tabId: 42, handoffId: startedId };
    };

    const handle = createPageHelperHandler(invoke, undefined, undefined, { extensionRequest });
    const res = await handle(
      "script",
      {
        code: `const r = await page.handoff("Solve the CAPTCHA", { timeout: 15 }); return { result: r };`,
      },
      "extension:42",
    );

    expect(res.ok).toBe(true);
    expect(textOf(res)).toContain('"result": "handoff: done"');
    expect(extCalls).toEqual([
      {
        op: "handoff_start",
        params: { targetId: "extension:42", message: "Solve the CAPTCHA", handoffId: startedId },
      },
    ]);
    expect(waitInputs).toHaveLength(1);
    expect(waitInputs[0]!["timeoutMs"] as number).toBeGreaterThan(14_000);
    expect(waitInputs[0]!["timeoutMs"] as number).toBeLessThanOrEqual(15_000);
  });

  test("rejects in script on HANDOFF_TIMEOUT and clears the overlay", async () => {
    const extCalls: string[] = [];
    const invoke = async (op: string): Promise<InvokeResult> => {
      if (op === "read_events") return { ok: true, data: { events: [] } };
      if (op === "wait_for_event") return { ok: true, data: { found: false, timedOut: true, waitedMs: 2_000 } };
      return { ok: true, data: {} };
    };
    const extensionRequest = async (op: string) => {
      extCalls.push(op);
      return { ok: true };
    };

    const handle = createPageHelperHandler(invoke, undefined, undefined, { extensionRequest });
    const res = await handle(
      "script",
      { code: `await page.handoff("Sign in", { timeout: 2 });` },
      "extension:42",
    );

    expect(res.ok).toBe(false);
    expect(textOf(res)).toContain("HANDOFF_TIMEOUT: handoff timed out after 2s");
    expect(textOf(res)).toContain("#1 handoff FAIL");
    expect(extCalls).toEqual(["handoff_start", "handoff_clear"]);
  });

  test("rejects on non-extension tabs with INPUT_INVALID", async () => {
    const invoke = async (op: string): Promise<InvokeResult> => {
      if (op === "get_browser_status") return { ok: true, data: { connected: true } };
      return { ok: true, data: {} };
    };
    const handle = createPageHelperHandler(invoke);
    const res = await handle("script", { code: `await page.handoff("Sign in", { timeout: 5 });` });
    expect(res.ok).toBe(false);
    expect(textOf(res)).toContain("INPUT_INVALID: handoff requires an extension tab");
  });

  test("pauses the script timeout while waiting on page.handoff so human wait does not trigger SCRIPT_TIMEOUT", async () => {
    let startedId = "";
    const invoke = async (op: string): Promise<InvokeResult> => {
      if (op === "read_events") return { ok: true, data: { events: [] } };
      if (op === "wait_for_event") {
        // Wait longer than the 1000ms script timeout!
        await new Promise((r) => setTimeout(r, 1_150));
        return {
          ok: true,
          data: {
            found: true,
            event: { method: "bc.handoffDone", params: { tabId: 42, handoffId: startedId } },
            timedOut: false,
          },
        };
      }
      return { ok: true, data: {} };
    };
    const extensionRequest = async (op: string, params: Record<string, unknown> = {}) => {
      if (op === "handoff_start") startedId = String(params["handoffId"] ?? "");
      return { ok: true };
    };

    const handle = createPageHelperHandler(invoke, undefined, undefined, { extensionRequest });
    const res = await handle(
      "script",
      {
        timeoutMs: 1_000,
        code: `const done = await page.handoff("Take your time", { timeout: 5 }); return done;`,
      },
      "extension:42",
    );
    expect(res.ok).toBe(true);
    expect(textOf(res)).toBe("handoff: done");
  });
});
