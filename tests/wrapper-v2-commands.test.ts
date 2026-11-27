import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The wrapper is the daemon's shell client: it turns argv into a route plus a JSON body.
 * These tests stand a fake daemon on a Unix socket, run the real script, and assert the
 * request it made, so the v2 page commands keep sending what src/page-runner.ts reads.
 */

const WRAPPER = resolve(import.meta.dir, "../.agents/skills/browser-control/scripts/browser-control-daemon");

type Recorded = { method: string; path: string; query: string; body: string };
const seen: Recorded[] = [];
let dir = "";
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bc-wrapper-"));
  server = Bun.serve({
    unix: join(dir, "sock"),
    fetch(req) {
      const url = new URL(req.url);
      return (async () => {
        const body = req.method === "GET" ? "" : await req.text();
        seen.push({ method: req.method, path: url.pathname, query: url.search, body });
        return Response.json({ ok: true, data: { value: "ok" } });
      })();
    },
  });
});

afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

async function bc(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", WRAPPER, ...args], {
    env: { ...process.env, BROWSER_CONTROL_DAEMON_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
}

/** Run a command and return only the page request it produced (status probes excluded). */
async function call(...args: string[]): Promise<Recorded> {
  const before = seen.length;
  await bc(...args);
  const made = seen.slice(before).filter((r) => r.path !== "/status");
  expect(made.length).toBe(1);
  return made[0]!;
}

describe("wrapper v2 page commands", () => {
  test("hover sends the ref", async () => {
    const req = await call("hover", "Hover menu");
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/page/hover");
    expect(JSON.parse(req.body)).toEqual({ ref: "Hover menu" });
  });

  test("hover --xy sends a point", async () => {
    const req = await call("hover", "--xy", "120,240");
    expect(req.path).toBe("/page/hover");
    expect(JSON.parse(req.body)).toEqual({ xy: [120, 240] });
  });

  test("hover --xy rejects a malformed point", async () => {
    const res = await bc("hover", "--xy", "120");
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("INPUT_INVALID");
  });

  test("dialog accept sends sub and prompt text", async () => {
    const req = await call("dialog", "accept", "Ada");
    expect(req.path).toBe("/page/dialog");
    expect(JSON.parse(req.body)).toEqual({ sub: "accept", text: "Ada" });
  });

  test("dialog dismiss sends only sub", async () => {
    const req = await call("dialog", "dismiss");
    expect(JSON.parse(req.body)).toEqual({ sub: "dismiss" });
  });

  test("dialog rejects an unknown subcommand", async () => {
    const res = await bc("dialog", "open");
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("INPUT_INVALID");
  });

  test("emulate sends every option under the keys the runner reads", async () => {
    const req = await call(
      "emulate",
      "--viewport", "390x844@3",
      "--mobile",
      "--color-scheme", "dark",
      "--reduced-motion",
      "--offline",
      "--ua", "test-agent",
    );
    expect(req.path).toBe("/page/emulate");
    expect(JSON.parse(req.body)).toEqual({
      viewport: "390x844@3",
      colorScheme: "dark",
      ua: "test-agent",
      mobile: true,
      reducedMotion: true,
      offline: true,
    });
  });

  test("emulate --reset sends only reset", async () => {
    const req = await call("emulate", "--reset");
    expect(JSON.parse(req.body)).toEqual({ reset: true });
  });

  test("emulate without options is rejected before the request", async () => {
    const res = await bc("emulate");
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("INPUT_INVALID");
  });

  test("handoff sends the message and the timeout in seconds", async () => {
    const req = await call("handoff", "Finish the captcha", "--timeout", "2");
    expect(req.path).toBe("/page/handoff");
    expect(JSON.parse(req.body)).toEqual({ message: "Finish the captcha", timeout: 2 });
  });

  test("nav --browser scopes the request to that browser", async () => {
    const req = await call("nav", "https://example.test/", "--browser", "brave");
    expect(req.path).toBe("/nav");
    expect(new URLSearchParams(req.query).get("browser")).toBe("brave");
  });

  test("dialog dismiss takes a target, not prompt text", async () => {
    const r = await call("dialog", "dismiss", "extension:42");
    expect(JSON.parse(r.body)).toEqual({ sub: "dismiss" });
    expect(r.query).toContain("extension%3A42");
  });

  test("dialog accept sends a literal dash as prompt text", async () => {
    const r = await call("dialog", "accept", "-");
    expect(JSON.parse(r.body)).toEqual({ sub: "accept", text: "-" });
  });

  test("hover --xy rejects a coordinate without a leading digit", async () => {
    const before = seen.length;
    const res = await bc("hover", "--xy", ".5,20");
    expect(res.code).not.toBe(0);
    expect(seen.slice(before).filter((r) => r.path !== "/status")).toHaveLength(0);
  });

  test("handoff rejects --timeout 0 and reads 08 as 8 seconds", async () => {
    const res = await bc("handoff", "x", "--timeout", "0");
    expect(res.code).not.toBe(0);
    const r = await call("handoff", "x", "--timeout", "08");
    expect(JSON.parse(r.body)).toEqual({ message: "x", timeout: 8 });
  });

  test("help lists the new commands", async () => {
    const res = await bc("help");
    expect(res.code).toBe(0);
    for (const line of ["hover <ref|label>", "dialog accept", "emulate [--viewport", "handoff <message>", "--browser <slug>"]) {
      expect(res.stdout).toContain(line);
    }
  });
});
