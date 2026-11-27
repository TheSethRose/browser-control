import { describe, expect, test } from "bun:test";
import type { OperationHandler } from "@agent-software/core";
import { createBrowseBackend, type Runner } from "../src/backends/browse";
import { route } from "../src/backends/router";

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
    navigate: op("navigate"),
    evaluate: op("evaluate"),
    capture_screenshot: op("capture_screenshot"),
    capture_pdf: op("capture_pdf"),
    execute_cdp: op("execute_cdp"),
    select_target: op("select_target"),
    clear_target: op("clear_target"),
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
});
