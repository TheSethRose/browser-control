import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { handleExtensionRoute } from "../daemon";
import { redactSecrets, type ConnectedBrowserInfo, type ExtensionReportBackend } from "../src/backends/extension";
import { backendOrder, setDaemonBackendsFile } from "../src/backends/router";

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

  test("extension enable / disable write the daemon dir's backends file", async () => {
    const file = join(dir, "daemon", "backends");
    let res = await bc("extension", "enable");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ ok: true, data: { backends: "extension,cdp" } });
    expect((await readFile(file, "utf8")).trim()).toBe("extension,cdp");
    res = await bc("extension", "disable");
    expect(res.code).toBe(0);
    expect((await readFile(file, "utf8")).trim()).toBe("cdp");
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

  test("extension setup pairs, enables the backend, and prints no secret", async () => {
    const ext = join(dir, "ext");
    await mkdir(ext, { recursive: true });
    await writeFile(join(ext, "manifest.json"), "{}");
    await rm(join(dir, "daemon", "backends"), { force: true });
    const res = await bc("extension", "setup", ext);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.data).toMatchObject({ paired: true, backends: "extension,cdp", extensionDir: ext });
    const pairing = JSON.parse(await readFile(join(ext, "pairing.json"), "utf8")) as { token: string };
    expect(pairing.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.stdout).not.toContain(pairing.token);
    expect((await stat(join(ext, "pairing.json"))).mode & 0o777).toBe(0o600);
    expect((await readFile(join(dir, "daemon", "backends"), "utf8")).trim()).toBe("extension,cdp");
  });
});

describe("daemon backends file", () => {
  const saved = process.env["BROWSER_CONTROL_BACKENDS"];
  afterEach(() => {
    setDaemonBackendsFile(undefined);
    if (saved === undefined) delete process.env["BROWSER_CONTROL_BACKENDS"];
    else process.env["BROWSER_CONTROL_BACKENDS"] = saved;
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
  });
});

function mockBackend(browsers: ConnectedBrowserInfo[], diag: unknown): ExtensionReportBackend & { requests: unknown[][] } {
  const requests: unknown[][] = [];
  return {
    instanceId: "inst-1",
    requests,
    async status() {
      return { available: browsers.length > 0, listening: true, port: 49222, protocolVersion: 1, browsers, profileId: "secret-profile" };
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
    const backend = { ...mockBackend([], {}), async status() { started = true; return {}; } };
    const out = await (await handleExtensionRoute("status", backend, ["cdp"], join(dir, "none.json"))).json();
    expect(out.data).toEqual({ enabled: false, backends: "cdp", paired: false, listening: false, port: null, browsers: 0 });
    expect(started).toBe(false);
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
});
