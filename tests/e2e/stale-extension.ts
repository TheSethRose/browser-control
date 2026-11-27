// Live Chrome for Testing check against the pre-PR #10 (b8b976f) extension build.
// Verifies that an outdated extension is never invisible:
//   1. extension status & diagnostics show browsers: 0, the 4003 handshake record, and the reload fix line,
//   2. EXTENSION_ONLY errors use that same reload fix line instead of bare "did not connect within",
//   3. the relay closes both the rejected WebSocket (4003) and the /version probe socket (no lingering ESTABLISHED socket).
//
// Run standalone: BC_E2E_CHROME=<path> bun tests/e2e/stale-extension.ts
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { OperationHandler } from "@agent-software/core";
import {
  CLOSE_VERSION_MISMATCH,
  createExtensionBackend,
  extensionDiagnosticsReport,
  extensionStatusReport,
  setupExtensionPairing,
  type RelayHandshakeRecord,
} from "../../src/backends/extension";
import { route } from "../../src/backends/router";

const REPO = resolve(import.meta.dir, "../..");
const OLD_COMMIT = "b8b976f";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type StaleCheckRecord = (name: string, ok: boolean, detail: string) => void;

export async function runStaleExtensionCheck(
  chrome: string,
  record: StaleCheckRecord = (name, ok, detail) => {
    const clean = detail.replace(/\s+/g, " ").trim().slice(0, 240);
    console.log(ok ? `PASS ${name}` : `FAIL ${name} :: ${clean}`);
  },
): Promise<boolean> {
  // Confirm b8b976f is reachable in git history (shallow clones may lack it).
  const verify = spawn(["git", "-C", REPO, "rev-parse", "--verify", `${OLD_COMMIT}^{commit}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await verify.exited) !== 0) {
    console.log(`SKIP stale-extension: commit ${OLD_COMMIT} not present in this clone`);
    return true;
  }

  const tmp = mkdtempSync(join(tmpdir(), "bc-e2e-stale-"));
  const profile = join(tmp, "profile");
  const xdg = join(tmp, "xdg");
  const oldParent = join(tmp, "old");
  const oldExt = join(oldParent, "extension");
  for (const d of [profile, xdg, oldParent]) mkdirSync(d, { recursive: true });

  const tokenFile = join(xdg, "browser-control", "extension-relay.json");
  // Dedicated isolated port window outside 49222-49229 so we never touch the user's daemon or browser.
  const backend = createExtensionBackend({
    portStart: 49510,
    portEnd: 49530,
    tokenFile,
    waitConnectMs: 1_000,
    listTargetsWaitMs: 1_000,
  });

  let browser: Subprocess | undefined;
  let allOk = true;
  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) allOk = false;
    record(name, ok, detail);
  };

  try {
    const archive = spawn(
      ["bash", "-c", `git -C "${REPO}" archive ${OLD_COMMIT} extension | tar -x -C "${oldParent}"`],
      { stdout: "ignore", stderr: "pipe" },
    );
    if ((await archive.exited) !== 0) {
      check("stale-extract", false, await new Response(archive.stderr).text());
      return false;
    }

    await backend.start!();
    const port = backend.getPort()!;
    await setupExtensionPairing(oldExt, { tokenFile, port });

    browser = spawn(
      [
        chrome,
        "--headless=new",
        "--use-mock-keychain",
        "--password-store=basic",
        `--user-data-dir=${profile}`,
        `--load-extension=${oldExt}`,
        `--disable-extensions-except=${oldExt}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );

    // Wait for the b8b976f extension to probe /version and get rejected with 4003.
    let status: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      status = await extensionStatusReport(backend, ["extension"], tokenFile, 0);
      const handshakes = (status["handshakes"] as RelayHandshakeRecord[] | undefined) ?? [];
      if (handshakes.some((h) => h.stage === "rejected" && h.closeCode === CLOSE_VERSION_MISMATCH)) break;
      await sleep(250);
    }

    const handshakes = (status["handshakes"] as RelayHandshakeRecord[] | undefined) ?? [];
    const fix = String(status["fix"] ?? "");
    check(
      "stale-status-fix",
      status["browsers"] === 0 &&
        /Extension connected but uses helpers v\d+ \(need v\d+\): reload Browser Control at chrome:\/\/extensions\./.test(fix) &&
        handshakes.some((h) => h.stage === "rejected" && h.closeCode === CLOSE_VERSION_MISMATCH && typeof h.helpersVersion === "number"),
      JSON.stringify({ browsers: status["browsers"], fix, handshakes }),
    );

    const diag = (await extensionDiagnosticsReport(backend, ["extension"], { tokenFile, waitMs: 0 })) as {
      daemon: Record<string, unknown>;
      browsers: unknown[];
    };
    check(
      "stale-diagnostics-fix",
      diag.browsers.length === 0 && diag.daemon["fix"] === fix,
      JSON.stringify(diag.daemon),
    );

    // EXTENSION_ONLY error on list_targets surfaces the exact reload fix line.
    const dummyCdp: Record<string, OperationHandler> = {
      list_targets: async () => ({ targets: [] }),
      get_browser_status: async () => ({ connected: false }),
      clear_target: async () => ({}),
    };
    const ops = route(dummyCdp, [backend], () => ["extension"]);
    const tabErr = await Promise.resolve(ops["list_targets"]!({})).then(
      () => "",
      (e: unknown) => (e as Error).message,
    );
    check(
      "stale-extension-only-error",
      tabErr.startsWith("EXTENSION_ONLY:") &&
        tabErr.includes("reload Browser Control at chrome://extensions") &&
        !tabErr.includes("did not connect within"),
      tabErr,
    );

    // Confirm no lingering ESTABLISHED socket stays open on the isolated relay port.
    await sleep(300);
    const lsof = spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED"], { stdout: "pipe", stderr: "ignore" });
    const lsofOut = (await new Response(lsof.stdout).text()).trim();
    await lsof.exited;
    const stillPending = backend.getHandshakeRecords().some((r) => r.stage !== "rejected");
    check("stale-socket-closed", !stillPending && lsofOut === "", lsofOut || "no ESTABLISHED sockets");

    return allOk;
  } finally {
    browser?.kill();
    const exited = browser
      ? await Promise.race([browser.exited.then(() => true), sleep(5_000).then(() => false)])
      : true;
    if (!exited) browser?.kill("SIGKILL");
    await backend.dispose?.();
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const chrome = process.env["BC_E2E_CHROME"];
  if (!chrome || !existsSync(chrome)) {
    console.log("SKIP stale-extension: set BC_E2E_CHROME to Chrome for Testing binary");
    process.exit(0);
  }
  const ok = await runStaleExtensionCheck(chrome);
  process.exit(ok ? 0 : 1);
}
