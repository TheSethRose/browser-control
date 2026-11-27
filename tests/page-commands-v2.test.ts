import { describe, expect, test } from "bun:test";
import type { InvokeResult } from "@agent-software/core";
import { createPageHelperHandler } from "../src/page-runner";

type Call = { op: string; input: Record<string, unknown> };

/** Fake runtime: serves helper calls locally and records every execute_cdp call. */
function makeFakeInvoker(options: { dialogError?: string; activeTargetId?: string; cdpDelayMs?: number } = {}) {
  const calls: Call[] = [];
  const ok = (value: unknown): InvokeResult => ({ ok: true, data: { value } });

  const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
    calls.push({ op, input });
    if (op === "get_browser_status") {
      return { ok: true, data: { connected: true, ...(options.activeTargetId ? { activeTargetId: options.activeTargetId } : {}) } };
    }
    if (op === "evaluate") {
      const expr = String(input["expression"] ?? "");
      if (expr.includes("__bc.verifyRef")) return ok("e1");
      if (expr.includes("__bc.locate")) return ok("e7");
      if (expr.includes("__bc.diff")) return ok('+ tooltip "Save" [e9]');
      if (expr.includes("__bc.settle")) return ok('{"stamped":2}');
      if (expr.includes("__bc.hit")) return ok("https://a.test/x\nhit: button#save");
      if (expr.includes("__bc.point")) {
        return ok(expr.includes("__bc.baseline()") ? "https://a.test/x 120 240 visible" : "120 240 visible");
      }
      if (expr.includes("__bc.baseline")) return ok("https://a.test/x");
      return ok("ok");
    }
    if (op === "execute_cdp") {
      if (options.cdpDelayMs) await new Promise((r) => setTimeout(r, options.cdpDelayMs));
      if (input["method"] === "Page.handleJavaScriptDialog" && options.dialogError) {
        return { ok: false, error: { code: "EXECUTION_FAILED", message: options.dialogError } };
      }
      return { ok: true, data: { result: {} } };
    }
    return { ok: true, data: {} };
  };

  const cdpCalls = () =>
    calls.filter((c) => c.op === "execute_cdp").map((c) => ({
      method: String(c.input["method"]),
      params: (c.input["params"] ?? {}) as Record<string, unknown>,
      targetId: c.input["targetId"] as string | undefined,
    }));

  return { calls, invoke, cdpCalls };
}

const text = (res: InvokeResult) => (res.ok ? String((res.data as { value: unknown }).value) : res.error.message);

describe("hover", () => {
  test("hover by ref sends one mouseMoved to the resolved point and reports what changed", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    const res = await handle("hover", { ref: "@e1" });
    expect(res.ok).toBe(true);
    expect(text(res)).toBe('hover e1 at 120,240: delivered\n+ tooltip "Save" [e9]');

    const events = cdpCalls().filter((c) => c.method === "Input.dispatchMouseEvent");
    expect(events).toEqual([{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 120, y: 240 }, targetId: undefined }]);
  });

  test("hover by xy moves to the raw coordinates", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    const res = await handle("hover", { xy: [10, 20] });
    expect(res.ok).toBe(true);
    expect(text(res)).toBe('hover 10,20: delivered. hit: button#save\n+ tooltip "Save" [e9]');

    const events = cdpCalls().filter((c) => c.method === "Input.dispatchMouseEvent");
    expect(events).toEqual([{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 10, y: 20 }, targetId: undefined }]);
  });

  test("hover never presses or releases a mouse button", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    await handle("hover", { ref: "@e1" });
    await handle("hover", { xy: [5, 6] });

    const types = cdpCalls()
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .map((c) => c.params["type"]);
    expect(types).toEqual(["mouseMoved", "mouseMoved"]);
    expect(types).not.toContain("mousePressed");
    expect(types).not.toContain("mouseReleased");
  });

  test("hover rejects bad xy", async () => {
    const { invoke } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    const res = await handle("hover", { xy: ["a", 2] });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.error.code).toBe("INPUT_VALIDATION_FAILED");
  });
});

