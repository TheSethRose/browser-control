import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationHandler } from "@agent-software/core";
import { createBrowseBackend, type Runner } from "../src/backends/browse";
import { backendOrder, route, runWithFallbackNotice, setDaemonBackendsFile, withAutoConnect } from "../src/backends/router";
import { BackendUnavailable, type Backend } from "../src/backends/types";
import { createPageHelperHandler } from "../src/page-runner";

/** A fake `browse` CLI: records calls and answers from a table keyed by tool name. */
function fakeBrowse(answers: Record<string, { code?: number; out: string }>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const run: Runner = async (argv) => {
    const tool = argv[0]!;
    calls.push({ tool, args: JSON.parse(argv[2] ?? "{}") });
    const a = answers[tool] ?? { code: 1, out: `no answer for ${tool}` };
    return { code: a.code ?? 0, stdout: a.out, stderr: "" };
  };
  return { run, calls };
}

/** Fake CDP operations that report which ran. */
function fakeCdp(log: string[]): Record<string, OperationHandler> {
  const op = (name: string, data: unknown = { via: "cdp" }) => async (input: Record<string, unknown>) => {
    log.push(`${name}:${String(input["targetId"] ?? "")}`);
    return data;
  };
  return {
    connect_browser: op("connect_browser", { connected: true, browser: "Chrome" }),
    disconnect_browser: op("disconnect_browser", { connected: false }),
    list_browsers: op("list_browsers", { browsers: [] }),
    navigate: op("navigate"),
    evaluate: op("evaluate"),
    capture_screenshot: op("capture_screenshot"),
    capture_pdf: op("capture_pdf"),
    execute_cdp: op("execute_cdp"),
    select_target: op("select_target"),
    clear_target: op("clear_target"),
    close_target: op("close_target"),
    list_targets: op("list_targets", { targets: [{ targetId: "ABC", type: "page", title: "t", url: "u" }] }),
    get_browser_status: op("get_browser_status", { connected: true }),
  };
}

const browseFirst = () => ["browse", "cdp"];

describe("router with cdp only (default)", () => {
  test("every operation goes to CDP", async () => {
    const log: string[] = [];
    const { run, calls } = fakeBrowse({});
    const ops = route(fakeCdp(log), [createBrowseBackend(run)], () => ["cdp"]);
    await ops["navigate"]!({ url: "https://x" });
    await ops["evaluate"]!({ expression: "1" });
    expect(log).toEqual(["navigate:", "evaluate:"]);
    expect(calls.length).toBe(0);
    expect(await ops["get_browser_status"]!({})).toEqual({ connected: true });
  });
});

