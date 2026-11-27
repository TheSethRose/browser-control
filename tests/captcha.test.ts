import { describe, expect, test } from "bun:test";
import type { InvokeResult } from "@agent-software/core";
import type { ChallengeDetection, ChallengeProbe } from "../src/challenges";
import { formatCaptchaReport, widgetTypeOf, type CaptchaStatus } from "../src/captcha";
import { createPageHelperHandler } from "../src/page-runner";
import type { BcCallInput } from "../src/backends/extension";

const textOf = (res: InvokeResult): string =>
  res.ok ? String((res.data as { value: unknown }).value) : res.error.message;

/** Fill the non-signal fields so each case names only what it is about. */
function probe(overrides: Partial<ChallengeProbe> = {}): ChallengeProbe {
  return {
    url: "https://shop.example/",
    title: "",
    text: "",
    frameUrls: [],
    scriptSrcs: [],
    selectors: [],
    visibleSelectors: [],
    ...overrides,
  };
}

function detection(overrides: Partial<ChallengeDetection> = {}): ChallengeDetection {
  return { vendor: "recaptcha", kind: "interactive", reason: "iframe /recaptcha/anchor", ...overrides };
}

describe("widgetTypeOf", () => {
  test("vendor map: checkbox-type widgets, slider, image", () => {
    expect(widgetTypeOf(detection({ vendor: "cloudflare" }))).toBe("checkbox");
    expect(widgetTypeOf(detection({ vendor: "recaptcha" }))).toBe("checkbox");
    expect(widgetTypeOf(detection({ vendor: "hcaptcha" }))).toBe("checkbox");
    expect(widgetTypeOf(detection({ vendor: "perimeterx" }))).toBe("slider");
    expect(widgetTypeOf(detection({ vendor: "datadome" }))).toBe("image");
    expect(widgetTypeOf(detection({ vendor: "aws-waf" }))).toBe("unknown");
    expect(widgetTypeOf(detection({ vendor: "generic" }))).toBe("unknown");
  });

  test("reason text wins over the vendor map", () => {
    expect(widgetTypeOf(detection({ vendor: "generic", reason: "text: press & hold" }))).toBe("slider");
    expect(widgetTypeOf(detection({ vendor: "generic", reason: "text: audio confirmation" }))).toBe("audio");
    expect(widgetTypeOf(detection({ vendor: "generic", reason: "text: select the squares" }))).toBe("image");
    expect(widgetTypeOf(detection({ vendor: "generic", reason: "text: watch the video" }))).toBe("video");
  });

  test("non-interactive and block detections have no widget", () => {
    expect(widgetTypeOf(detection({ kind: "non-interactive" }))).toBe("unknown");
    expect(widgetTypeOf(detection({ kind: "block" }))).toBe("unknown");
  });
});