describe("dialog", () => {
  test("dialog accept sends accept plus the prompt text", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    const res = await handle("dialog", { sub: "accept", text: "Ada Lovelace" });
    expect(res.ok).toBe(true);
    expect(text(res)).toBe('dialog accept: accepted with prompt text "Ada Lovelace"');
    expect(cdpCalls().map((c) => c.method)).toEqual(["Page.handleJavaScriptDialog"]);
    expect(cdpCalls()[0]!.params).toEqual({ accept: true, promptText: "Ada Lovelace" });
  });

  test("dialog dismiss sends accept false without prompt text", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    const res = await handle("dialog", { sub: "dismiss" });
    expect(res.ok).toBe(true);
    expect(text(res)).toBe("dialog dismiss: dismissed");
    expect(cdpCalls().map((c) => c.method)).toEqual(["Page.handleJavaScriptDialog"]);
    expect(cdpCalls()[0]!.params).toEqual({ accept: false });
  });

  test("dialog with no open dialog returns a clean NO_MATCH instead of the raw CDP error", async () => {
    const { invoke } = makeFakeInvoker({ dialogError: "CDP -32603: No dialog is showing" });
    const handle = createPageHelperHandler(invoke);

    const res = await handle("dialog", { sub: "accept" });
    expect(res.ok).toBe(false);
    const message = res.ok ? "" : res.error.message;
    expect(message.startsWith("NO_MATCH: no JavaScript dialog is open")).toBe(true);
    expect(message).not.toContain("CDP");
    expect(message).not.toContain("run: snap");
  });

  test("dialog rejects an unknown subcommand", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    const res = await handle("dialog", { sub: "open" });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.error.code).toBe("INPUT_VALIDATION_FAILED");
    expect(cdpCalls()).toHaveLength(0);
  });
});

