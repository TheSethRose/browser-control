// End-to-end run: headless Chrome for Testing + the unpacked extension + the real skill wrapper and daemon,
// against a local fixture page. Not part of `bun test` (no `.test.ts` name); run with `bun run test:e2e`.
import { spawn, type Subprocess } from "bun";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { E2E_PORT_END, E2E_PORT_START, patchExtensionPorts, pickRelayPort, RELAY_PORTS_ENV } from "./relay-port";
import { runPacingCheck, type NavEntry } from "./pacing";
import { runStaleExtensionCheck } from "./stale-extension";

const REPO = resolve(import.meta.dir, "../..");
const FIXTURES = join(import.meta.dir, "fixtures");
const WRAPPER = join(REPO, ".agents/skills/browser-control/scripts/browser-control-daemon");
const CFT_BINARY = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

function findChrome(): string | undefined {
  const fromEnv = process.env["BC_E2E_CHROME"];
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  const roots = [
    join(homedir(), ".cache/puppeteer/chrome"),
    join(homedir(), ".cache/browser-control/cft/chrome"),
    join(homedir(), ".cache/ms-playwright"),
  ];
  const patterns = [
    `*/chrome-mac-arm64/${CFT_BINARY}`,
    `*/chrome-mac-x64/${CFT_BINARY}`,
    `*/chrome-mac/${CFT_BINARY}`,
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const pattern of patterns) {
      for (const hit of new Glob(pattern).scanSync({ cwd: root, onlyFiles: false, followSymlinks: false })) {
        const full = join(root, hit);
        if (existsSync(full)) return full;
      }
    }
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
const REQUIRED = process.env["BC_E2E_REQUIRED"] === "1";
const skips: { name: string; reason: string }[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  const clean = detail.replace(/\s+/g, " ").trim().slice(0, 240);
  console.log(ok ? `PASS ${name}` : `FAIL ${name} :: ${clean}`);
}
// A skipped check is never a pass: it prints its own line and is counted apart from passed/failed.
function recordSkip(name: string, reason: string) {
  skips.push({ name, reason });
  console.log(`SKIP ${name} :: ${reason}`);
}
function printTotals() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const line = `e2e: ${passed} passed, ${failed} failed`;
  console.log(skips.length > 0 ? `${line}, ${skips.length} skipped` : line);
}

// ---- minimal CDP client (only used to press the handoff card's Continue button with a trusted click) ----
class Cdp {
  private id = 0;
  private pending = new Map<number, (msg: any) => void>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) this.pending.get(msg.id)?.(msg), this.pending.delete(msg.id);
    });
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => res(new Cdp(ws)));
      ws.addEventListener("error", () => rej(new Error("CDP websocket failed")));
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`CDP timeout: ${method}`)), 10_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result);
      });
    });
  }
  close() {
    this.ws.close();
  }
}

type DomNode = {
  nodeId: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
};

