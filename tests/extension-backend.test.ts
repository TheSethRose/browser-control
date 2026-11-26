import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvokeResult, OperationHandler } from "@agent-software/core";
import {
  CLOSE_AUTH_REFUSED,
  CLOSE_BAD_HELLO,
  CLOSE_VERSION_MISMATCH,
  EXTENSION_ORIGIN,
  PRE_AUTH_MAX_BYTES,
  PROTOCOL_VERSION,
  RELAY_VERSION,
  createExtensionBackend,
  ensureRelayToken,
  extProofMessage,
  hmacHex,
  relayProofMessage,
  setupExtensionPairing,
  type ExtensionBackend,
} from "../src/backends/extension";
import { route } from "../src/backends/router";
import { BackendUnavailable } from "../src/backends/types";
import { PAGE_HELPERS_VERSION } from "../src/page-helpers";
import { createPageHelperHandler } from "../src/page-runner";

const disposables: ExtensionBackend[] = [];
const sockets: WebSocket[] = [];
const tempDirs: string[] = [];

// Use a dedicated local test port window so unit tests never collide with a live daemon on 49222-49229.
let nextPortBase = 49610;
function allocPortWindow(size = 4): { portStart: number; portEnd: number } {
  const portStart = nextPortBase;
  nextPortBase += size;
  return { portStart, portEnd: portStart + size - 1 };
}

afterEach(async () => {
  while (sockets.length > 0) {
    try {
      sockets.pop()!.close();
    } catch {
      /* ignore */
    }
  }
  while (disposables.length > 0) {
    await disposables.pop()!.dispose?.();
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function openWs(url: string, origin: string = EXTENSION_ORIGIN): WebSocket {
  // Bun's WebSocket constructor accepts a `headers` init option for setting Origin in tests.
  const ws = new WebSocket(url, { headers: { Origin: origin } } as unknown as string[]);
  sockets.push(ws);
  return ws;
}

function waitMessage(ws: WebSocket, timeoutMs = 3_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for ws message")), timeoutMs);
    const onMsg = (ev: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      ws.removeEventListener("close", onClose);
      resolve(JSON.parse(String(ev.data)) as Record<string, unknown>);
    };
    const onClose = (ev: CloseEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      ws.removeEventListener("close", onClose);
      reject(new Error(`ws closed early (${ev.code}: ${ev.reason})`));
    };
    ws.addEventListener("message", onMsg);
    ws.addEventListener("close", onClose);
  });
}

function waitClose(ws: WebSocket, timeoutMs = 3_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve({ code: 1006, reason: "" });
      return;
    }
    const timer = setTimeout(() => reject(new Error("timed out waiting for ws close")), timeoutMs);
    ws.addEventListener(
      "close",
      (ev) => {
        clearTimeout(timer);
        resolve({ code: ev.code, reason: ev.reason });
      },
      { once: true },
    );
  });
}

function waitOpen(ws: WebSocket, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("timed out waiting for ws open")), timeoutMs);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("ws error before open"));
      },
      { once: true },
    );
  });
}

type MockHandler = (op: string, params: Record<string, unknown>) => unknown | Promise<unknown>;

async function connectMockExtension(
  port: number,
  token: string,
  onReq?: MockHandler,
): Promise<{
  ws: WebSocket;
  welcome: Record<string, unknown>;
  challenge: Record<string, unknown>;
  daemonProofVerified: boolean;
  receivedReqs: Array<{ id: number; op: string; params: Record<string, unknown> }>;
}> {
  const ws = openWs(`ws://127.0.0.1:${port}/extension`, EXTENSION_ORIGIN);
  await waitOpen(ws);

  const extNonce = randomBytes(16).toString("hex");
  const challengePromise = waitMessage(ws);
  ws.send(
    JSON.stringify({
      type: "hello",
      profileId: "test-profile-1",
      browser: "Chrome",
      version: "2.0.0",
      helpersVersion: PAGE_HELPERS_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      nonce: extNonce,
    }),
  );

  const challenge = await challengePromise;
  expect(challenge["type"]).toBe("auth.challenge");
  const relayNonce = String(challenge["nonce"]);
  const expectedDaemonProof = hmacHex(token, relayProofMessage(port, extNonce, relayNonce));
  const daemonProofVerified = challenge["proof"] === expectedDaemonProof;
  expect(daemonProofVerified).toBe(true);

  const welcomePromise = waitMessage(ws);
  const extProof = hmacHex(token, extProofMessage(port, relayNonce, extNonce));
  ws.send(JSON.stringify({ type: "auth.response", proof: extProof }));
  const welcome = await welcomePromise;

  const receivedReqs: Array<{ id: number; op: string; params: Record<string, unknown> }> = [];
  ws.addEventListener("message", async (ev) => {
    const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
    if (msg["type"] === "req" && typeof msg["id"] === "number") {
      const req = {
        id: msg["id"],
        op: String(msg["op"]),
        params: (msg["params"] as Record<string, unknown>) ?? {},
      };
      receivedReqs.push(req);
      try {
        await Promise.resolve();
        const result = onReq ? await onReq(req.op, req.params) : { ok: true };
        ws.send(JSON.stringify({ type: "res", id: req.id, ok: true, result }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "res", id: req.id, ok: false, error: (err as Error).message }));
      }
    }
  });

  return { ws, welcome, challenge, daemonProofVerified, receivedReqs };
}

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
    read_events: op("read_events", { events: [], nextSeq: 1, dropped: 0 }),
    wait_for_event: op("wait_for_event", { found: false, timedOut: true, waitedMs: 0 }),
    select_target: op("select_target"),
    clear_target: op("clear_target"),
    list_targets: op("list_targets", { targets: [{ targetId: "CDP1", type: "page", title: "cdp", url: "https://cdp" }] }),
    get_browser_status: op("get_browser_status", { connected: false }),
  };
}