describe("formatCaptchaReport", () => {
  const baseInteractive: CaptchaStatus = {
    status: "interactive",
    waited: false,
    url: "https://shop.example/",
    detection: detection(),
  };

  test("interactive: reports vendor, origin, widget hint, and verify hint", () => {
    const out = formatCaptchaReport(baseInteractive);
    expect(out).toContain("CAPTCHA: recaptcha interactive on https://shop.example");
    expect(out).toContain("widget (hint): checkbox");
    expect(out).toContain("verify: solve_captcha --verify");
  });

  test("verify mode says still present and keeps the verify hint", () => {
    const out = formatCaptchaReport(baseInteractive, true);
    expect(out).toContain("CAPTCHA verify: recaptcha interactive");
    expect(out).toContain("status: still present");
    expect(out).toContain("verify: solve_captcha --verify");
  });

  test("clear: no challenge on the origin", () => {
    const out = formatCaptchaReport({ status: "clear", waited: true, url: "https://shop.example/items" });
    expect(out).toBe("CAPTCHA: clear — no challenge detected on https://shop.example");
  });

  test("clear in verify mode", () => {
    const out = formatCaptchaReport({ status: "clear", waited: true, url: "https://shop.example/" }, true);
    expect(out).toBe("CAPTCHA verify: clear — no challenge detected on https://shop.example");
  });

  test("block: refuses and stops the agent", () => {
    const out = formatCaptchaReport({
      status: "block",
      waited: false,
      url: "https://blocked.example/",
      detection: detection({ vendor: "cloudflare", kind: "block", reason: "text: Sorry, you have been blocked" }),
    });
    expect(out).toContain("BLOCKED: cloudflare refused the visit on https://blocked.example");
    expect(out).toContain("Stop and tell the user");
  });

  test("unknown: the probe failed", () => {
    const out = formatCaptchaReport({ status: "unknown", waited: false });
    expect(out).toContain("unknown");
    expect(out).toContain("snap");
  });

  test("non-interactive: wait, re-verify, or hand off", () => {
    const out = formatCaptchaReport({
      status: "non-interactive-timeout",
      waited: true,
      url: "https://shop.example/",
      detection: detection({ vendor: "cloudflare", kind: "non-interactive", reason: "title: Just a moment..." }),
    });
    expect(out).toContain("cloudflare non-interactive on https://shop.example");
    expect(out).toContain("did not auto-clear");
    expect(out).toContain("solve_captcha --verify");
  });

  test("the reason is page content in its own boundary, never mixed with tool guidance", () => {
    const pageBits = [
      { kind: "block" as const, vendor: "generic" as const, reason: "status 403, title: Access Denied" },
      { kind: "interactive" as const, vendor: "recaptcha" as const, reason: "iframe https://www.google.com/recaptcha/api2/anchor#?k=x" },
      { kind: "non-interactive" as const, vendor: "cloudflare" as const, reason: "title: Just a moment..." },
    ];
    for (const detection of pageBits) {
      const status =
        detection.kind === "non-interactive" ? ("non-interactive-timeout" as const)
        : detection.kind === "interactive" ? ("interactive" as const)
        : ("block" as const);
      for (const verify of [false, true]) {
        const out = formatCaptchaReport({ status, waited: false, url: "https://shop.example/", detection }, verify);
        // The reason is not inline on the first line — it lives in its own boundary.
        expect(out.split("\n")[0]).not.toContain(detection.reason);
        expect(out).toContain("<<<UNTRUSTED_PAGE_CONTENT");
        expect(out).toContain("reason: ");
        expect(out).toContain("<<<END_UNTRUSTED_PAGE_CONTENT");
      }
    }
  });

  test("never throws on garbage input", () => {
    expect(() => formatCaptchaReport({ status: "unknown", waited: false })).not.toThrow();
    expect(() => formatCaptchaReport({ status: "clear", waited: false, url: "not a url" })).not.toThrow();
    expect(() => formatCaptchaReport({ status: "unknown", waited: false, url: "https://ok.example/" })).not.toThrow();
  });
});

/**
 * Page-runner wiring: a fake CDP invoker serves the challenge probe expression, so the
 * `solve_captcha` case runs through the real detection engine.
 */
function cdpHarness(probePayload: string) {
  const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
  const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
    calls.push({ op, input });
    if (op === "get_browser_status") return { ok: true, data: { connected: true } };
    if (op === "evaluate") {
      const expr = String(input["expression"] ?? "");
      if (expr.includes("responseStatus") && expr.includes("visibleSelectors")) {
        return { ok: true, data: { value: probePayload } };
      }
      return { ok: true, data: { value: "ok" } };
    }
    return { ok: true, data: {} };
  };
  const handle = createPageHelperHandler(invoke, undefined, undefined, { sleep: async () => {} });
  return { calls, handle };
}

const recaptchaProbe = JSON.stringify({
  skip: false,
  probe: probe({
    url: "https://shop.example/",
    title: "Shop",
    text: "Verify you are human to continue",
    textLength: 34,
    frameUrls: ["https://www.google.com/recaptcha/api2/anchor#?k=x"],
    selectors: [".g-recaptcha"],
  }),
});

