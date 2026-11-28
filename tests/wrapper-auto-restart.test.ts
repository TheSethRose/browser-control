import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extensionWaitMs, handleExtensionRoute } from "../daemon";

/**
 * The wrapper restarts a stale daemon by itself only when no remote-debugging (cdp) connection
 * would drop, and `start` with no browser tries the extension before it ever opens cdp.
 * Each test copies the real wrapper beside a fake `runtime/cli.js`, so the wrapper's own
 * `bun runtime/cli.js --serve` restart path runs a fake daemon: no browser, no relay, no ports.
 */

const WRAPPER = resolve(import.meta.dir, "../.agents/skills/browser-control/scripts/browser-control-daemon");

const FAKE_CLI = String.raw`
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const sock = argv[argv.indexOf("--serve") + 1];
const self = createHash("sha256").update(readFileSync(process.argv[1])).digest("hex").slice(0, 12);
const env = process.env;
const build = () => (env.FAKE_STALE_FILE && existsSync(env.FAKE_STALE_FILE) ? "stale0000old" : self);
const connected = () => (env.FAKE_CDP === "1" ? true : false);
const browsers = () => Number(env.FAKE_BROWSERS ?? "1");
appendFileSync(env.FAKE_STARTS, "start\n");
writeFileSync(env.FAKE_PID, String(process.pid));
writeFileSync(sock + ".build", build() + "\n");
Bun.serve({
  unix: sock,
  idleTimeout: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/status") {
      return Response.json({ ok: true, data: { running: true, pid: process.pid, version: "0.0.0", build: build(), connected: connected(), activeTargetId: null } });
    }
    return (async () => {
    const body = req.method === "GET" ? "" : await req.text();
    appendFileSync(env.FAKE_REQUESTS, req.method + " " + url.pathname + url.search + " " + body + "\n");
    if (url.pathname === "/extension/status") {
      return Response.json({
        ok: true,
        data: {
          enabled: env.FAKE_ENABLED !== "0",
          backends: env.FAKE_ORDER || "extension",
          paired: true,
          listening: true,
          port: 49222,
          browsers: browsers(),
        },
      });
    }
    if (url.pathname === "/stop") {
      if (env.FAKE_STALE_FILE) rmSync(env.FAKE_STALE_FILE, { force: true });
      rmSync(sock, { force: true });
      rmSync(sock + ".build", { force: true });
      setTimeout(() => process.exit(0), 5);
      return Response.json({ ok: true, data: { running: false } });
    }
    if (url.pathname === "/tabs") return new Response("# fake browser\n");
    return Response.json({ ok: true, data: { value: "ok" } });
    })();
  },
});
`;

type Run = { code: number; stdout: string; stderr: string };

type Rig = {
  root: string;
  dir: string;
  bc: (...args: string[]) => Promise<Run>;
  requests: () => string[];
  starts: () => number;
};

const rigs: Rig[] = [];