describe("router with browse first", () => {
  test("navigate opens a browse tab, then tab operations stay on it", async () => {
    const log: string[] = [];
    const { run, calls } = fakeBrowse({
      navigate: { out: JSON.stringify({ tab: 7, url: "https://x/", title: "X", navigated: true }) },
      eval: { out: '"X"' },
    });
    const ops = route(fakeCdp(log), [createBrowseBackend(run)], browseFirst);
    const nav = (await ops["navigate"]!({ url: "https://x" })) as Record<string, unknown>;
    expect(nav["targetId"]).toBe("browse:7");
    expect(nav["loaded"]).toBe(true);
    expect(await ops["evaluate"]!({ expression: "document.title" })).toEqual({ value: "X" });
    expect(calls.map((c) => c.tool)).toEqual(["navigate", "eval"]);
    expect(calls[1]!.args).toEqual({ tab: 7, expression: "document.title", world: "main" });
    expect(log).toEqual([]);
  });

  test("dropping browse from the order sends untargeted calls back to CDP", async () => {
    const log: string[] = [];
    const { run } = fakeBrowse({ navigate: { out: JSON.stringify({ tab: 7 }) } });
    let order = ["browse", "cdp"];
    const ops = route(fakeCdp(log), [createBrowseBackend(run)], () => order);
    await ops["navigate"]!({ url: "https://x" });
    order = ["cdp"];
    await ops["capture_pdf"]!({});
    expect(log).toEqual(["capture_pdf:"]);
  });

  test("an operation browse lacks fails clearly on a browse tab instead of using another tab", async () => {
    const log: string[] = [];
    const { run } = fakeBrowse({ navigate: { out: JSON.stringify({ tab: 7 }) } });
    const ops = route(fakeCdp(log), [createBrowseBackend(run)], browseFirst);
    await ops["navigate"]!({ url: "https://x" });
    await expect(ops["capture_pdf"]!({})).rejects.toThrow(/isn't available on browse tabs/);
    // Browser-level CDP still works.
    await ops["execute_cdp"]!({ method: "Target.getTargets" });
    expect(log).toEqual(["execute_cdp:"]);
  });

  test("a CDP target id always goes to CDP", async () => {
    const log: string[] = [];
    const { run, calls } = fakeBrowse({});
    const ops = route(fakeCdp(log), [createBrowseBackend(run)], browseFirst);
    await ops["evaluate"]!({ expression: "1", targetId: "ABC" });
    expect(log).toEqual(["evaluate:ABC"]);
    expect(calls.length).toBe(0);
  });

  test("after selecting a CDP tab, an untargeted navigate stays on it", async () => {
    const log: string[] = [];
    const { run, calls } = fakeBrowse({ navigate: { out: JSON.stringify({ tab: 7 }) } });
    const ops = route(fakeCdp(log), [createBrowseBackend(run)], browseFirst);
    await ops["select_target"]!({ targetId: "ABC" });
    await ops["navigate"]!({ url: "https://x" });
    expect(log).toEqual(["select_target:ABC", "navigate:"]);
    expect(calls.length).toBe(0);
    // clear_target hands untargeted navigate back to browse.
    await ops["clear_target"]!({});
    await ops["navigate"]!({ url: "https://y" });
    expect(calls.map((c) => c.tool)).toEqual(["navigate"]);
  });

  test("when browse is not installed, operations fall back to CDP", async () => {
    const log: string[] = [];
    const run: Runner = async () => ({ code: 127, stdout: "", stderr: "browse not found" });
    const ops = route(fakeCdp(log), [createBrowseBackend(run)], browseFirst);
    expect(await ops["navigate"]!({ url: "https://x" })).toEqual({ via: "cdp" });
    expect(log).toEqual(["navigate:"]);
  });

  test("a page exception becomes JS_EXCEPTION and does not fall back", async () => {
    const log: string[] = [];
    const { run } = fakeBrowse({
      navigate: { out: JSON.stringify({ tab: 3 }) },
      eval: { code: 1, out: "Error: boom (at line 1:7 of the eval code)" },
    });
    const ops = route(fakeCdp(log), [createBrowseBackend(run)], browseFirst);
    await ops["navigate"]!({ url: "https://x" });
    await expect(ops["evaluate"]!({ expression: "throw 1" })).rejects.toThrow(/^JS_EXCEPTION: Error: boom/);
    expect(log).toEqual([]);
  });

  test("list_targets merges both backends; select_target and clear_target switch tabs", async () => {
    const log: string[] = [];
    const { run } = fakeBrowse({
      tabs: { out: JSON.stringify({ tabs: [{ tab: 9, url: "https://b/", title: "B" }] }) },
      eval: { out: "2" },
    });
    const ops = route(fakeCdp(log), [createBrowseBackend(run)], browseFirst);
    const { targets } = (await ops["list_targets"]!({})) as { targets: Array<{ targetId: string }> };
    expect(targets.map((t) => t.targetId)).toEqual(["browse:9", "ABC"]);

    await ops["select_target"]!({ targetId: "browse:9" });
    expect(await ops["evaluate"]!({ expression: "1+1" })).toEqual({ value: 2 });

    await ops["select_target"]!({ targetId: "ABC" });
    await ops["evaluate"]!({ expression: "1" });
    await ops["clear_target"]!({});
    expect(log).toEqual(["list_targets:", "select_target:ABC", "evaluate:", "clear_target:"]);
  });

  test("status reports the backend order and browse state", async () => {
    const { run } = fakeBrowse({ tabs: { out: JSON.stringify({ tabs: [] }) } });
    const ops = route(fakeCdp([]), [createBrowseBackend(run)], browseFirst);
    const status = (await ops["get_browser_status"]!({})) as { backends: Record<string, unknown> };
    expect(status.backends["order"]).toEqual(["browse", "cdp"]);
    expect(status.backends["browse"]).toEqual({ available: true, tabs: 0, activeTargetId: null });
  });
});

describe("router with extension first", () => {
  test("a navigate that names a browser skips the selected CDP tab", async () => {
    const log: string[] = [];
    const extCalls: string[] = [];
    const ext = {
      name: "extension",
      handles: (op: string) => op === "navigate",
      invoke: async (op: string, input: Record<string, unknown>) => {
        extCalls.push(`${op}:${String(input["browser"] ?? "")}`);
        return { targetId: "extension:5" };
      },
      listTargets: async () => [],
      clearActive: () => {},
      status: () => ({}),
    };
    const ops = route(fakeCdp(log), [ext as never], () => ["extension", "cdp"]);
    await ops["select_target"]!({ targetId: "ABC" });
    await ops["navigate"]!({ url: "https://x", browser: "chrome-abc123" });
    expect(extCalls).toEqual(["navigate:chrome-abc123"]);
    expect(log).toEqual(["select_target:ABC"]);
  });

  test("a browser-named navigate goes to the extension even with cdp first", async () => {
    const log: string[] = [];
    const extCalls: string[] = [];
    const ext = {
      name: "extension",
      handles: (op: string) => op === "navigate",
      invoke: async (op: string) => {
        extCalls.push(op);
        return { targetId: "extension:5" };
      },
      listTargets: async () => [],
      clearActive: () => {},
      status: async () => ({}),
    };
    const ops = route(fakeCdp(log), [ext as never], () => ["cdp", "extension"]);
    await ops["navigate"]!({ url: "https://x", browser: "chrome-abc123" });
    expect(extCalls).toEqual(["navigate"]);
    expect(log).toEqual([]);
  });

  test("a browser-named navigate skips browse and fails when the extension is disabled", async () => {
    const log: string[] = [];
    const { run, calls } = fakeBrowse({ navigate: { out: JSON.stringify({ tab: 7 }) } });
    const extCalls: string[] = [];
    const ext = {
      name: "extension",
      handles: () => false,
      invoke: async (op: string) => {
        extCalls.push(op);
        return { targetId: "extension:5" };
      },
      listTargets: async () => [],
      clearActive: () => {},
      status: async () => ({}),
    };
    const ops = route(fakeCdp(log), [createBrowseBackend(run), ext as never], () => ["cdp", "browse", "extension"]);
    await ops["navigate"]!({ url: "https://x", browser: "chrome-abc123", targetId: "browse:7" });
    expect(extCalls).toEqual(["navigate"]);
    expect(calls.length).toBe(0);
    const noExt = route(fakeCdp(log), [createBrowseBackend(run), ext as never], () => ["cdp", "browse"]);
    await expect(noExt["navigate"]!({ url: "https://x", browser: "chrome-abc123" })).rejects.toThrow(
      /needs the extension backend/,
    );
    expect(log).toEqual([]);
  });

  test("a navigate that names an offline browser fails instead of using the CDP tab", async () => {
    const log: string[] = [];
    const ext = {
      name: "extension",
      handles: (op: string) => op === "navigate",
      invoke: async () => {
        throw new BackendUnavailable("extension", 'browser "chrome-abc123" is not connected');
      },
      listTargets: async () => [],
      clearActive: () => {},
      status: async () => ({}),
    };
    const ops = route(fakeCdp(log), [ext as never], () => ["extension", "cdp"]);
    await expect(ops["navigate"]!({ url: "https://x", browser: "chrome-abc123" })).rejects.toThrow(
      /not connected/,
    );
    expect(log).toEqual([]);
  });
});

function fakeExtension(overrides: Partial<Backend> = {}): Backend {
  return {
    name: "extension",
    handles: (op, input, active) => {
      if (op === "select_target") return typeof input["targetId"] === "string" && input["targetId"].startsWith("extension:");
      if (op === "execute_cdp" && typeof input["method"] === "string" && /^(Browser|Target|Extensions)\./.test(input["method"])) {
        return false;
      }
      if (op === "navigate") return true;
      if (op === "evaluate" || op === "execute_cdp" || op === "capture_screenshot") {
        return active || (typeof input["targetId"] === "string" && input["targetId"].startsWith("extension:"));
      }
      return false;
    },
    invoke: async (op) => ({ via: "extension", op, targetId: "extension:5" }),
    listTargets: async () => [
      { targetId: "extension:5", type: "page", title: "Ext", url: "https://ext.test/", backend: "extension" },
    ],
    status: async () => ({ available: true, listening: true, activeTargetId: "extension:5" }),
    clearActive: () => {},
    ...overrides,
  };
}

describe("router with extension only (no implicit cdp fallback)", () => {
  const savedBackends = process.env["BROWSER_CONTROL_BACKENDS"];
  afterEach(() => {
    if (savedBackends === undefined) delete process.env["BROWSER_CONTROL_BACKENDS"];
    else process.env["BROWSER_CONTROL_BACKENDS"] = savedBackends;
  });

  test("RESTRICTED_PAGE refuses with EXTENSION_ONLY and never calls CDP", async () => {
    const log: string[] = [];
    const ext = fakeExtension({
      invoke: async (op) => {
        if (op === "select_target") return { activeTargetId: "extension:5" };
        throw new BackendUnavailable(
          "extension",
          "RESTRICTED_PAGE: the extension cannot run on tab 5 (Cannot access a chrome:// URL); use a DevTools (cdp) tab for it",
        );
      },
    });
    const ops = route(fakeCdp(log), [ext], () => ["extension"]);
    await ops["select_target"]!({ targetId: "extension:5" });
    await expect(ops["evaluate"]!({ expression: "document.title" })).rejects.toThrow(
      /^EXTENSION_ONLY: RESTRICTED_PAGE:.*chrome:\/\/.*This strict mode comes from an explicit backend order/,
    );
    await expect(ops["evaluate"]!({ expression: "document.title", targetId: "extension:5" })).rejects.toThrow(
      /^EXTENSION_ONLY: RESTRICTED_PAGE:.*chrome:\/\//,
    );
    expect(log).toEqual([]);
  });

  test("BackendUnavailable (disconnected, not shared) refuses with EXTENSION_ONLY and never calls CDP", async () => {
    const log: string[] = [];
    const disconnected = fakeExtension({
      invoke: async () => {
        throw new BackendUnavailable("extension", "extension is not connected");
      },
      listTargets: async () => {
        throw new BackendUnavailable("extension", "extension is not connected");
      },
    });
    const opsDisconnected = route(fakeCdp(log), [disconnected], () => ["extension"]);
    await expect(opsDisconnected["navigate"]!({ url: "https://example.com" })).rejects.toThrow(
      /^EXTENSION_ONLY: extension is not connected\..*This strict mode comes from an explicit backend order/,
    );
    await expect(opsDisconnected["list_targets"]!({})).rejects.toThrow(
      /^EXTENSION_ONLY: extension is not connected\./,
    );

    const notShared = fakeExtension({
      invoke: async () => {
        throw new BackendUnavailable("extension", "tab 5 isn't shared with Browser Control");
      },
    });
    const opsNotShared = route(fakeCdp(log), [notShared], () => ["extension"]);
    await expect(opsNotShared["navigate"]!({ url: "https://example.com" })).rejects.toThrow(
      /^EXTENSION_ONLY: tab 5 isn't shared with Browser Control\..*This strict mode comes from an explicit backend order/,
    );
    expect(log).toEqual([]);
  });

  test("unhandled ops and browser-level CDP ops refuse with EXTENSION_ONLY and never call CDP", async () => {
    const log: string[] = [];
    const ext = fakeExtension();
    const ops = route(fakeCdp(log), [ext], () => ["extension"]);
    await ops["select_target"]!({ targetId: "extension:5" });

    await expect(ops["capture_pdf"]!({})).rejects.toThrow(
      /^EXTENSION_ONLY: capture_pdf isn't handled by the extension\..*This strict mode comes from an explicit backend order/,
    );
    await expect(ops["list_browsers"]!({})).rejects.toThrow(
      /^EXTENSION_ONLY: list_browsers isn't handled by the extension\./,
    );
    await expect(ops["execute_cdp"]!({ method: "Browser.getVersion" })).rejects.toThrow(
      /^EXTENSION_ONLY: browser-level CDP method "Browser\.getVersion" can't run on the extension\./,
    );
    await expect(ops["execute_cdp"]!({ method: "Target.getTargets", targetId: "extension:5" })).rejects.toThrow(
      /^EXTENSION_ONLY: browser-level CDP method "Target\.getTargets" can't run on the extension\./,
    );
    // list_targets and get_browser_status also never touch CDP in extension-only mode.
    const listed = (await ops["list_targets"]!({})) as { targets: Array<{ targetId: string }> };
    expect(listed.targets.map((t) => t.targetId)).toEqual(["extension:5"]);
    const status = (await ops["get_browser_status"]!({})) as { connected: boolean; backends: { order: string[] } };
    expect(status.connected).toBe(false);
    expect(status.backends.order).toEqual(["extension"]);
    expect(log).toEqual([]);
  });

  test("order extension,cdp still falls back to CDP on RESTRICTED_PAGE, BackendUnavailable, unhandled and browser-level ops", async () => {
    const log: string[] = [];
    const ext = fakeExtension({
      invoke: async (op) => {
        if (op === "navigate") throw new BackendUnavailable("extension", "extension is not connected");
        throw new BackendUnavailable("extension", "RESTRICTED_PAGE: cannot access chrome://version");
      },
    });
    const ops = route(fakeCdp(log), [ext], () => ["extension", "cdp"]);
    expect(await ops["navigate"]!({ url: "https://x" })).toEqual({ via: "cdp" });
    expect(await ops["evaluate"]!({ expression: "1" })).toEqual({ via: "cdp" });
    expect(await ops["capture_pdf"]!({})).toEqual({ via: "cdp" });
    expect(await ops["execute_cdp"]!({ method: "Browser.getVersion" })).toEqual({ via: "cdp" });
    expect(log).toEqual(["navigate:", "evaluate:", "capture_pdf:", "execute_cdp:"]);
  });

  test("order extension with explicit connect_browser runs on CDP, keeps untargeted calls & tabs on CDP, and returns on clear_target or nav --browser", async () => {
    const log: string[] = [];
    const extCalls: string[] = [];
    const ext = fakeExtension({
      invoke: async (op, input) => {
        extCalls.push(`${op}:${String(input["browser"] ?? "")}`);
        return { via: "extension", targetId: "extension:5" };
      },
    });
    const ops = route(fakeCdp(log), [ext], () => ["extension"]);

    await ops["connect_browser"]!({ browser: "chrome" });
    await ops["evaluate"]!({ expression: "1" });
    const withCdp = (await ops["list_targets"]!({})) as { targets: Array<{ targetId: string }> };
    expect(withCdp.targets.map((t) => t.targetId)).toEqual(["extension:5", "ABC"]);
    expect(log).toEqual(["connect_browser:", "evaluate:", "list_targets:"]);

    // clear_target returns untargeted calls and list_targets to the extension.
    await ops["clear_target"]!({});
    log.length = 0;
    await ops["navigate"]!({ url: "https://ext.test/" });
    const extOnly = (await ops["list_targets"]!({})) as { targets: Array<{ targetId: string }> };
    expect(extOnly.targets.map((t) => t.targetId)).toEqual(["extension:5"]);
    expect(extCalls).toEqual(["navigate:"]);
    expect(log).toEqual([]);

    // nav --browser <slug> also returns from an active CDP route to the extension.
    await ops["connect_browser"]!({ browser: "chrome" });
    log.length = 0;
    await ops["navigate"]!({ url: "https://ext.test/", browser: "chrome-abc123" });
    await ops["evaluate"]!({ expression: "2" });
    const backToExt = (await ops["list_targets"]!({})) as { targets: Array<{ targetId: string }> };
    expect(backToExt.targets.map((t) => t.targetId)).toEqual(["extension:5"]);
    expect(extCalls).toEqual(["navigate:", "navigate:chrome-abc123", "evaluate:"]);
    expect(log).toEqual([]);
  });

  test("order extension with an explicit DevTools targetId or select_target runs on CDP", async () => {
    const log: string[] = [];
    const extCalls: string[] = [];
    const ext = fakeExtension({
      invoke: async (op) => {
        extCalls.push(op);
        return { via: "extension", targetId: "extension:5" };
      },
    });
    const ops = route(fakeCdp(log), [ext], () => ["extension"]);

    // One-shot DevTools targetId runs on CDP without changing untargeted routing.
    await ops["evaluate"]!({ expression: "1", targetId: "ABC" });
    await ops["navigate"]!({ url: "https://ext.test/" });
    expect(log).toEqual(["evaluate:ABC"]);
    expect(extCalls).toEqual(["navigate"]);

    // select_target of a DevTools target switches untargeted calls and tabs to include CDP.
    await ops["select_target"]!({ targetId: "ABC" });
    await ops["navigate"]!({ url: "https://cdp.test/" });
    const listed = (await ops["list_targets"]!({})) as { targets: Array<{ targetId: string }> };
    expect(listed.targets.map((t) => t.targetId)).toEqual(["extension:5", "ABC"]);
    expect(log).toEqual(["evaluate:ABC", "select_target:ABC", "navigate:", "list_targets:"]);
  });

  test("page-runner nav and snap surface EXTENSION_ONLY on RESTRICTED_PAGE in extension-only mode without touching CDP", async () => {
    process.env["BROWSER_CONTROL_BACKENDS"] = "extension";
    const cdpLog: string[] = [];
    const ext = fakeExtension({
      invoke: async (op) => {
        if (op === "navigate") return { loaded: true, targetId: "extension:5", url: "chrome://version/" };
        throw new BackendUnavailable("extension", "RESTRICTED_PAGE: cannot access chrome://version");
      },
    });
    const ops = route(fakeCdp(cdpLog), [ext], () => ["extension"]);
    const invoke = async (op: string, input: Record<string, unknown> = {}) => {
      try {
        return { ok: true as const, data: await ops[op]!(input) };
      } catch (err) {
        return { ok: false as const, error: { code: "EXECUTION_FAILED" as const, message: (err as Error).message } };
      }
    };
    const handlePage = createPageHelperHandler(invoke, undefined, undefined, {
      bcCall: async () => {
        throw new BackendUnavailable(
          "extension",
          "RESTRICTED_PAGE: the extension cannot run on tab 5 (Cannot access a chrome:// URL); use a DevTools (cdp) tab for it",
        );
      },
    });
    const navRes = await handlePage("nav", { url: "chrome://version" });
    expect(navRes.ok).toBe(false);
    if (!navRes.ok) expect(navRes.error.message).toMatch(/^EXTENSION_ONLY: RESTRICTED_PAGE:.*chrome:\/\//);
    const snapRes = await handlePage("snap", {}, "extension:5");
    expect(snapRes.ok).toBe(false);
    if (!snapRes.ok) expect(snapRes.error.message).toMatch(/^EXTENSION_ONLY: RESTRICTED_PAGE:.*chrome:\/\//);
    expect(cdpLog).toEqual([]);
  });

  test("S1: automatic reconnect in CDP mode does not pin CDP after switching back to extension", async () => {
    const log: string[] = [];
    const extCalls: string[] = [];
    let cdpConnected = false;
    let order = ["cdp"];
    const cdp = {
      ...fakeCdp(log),
      connect_browser: async () => {
        cdpConnected = true;
        log.push("connect_browser:");
        return { connected: true, browser: "Chrome" };
      },
      list_targets: async () => {
        log.push("list_targets:");
        if (!cdpConnected) throw new Error("NOT_CONNECTED: call connect_browser first");
        return { targets: [{ targetId: "ABC", type: "page", title: "t", url: "u" }] };
      },
    };
    const ext = fakeExtension({
      invoke: async (op) => {
        extCalls.push(op);
        return { via: "extension", targetId: "extension:5" };
      },
    });
    const ops = route(cdp, [ext], () => order);

    // Simulate daemon auto-reconnect on `tabs` while in CDP mode.
    await expect(ops["list_targets"]!({})).rejects.toThrow(/^NOT_CONNECTED/);
    await withAutoConnect(() => ops["connect_browser"]!({}));
    const cdpTabs = (await ops["list_targets"]!({})) as { targets: Array<{ targetId: string }> };
    expect(cdpTabs.targets.map((t) => t.targetId)).toEqual(["ABC"]);

    // `extension enable` restores order to ["extension"]; untargeted calls must not stay pinned on CDP.
    order = ["extension"];
    log.length = 0;
    await ops["navigate"]!({ url: "https://ext.test/" });
    const extTabs = (await ops["list_targets"]!({})) as { targets: Array<{ targetId: string }> };
    expect(extTabs.targets.map((t) => t.targetId)).toEqual(["extension:5"]);
    expect(extCalls).toEqual(["navigate"]);
    expect(log).toEqual([]);
  });

  test("S2: untargeted emulate after nav --browser and relay disconnect never reuses parked CDP target", async () => {
    const log: string[] = [];
    let connected = true;
    const cdp = {
      ...fakeCdp(log),
      get_browser_status: async () => {
        log.push("get_browser_status:");
        return { connected: true, activeTargetId: "CDP-1" };
      },
    };
    const ext = fakeExtension({
      invoke: async (op) => {
        if (!connected) throw new BackendUnavailable("extension", "extension is not connected");
        return { via: "extension", op, targetId: "extension:5" };
      },
      status: async () => ({
        available: connected,
        listening: true,
        activeTargetId: connected ? "extension:5" : null,
      }),
    });
    const ops = route(cdp, [ext], () => ["extension"]);
    const invoke = async (op: string, input: Record<string, unknown> = {}) => {
      try {
        return { ok: true as const, data: await ops[op]!(input) };
      } catch (err) {
        return { ok: false as const, error: { code: "EXECUTION_FAILED" as const, message: (err as Error).message } };
      }
    };
    const handlePage = createPageHelperHandler(invoke);

    // Park a CDP target, then switch the active route to extension via nav --browser.
    await ops["select_target"]!({ targetId: "CDP-1" });
    await ops["navigate"]!({ url: "https://ext.test/", browser: "chrome-abc123" });
    connected = false;
    log.length = 0;

    const res = await handlePage("emulate", { colorScheme: "dark" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/^EXTENSION_ONLY:.*This strict mode comes from an explicit backend order/);
    expect(log.filter((entry) => entry.startsWith("execute_cdp:"))).toEqual([]);
  });

  test("S3: list_targets rethrows NOT_CONNECTED when CDP is the active route so daemon reconnects", async () => {
    const log: string[] = [];
    let cdpConnected = false;
    const cdp = {
      ...fakeCdp(log),
      connect_browser: async () => {
        cdpConnected = true;
        log.push("connect_browser:");
        return { connected: true, browser: "Chrome" };
      },
      list_targets: async () => {
        log.push("list_targets:");
        if (!cdpConnected) throw new Error("NOT_CONNECTED: call connect_browser first");
        return { targets: [{ targetId: "ABC", type: "page", title: "t", url: "u" }] };
      },
    };
    const ops = route(cdp, [fakeExtension()], () => ["extension"]);

    await ops["connect_browser"]!({ browser: "chrome" });
    cdpConnected = false; // CDP connection drops after explicit start.

    await expect(ops["list_targets"]!({})).rejects.toThrow(/^NOT_CONNECTED/);
    await withAutoConnect(() => ops["connect_browser"]!({}));
    const listed = (await ops["list_targets"]!({})) as { targets: Array<{ targetId: string }> };
    expect(listed.targets.map((t) => t.targetId)).toEqual(["extension:5", "ABC"]);
  });

  test("S8: automatic reconnect under order extension refuses unless CDP was asked for", async () => {
    const log: string[] = [];
    const cdp = {
      ...fakeCdp(log),
      connect_browser: async () => {
        log.push("connect_browser:");
        return { connected: true };
      },
    };
    const ops = route(cdp, [fakeExtension()], () => ["extension"]);
    await expect(withAutoConnect(() => ops["connect_browser"]!({}))).rejects.toThrow(/^EXTENSION_ONLY: the daemon would reconnect/);
    expect(log).toEqual([]);
    // A request that named a DevTools tab may reconnect.
    await withAutoConnect(() => ops["connect_browser"]!({}), true);
    expect(log).toEqual(["connect_browser:"]);
  });

  test("S9: untargeted tab op with no extension tab says no tab is selected", async () => {
    const log: string[] = [];
    const ext = fakeExtension();
    ext.handles = () => false;
    const ops = route(fakeCdp(log), [ext], () => ["extension"]);
    await expect(ops["evaluate"]!({ expression: "1" })).rejects.toThrow(/^EXTENSION_ONLY: no extension tab is selected/);
    expect(log).toEqual([]);
  });

  test("S9: after a targeted extension call with no selected tab, untargeted ops still say no tab is selected", async () => {
    const log: string[] = [];
    const ext = fakeExtension({ hasActive: () => false });
    const ops = route(fakeCdp(log), [ext], () => ["extension"]);
    await ops["evaluate"]!({ expression: "1", targetId: "extension:5" });
    ext.handles = () => false;
    await expect(ops["evaluate"]!({ expression: "1" })).rejects.toThrow(/^EXTENSION_ONLY: no extension tab is selected/);
    expect(log).toEqual([]);
  });

  test("S5: untargeted handoff with no extension tab returns EXTENSION_ONLY in extension-only mode", async () => {
    const log: string[] = [];
    let available = true;
    const ext = fakeExtension({
      status: async () => ({ available, listening: true, activeTargetId: null }),
    });
    const ops = route(fakeCdp(log), [ext], () => ["extension"]);
    const invoke = async (op: string, input: Record<string, unknown> = {}) => {
      try {
        return { ok: true as const, data: await ops[op]!(input) };
      } catch (err) {
        return { ok: false as const, error: { code: "EXECUTION_FAILED" as const, message: (err as Error).message } };
      }
    };
    const handlePage = createPageHelperHandler(invoke);

    const noTab = await handlePage("handoff", { message: "Sign in" });
    expect(noTab.ok).toBe(false);
    if (!noTab.ok) {
      expect(noTab.error.message).toMatch(/^EXTENSION_ONLY: no extension tab is selected\..*This strict mode comes from an explicit backend order/);
    }

    available = false;
    const disconnected = await handlePage("handoff", { message: "Sign in" });
    expect(disconnected.ok).toBe(false);
    if (!disconnected.ok) {
      expect(disconnected.error.message).toMatch(/^EXTENSION_ONLY: extension is not connected\..*This strict mode comes from an explicit backend order/);
    }

    // Explicit CDP targetId still rejects with INPUT_INVALID.
    const onCdpTarget = await handlePage("handoff", { message: "Sign in" }, "ABC");
    expect(onCdpTarget.ok).toBe(false);
    if (!onCdpTarget.ok) expect(onCdpTarget.error.message).toBe("INPUT_INVALID: handoff requires an extension tab");
    expect(log).toEqual([]);
  });

  test("S6: router resolves order once per status request", async () => {
    let calls = 0;
    const ops = route(fakeCdp([]), [fakeExtension()], () => {
      calls += 1;
      return ["extension"];
    });
    await ops["get_browser_status"]!({});
    expect(calls).toBe(1);
  });
});

describe("default order: extension first, then cdp with one notice", () => {
  const saved = process.env["BROWSER_CONTROL_BACKENDS"];
  const savedXdg = process.env["XDG_CONFIG_HOME"];
  const TOKEN = "ef".repeat(32);
  afterEach(() => {
    setDaemonBackendsFile(undefined);
    if (saved === undefined) delete process.env["BROWSER_CONTROL_BACKENDS"];
    else process.env["BROWSER_CONTROL_BACKENDS"] = saved;
    if (savedXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = savedXdg;
  });

  async function isolatePaired(paired: boolean): Promise<string> {
    const xdg = await mkdtemp(join(tmpdir(), "bc-default-order-"));
    delete process.env["BROWSER_CONTROL_BACKENDS"];
    process.env["XDG_CONFIG_HOME"] = xdg;
    setDaemonBackendsFile(join(xdg, "missing-backends"));
    if (paired) {
      const cfg = join(xdg, "browser-control");
      await mkdir(cfg, { recursive: true, mode: 0o700 });
      const tokenFile = join(cfg, "extension-relay.json");
      await writeFile(tokenFile, JSON.stringify({ token: TOKEN }), { mode: 0o600 });
      await chmod(tokenFile, 0o600);
    }
    return xdg;
  }

  test("a paired default is extension,cdp; unpaired stays cdp", async () => {
    const unpaired = await isolatePaired(false);
    try {
      expect(backendOrder()).toEqual(["cdp"]);
    } finally {
      await rm(unpaired, { recursive: true, force: true });
    }
    const paired = await isolatePaired(true);
    try {
      expect(backendOrder()).toEqual(["extension", "cdp"]);
    } finally {
      await rm(paired, { recursive: true, force: true });
    }
  });

  test("the paired default falls back to cdp on a disconnected extension and says so once", async () => {
    const xdg = await isolatePaired(true);
    try {
      const log: string[] = [];
      const ext = fakeExtension({
        invoke: async () => {
          throw new BackendUnavailable("extension", "extension is not connected");
        },
      });
      const ops = route(fakeCdp(log), [ext], backendOrder);
      const status = (await ops["get_browser_status"]!({})) as { backends: { order: string[]; orderSource: string; orderLabel: string } };
      expect(status.backends.order).toEqual(["extension", "cdp"]);
      expect(status.backends.orderSource).toBe("default");
      expect(status.backends.orderLabel).toBe("extension,cdp (default)");
      log.length = 0;
      const { value, notice } = await runWithFallbackNotice(async () => {
        await ops["navigate"]!({ url: "https://x" });
        await ops["evaluate"]!({ expression: "1" });
        return "done";
      });
      expect(value).toBe("done");
      expect(log).toEqual(["navigate:", "evaluate:"]);
      expect(notice).toBe("# used remote debugging: the extension is not connected (Chrome may ask you to Allow)");
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
  });

  test("a restricted page and an unhandled op each name their cause on an explicit extension,cdp order", async () => {
    const log: string[] = [];
    const ext = fakeExtension({
      invoke: async () => {
        throw new BackendUnavailable("extension", "RESTRICTED_PAGE: cannot access chrome://version");
      },
    });
    const ops = route(fakeCdp(log), [ext], () => ["extension", "cdp"]);
    const restricted = await runWithFallbackNotice(() => ops["navigate"]!({ url: "https://x" }));
    expect(restricted.notice).toBe("# used remote debugging: restricted page (Chrome may ask you to Allow)");
    const unhandled = await runWithFallbackNotice(() => ops["capture_pdf"]!({}));
    expect(unhandled.notice).toBe("# used remote debugging: the extension can't run capture_pdf (Chrome may ask you to Allow)");
  });

  test("an explicit extension order still refuses with EXTENSION_ONLY and reports no fallback", async () => {
    const log: string[] = [];
    const ext = fakeExtension({
      invoke: async () => {
        throw new BackendUnavailable("extension", "extension is not connected");
      },
    });
    const ops = route(fakeCdp(log), [ext], () => ["extension"]);
    const { notice } = await runWithFallbackNotice(async () => {
      await expect(ops["navigate"]!({ url: "https://x" })).rejects.toThrow(/^EXTENSION_ONLY: extension is not connected\./);
      return "done";
    });
    expect(notice).toBeUndefined();
    expect(log).toEqual([]);
  });

  test("cdp alone never reports a fallback", async () => {
    const log: string[] = [];
    const ops = route(fakeCdp(log), [fakeExtension()], () => ["cdp"]);
    const { notice } = await runWithFallbackNotice(() => ops["navigate"]!({ url: "https://x" }));
    expect(notice).toBeUndefined();
    expect(log).toEqual(["navigate:"]);
  });

  test("a page command carries the notice once, after its output", async () => {
    const log: string[] = [];
    const ext = fakeExtension({
      invoke: async (op) => {
        if (op === "navigate") throw new BackendUnavailable("extension", "extension is not connected");
        throw new BackendUnavailable("extension", "RESTRICTED_PAGE: cannot access chrome://version");
      },
    });
    const ops = route(fakeCdp(log), [ext], () => ["extension", "cdp"]);
    const invoke = async (op: string, input: Record<string, unknown> = {}) => {
      try {
        return { ok: true as const, data: (await ops[op]!(input)) as Record<string, unknown> };
      } catch (err) {
        return { ok: false as const, error: { code: "EXECUTION_FAILED" as const, message: (err as Error).message } };
      }
    };
    const handlePage = createPageHelperHandler(invoke);
    const res = await handlePage("nav", { url: "https://x" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const value = String((res.data as Record<string, unknown>)["value"]);
      const lines = value.split("\n").filter((l) => l.startsWith("# used remote debugging:"));
      expect(lines).toEqual(["# used remote debugging: the extension is not connected (Chrome may ask you to Allow)"]);
    }
  });
});
