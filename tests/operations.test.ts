import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispose, initialize, operations } from "../src/index";

const dirs: string[] = [];

afterEach(async () => {
  await dispose();
  delete process.env["BROWSER_ARTIFACT_DIR"];
  while (dirs.length > 0) {
    await rm(dirs.pop()!, { recursive: true, force: true });
  }
});

function call(name: string, input: Record<string, unknown> = {}): Promise<unknown> {
  const handler = operations[name];
  if (!handler) throw new Error(`no handler: ${name}`);
  return Promise.resolve(handler(input));
}

describe("browser-control lifecycle", () => {
  test("initialize resolves and creates the artifact directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "bc-"));
    dirs.push(root);
    const artifacts = join(root, "artifacts");
    process.env["BROWSER_ARTIFACT_DIR"] = artifacts;

    await initialize();

    expect(existsSync(artifacts)).toBe(true);
    const status = (await call("get_browser_status")) as { connected: boolean; artifactDir: string };
    expect(status.connected).toBe(false);
    expect(status.artifactDir).toBe(artifacts);
  });

  test("dispose closes the connection and status remains queryable", async () => {
    await initialize();
    await dispose();
    const status = (await call("get_browser_status")) as { connected: boolean };
    expect(status.connected).toBe(false);
  });

  test("clear_target reports no active route", async () => {
    await initialize();
    expect(await call("clear_target")).toEqual({ activeTargetId: null, activeSessionId: null });
  });
});

describe("browser-control operations without a browser", () => {
  test("list_browsers always returns an array", async () => {
    await initialize();
    const result = (await call("list_browsers")) as { browsers: unknown[] };
    expect(Array.isArray(result.browsers)).toBe(true);
  });

  test("connect_browser rejects mutually exclusive address forms before connecting", async () => {
    await initialize();
    await expect(call("connect_browser", { wsUrl: "ws://x", port: 1 })).rejects.toThrow(
      "INPUT_INVALID",
    );
  });

  test("target-scoped operations fail with NOT_CONNECTED when no browser is connected", async () => {
    await initialize();
    await expect(call("execute_cdp", { method: "Page.navigate" })).rejects.toThrow("NOT_CONNECTED");
    await expect(call("list_targets")).rejects.toThrow("NOT_CONNECTED");
    await expect(
      call("wait_for_event", { method: "Page.loadEventFired", timeoutMs: 5 }),
    ).rejects.toThrow("NOT_CONNECTED");
  });

  test("evaluate and navigate validate input, then need a connection", async () => {
    await initialize();
    await expect(call("evaluate", {})).rejects.toThrow("INPUT_INVALID");
    await expect(call("navigate", {})).rejects.toThrow("INPUT_INVALID");
    await expect(call("evaluate", { expression: "1" })).rejects.toThrow("NOT_CONNECTED");
    await expect(call("navigate", { url: "https://example.com" })).rejects.toThrow("NOT_CONNECTED");
  });

  test("connect_browser rejects a browser name combined with a port", async () => {
    await initialize();
    await expect(call("connect_browser", { browser: "chrome", port: 1 })).rejects.toThrow("INPUT_INVALID");
  });

  test("read_events returns an empty result when nothing is buffered", async () => {
    await initialize();
    const result = (await call("read_events")) as { events: unknown[]; nextSeq: number; dropped: number };
    expect(result.events).toEqual([]);
    expect(result.nextSeq).toBeGreaterThan(0);
    expect(result.dropped).toBe(0);
  });

  test("close_target refuses on the cdp backend", async () => {
    await initialize();
    await expect(call("close_target")).rejects.toThrow(/INPUT_INVALID:.*extension/);
  });
});
