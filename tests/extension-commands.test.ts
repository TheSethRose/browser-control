import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPageHelperHandler, dispatchExtensionRequest, handleExtensionRoute } from "../daemon";
import {
  createExtensionBackend,
  EXTENSION_ORIGIN,
  extProofMessage,
  hmacHex,
  PROTOCOL_VERSION,
  redactSecrets,
  type ConnectedBrowserInfo,
  type ExtensionReportBackend,
} from "../src/backends/extension";
import { backendOrder, route, setDaemonBackendsFile } from "../src/backends/router";
import { PAGE_HELPERS_VERSION } from "../src/page-helpers";

const WRAPPER = resolve(import.meta.dir, "../.agents/skills/browser-control/scripts/browser-control-daemon");
const TOKEN = "ab".repeat(32);

type Recorded = { method: string; path: string };
const seen: Recorded[] = [];
let dir = "";
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bc-ext-cmd-"));
  await mkdir(join(dir, "daemon"));
  server = Bun.serve({
    unix: join(dir, "daemon", "sock"),
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ method: req.method, path: url.pathname });
      return Response.json({ ok: true, data: { value: "ok" } });
    },
  });
});

afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

async function bc(...args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bash", WRAPPER, ...args], {
    env: { ...process.env, BROWSER_CONTROL_DAEMON_DIR: join(dir, "daemon"), XDG_CONFIG_HOME: join(dir, "xdg") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
}

const made = (before: number) => seen.slice(before).filter((r) => r.path !== "/status");

describe("wrapper extension subcommands", () => {
  for (const sub of ["status", "browsers", "diagnostics"]) {
    test(`extension ${sub} calls GET /extension/${sub}`, async () => {
      const before = seen.length;
      const res = await bc("extension", sub);
      expect(res.code).toBe(0);
      expect(made(before)).toEqual([{ method: "GET", path: `/extension/${sub}` }]);
    });
  }

  test("extension disable writes cdp and extension enable deletes the daemon dir's backends file", async () => {
    const file = join(dir, "daemon", "backends");
    let res = await bc("extension", "disable");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ ok: true, data: { backends: "cdp" } });
    expect((await readFile(file, "utf8")).trim()).toBe("cdp");
    res = await bc("extension", "enable");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ ok: true, data: { backends: "extension" } });
    expect(existsSync(file)).toBe(false);
  });

  for (const sub of ["pair", "revoke"]) {
    test(`extension ${sub} is deferred to the Web Store build`, async () => {
      const before = seen.length;
      const res = await bc("extension", sub, "chrome-abc123");
      expect(res.code).not.toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.error.code).toBe("INPUT_INVALID");
      expect(out.error.message).toContain("Web Store build");
      expect(made(before)).toHaveLength(0);
    });
  }

  test("unknown or missing subcommand prints usage as INPUT_INVALID", async () => {
    for (const args of [["extension"], ["extension", "nope"]]) {
      const res = await bc(...args);
      expect(res.code).not.toBe(0);
      expect(JSON.parse(res.stdout).error.code).toBe("INPUT_INVALID");
    }
  });

  test("extension setup rejects a folder without manifest.json", async () => {
    const res = await bc("extension", "setup", join(dir, "missing"));
    expect(res.code).not.toBe(0);
    expect(JSON.parse(res.stdout).error.code).toBe("INPUT_INVALID");
  });

  test("extension setup pairs, leaves no daemon backends file, and prints no secret", async () => {
    const ext = join(dir, "ext");
    await mkdir(ext, { recursive: true });
    await writeFile(join(ext, "manifest.json"), "{}");
    await rm(join(dir, "daemon", "backends"), { force: true });
    const res = await bc("extension", "setup", ext);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.data).toMatchObject({ paired: true, backends: "extension", extensionDir: ext });
    const pairing = JSON.parse(await readFile(join(ext, "pairing.json"), "utf8")) as { token: string };
    expect(pairing.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.stdout).not.toContain(pairing.token);
    expect((await stat(join(ext, "pairing.json"))).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, "daemon", "backends"))).toBe(false);
  });
});