describe("extension relay backend", () => {
  test("GET /version returns expected unauthenticated metadata", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 500 });
    disposables.push(backend);
    await backend.start!();

    const port = backend.getPort()!;
    const resp = await fetch(`http://127.0.0.1:${port}/version`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toEqual({
      app: "browser-control",
      version: RELAY_VERSION,
      instanceId: backend.instanceId,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  test("rejects WebSocket upgrade with wrong or missing Origin with 403", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 500 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const wrongOrigin = await fetch(`http://127.0.0.1:${port}/extension`, {
      headers: {
        Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
      },
    });
    expect(wrongOrigin.status).toBe(403);

    const noOrigin = await fetch(`http://127.0.0.1:${port}/extension`, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
      },
    });
    expect(noOrigin.status).toBe(403);
  });

  test("closes with 4002 on bad hello and 4003 on protocol/helpers mismatch", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 500 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    // Bad hello (missing fields)
    const wsBad = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(wsBad);
    const closedBad = waitClose(wsBad);
    wsBad.send(JSON.stringify({ type: "hello", profileId: "p1" }));
    expect((await closedBad).code).toBe(CLOSE_BAD_HELLO);

    // Helpers version mismatch
    const wsMismatch = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(wsMismatch);
    const closedMismatch = waitClose(wsMismatch);
    wsMismatch.send(
      JSON.stringify({
        type: "hello",
        profileId: "p1",
        browser: "Chrome",
        version: "2.0.0",
        helpersVersion: PAGE_HELPERS_VERSION + 1,
        protocolVersion: PROTOCOL_VERSION,
        nonce: randomBytes(16).toString("hex"),
      }),
    );
    expect((await closedMismatch).code).toBe(CLOSE_VERSION_MISMATCH);
  });

  test("closes with 4006 on bad HMAC auth.response", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 500 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const ws = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ws);
    const challengeP = waitMessage(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        profileId: "p1",
        browser: "Chrome",
        version: "2.0.0",
        helpersVersion: PAGE_HELPERS_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        nonce: randomBytes(16).toString("hex"),
      }),
    );
    const challenge = await challengeP;
    expect(challenge["type"]).toBe("auth.challenge");

    const closed = waitClose(ws);
    ws.send(JSON.stringify({ type: "auth.response", proof: "0".repeat(64) }));
    expect((await closed).code).toBe(CLOSE_AUTH_REFUSED);
    expect(backend.isConnected()).toBe(false);
  });

  test("closes socket on oversized pre-auth message (> 64 KB)", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 500 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const ws = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ws);
    const closed = waitClose(ws);
    ws.send("x".repeat(PRE_AUTH_MAX_BYTES + 1024));
    const result = await closed;
    expect(result.code).toBe(1009);
  });

  test("closes socket with 4006 when pre-auth handshake exceeds deadline", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({
      ...allocPortWindow(),
      token,
      handshakeTimeoutMs: 120,
      waitConnectMs: 500,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const ws = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ws);
    const closed = await waitClose(ws, 2_000);
    expect(closed.code).toBe(CLOSE_AUTH_REFUSED);
  });

  test("good mutual HMAC handshake verifies daemon proof and receives welcome", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 500 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const client = await connectMockExtension(port, token);
    expect(client.daemonProofVerified).toBe(true);
    expect(client.welcome["type"]).toBe("welcome");
    expect(client.welcome["instanceId"]).toBe(backend.instanceId);
    expect(client.welcome["protocolVersion"]).toBe(PROTOCOL_VERSION);
    expect(backend.isConnected()).toBe(true);

    // Ping/pong keepalive round-trip
    const pongP = waitMessage(client.ws);
    client.ws.send(JSON.stringify({ type: "ping" }));
    expect(await pongP).toEqual({ type: "pong" });
  });

  test("req/res round-trip for cdp, bc_call, __bc tripwire, RESTRICTED_PAGE fallback, and events", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 1_000 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const client = await connectMockExtension(port, token, (op, params) => {
      if (op === "list_tabs") {
        return { tabs: [{ tabId: 42, url: "http://127.0.0.1/app", title: "App" }] };
      }
      if (op === "cdp") {
        return { result: { echoedMethod: params["method"], echoedParams: params["params"] } };
      }
      if (op === "bc_call") {
        const steps = params["steps"] as Array<{ kind: string; method?: string }>;
        if (steps.length === 3 && steps[0]?.method === "settle") {
          return { values: [undefined, "http://127.0.0.1/app", ""] };
        }
        return { values: ["# App | http://127.0.0.1/app\n- button \"Go\" [e1]"] };
      }
      if (op === "eval") {
        if (String(params["expression"]).includes("restricted")) {
          throw new Error("RESTRICTED_PAGE: cannot access chrome://settings");
        }
        return { value: 42 };
      }
      return { ok: true };
    });

    const cdpLog: string[] = [];
    const ops = route(fakeCdp(cdpLog), [backend], () => ["extension", "cdp"]);

    // list_targets includes extension:42
    const listed = (await ops["list_targets"]!({})) as { targets: Array<{ targetId: string }> };
    expect(listed.targets.map((t) => t.targetId)).toContain("extension:42");

    // select_target + execute_cdp round-trip
    await ops["select_target"]!({ targetId: "extension:42" });
    const cdpRes = (await ops["execute_cdp"]!({
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 10, y: 20 },
    })) as { result: Record<string, unknown> };
    expect(cdpRes.result).toEqual({
      echoedMethod: "Input.dispatchMouseEvent",
      echoedParams: { type: "mousePressed", x: 10, y: 20 },
    });
    expect(cdpLog).toEqual(["list_targets:"]);

    // bc_call combines steps with discard/join/fallback
    const bcRes = await backend.bcCall({
      targetId: "extension:42",
      steps: [
        { kind: "bc", method: "settle", discard: true },
        { kind: "href" },
        { kind: "bc", method: "wall", fallback: "" },
      ],
      join: "\n",
    });
    expect(bcRes.value).toBe("http://127.0.0.1/app\n");

    // Tripwire: evaluate referencing __bc must fail with INTERNAL
    await expect(
      ops["evaluate"]!({ expression: "globalThis.__bc.snapshot()", targetId: "extension:42" }),
    ).rejects.toThrow(/^INTERNAL:/);

    // RESTRICTED_PAGE maps to BackendUnavailable
    const restrictedErr = await backend
      .invoke("evaluate", { expression: "restricted", targetId: "extension:42" })
      .catch((e) => e);
    expect(restrictedErr).toBeInstanceOf(BackendUnavailable);
    expect((restrictedErr as Error).message).toMatch(/RESTRICTED_PAGE/);

    // Event forwarding + read_events
    client.ws.send(
      JSON.stringify({
        type: "event",
        tabId: 42,
        method: "Network.responseReceived",
        params: { requestId: "r1" },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const evs = (await ops["read_events"]!({ method: "Network.responseReceived" })) as {
      events: Array<{ method: string; params: Record<string, unknown> }>;
    };
    expect(evs.events.length).toBe(1);
    expect(evs.events[0]!.params).toEqual({ requestId: "r1" });
  });

  test("second daemon automatically binds the next free port", async () => {
    const token = randomBytes(32).toString("hex");
    const win = allocPortWindow(2);
    const first = createExtensionBackend({ ...win, token, waitConnectMs: 500 });
    const second = createExtensionBackend({ ...win, token, waitConnectMs: 500 });
    const third = createExtensionBackend({ ...win, token, waitConnectMs: 500 });
    disposables.push(first, second, third);

    await first.start!();
    await second.start!();
    expect(first.getPort()).toBe(win.portStart);
    expect(second.getPort()).toBe(win.portStart + 1);
    await expect(third.start!()).rejects.toBeInstanceOf(BackendUnavailable);
  });

  test("ensureRelayToken and setupExtensionPairing create 0600 files respecting XDG_CONFIG_HOME", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-ext-setup-"));
    tempDirs.push(dir);
    const xdgDir = join(dir, "xdg");
    const extDir = join(dir, "extension");
    const tokenFile = join(xdgDir, "browser-control", "extension-relay.json");

    const token = await ensureRelayToken(tokenFile);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const tokenStat = await stat(tokenFile);
    expect(tokenStat.mode & 0o777).toBe(0o600);

    // Re-calling returns the same token
    expect(await ensureRelayToken(tokenFile)).toBe(token);

    const setup = await setupExtensionPairing(extDir, { tokenFile, port: 49222 });
    expect(setup.pairingFile).toBe(join(extDir, "pairing.json"));
    const pairingStat = await stat(setup.pairingFile);
    expect(pairingStat.mode & 0o777).toBe(0o600);
    const pairing = JSON.parse(await readFile(setup.pairingFile, "utf8")) as { token: string; port: number };
    expect(pairing).toEqual({ token, port: 49222 });
  });

  test("page-runner nav/snap/click/type on extension tab uses bc_call and cdp, never evaluate(__bc)", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 1_000 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    let typedValue = "";
    const client = await connectMockExtension(port, token, (op, params) => {
      if (op === "navigate") {
        return { tabId: 77, loaded: true, url: String(params["url"]), title: "Fixture" };
      }
      if (op === "bc_call") {
        const steps = params["steps"] as Array<{ kind: string; method?: string; args?: unknown[] }>;
        return {
          values: steps.map((s) => {
            if (s.kind === "href") return "http://127.0.0.1/fixture";
            if (s.kind === "bc") {
              switch (s.method) {
                case "snapshot":
                  return '# Fixture | http://127.0.0.1/fixture\n- textbox "Name" [e1]\n- button "Save" [e2]';
                case "verifyRef":
                  return "ok";
                case "baseline":
                  return "http://127.0.0.1/fixture";
                case "point":
                  return "100 200 visible";
                case "armInputProbe":
                  return "ok";
                case "readInputProbe":
                  return JSON.stringify({ mousedown: 1, mouseup: 1, click: 1 });
                case "guard":
                  return "ok";
                case "setTypedValue":
                  return "";
                case "cellInfo":
                  return "";
                case "focusForType":
                  return "focused";
                case "value":
                  return typedValue;
                case "settle":
                  return undefined;
                case "diff":
                  return "+ changed";
                case "wall":
                  return "";
                default:
                  return "";
              }
            }
            return "";
          }),
        };
      }
      if (op === "cdp") {
        if (params["method"] === "Input.insertText") {
          typedValue += String((params["params"] as Record<string, unknown>)["text"] ?? "");
        } else if (params["method"] === "Input.dispatchKeyEvent") {
          const p = params["params"] as Record<string, unknown>;
          if (p["type"] === "keyDown" && typeof p["text"] === "string") {
            typedValue += p["text"];
          }
        }
        return { result: {} };
      }
      throw new Error(`unexpected op ${op}`);
    });

    const ops = route(fakeCdp([]), [backend], () => ["extension", "cdp"]);
    const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
      try {
        const data = await ops[op]!(input);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: { code: "EXECUTION_FAILED", message: (err as Error).message } };
      }
    };
    const handlePage = createPageHelperHandler(invoke, undefined, undefined, {
      bcCall: (input) => backend.bcCall(input),
      sleep: async () => {},
      rng: () => 0.5,
    });

    const nav = await handlePage("nav", { url: "http://127.0.0.1/fixture", until: "load" });
    expect(nav.ok).toBe(true);
    if (nav.ok) expect(String((nav.data as Record<string, unknown>)["value"])).toContain("extension:77");

    const snap = await handlePage("snap", {});
    expect(snap.ok).toBe(true);
    if (snap.ok) expect(String((snap.data as Record<string, unknown>)["value"])).toContain('button "Save" [e2]');

    const typed = await handlePage("type", { ref: "e1", text: "Ada", fast: true });
    expect(typed.ok).toBe(true);
    if (typed.ok) expect(String((typed.data as Record<string, unknown>)["value"])).toContain("read back matches");

    const clicked = await handlePage("click", { ref: "e2" });
    expect(clicked.ok).toBe(true);
    if (clicked.ok) expect(String((clicked.data as Record<string, unknown>)["value"])).toContain("delivered");

    // Verify no `eval` op was ever sent to the extension during nav/snap/type/click
    expect(client.receivedReqs.some((r) => r.op === "eval")).toBe(false);
    expect(client.receivedReqs.some((r) => r.op === "bc_call")).toBe(true);
    expect(client.receivedReqs.some((r) => r.op === "cdp")).toBe(true);
  });
});
