import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dispatchExtensionRequest } from "../daemon";
import { backendOrderSource, setDaemonBackendsFile } from "../src/backends/router";

/**
 * `extension setup` must not leave a global `~/.config/browser-control/backends` file that hides
 * the extension, and `extension status` must say which source set the effective order.
 */

const WRAPPER = resolve(import.meta.dir, "../.agents/skills/browser-control/scripts/browser-control-daemon");

const roots: string[] = [];
async function tempRoot(label: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `bc-${label}-`));
  roots.push(d);
  return d;
}

const savedEnv = process.env["BROWSER_CONTROL_BACKENDS"];
const savedXdg = process.env["XDG_CONFIG_HOME"];
afterEach(() => {
  setDaemonBackendsFile(undefined);
  if (savedEnv === undefined) delete process.env["BROWSER_CONTROL_BACKENDS"];
  else process.env["BROWSER_CONTROL_BACKENDS"] = savedEnv;
  if (savedXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = savedXdg;
});
afterAll(async () => {
  for (const d of roots) await rm(d, { recursive: true, force: true });
});

/** Isolate the config dir and daemon dir, and drop any inherited order overrides. */
async function isolate(label: string): Promise<{ root: string; xdg: string; daemonDir: string; globalFile: string }> {
  const root = await tempRoot(label);
  const xdg = join(root, "xdg");
  const daemonDir = join(root, "daemon");
  await mkdir(join(xdg, "browser-control"), { recursive: true, mode: 0o700 });
  await mkdir(daemonDir, { recursive: true });
  process.env["XDG_CONFIG_HOME"] = xdg;
  delete process.env["BROWSER_CONTROL_BACKENDS"];
  setDaemonBackendsFile(join(daemonDir, "backends"));
  return { root, xdg, daemonDir, globalFile: join(xdg, "browser-control", "backends") };
}

async function setup(
  extDir: string,
  daemonDir: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; data: Record<string, unknown> }> {
  const proc = Bun.spawn(["bash", WRAPPER, "extension", "setup", extDir], {
    env: { ...process.env, BROWSER_CONTROL_DAEMON_DIR: daemonDir, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  const parsed = JSON.parse(stdout) as { ok: boolean; data?: Record<string, unknown> };
  return { code: await proc.exited, stdout, data: parsed.data ?? {} };
}

/** The same date the wrapper uses for backup names (local time, `date +%Y-%m-%d`). */
function today(): string {
  const out = Bun.spawnSync(["date", "+%Y-%m-%d"]);
  return new TextDecoder().decode(out.stdout).trim();
}

async function extFolder(root: string): Promise<string> {
  const ext = join(root, "ext");
  await mkdir(ext, { recursive: true });
  await writeFile(join(ext, "manifest.json"), "{}");
  return ext;
}

describe("extension setup and the global order file", () => {
  test("a global file without extension is backed up and rewritten to extension", async () => {
    const { root, daemonDir, globalFile } = await isolate("setup-global");
    const ext = await extFolder(root);
    await writeFile(globalFile, "browse,cdp\n");
    const res = await setup(ext, daemonDir);
    expect(res.code).toBe(0);
    const backup = `${globalFile}.bak-${today()}`;
    expect(res.data["globalOrder"]).toEqual({ was: "browse,cdp", now: "extension", backup });
    expect((await readFile(globalFile, "utf8")).trim()).toBe("extension");
    expect((await readFile(backup, "utf8")).trim()).toBe("browse,cdp");
    expect(res.data["overriddenBy"]).toBeUndefined();
    expect(res.stdout).not.toContain("token");
  });

  test("a second run keeps the first backup and adds a -2 suffix", async () => {
    const { root, daemonDir, globalFile } = await isolate("setup-backup");
    const ext = await extFolder(root);
    await writeFile(globalFile, "cdp\n");
    await writeFile(`${globalFile}.bak-${today()}`, "older\n");

    const res = await setup(ext, daemonDir);
    expect(res.code).toBe(0);
    expect((res.data["globalOrder"] as Record<string, unknown>)["backup"]).toBe(`${globalFile}.bak-${today()}-2`);
    expect((await readFile(`${globalFile}.bak-${today()}`, "utf8")).trim()).toBe("older");
    expect((await readFile(`${globalFile}.bak-${today()}-2`, "utf8")).trim()).toBe("cdp");
  });

  test("setup reads the whole global file like the router does", async () => {
    const { root, daemonDir, globalFile } = await isolate("setup-multiline");
    const ext = await extFolder(root);
    // A blank first line followed by cdp leaves the extension out: rewritten.
    await writeFile(globalFile, "\ncdp\n");
    const res = await setup(ext, daemonDir);
    expect((res.data["globalOrder"] as Record<string, unknown>)["was"]).toBe("cdp");
    expect((await readFile(globalFile, "utf8")).trim()).toBe("extension");
    // cdp then extension on the next line already includes the extension: untouched.
    const second = await isolate("setup-multiline-keep");
    const ext2 = await extFolder(second.root);
    await writeFile(second.globalFile, "cdp\nextension\n");
    const res2 = await setup(ext2, second.daemonDir);
    expect(res2.data["globalOrder"]).toBeUndefined();
    expect(await readFile(second.globalFile, "utf8")).toBe("cdp\nextension\n");
  });

  test("the rewritten global file and its backup keep the original file mode", async () => {
    const { root, daemonDir, globalFile } = await isolate("setup-mode");
    const ext = await extFolder(root);
    await writeFile(globalFile, "cdp\n", { mode: 0o600 });
    await chmod(globalFile, 0o600);
    const res = await setup(ext, daemonDir);
    const backup = (res.data["globalOrder"] as Record<string, string>)["backup"]!;
    expect((await stat(globalFile)).mode & 0o777).toBe(0o600);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    const leftovers = (await readdir(join(globalFile, ".."))).filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });

  test("a global file that already includes extension is left untouched", async () => {
    const { root, xdg, daemonDir, globalFile } = await isolate("setup-keep");
    const ext = await extFolder(root);
    await writeFile(globalFile, "extension,cdp\n");

    const res = await setup(ext, daemonDir);
    expect(res.code).toBe(0);
    expect(res.data["globalOrder"]).toBeUndefined();
    expect((await readFile(globalFile, "utf8")).trim()).toBe("extension,cdp");
    const entries = (await readdir(join(xdg, "browser-control"))).filter((f) => f.startsWith("backends"));
    expect(entries).toEqual(["backends"]);
  });

  test("an env override is reported and never edited", async () => {
    const { root, daemonDir, globalFile } = await isolate("setup-env");
    const ext = await extFolder(root);
    await writeFile(globalFile, "extension\n");

    const res = await setup(ext, daemonDir, { BROWSER_CONTROL_BACKENDS: "browse,cdp" });
    expect(res.code).toBe(0);
    expect(res.data["overriddenBy"]).toBe("env BROWSER_CONTROL_BACKENDS=browse,cdp");
    expect(res.data["globalOrder"]).toBeUndefined();
    expect((await readFile(globalFile, "utf8")).trim()).toBe("extension");
    expect(process.env["BROWSER_CONTROL_BACKENDS"]).toBeUndefined();
  });
});

const TOKEN = "cd".repeat(32);

describe("extension status orderSource", () => {
  async function statusOrder(iso: Awaited<ReturnType<typeof isolate>>, order: string[], tokenFile?: string) {
    const req = new Request("http://daemon/extension/status");
    const url = new URL("http://daemon/extension/status");
    const res = await dispatchExtensionRequest(req, url, undefined, order, tokenFile ?? join(iso.root, "none.json"));
    const out = (await res!.json()) as { ok: boolean; data: Record<string, unknown> };
    return out.data;
  }

  test("daemon file", async () => {
    const iso = await isolate("src-daemon");
    const file = join(iso.daemonDir, "backends");
    await writeFile(file, "extension,cdp\n");
    setDaemonBackendsFile(file);
    const data = await statusOrder(iso, ["extension", "cdp"]);
    expect(data).toMatchObject({ orderSource: "daemon file", orderSourceValue: "extension,cdp" });
  });

  test("env", async () => {
    const iso = await isolate("src-env");
    await writeFile(iso.globalFile, "cdp\n");
    process.env["BROWSER_CONTROL_BACKENDS"] = "extension,cdp";
    const data = await statusOrder(iso, ["extension", "cdp"]);
    expect(data).toMatchObject({ orderSource: "env", orderSourceValue: "extension,cdp" });
  });

  test("global file", async () => {
    const iso = await isolate("src-global");
    await writeFile(iso.globalFile, "browse,cdp\n");
    const data = await statusOrder(iso, ["browse", "cdp"]);
    expect(data).toMatchObject({ orderSource: "global file", orderSourceValue: "browse,cdp" });
  });

  test("default reports the effective order", async () => {
    const iso = await isolate("src-default");
    const data = await statusOrder(iso, ["cdp"]);
    expect(data).toMatchObject({ orderSource: "default", orderSourceValue: "cdp" });
  });

  test("backendOrderSource names each source and keeps a valid token file private", async () => {
    const iso = await isolate("src-unit");
    expect(backendOrderSource()).toEqual({ source: "default", value: "" });
    await writeFile(iso.globalFile, "extension\n");
    expect(backendOrderSource()).toEqual({ source: "global file", value: "extension" });
    process.env["BROWSER_CONTROL_BACKENDS"] = "cdp";
    expect(backendOrderSource()).toEqual({ source: "env", value: "cdp" });
    const file = join(iso.daemonDir, "backends");
    await writeFile(file, "extension,cdp");
    setDaemonBackendsFile(file);
    expect(backendOrderSource()).toEqual({ source: "daemon file", value: "extension,cdp" });
    await writeFile(join(iso.xdg, "browser-control", "extension-relay.json"), JSON.stringify({ token: TOKEN }), { mode: 0o600 });
    const paired = await statusOrder(iso, ["extension"], join(iso.xdg, "browser-control", "extension-relay.json"));
    expect(paired).toMatchObject({ paired: true, orderSource: "daemon file" });
    expect(existsSync(join(iso.xdg, "browser-control", "extension-relay.json"))).toBe(true);
  });
});