function findHandoffButton(node: DomNode, insideHost = false): number | undefined {
  const isHost = (node.attributes ?? []).includes("data-bc-handoff-host");
  const inHost = insideHost || isHost;
  if (inHost && node.nodeName === "BUTTON") {
    const text = (node.children ?? []).map((c) => c.nodeValue ?? "").join("");
    if (text.trim() === "Continue") return node.nodeId;
  }
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const hit = findHandoffButton(child, inHost);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

async function interactWithHandoff(
  cdp: Cdp,
  urlPrefix: string,
  typeOpts?: { selector: string; text: string },
): Promise<{ clicked: string; typedValue?: string; cardUpDuringType?: boolean }> {
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const pages = (targetInfos as any[]).filter((t) => t.type === "page" && String(t.url).startsWith(urlPrefix));
    for (const page of pages) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      try {
        const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, sessionId);
        const nodeId = findHandoffButton(root);
        if (nodeId === undefined) continue;

        let typedValue: string | undefined;
        let cardUpDuringType: boolean | undefined;
        if (typeOpts) {
          const { nodeId: inputNodeId } = await cdp.send(
            "DOM.querySelector",
            { nodeId: root.nodeId, selector: typeOpts.selector },
            sessionId,
          );
          if (inputNodeId) {
            const { model: inputModel } = await cdp.send("DOM.getBoxModel", { nodeId: inputNodeId }, sessionId);
            const iq: number[] = inputModel.content;
            const ix = (iq[0]! + iq[4]!) / 2;
            const iy = (iq[1]! + iq[5]!) / 2;
            for (const type of ["mousePressed", "mouseReleased"]) {
              await cdp.send("Input.dispatchMouseEvent", { type, x: ix, y: iy, button: "left", clickCount: 1 }, sessionId);
            }
            for (const ch of typeOpts.text) {
              await cdp.send(
                "Input.dispatchKeyEvent",
                { type: "keyDown", text: ch, unmodifiedText: ch, key: ch },
                sessionId,
              );
              await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, sessionId);
            }
            const evalRes = await cdp.send(
              "Runtime.evaluate",
              {
                expression: `JSON.stringify({ value: document.querySelector(${JSON.stringify(typeOpts.selector)})?.value ?? "", cardUp: !!document.querySelector('[data-bc-handoff-host]') })`,
                returnByValue: true,
              },
              sessionId,
            );
            const parsed = JSON.parse(String(evalRes?.result?.value ?? "{}")) as {
              value?: string;
              cardUp?: boolean;
            };
            typedValue = parsed.value;
            cardUpDuringType = parsed.cardUp;
          }
        }

        const { model } = await cdp.send("DOM.getBoxModel", { nodeId }, sessionId);
        const q: number[] = model.content;
        const x = (q[0]! + q[4]!) / 2;
        const y = (q[1]! + q[5]!) / 2;
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sessionId);
        }
        return { clicked: "clicked", typedValue, cardUpDuringType };
      } finally {
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    }
    await sleep(250);
  }
  return { clicked: "Continue button never appeared" };
}