/** A wrapper plus a fake daemon in one throwaway root, with its own daemon dir and env. */
async function rig(options: { stale?: boolean; cdp?: boolean; browsers?: number; order?: string; envOrder?: string } = {}): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "bc-restart-"));
  const skill = join(root, "skill");
  const dir = join(root, "daemon");
  mkdirSync(join(skill, "scripts"), { recursive: true });
  mkdirSync(join(skill, "runtime"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(WRAPPER, join(skill, "scripts", "browser-control-daemon"));
  chmodSync(join(skill, "scripts", "browser-control-daemon"), 0o755);
  writeFileSync(join(skill, "runtime", "cli.js"), FAKE_CLI);

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env["BROWSER_CONTROL_BACKENDS"];
  if (options.envOrder !== undefined) env["BROWSER_CONTROL_BACKENDS"] = options.envOrder;
  env["BROWSER_CONTROL_DAEMON_DIR"] = dir;
  env["FAKE_STARTS"] = join(root, "starts");
  env["FAKE_REQUESTS"] = join(root, "requests");
  env["FAKE_PID"] = join(root, "pid");
  env["FAKE_STALE_FILE"] = join(root, "stale");
  if (options.stale) writeFileSync(env["FAKE_STALE_FILE"], "1\n");
  if (options.cdp) env["FAKE_CDP"] = "1";
  if (options.browsers !== undefined) env["FAKE_BROWSERS"] = String(options.browsers);
  if (options.order !== undefined) env["FAKE_ORDER"] = options.order;

  const script = join(skill, "scripts", "browser-control-daemon");
  const bc = async (...args: string[]): Promise<Run> => {
    const proc = Bun.spawn(["bash", script, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { code: await proc.exited, stdout, stderr };
  };

  const child = Bun.spawn(["bun", join(skill, "runtime", "cli.js"), "--serve", join(dir, "sock")], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  });

  const r: Rig = {
    root,
    dir,
    bc,
    requests: () => (existsSync(env["FAKE_REQUESTS"]!) ? readFileSync(env["FAKE_REQUESTS"]!, "utf8").trim().split("\n").filter(Boolean) : []),
    starts: () => (existsSync(env["FAKE_STARTS"]!) ? readFileSync(env["FAKE_STARTS"]!, "utf8").trim().split("\n").filter(Boolean).length : 0),
  };
  rigs.push(r);
  // Wait for the fake's socket, then let go of the child handle: the wrapper owns the daemon after that.
  for (let i = 0; i < 100; i++) {
    if (existsSync(join(dir, "sock"))) break;
    await Bun.sleep(20);
  }
  child.unref();
  return r;
}

afterAll(() => {
  for (const r of rigs) {
    try {
      process.kill(Number(readFileSync(join(r.root, "pid"), "utf8")), "SIGTERM");
    } catch {
      /* already gone */
    }
    rmSync(r.root, { recursive: true, force: true });
  }
});

const connectBrowser = (r: Rig) => r.requests().filter((line) => line.includes("/call/connect_browser"));

describe("wrapper stale-daemon restart", () => {
  test("restarts a stale daemon once, then runs the command on the new build", async () => {
    const r = await rig({ stale: true });
    const res = await r.bc("tabs");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("# fake browser");
    expect(res.stderr).toContain("restarted the daemon on the new build (the extension reconnects on its own).");
    expect(res.stderr).not.toContain("older build");
    expect(r.starts()).toBe(2);
  });

  test("only warns when a remote-debugging connection is live", async () => {
    const r = await rig({ stale: true, cdp: true });
    const res = await r.bc("tabs");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("# fake browser");
    expect(res.stderr).toContain("running daemon is an older build");
    expect(res.stderr).toContain("stop --force");
    expect(r.starts()).toBe(1);
  });

  test("two concurrent stale calls restart the daemon once", async () => {
    const r = await rig({ stale: true });
    const [a, b] = await Promise.all([r.bc("tabs"), r.bc("tabs")]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(r.starts()).toBe(2);
    const lines = `${a.stderr}\n${b.stderr}`.split("\n").filter((l) => l.includes("restarted the daemon on the new build"));
    expect(lines).toHaveLength(1);
  }, 15_000);
});

describe("wrapper start", () => {
  test("BROWSER_CONTROL_BACKENDS=extension never posts connect_browser", async () => {
    const r = await rig({ envOrder: "extension", browsers: 1 });
    const res = await r.bc("start");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('"backends":"extension"');
    expect(connectBrowser(r)).toHaveLength(0);
    expect(r.requests().some((line) => line.includes("/extension/status"))).toBe(true);
  });

  test("BROWSER_CONTROL_BACKENDS=extension stays off cdp even when the daemon order is cdp", async () => {
    const r = await rig({ envOrder: "extension", order: "cdp", browsers: 0 });
    const res = await r.bc("start");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('"backends":"cdp"');
    expect(connectBrowser(r)).toHaveLength(0);
  });

  test("with no explicit order, a connected extension is used and connect_browser is never posted", async () => {
    const r = await rig({ browsers: 1 });
    const res = await r.bc("start");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('"browsers":1');
    expect(connectBrowser(r)).toHaveLength(0);
    expect(r.requests().some((line) => line.includes("/extension/status?wait=10000"))).toBe(true);
  });

  test("with no explicit order, a missing extension falls back to cdp with one notice line", async () => {
    const r = await rig({ browsers: 0 });
    const res = await r.bc("start");
    expect(res.code).toBe(0);
    expect(connectBrowser(r)).toHaveLength(1);
    const notice = res.stderr.split("\n").filter((l) => l.includes("the extension is not connected, so this uses remote debugging"));
    expect(notice).toHaveLength(1);
    expect(notice[0]).toBe(
      "browser-control-daemon: the extension is not connected, so this uses remote debugging (Chrome may ask you to Allow).",
    );
  });

  test("start 9222 still connects over cdp by name", async () => {
    const r = await rig({ browsers: 1 });
    const res = await r.bc("start", "9222");
    expect(res.code).toBe(0);
    const posted = connectBrowser(r);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('"port":9222');
  });
});

describe("daemon /extension/status?wait", () => {
  test("clamps the wait to 0..60 s and ignores junk", () => {
    const at = (query: string) => extensionWaitMs(new URL(`http://daemon/extension/status${query}`));
    expect(at("")).toBeUndefined();
    expect(at("?wait=10000")).toBe(10_000);
    expect(at("?wait=999999")).toBe(60_000);
    expect(at("?wait=-5")).toBe(0);
    expect(at("?wait=abc")).toBeUndefined();
  });

  test("wait=0 answers from the current state without waiting for a connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bc-wait-"));
    let waited = 0;
    const backend = {
      instanceId: "inst",
      getPort: () => 49222,
      async status() {
        return { listening: true, port: 49222, protocolVersion: 1, browsers: [] };
      },
      getConnectedBrowsers: () => [],
      async request() {
        return {};
      },
      async waitForConnection() {
        waited += 1;
      },
    };
    try {
      const res = await handleExtensionRoute(
        "status",
        backend as never,
        ["extension"],
        join(dir, "relay.json"),
        undefined,
        0,
      );
      const out = (await res.json()) as { data: { enabled: boolean; browsers: number } };
      expect(out.data.enabled).toBe(true);
      expect(out.data.browsers).toBe(0);
      expect(waited).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