describe("solve_captcha (page-runner)", () => {
  test("reports an interactive challenge with the widget hint", async () => {
    const h = cdpHarness(recaptchaProbe);
    const res = await h.handle("solve_captcha", {});
    expect(res.ok).toBe(true);
    const out = textOf(res);
    expect(out).toContain("recaptcha interactive");
    expect(out).toContain("widget (hint): checkbox");
    expect(out).toContain("verify: solve_captcha --verify");
  });

  test("verify mode reports the challenge still present", async () => {
    const h = cdpHarness(recaptchaProbe);
    const res = await h.handle("solve_captcha", { verify: true });
    expect(res.ok).toBe(true);
    const out = textOf(res);
    expect(out).toContain("CAPTCHA verify: recaptcha interactive");
    expect(out).toContain("status: still present");
  });

  test("a normal page reports clear", async () => {
    const h = cdpHarness(JSON.stringify({ skip: true, url: "https://normal.example/" }));
    const res = await h.handle("solve_captcha", {});
    expect(res.ok).toBe(true);
    expect(textOf(res)).toBe("CAPTCHA: clear — no challenge detected on https://normal.example");
  });

  test("a hard-blocked page reports BLOCKED and does not solve", async () => {
    const h = cdpHarness(
      JSON.stringify({
        skip: false,
        probe: probe({
          url: "https://blocked.example/",
          title: "Access Denied",
          status: 403,
          text: "Access Denied\nYou don't have permission to access this page.",
          textLength: 300,
        }),
      }),
    );
    const res = await h.handle("solve_captcha", {});
    expect(res.ok).toBe(true);
    const out = textOf(res);
    expect(out).toContain("BLOCKED:");
  });

  test("verify mode on a clear page says cleared", async () => {
    const h = cdpHarness(JSON.stringify({ skip: true, url: "https://normal.example/" }));
    const res = await h.handle("solve_captcha", { verify: true });
    expect(res.ok).toBe(true);
    expect(textOf(res)).toBe("CAPTCHA verify: clear — no challenge detected on https://normal.example");
  });

  test("verify mode on a page the probe cannot read reports unknown", async () => {
    const h = cdpHarness("not-json");
    const res = await h.handle("solve_captcha", { verify: true });
    expect(res.ok).toBe(true);
    expect(textOf(res)).toContain("unknown");
    expect(textOf(res)).not.toContain("clear");
  });

  test("an unreadable CDP page reports unknown, never clear", async () => {
    const h = cdpHarness("not-json");
    const res = await h.handle("solve_captcha", {});
    expect(res.ok).toBe(true);
    expect(textOf(res)).toContain("unknown");
    expect(textOf(res)).not.toContain("clear");
  });
});

/** Extension harness: serves the silent bcCall tier, records which steps ran. */
function extensionHarness(page: {
  url: string;
  title: string;
  bodyText: string;
  frames?: string[];
  scripts?: string[];
  selectorRows?: Array<Record<string, string>>;
  visibleSelectorRows?: Array<Record<string, string>>;
  hasAwsCaptcha?: boolean;
  /** Fail the quick probe (simulates an unreadable page). */
  quickError?: boolean;
  /** Return a quick readback that is missing fields (simulates an incomplete read). */
  quickShort?: boolean;
}) {
  const calls: string[] = [];
  const formatRows = (sel: string, rows: Array<Record<string, string>>) =>
    [`# ${rows.length} row(s) for ${sel}`, ...rows.map((r) => JSON.stringify(r))].join("\n");

  const bcCall = async (input: BcCallInput) => {
    if (page.quickError && input.steps.length <= 4) {
      // The quick probe is the four-step read (href, title, text, FAST_VENDOR_CSS query).
      return { ok: false, error: { code: "EXECUTION_FAILED", message: "quick probe unavailable" } } as never;
    }
    const values = input.steps.map((step) => {
      if (step.kind === "href") return page.url;
      if (step.kind === "title") return page.title;
      if (step.kind === "bc") {
        if (step.method === "text") return `# ${page.title} | ${page.url}\n\n${page.bodyText}`;
        if (step.method === "query") {
          const opts = (step.args?.[0] ?? {}) as { selector?: string; all?: boolean };
          const sel = String(opts.selector ?? "");
          const rows =
            sel === "iframe[src]"
              ? (page.frames ?? []).map((src) => ({ src }))
              : sel === "script[src]"
                ? (page.scripts ?? []).map((src) => ({ src }))
                : sel === "awswaf-captcha"
                  ? page.hasAwsCaptcha
                    ? [{ id: "" }]
                    : []
                  : opts.all === false
                    ? (page.visibleSelectorRows ?? [])
                    : (page.selectorRows ?? []);
          return formatRows(sel, rows);
        }
        if (step.method === "settle" || step.method === "wall") return "ok";
        return "ok";
      }
      return "ok";
    });
    const kept = values.filter((_, i) => !input.steps[i]?.discard);
    if (page.quickShort && input.steps.length <= 4) return { value: kept.slice(0, 3).join(input.join ?? "\n") };
    return { value: kept.join(input.join ?? "\n") };
  };

  const invoke = async (op: string, input?: Record<string, unknown>): Promise<InvokeResult> => {
    calls.push(op);
    if (op === "get_browser_status") {
      return {
        ok: true,
        data: {
          connected: true,
          backends: { active: "extension", extension: { available: true, activeTargetId: "extension:42" } },
        },
      };
    }
    if (op === "evaluate") throw new Error(`unexpected evaluate on extension tier: ${String(input?.["expression"] ?? "")}`);
    if (op.startsWith("Input.")) throw new Error(`unexpected CDP dispatch: ${op}`);
    throw new Error(`unexpected invoke op: ${op}`);
  };

  const handle = createPageHelperHandler(invoke, undefined, undefined, { bcCall, sleep: async () => {} });
  return { handle, calls };
}