// ---- main ----
async function main(): Promise<number> {
  const chrome = findChrome();
  if (!chrome) {
    // A required run (CI gate) must never pass on a missing browser.
    if (REQUIRED) {
      record("e2e", false, "BC_E2E_REQUIRED=1 but Chrome for Testing was not found (set BC_E2E_CHROME to its binary)");
      return 1;
    }
    recordSkip("e2e", "Chrome for Testing not found (set BC_E2E_CHROME to its binary)");
    return 0;
  }
  if (!existsSync(WRAPPER)) {
    record("setup", false, `wrapper missing at ${WRAPPER}`);
    return 1;
  }

  // Isolated relay port: the daemon binds it and the copied extension probes only it, so this run
  // can never touch 49222-49229 where the user's live daemon listens.
  const relayPort = await pickRelayPort();
  if (relayPort === undefined) {
    record("e2e-relay-port", false, `no free port in ${E2E_PORT_START}-${E2E_PORT_END} for the isolated test relay`);
    return 1;
  }

  const tmp = mkdtempSync(join(tmpdir(), "bc-e2e-"));
  const profile = join(tmp, "profile");
  const ext = join(tmp, "ext");
  const xdg = join(tmp, "xdg");
  const daemonDir = join(tmp, "daemon");
  for (const d of [profile, xdg, daemonDir]) mkdirSync(d, { recursive: true });
  const uploadFile = join(tmp, "e2e-upload.txt");
  writeFileSync(uploadFile, "upload me\n");

  const servers: ReturnType<typeof Bun.serve>[] = [];
  let browser: Subprocess | undefined;
  let cdp: Cdp | undefined;
  // The caller's agent session must not key these runs; the session cases set their own. The pacing check
  // switches natural browsing through the per-run config file, and the env would override it, so drop that too.
  const inherited: Record<string, string | undefined> = { ...process.env };
  for (const k of [
    "BROWSER_CONTROL_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "T3CODE_THREAD_ID",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "BROWSER_CONTROL_NATURAL",
  ]) {
    delete inherited[k];
  }
  const env = {
    ...inherited,
    XDG_CONFIG_HOME: xdg,
    BROWSER_CONTROL_BACKENDS: "extension",
    BROWSER_CONTROL_DAEMON_DIR: daemonDir,
    // The pacing check reads each planned think pause from the `do` output; without this the daemon adds no
    // trace line, so callers see the same output as always.
    BC_E2E_PACING_TRACE: "1",
    [RELAY_PORTS_ENV]: `${relayPort}-${relayPort}`,
  };

  const bc = async (args: string[], timeoutMs = 45_000, extraEnv: Record<string, string> = {}): Promise<string> => {
    const proc = spawn([WRAPPER, ...args], { env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe", cwd: tmp });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    clearTimeout(timer);
    return (out + err).trim();
  };
  const check = async (name: string, args: string[], expect: RegExp, timeoutMs?: number) => {
    const out = await bc(args, timeoutMs);
    record(name, expect.test(out), out);
    return out;
  };
  const evalJs = (expr: string) => bc(["eval", expr]);
  const checkEval = async (name: string, expr: string, expect: RegExp) => {
    const out = await evalJs(expr);
    record(name, expect.test(out), out);
  };
  // A page call refused with DIALOG_OPEN means the extension has seen the dialog, so `dialog` can handle it.
  // A fixed sleep raced that detection on a loaded machine.
  const waitForDialog = async (ms = 10_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      if (/DIALOG_OPEN/.test(await evalJs("1"))) return;
    }
  };

  let cleaned: Promise<void> | undefined;
  const cleanup = () =>
    (cleaned ??= (async () => {
      cdp?.close();
      browser?.kill();
      const exited = browser ? await Promise.race([browser.exited.then(() => true), sleep(5000).then(() => false)]) : true;
      if (!exited) browser?.kill("SIGKILL");
      // The wrapper starts a daemon on this run's private socket dir; stop only that one.
      const pg = spawn(["pgrep", "-f", daemonDir], { stdout: "pipe" });
      const pids = (await new Response(pg.stdout).text()).split(/\s+/).filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {}
      }
      for (const s of servers) s.stop(true);
      await sleep(300);
      rmSync(tmp, { recursive: true, force: true });
      const pass = results.filter((r) => r.ok).length;
      const fail = results.length - pass;
      console.log(`SUMMARY ${pass} pass, ${fail} fail`);
    })());
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.on(sig, () => void cleanup().finally(() => {
      printTotals();
      process.exit(code);
    }));
  }

  try {
    // Fixture servers: two origins (different ports and hostnames) so the iframes are cross-origin.
    // Every request is stamped so the pacing check can measure nav dispatch gaps at the server.
    const navLog: NavEntry[] = [];
    const read = (f: string) => readFileSync(join(FIXTURES, f), "utf8");
    const html = { headers: { "content-type": "text/html; charset=utf-8" } };
    const frameServer = Bun.serve({
      port: 0,
      hostname: "localhost",
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        navLog.push({ path, t: Date.now() });
        return path === "/next"
          ? new Response("<!doctype html><title>E2E Next</title><p>next page ready</p>", html)
          : new Response(read("frame.html"), html);
      },
    });
    servers.push(frameServer);
    const frameUrl = `http://localhost:${frameServer.port}/frame`;
    const pageServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        navLog.push({ path, t: Date.now() });
        if (path === "/form") return new Response(read("form.html"), html);
        if (path === "/busy") return new Response("<!doctype html><title>E2E Busy</title><p>busy page</p>", html);
        // Keeps the form page loading for 3 s after DOMContentLoaded, as slow trackers do on real sites.
        if (path === "/slow.png") return sleep(3000).then(() => new Response(PIXEL, { headers: { "content-type": "image/png" } }));
        if (path === "/challenge") return new Response(read("challenge.html"), { ...html, status: 403 });
        if (path === "/challenge-wall") return new Response(read("challenge-wall.html"), html);
        if (path === "/popup") return new Response(read("popup.html"), html);
        if (path === "/pacing") return new Response(read("pacing.html"), html);
        if (path === "/pacing-short") return new Response(read("pacing-short.html"), html);
        if (path === "/pacing-long") return new Response(read("pacing-long.html"), html);
        if (path.startsWith("/paging-")) return new Response(read("pacing-short.html"), html);
        if (path === "/pacing-wall") return new Response(read("pacing-wall.html"), html);
        return new Response(read("page.html").replaceAll("__FRAME__", frameUrl), html);
      },
    });
    servers.push(pageServer);
    const base = `http://127.0.0.1:${pageServer.port}`;

    // Unpacked extension copy, paired with this run's private config dir.
    cpSync(join(REPO, "extension"), ext, { recursive: true, filter: (p) => !p.endsWith("pairing.json") });
    const portPatch = patchExtensionPorts(ext, relayPort);
    record("e2e-port-patch", portPatch.ok, portPatch.detail);
    if (!portPatch.ok) return 1;
    const setup = spawn(["bun", "./cli.ts", "extension-setup", ext], { cwd: REPO, env, stdout: "ignore", stderr: "pipe" });
    if ((await setup.exited) !== 0) {
      record("setup", false, `extension-setup failed: ${(await new Response(setup.stderr).text()).slice(0, 200)}`);
      return 1;
    }

    browser = spawn(
      [
        chrome,
        "--headless=new",
        "--use-mock-keychain",
        "--password-store=basic",
        `--user-data-dir=${profile}`,
        `--load-extension=${ext}`,
        `--disable-extensions-except=${ext}`,
        "--remote-debugging-port=0",
        "--window-size=1200,900",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );

    // Wait for the DevTools port file and for the extension to reach the daemon.
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 60 && !existsSync(portFile); i++) await sleep(250);
    if (!existsSync(portFile)) {
      record("launch", false, "Chrome for Testing did not write DevToolsActivePort");
      return 1;
    }
    const [devPort, wsPath] = readFileSync(portFile, "utf8").trim().split("\n");
    cdp = await Cdp.open(`ws://127.0.0.1:${devPort}${wsPath}`);

    let tabs = "";
    for (let i = 0; i < 20 && !/extension:/.test(tabs); i++) {
      tabs = await bc(["tabs"], 15_000);
      if (!/extension:/.test(tabs)) await sleep(1000);
    }
    record("connect", /extension:/.test(tabs), tabs);
    if (!/extension:/.test(tabs)) return 1;
    const relayStatus = await bc(["extension", "status"]);
    record(
      "e2e-relay-port",
      new RegExp(`"port":\\s*${relayPort}\\b`).test(relayStatus) && !/"port":\s*4922[2-9]\b/.test(relayStatus),
      relayStatus,
    );

    await check("nav", ["nav", `${base}/`], /E2E Fixture/);
    await checkEval("nav-title", "document.title", /E2E Fixture/);

    // Shadow DOM.
    await check("shadow-click", ["click", "Shadow button"], /./);
    await checkEval("shadow-click-check", "document.getElementById('sh').shadowRoot.getElementById('sbtn').textContent", /shadow clicked/);
    await check("shadow-type", ["type", "Shadow input", "deep"], /./);
    await checkEval("shadow-type-check", "document.getElementById('sh').shadowRoot.getElementById('sin').value", /deep/);

    // Two cross-origin iframes with the same URL, each with its own input.
    await check("frame-a-type", ["type", "Frame A input", "alpha"], /delivered|typed/);
    await check("frame-b-type", ["type", "Frame B input", "bravo"], /delivered|typed/);
    await check("frame-a-value", ["value", "Frame A input"], /alpha/);
    await check("frame-b-value", ["value", "Frame B input"], /bravo/);
    const aOut = await bc(["value", "Frame A input"]);
    record("frame-a-not-b", !/bravo/.test(aOut), aOut);

    // File input.
    await check("upload", ["upload", "Upload file", uploadFile], /e2e-upload\.txt/);
    await checkEval("upload-check", "document.getElementById('log').textContent", /file e2e-upload\.txt/);

    // Hash link.
    await check("hash-click", ["click", "Jump to section"], /./);
    await checkEval("hash-check", "location.hash", /#section/);

    // confirm: accept, then dismiss.
    await evalJs("setTimeout(()=>document.getElementById('cf').click(),50);1");
    await waitForDialog();
    await check("confirm-accept", ["dialog", "accept"], /^dialog accept: accepted/m);
    await checkEval("confirm-accept-check", "document.getElementById('log').textContent", /confirm true/);
    await evalJs("setTimeout(()=>document.getElementById('cf').click(),50);1");
    await waitForDialog();
    await check("confirm-dismiss", ["dialog", "dismiss"], /^dialog dismiss: dismissed/m);
    await checkEval("confirm-dismiss-check", "document.getElementById('log').textContent", /confirm false/);

    // alert: the click reports the open dialog, then dismiss it.
    await check("alert-detect", ["click", "Alert me"], /dialog|alert|DIALOG/);
    await check("alert-dismiss", ["dialog", "dismiss"], /^dialog dismiss: dismissed/m);
    await checkEval("alert-check", "document.getElementById('log').textContent", /alert closed/);

    // target=_blank popup opens a new tab.
    await check("popup-click", ["click", "Open popup"], /./);
    let tabList = "";
    for (let i = 0; i < 10 && !/\/popup/.test(tabList); i++) {
      tabList = await bc(["tabs"]);
      if (!/\/popup/.test(tabList)) await sleep(500);
    }
    record("popup-tab", /\/popup/.test(tabList), tabList);
    await checkEval("popup-opener-still-routed", "document.title", /E2E Fixture/);

    // Simulated Cloudflare / Turnstile challenge.
    await check("challenge", ["nav", `${base}/challenge`], /CHALLENGE:/);

    // A challenge page stops `do` and `fill` before step 1. The fixture's form is real and counts its own
    // presses and inputs, so zero clicks and zero typed values are measured, not inferred.
    const wallState = "JSON.stringify({v:document.getElementById('wall-field').value,pressed:window.__pressed,typed:window.__typed,submitted:window.__submitted})";
    const untouched = (s: string) => /"v":""/.test(s) && /"pressed":0/.test(s) && /"typed":0/.test(s) && /"submitted":0/.test(s);
    await check("challenge-wall-nav", ["nav", `${base}/challenge-wall`], /CHALLENGE:|WALL:/);
    const wallFill = await check("challenge-wall-fill-stops", ["fill", JSON.stringify({ "Wall field": "nope" })], /STOPPED: .*before step 1/);
    const afterFill = await evalJs(wallState);
    record("challenge-wall-fill-untouched", /1 step\(s\) not run/.test(wallFill) && untouched(afterFill), `${afterFill} ${wallFill}`);
    const wallDo = await check(
      "challenge-wall-do-stops",
      ["do", JSON.stringify([{ click: "Wall button" }, { type: ["Wall field", "nope"] }])],
      /STOPPED: .*before step 1/,
    );
    const afterDo = await evalJs(wallState);
    record("challenge-wall-do-untouched", /2 step\(s\) not run/.test(wallDo) && untouched(afterDo), `${afterDo} ${wallDo}`);

    // Handoff 1: times out, clears itself, tab restored.
    await bc(["nav", `${base}/`]);
    await check("handoff-timeout", ["handoff", "E2E handoff", "--timeout", "2"], /HANDOFF_TIMEOUT/, 60_000);
    await checkEval("handoff-timeout-cleared", "String(!!document.querySelector('[data-bc-handoff-host]'))", /false/);

    // Handoff 2: while the card is up, the user can focus and type on the page, then click Continue -> "done".
    const pending = bc(["handoff", "E2E continue", "--timeout", "30"], 60_000);
    await sleep(500);
    const handoffAction = await interactWithHandoff(cdp, base, {
      selector: "#handoff-input",
      text: "human-ok",
    });
    record(
      "handoff-type-while-up",
      handoffAction.cardUpDuringType === true && handoffAction.typedValue === "human-ok",
      JSON.stringify(handoffAction),
    );
    record("handoff-continue-click", handoffAction.clicked === "clicked", handoffAction.clicked);
    const done = await Promise.race([pending, sleep(15_000).then(() => "TIMED OUT waiting for handoff to return")]);
    record("handoff-done", /handoff: done/.test(done), done);
    await checkEval("handoff-done-cleared", "String(!!document.querySelector('[data-bc-handoff-host]'))", /false/);
    await checkEval("handoff-tab-usable", "document.title", /E2E Fixture/);

    // Restricted chrome:// page refuses with EXTENSION_ONLY and never connects to CDP.
    const pageCount = async () =>
      ((await cdp!.send("Target.getTargets")).targetInfos as Array<{ type: string }>).filter((t) => t.type === "page")
        .length;
    await check("restricted-chrome-nav", ["nav", "chrome://version"], /EXTENSION_ONLY/);
    await check("restricted-chrome-eval", ["eval", "document.title"], /EXTENSION_ONLY/);
    const statusAfterRestricted = await bc(["status"]);
    record(
      "restricted-no-cdp",
      /"connected":\s*false/.test(statusAfterRestricted) && !/"alsoConnected"/.test(statusAfterRestricted),
      statusAfterRestricted,
    );
    await check("return-after-restricted", ["nav", `${base}/`], /E2E Fixture/);

    // Refused nav that creates a new tab closes that tab before returning the error.
    await bc(["call", "clear_target"]);
    const tabsBeforeRefusedNew = await pageCount();
    await check("restricted-new-tab-refused", ["nav", "chrome://version"], /EXTENSION_ONLY/);
    await sleep(300);
    const tabsAfterRefusedNew = await pageCount();
    record(
      "restricted-new-tab-closed",
      tabsAfterRefusedNew === tabsBeforeRefusedNew,
      `before=${tabsBeforeRefusedNew} after=${tabsAfterRefusedNew}`,
    );

    // close: open a new agent tab, close it, confirm it is gone.
    const openedOut = await check("close-open-agent-tab", ["nav", `${base}/`], /E2E Fixture/);
    const openedId = /"targetId":"(extension:[^"]+)"/.exec(openedOut)?.[1] ?? "";
    record("close-open-agent-tab-id", openedId !== "", openedOut);
    const tabsBeforeClose = await pageCount();
    await check("close-agent-tab", ["close", openedId], /closed extension:/);
    await sleep(300);
    const tabsAfterClose = await pageCount();
    const tabsAfterCloseList = await bc(["tabs"]);
    record(
      "close-agent-tab-gone",
      tabsAfterClose === tabsBeforeClose - 1 && openedId !== "" && !tabsAfterCloseList.includes(openedId),
      `before=${tabsBeforeClose} after=${tabsAfterClose} id=${openedId}`,
    );

    // Session reuse: one session's tab-less navs share a tab; another session or --new-tab gets its own.
    const tabOf = (out: string) => /"targetId":"(extension:[^"]+)"/.exec(out)?.[1] ?? "";
    const sessA = { BROWSER_CONTROL_SESSION: "e2e-session-a" };
    const navs = [
      await bc(["nav", `${base}/`], 45_000, sessA),
      await bc(["nav", `${base}/form`], 45_000, sessA),
      await bc(["nav", `${base}/`], 45_000, { BROWSER_CONTROL_SESSION: "e2e-session-b" }),
      await bc(["nav", `${base}/`, "--new-tab"], 45_000, sessA),
    ];
    const [idA1, idA2, idB1, idANew] = navs.map(tabOf);
    record("session-tab-reused", idA1 !== "" && idA1 === idA2 && /reused this session's tab/.test(navs[1]!), `${navs[0]}\n${navs[1]}`);
    record("session-tab-separate", idB1 !== "" && idB1 !== idA1, `${idA1} ${idB1}`);
    record("session-new-tab", idANew !== "" && idANew !== idA1 && idANew !== idB1, `${idA1} ${idANew}`);
    for (const id of new Set([idA1, idB1, idANew])) if (id) await bc(["close", id]);

    // Fresh tab, nav, then an immediate natural 10-field fill, five times; every field must read back exactly.
    const steps = JSON.stringify([
      { type: ["Full name", "Ada Lovelace"] },
      { type: ["Email address", "ada@example.com"] },
      { type: ["Phone number", "5550100"] },
      { type: ["Company", "Analytical Engines"] },
      { type: ["Website", "https://example.com"] },
      { type: ["Start date", "2026-11-27"] },
      { select: ["Country", "Canada"] },
      { type: ["Notes", "First program"] },
      { click: "Accept terms" },
      { click: "Pro plan" },
    ]);
    const want = "Ada Lovelace|ada@example.com|5550100|Analytical Engines|https://example.com|2026-11-27|ca|First program|true|pro";
    const readBack =
      "['name','email','phone','company','site','date','country','notes'].map((k)=>document.getElementById('f-'+k).value)" +
      ".concat(String(document.getElementById('f-terms').checked), document.querySelector('[name=plan]:checked')?.value ?? '').join('|')";
    const fillMs: number[] = [];
    for (let run = 1; run <= 5; run++) {
      await bc(["call", "clear_target"]);
      const navOut = await bc(["nav", `${base}/form`]);
      const formTab = /"targetId":"(extension:[^"]+)"/.exec(navOut)?.[1] ?? "";
      const t0 = Date.now();
      const out = await bc(["do", steps], 120_000);
      fillMs.push(Date.now() - t0);
      const got = await evalJs(readBack);
      record(`natural-fill-fresh-${run}`, formTab !== "" && !/FAILED|STOPPED/.test(out) && got.includes(want), `${got} :: ${out}`);
      if (formTab) await bc(["close", formTab]);
    }
    console.log(`TIMING natural-fill-fresh ms=${fillMs.join(",")}`);

    // A 600-character natural type in one step must not hit a per-call timer, and must read back exactly.
    const longText = Array.from({ length: 600 }, (_, i) => "abcdefghij klmnopqrst uvwxyz.,"[i % 30]).join("");
    await bc(["call", "clear_target"]);
    const longNav = await bc(["nav", `${base}/form`]);
    const longTab = /"targetId":"(extension:[^"]+)"/.exec(longNav)?.[1] ?? "";
    const typeT0 = Date.now();
    const longOut = await bc(["do", JSON.stringify([{ type: ["Notes", longText] }])], 300_000);
    const typeMs = Date.now() - typeT0;
    const longGot = await evalJs(`String(document.getElementById('f-notes').value === ${JSON.stringify(longText)})`);
    record("natural-type-600", !/FAILED|STOPPED/.test(longOut) && /true/.test(longGot), `${longGot} ${typeMs}ms :: ${longOut}`);
    console.log(`TIMING natural-type-600 ms=${typeMs}`);
    if (longTab) await bc(["close", longTab]);

    // A browser-side tabs.update commits a new document while a helper call waits on a busy page.
    // Chrome never answers the old document's executeScript; the call must rerun on the new page.
    await bc(["call", "clear_target"]);
    const busyNav = await bc(["nav", `${base}/busy`]);
    const busyTab = /"targetId":"(extension:[^"]+)"/.exec(busyNav)?.[1] ?? "";
    await evalJs("setTimeout(()=>{const t=performance.now()+6000;while(performance.now()<t);},300);1");
    await sleep(450);
    const replaceT0 = Date.now();
    const pendingRead = bc(["text"], 60_000);
    await sleep(1200);
    const sw = ((await cdp.send("Target.getTargets")).targetInfos as Array<{ type: string; url: string; targetId: string }>).find(
      (x) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"),
    );
    let updated = "no extension service worker";
    if (sw) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
      const res = await cdp.send(
        "Runtime.evaluate",
        {
          expression: `(async()=>{const t=(await chrome.tabs.query({})).find((x)=>(x.url||"").includes("/busy"));if(!t)return "no busy tab";await chrome.tabs.update(t.id,{url:${JSON.stringify(`http://localhost:${frameServer.port}/next`)}});return "updated";})()`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      );
      updated = String(res?.result?.value ?? JSON.stringify(res));
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
    const replacedOut = await pendingRead;
    const replaceMs = Date.now() - replaceT0;
    record(
      "nav-replace-during-call",
      updated === "updated" && /next page ready/.test(replacedOut) && replaceMs < 15_000,
      `${updated} ${replaceMs}ms :: ${replacedOut}`,
    );
    if (busyTab) await bc(["close", busyTab]);

    // The backends file the wrapper writes steers the shipped daemon and outranks the env var.
    const tid = /extension:[A-Za-z0-9:@-]*[A-Za-z0-9]/.exec(await bc(["tabs"]))?.[0] ?? "";
    record("tab-id", tid !== "", tid);
    const backendsFile = join(daemonDir, "backends");
    await check("disable", ["extension", "disable"], /"backends":"cdp"/);
    record("disable-wrote-cdp", existsSync(backendsFile) && readFileSync(backendsFile, "utf8").trim() === "cdp", backendsFile);
    await check("disabled-refuses", ["eval", "document.title", tid], /extension backend is disabled/);
    await check("enable", ["extension", "enable"], /"orderFile":"removed"/);
    record("enable-deleted-file", !existsSync(backendsFile), backendsFile);
    await check("enabled-works", ["eval", "document.title", tid], /E2E Fixture/);
    await runPacingCheck(bc, base, record, { navLog, frameUrl });
    // The stale-extension check archives the pre-PR #10 build; a shallow clone cannot, so say so out loud.
    const oldCommit = "b8b976f";
    const hasOldCommit =
      (await spawn(["git", "-C", REPO, "rev-parse", "--verify", `${oldCommit}^{commit}`], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited) === 0;
    if (hasOldCommit) await runStaleExtensionCheck(chrome, record);
    else if (REQUIRED) record("stale-extension", false, `commit ${oldCommit} not present in this clone (fetch full history)`);
    else recordSkip("stale-extension", `commit ${oldCommit} not present in this clone (fetch full history)`);
    return results.some((r) => !r.ok) ? 1 : 0;
  } catch (error) {
    record("runner", false, String(error instanceof Error ? error.stack : error));
    return 1;
  } finally {
    await cleanup();
  }
}

// One finalizer: totals print for normal completion and for setup/cleanup exceptions alike.
let code = 1;
try {
  code = await main();
} catch (error) {
  record("runner", false, String(error instanceof Error ? error.stack : error));
} finally {
  printTotals();
}
process.exit(code);