describe("emulate", () => {
  test("viewport WxH@scale plus mobile sets device metrics and touch emulation", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    const res = await handle("emulate", { viewport: "390x844@3", mobile: true });
    expect(res.ok).toBe(true);
    expect(text(res)).toBe("emulate: viewport 390x844@3, mobile");
    expect(cdpCalls()).toEqual([
      {
        method: "Emulation.setDeviceMetricsOverride",
        params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
        targetId: undefined,
      },
      { method: "Emulation.setTouchEmulationEnabled", params: { enabled: true }, targetId: undefined },
    ]);
  });

  test("color scheme and reduced motion share one setEmulatedMedia call", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    const res = await handle("emulate", { colorScheme: "dark", reducedMotion: true });
    expect(res.ok).toBe(true);
    expect(text(res)).toBe("emulate: color-scheme dark, reduced-motion reduce");
    expect(cdpCalls()).toEqual([
      {
        method: "Emulation.setEmulatedMedia",
        params: {
          features: [
            { name: "prefers-color-scheme", value: "dark" },
            { name: "prefers-reduced-motion", value: "reduce" },
          ],
        },
        targetId: undefined,
      },
    ]);
  });

  test("offline emulates a dead network", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    const res = await handle("emulate", { offline: true });
    expect(res.ok).toBe(true);
    expect(text(res)).toBe("emulate: offline");
    expect(cdpCalls()).toEqual([
      {
        method: "Network.emulateNetworkConditions",
        params: { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        targetId: undefined,
      },
    ]);
  });

  test("ua overrides the user agent", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    const res = await handle("emulate", { ua: "bc-test/2.0" });
    expect(res.ok).toBe(true);
    expect(text(res)).toBe("emulate: ua");
    expect(cdpCalls()).toEqual([
      { method: "Emulation.setUserAgentOverride", params: { userAgent: "bc-test/2.0" }, targetId: undefined },
    ]);
  });

  test("reset clears device metrics twice with a 100 ms pause between, then restores everything else", async () => {
    const fake = makeFakeInvoker();
    const events: string[] = [];
    const handle = createPageHelperHandler(
      async (op: string, input: Record<string, unknown> = {}) => {
        if (op === "execute_cdp") events.push(String(input["method"]));
        return fake.invoke(op, input);
      },
      undefined,
      undefined,
      { sleep: async (ms) => { events.push(`sleep:${ms}`); } },
    );

    const res = await handle("emulate", { reset: true });
    expect(res.ok).toBe(true);
    expect(text(res)).toBe("emulate: reset");
    expect(events).toEqual([
      "Emulation.clearDeviceMetricsOverride",
      "sleep:100",
      "Emulation.clearDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setEmulatedMedia",
      "Network.emulateNetworkConditions",
      "Emulation.setUserAgentOverride",
    ]);
    expect(fake.cdpCalls().map((c) => c.params)).toEqual([
      {},
      {},
      { enabled: false },
      { features: [] },
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      { userAgent: "" },
    ]);
  });

  test("setting one media feature keeps the other", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    await handle("emulate", { colorScheme: "dark" });
    await handle("emulate", { reducedMotion: true });
    expect(cdpCalls().at(-1)?.params).toEqual({
      features: [
        { name: "prefers-color-scheme", value: "dark" },
        { name: "prefers-reduced-motion", value: "reduce" },
      ],
    });
    await handle("emulate", { reset: true });
    await handle("emulate", { reducedMotion: false });
    expect(cdpCalls().at(-1)?.params).toEqual({ features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  });

  test("media cache follows the real active tab, not the implicit route", async () => {
    const opts: { activeTargetId?: string } = { activeTargetId: "tabA" };
    const { invoke, cdpCalls } = makeFakeInvoker(opts);
    const handle = createPageHelperHandler(invoke);

    await handle("emulate", { colorScheme: "dark" });
    opts.activeTargetId = "tabB";
    await handle("emulate", { reducedMotion: true });
    const last = cdpCalls().at(-1);
    expect(last?.targetId).toBe("tabB");
    expect(last?.params).toEqual({ features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  });

  test("parallel media updates on one tab both survive", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker({ activeTargetId: "tabA", cdpDelayMs: 5 });
    const handle = createPageHelperHandler(invoke);

    await Promise.all([handle("emulate", { colorScheme: "dark" }), handle("emulate", { reducedMotion: true })]);
    expect(cdpCalls().at(-1)?.params).toEqual({
      features: [
        { name: "prefers-color-scheme", value: "dark" },
        { name: "prefers-reduced-motion", value: "reduce" },
      ],
    });
  });

  test("viewport over Chrome's limit is rejected before reset runs", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    const res = await handle("emulate", { reset: true, viewport: "10000001x800" });
    expect(res.ok ? "" : res.error.code).toBe("INPUT_VALIDATION_FAILED");
    expect(cdpCalls()).toHaveLength(0);
  });

  test("bad viewport is rejected before any CDP call", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    const res = await handle("emulate", { viewport: "390x" });
    expect(res.ok).toBe(false);
    const message = res.ok ? "" : res.error.message;
    expect(res.ok ? "" : res.error.code).toBe("INPUT_VALIDATION_FAILED");
    expect(message).toContain("INPUT_INVALID");
    expect(cdpCalls()).toHaveLength(0);
  });

  test("emulate without options explains the options", async () => {
    const { invoke, cdpCalls } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    const res = await handle("emulate", {});
    expect(res.ok).toBe(false);
    const message = res.ok ? "" : res.error.message;
    expect(message).toContain("INPUT_INVALID");
    expect(message).toContain("viewport");
    expect(message).toContain("reset");
    expect(cdpCalls()).toHaveLength(0);

    const off = await handle("emulate", { reset: false });
    expect(off.ok).toBe(false);
    expect(off.ok ? "" : off.error.code).toBe("INPUT_VALIDATION_FAILED");
    expect(cdpCalls()).toHaveLength(0);
  });
});