describe("solve_captcha (extension harness)", () => {
  test("reports an interactive recaptcha widget on the silent bcCall tier", async () => {
    const h = extensionHarness({
      url: "https://shop.example/",
      title: "Shop",
      bodyText: "Verify you are human to continue",
      frames: ["https://www.google.com/recaptcha/api2/anchor#?k=x"],
    });
    const res = await h.handle("solve_captcha", {}, "extension:42");
    expect(res.ok).toBe(true);
    const out = textOf(res);
    expect(out).toContain("recaptcha interactive");
    expect(out).toContain("widget (hint): checkbox");
  });

  test("a normal extension page reports clear without an attach, an Input dispatch, or any read beyond one status check", async () => {
    const h = extensionHarness({
      url: "https://normal.example/page",
      title: "Catalog",
      bodyText: "Normal article paragraph with real product details and documentation. ".repeat(40),
    });
    const res = await h.handle("solve_captcha", {});
    expect(res.ok).toBe(true);
    expect(textOf(res)).toContain("clear");
    // One status check on the read path, nothing else: no chrome.debugger attach (evaluate),
    // no CDP Input dispatch (the extension tier never sends gestures).
    expect(h.calls).toEqual(["get_browser_status"]);
  });

  test("an unreadable page reports unknown, never clear", async () => {
    const h = extensionHarness({
      url: "https://shop.example/",
      title: "Shop",
      bodyText: "Verify you are human to continue",
      quickError: true,
    });
    const res = await h.handle("solve_captcha", {});
    expect(res.ok).toBe(true);
    expect(textOf(res)).toContain("unknown");
    expect(textOf(res)).not.toContain("clear");
    expect(h.calls).toEqual(["get_browser_status"]);
  });

  test("an incomplete quick read reports unknown, never clear", async () => {
    const h = extensionHarness({
      url: "https://shop.example/",
      title: "Shop",
      bodyText: "Verify you are human to continue",
      quickShort: true,
    });
    const res = await h.handle("solve_captcha", {}, "extension:42");
    expect(res.ok).toBe(true);
    expect(textOf(res)).toContain("unknown");
  });

  test("verify mode forces a full probe: a long page with a widget is not clear", async () => {
    const h = extensionHarness({
      url: "https://shop.example/",
      title: "Shop",
      bodyText: "Long landing page with a marketing hero and a widget. ".repeat(60),
      frames: ["https://www.google.com/recaptcha/api2/anchor#?k=x"],
      selectorRows: [{ id: "", cls: "g-recaptcha", src: "", title: "" }],
      visibleSelectorRows: [{ id: "", cls: "g-recaptcha", src: "", title: "" }],
    });
    const res = await h.handle("solve_captcha", { verify: true });
    expect(res.ok).toBe(true);
    const out = textOf(res);
    // The full probe found the widget — not a fast-path skip.
    expect(out).not.toContain("no challenge detected");
    expect(out).toContain("still present");
  });
});
