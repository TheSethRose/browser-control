// End-to-end run: headless Chrome for Testing + the unpacked extension + the real skill wrapper and daemon,
// against a local fixture page. Not part of `bun test` (no `.test.ts` name); run with `bun run test:e2e`.
import { spawn, type Subprocess } from "bun";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { E2E_PORT_END, E2E_PORT_START, patchExtensionPorts, pickRelayPort, RELAY_PORTS_ENV } from "./relay-port";
import { runPacingCheck } from "./pacing";
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

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  const clean = detail.replace(/\s+/g, " ").trim().slice(0, 240);
  console.log(ok ? `PASS ${name}` : `FAIL ${name} :: ${clean}`);
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
    console.log("SKIP e2e: Chrome for Testing not found (set BC_E2E_CHROME to its binary).");
    return 0;
  }
  if (!existsSync(WRAPPER)) {
    console.log(`FAIL setup :: wrapper missing at ${WRAPPER}`);
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
  // The pacing check sets natural browsing through the per-run config file, so a caller's env must not pin it.
  const { BROWSER_CONTROL_NATURAL: _natural, ...callerEnv } = process.env;
  const env = {
    ...callerEnv,
    XDG_CONFIG_HOME: xdg,
    BROWSER_CONTROL_BACKENDS: "extension",
    BROWSER_CONTROL_DAEMON_DIR: daemonDir,
    [RELAY_PORTS_ENV]: `${relayPort}-${relayPort}`,
  };

  const bc = async (args: string[], timeoutMs = 45_000): Promise<string> => {
    const proc = spawn([WRAPPER, ...args], { env, stdout: "pipe", stderr: "pipe", cwd: tmp });
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
    process.on(sig, () => void cleanup().finally(() => process.exit(code)));
  }

  try {
    // Fixture servers: two origins (different ports and hostnames) so the iframes are cross-origin.
    const read = (f: string) => readFileSync(join(FIXTURES, f), "utf8");
    const html = { headers: { "content-type": "text/html; charset=utf-8" } };
    const frameServer = Bun.serve({ port: 0, hostname: "localhost", fetch: () => new Response(read("frame.html"), html) });
    servers.push(frameServer);
    const frameUrl = `http://localhost:${frameServer.port}/frame`;
    const pageServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/challenge") return new Response(read("challenge.html"), { ...html, status: 403 });
        if (path === "/popup") return new Response(read("popup.html"), html);
        if (path === "/pacing") return new Response(read("pacing.html"), html);
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
    await sleep(500);
    await check("confirm-accept", ["dialog", "accept"], /^dialog accept: accepted/m);
    await checkEval("confirm-accept-check", "document.getElementById('log').textContent", /confirm true/);
    await evalJs("setTimeout(()=>document.getElementById('cf').click(),50);1");
    await sleep(500);
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
    await runPacingCheck(bc, base, record);
    await runStaleExtensionCheck(chrome, record);
    return results.some((r) => !r.ok) ? 1 : 0;
  } catch (error) {
    record("runner", false, String(error instanceof Error ? error.stack : error));
    return 1;
  } finally {
    await cleanup();
  }
}

process.exit(await main());