describe("daemon backends file and paired default", () => {
  const saved = process.env["BROWSER_CONTROL_BACKENDS"];
  const savedXdg = process.env["XDG_CONFIG_HOME"];
  afterEach(() => {
    setDaemonBackendsFile(undefined);
    if (saved === undefined) delete process.env["BROWSER_CONTROL_BACKENDS"];
    else process.env["BROWSER_CONTROL_BACKENDS"] = saved;
    if (savedXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = savedXdg;
  });

  test("the daemon dir's file wins over BROWSER_CONTROL_BACKENDS and is re-read on every call", async () => {
    const file = join(dir, "order");
    process.env["BROWSER_CONTROL_BACKENDS"] = "extension";
    setDaemonBackendsFile(file);
    expect(backendOrder()).toEqual(["extension"]);
    await writeFile(file, "cdp\n");
    expect(backendOrder()).toEqual(["cdp"]);
    await writeFile(file, "extension,cdp\n");
    expect(backendOrder()).toEqual(["extension", "cdp"]);
    await rm(file, { force: true });
    expect(backendOrder()).toEqual(["extension"]);
  });

  test("with no order set, unpaired defaults to cdp and paired defaults to extension", async () => {
    const isoXdg = await mkdtemp(join(tmpdir(), "bc-order-xdg-"));
    try {
      delete process.env["BROWSER_CONTROL_BACKENDS"];
      process.env["XDG_CONFIG_HOME"] = isoXdg;
      setDaemonBackendsFile(join(isoXdg, "missing-backends"));

      // No pairing, no settings -> v1 default cdp.
      expect(backendOrder()).toEqual(["cdp"]);

      // Non-private or invalid token file -> still cdp (same check as extension status paired).
      const cfgDir = join(isoXdg, "browser-control");
      await mkdir(cfgDir, { recursive: true, mode: 0o700 });
      const tokenFile = join(cfgDir, "extension-relay.json");
      await writeFile(tokenFile, JSON.stringify({ token: TOKEN }), { mode: 0o644 });
      await chmod(tokenFile, 0o644);
      expect(backendOrder()).toEqual(["cdp"]);

      // Valid private 0600 token file -> extension alone.
      await chmod(tokenFile, 0o600);
      expect(backendOrder()).toEqual(["extension"]);

      // Explicit config file and env var still override the paired default.
      await writeFile(join(cfgDir, "backends"), "extension,cdp\n");
      expect(backendOrder()).toEqual(["extension", "cdp"]);
      process.env["BROWSER_CONTROL_BACKENDS"] = "cdp";
      expect(backendOrder()).toEqual(["cdp"]);
    } finally {
      await rm(isoXdg, { recursive: true, force: true });
    }
  });
});

function mockBackend(
  browsers: ConnectedBrowserInfo[],
  diag: unknown,
  port: number | null = 49222,
): ExtensionReportBackend & { requests: unknown[][] } {
  const requests: unknown[][] = [];
  return {
    instanceId: "inst-1",
    requests,
    getPort: () => port ?? undefined,
    async status() {
      return { available: browsers.length > 0, listening: port !== null, port, protocolVersion: 1, browsers, profileId: "secret-profile" };
    },
    getConnectedBrowsers: () => browsers,
    async request(op, params, timeoutMs, slug) {
      requests.push([op, params, timeoutMs, slug]);
      return diag;
    },
    async waitForConnection() {},
  };
}

const chrome: ConnectedBrowserInfo = {
  slug: "chrome-1a2b3c",
  profileId: "p1",
  browser: "Google Chrome",
  extensionVersion: "2.0.0",
};

describe("daemon /extension routes", () => {
  let tokenFile = "";
  beforeAll(async () => {
    tokenFile = join(dir, "relay.json");
    await writeFile(tokenFile, JSON.stringify({ token: TOKEN }), { mode: 0o600 });
  });

  test("status reports port, browser count and pairing, never the token or profile id", async () => {
    const res = await handleExtensionRoute("status", mockBackend([chrome], {}), ["extension", "cdp"], tokenFile);
    const out = await res.json();
    expect(out.data).toMatchObject({ enabled: true, backends: "extension,cdp", paired: true, listening: true, port: 49222, browsers: 1 });
    const raw = JSON.stringify(out);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("secret-profile");
  });

  test("status waits briefly for a just-started relay's first browser", async () => {
    const browsers: ConnectedBrowserInfo[] = [];
    const backend = {
      ...mockBackend(browsers, {}),
      async status() {
        return { listening: true, port: 49222, browsers: [...browsers] };
      },
      async waitForConnection() {
        browsers.push(chrome);
      },
    };
    const out = await (await handleExtensionRoute("status", backend, ["extension"], tokenFile)).json();
    expect(out.data.browsers).toBe(1);
  });

  test("status when disabled is CDP-only and does not start the relay", async () => {
    let started = false;
    const backend = { ...mockBackend([], {}, null), async status() { started = true; return {}; } };
    const out = await (await handleExtensionRoute("status", backend, ["cdp"], join(dir, "none.json"))).json();
    expect(out.data).toEqual({ enabled: false, backends: "cdp", paired: false, listening: false, port: null, browsers: 0 });
    expect(started).toBe(false);
  });

  test("S3: status when disabled still reports actual listening state and port if relay is bound", async () => {
    const backend = createExtensionBackend({ portStart: 49326, portEnd: 49330, token: TOKEN });
    try {
      const before = await (await handleExtensionRoute("status", backend, ["cdp"], tokenFile)).json();
      expect(before.data).toEqual({
        enabled: false,
        backends: "cdp",
        paired: true,
        listening: false,
        port: null,
        browsers: 0,
      });
      expect(backend.getPort()).toBeUndefined();

      await backend.start?.();
      const boundPort = backend.getPort();
      expect(typeof boundPort).toBe("number");

      const after = await (await handleExtensionRoute("status", backend, ["cdp"], tokenFile)).json();
      expect(after.data).toEqual({
        enabled: false,
        backends: "cdp",
        paired: true,
        listening: true,
        port: boundPort,
        browsers: 0,
      });
    } finally {
      await backend.dispose?.();
    }
  });

  test("browsers lists slug, brand and version one per line", async () => {
    const res = await handleExtensionRoute("browsers", mockBackend([chrome], {}), ["extension"], tokenFile);
    expect(await res.text()).toBe("chrome-1a2b3c chrome Google Chrome v2.0.0\n");
    const none = await handleExtensionRoute("browsers", mockBackend([], {}), ["extension"], tokenFile);
    expect(await none.text()).toBe("(no browsers connected)\n");
  });

  test("browsers when disabled says how to enable", async () => {
    const res = await handleExtensionRoute("browsers", mockBackend([chrome], {}), ["cdp"], tokenFile);
    expect(res.status).toBe(400);
    const out = await res.json();
    expect(out.error.code).toBe("INPUT_INVALID");
    expect(out.error.message).toContain("extension enable");
  });

  test("diagnostics asks each browser and redacts secrets", async () => {
    const backend = mockBackend([chrome], {
      extensionVersion: "2.0.0",
      hasToken: true,
      token: "leak",
      connections: [{ port: 49222, relayNonce: "n1", state: "ready" }],
      note: TOKEN,
    });
    const out = await (await handleExtensionRoute("diagnostics", backend, ["extension", "cdp"], tokenFile)).json();
    expect(backend.requests).toEqual([["diagnostics", {}, 5000, "chrome-1a2b3c"]]);
    expect(out.data.daemon).toMatchObject({ enabled: true, paired: true, instanceId: "inst-1" });
    const d = out.data.browsers[0].diagnostics;
    expect(d).toMatchObject({ hasToken: true, token: "[redacted]", note: "[redacted]" });
    expect(d.connections[0]).toEqual({ port: 49222, relayNonce: "[redacted]", state: "ready" });
    expect(JSON.stringify(out)).not.toContain("leak");
  });

  test("diagnostics keeps going when one browser fails", async () => {
    const backend = { ...mockBackend([chrome], {}), async request() { throw new Error("timed out"); } };
    const out = await (await handleExtensionRoute("diagnostics", backend, ["extension"], tokenFile)).json();
    expect(out.data.browsers[0]).toMatchObject({ slug: "chrome-1a2b3c", error: "timed out" });
  });

  test("unknown subcommand is INPUT_INVALID", async () => {
    const res = await handleExtensionRoute("pair", mockBackend([], {}), ["extension"], tokenFile);
    expect((await res.json()).error.code).toBe("INPUT_INVALID");
  });

  test("redactSecrets leaves booleans and ordinary values", () => {
    expect(redactSecrets({ hasToken: false, apiKey: "x", port: 1, list: [{ secret: 2 }] })).toEqual({
      hasToken: false,
      apiKey: "[redacted]",
      port: 1,
      list: [{ secret: "[redacted]" }],
    });
  });

  test("S2: after extension disable, explicit extension target ids cannot reach the connected extension", async () => {
    const backendsFile = join(dir, "s2-backends");
    await writeFile(backendsFile, "extension,cdp\n");
    setDaemonBackendsFile(backendsFile);
    const backend = createExtensionBackend({
      portStart: 49320,
      portEnd: 49325,
      token: TOKEN,
      registerGlobal: true,
      waitConnectMs: 5_000,
    });
    let ws: WebSocket | undefined;
    try {
      await backend.start?.();
      const port = backend.getPort()!;
      const received: Array<{ op: string; params: Record<string, unknown> }> = [];
      const extNonce = "2".repeat(32);
      ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
        headers: { Origin: EXTENSION_ORIGIN },
      } as unknown as string[]);
      await new Promise<void>((resolveReady, rejectReady) => {
        ws!.addEventListener("open", () => {
          ws!.send(
            JSON.stringify({
              type: "hello",
              profileId: "prof-s2",
              browser: "Chrome",
              version: "2.0.0",
              helpersVersion: PAGE_HELPERS_VERSION,
              protocolVersion: PROTOCOL_VERSION,
              nonce: extNonce,
            }),
          );
        });
        ws!.addEventListener("message", (ev) => {
          const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (msg["type"] === "auth.challenge") {
            const proof = hmacHex(TOKEN, extProofMessage(port, String(msg["nonce"]), extNonce));
            ws!.send(JSON.stringify({ type: "auth.response", proof }));
          } else if (msg["type"] === "welcome") {
            resolveReady();
          } else if (msg["type"] === "req") {
            received.push({ op: String(msg["op"]), params: (msg["params"] ?? {}) as Record<string, unknown> });
            ws!.send(JSON.stringify({ type: "res", id: msg["id"], ok: true, result: { ok: true } }));
          }
        });
        ws!.addEventListener("error", (err) => rejectReady(err));
      });

      // Disable the extension backend while the relay and browser stay connected.
      await writeFile(backendsFile, "cdp\n");

      const cdpCalled: string[] = [];
      const ops = route(
        {
          read_events: async () => {
            cdpCalled.push("read_events");
            return { events: [] };
          },
          wait_for_event: async () => {
            cdpCalled.push("wait_for_event");
            return { found: false };
          },
          execute_cdp: async () => {
            cdpCalled.push("execute_cdp");
            return { result: {} };
          },
          get_browser_status: async () => ({ connected: true }),
          clear_target: async () => ({}),
          list_targets: async () => ({ targets: [] }),
        },
        [backend],
      );
      const invoke = async (op: string, input: Record<string, unknown> = {}) => {
        try {
          return { ok: true as const, data: await ops[op]!(input) };
        } catch (error) {
          return { ok: false as const, error: { code: "EXECUTION_FAILED" as const, message: (error as Error).message } };
        }
      };

      const handlePage = createPageHelperHandler(invoke);
      const handoff = await handlePage("handoff", { message: "Sign in", timeout: 2 }, "extension:7");
      expect(handoff.ok).toBe(false);
      if (!handoff.ok) {
        expect(handoff.error.message).toBe("INPUT_INVALID: the extension backend is disabled; run: extension enable");
      }

      const extReq = (globalThis as Record<symbol, unknown>)[
        Symbol.for("browser-control.extension-request")
      ] as (op: string, params?: Record<string, unknown>) => Promise<unknown>;
      await expect(extReq("resolve_bc_node", { targetId: "extension:7", ref: "e1", mode: "ref" })).rejects.toThrow(
        "INPUT_INVALID: the extension backend is disabled; run: extension enable",
      );

      const dialog = await handlePage("dialog", { sub: "accept" }, "extension:7");
      expect(dialog.ok).toBe(false);
      if (!dialog.ok) {
        expect(dialog.error.message).toBe("INPUT_INVALID: the extension backend is disabled; run: extension enable");
      }

      expect(received).toEqual([]);
      expect(cdpCalled).toEqual([]);
    } finally {
      ws?.close();
      setDaemonBackendsFile(undefined);
      await backend.dispose?.();
    }
  });

  test("S5: dispatchExtensionRequest matches only GET /extension/(status|browsers|diagnostics) and rejects bad methods/paths", async () => {
    const backend = mockBackend([chrome], {});
    const callExt = (method: string, path: string) => {
      const url = new URL(`http://localhost${path}`);
      return dispatchExtensionRequest(new Request(url, { method }), url, backend, ["extension", "cdp"], tokenFile);
    };

    const ok = await callExt("GET", "/extension/status?m=should-not-lookup");
    expect(ok?.status).toBe(200);
    expect((await ok!.json()).data).toMatchObject({ enabled: true, listening: true, port: 49222, browsers: 1 });

    const badMethod = await callExt("POST", "/extension/status");
    expect(badMethod?.status).toBe(405);
    expect(badMethod?.headers.get("allow")).toBe("GET");

    const badMethod2 = await callExt("DELETE", "/extension/browsers");
    expect(badMethod2?.status).toBe(405);

    for (const badPath of ["/extension", "/extension/", "/extension/status/extra", "/extension/pair"]) {
      const res = await callExt("GET", badPath);
      expect(res?.status).toBe(404);
    }

    expect(await callExt("GET", "/tabs")).toBeUndefined();
  });
});
