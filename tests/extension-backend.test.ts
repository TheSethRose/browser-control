import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvokeResult, OperationHandler } from "@agent-software/core";
import {
  CHUNK_MAX_DATA_BYTES,
  CLOSE_AUTH_REFUSED,
  CLOSE_BAD_HELLO,
  CLOSE_VERSION_MISMATCH,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  PAIR_CODE_MAX_FAILURES,
  PRE_AUTH_MAX_BYTES,
  PROTOCOL_VERSION,
  RELAY_VERSION,
  TRANSPORT_MAX_PAYLOAD_BYTES,
  allocateBrowserSlug,
  createExtensionBackend,
  createPairingCode,
  ensureRelayToken,
  extProofMessage,
  hmacHex,
  parseExtensionTargetId,
  relayProofMessage,
  setupExtensionPairing,
  type ExtensionBackend,
} from "../src/backends/extension";
// @ts-expect-error plain JS MV3 module
import * as extPairingRaw from "../extension/lib/pairing.js";
// @ts-expect-error plain JS MV3 module
import * as extFramesRaw from "../extension/lib/frames.js";

type ExtPairingMod = {
  normalizePairingCode(raw: string): string | null;
  formatPairingCode(raw: string): string;
  selectAuthCredentials(
    stored: Record<string, unknown>,
    fileCfg: Record<string, unknown> | null,
    defaultPort?: number,
  ): { port: number; mode: "browser" | "bootstrap" | "none"; token: string; tokenId?: string; pairingId?: string };
  unwrapBootstrapToken(params: {
    wrappedToken: Record<string, unknown>;
    bootstrapToken: string;
    port: number;
    extNonce: string;
    relayNonce: string;
    profileId: string;
  }): Promise<{ token: string; tokenId: string }>;
  startCodePairing(): Promise<{ keyPair: CryptoKeyPair; ecdhPub: string; extNonce: string }>;
  buildPairResponse(params: {
    code: string;
    port: number;
    extNonce: string;
    relayNonce: string;
    extPubB64: string;
    relayPubB64: string;
    keyPair: CryptoKeyPair;
    salt: string;
    iterations: number;
  }): Promise<{ extProof: string; expectedRelayProof: string; pairKey: Uint8Array }>;
  verifyPairWelcome(params: {
    welcome: Record<string, unknown>;
    expectedRelayProof: string;
    pairKey: Uint8Array;
    port: number;
    extNonce: string;
    relayNonce: string;
    profileId: string;
  }): Promise<{ ok: true; token: string; tokenId: string; slug?: string } | { ok: false; error: string }>;
};

type ExtFramesMod = {
  encodeMessage(
    obj: Record<string, unknown>,
    options?: { id?: string; maxDataBytes?: number; maxFrameBytes?: number; maxTotalBytes?: number },
  ):
    | { ok: true; frames: string[]; chunked: boolean; totalBytes: number; id?: string }
    | { ok: false; error: string; totalBytes: number };
  createFrameDecoder(options?: {
    maxDataBytes?: number;
    maxTotalBytes?: number;
  }): {
    push(msg: Record<string, unknown>):
      | { kind: "message"; message: Record<string, unknown> }
      | { kind: "pending" }
      | { kind: "ignored" }
      | { kind: "error"; id: string; reqId?: number; error: string };
    clear(id?: string): void;
    size(): number;
  };
};

const {
  buildPairResponse,
  formatPairingCode,
  normalizePairingCode,
  selectAuthCredentials,
  startCodePairing,
  unwrapBootstrapToken,
  verifyPairWelcome,
} = extPairingRaw as unknown as ExtPairingMod;
const { createFrameDecoder, encodeMessage } = extFramesRaw as unknown as ExtFramesMod;
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

type MockConnectOpts = {
  profileId?: string;
  browser?: string;
  name?: string;
  tokenId?: string;
  chunkedResponses?: boolean;
  maxChunkDataBytes?: number;
  manualRequests?: boolean;
};

async function connectMockExtension(
  port: number,
  token: string,
  onReq?: MockHandler,
  opts: MockConnectOpts = {},
): Promise<{
  ws: WebSocket;
  welcome: Record<string, unknown>;
  challenge: Record<string, unknown>;
  extNonce: string;
  relayNonce: string;
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
      profileId: opts.profileId ?? "test-profile-1",
      browser: opts.browser ?? "Chrome",
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.tokenId ? { tokenId: opts.tokenId } : {}),
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
  const decoder = createFrameDecoder();
  if (!opts.manualRequests) {
    ws.addEventListener("message", async (ev) => {
      const rawMsg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      const decoded = decoder.push(rawMsg);
      if (decoded.kind !== "message") return;
      const msg = decoded.message as Record<string, unknown>;
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
          const resObj = { type: "res", id: req.id, ok: true, result };
          if (opts.chunkedResponses) {
            const enc = encodeMessage(resObj, {
              maxDataBytes: opts.maxChunkDataBytes ?? CHUNK_MAX_DATA_BYTES,
            });
            if (!enc.ok) {
              ws.send(JSON.stringify({ type: "res", id: req.id, ok: false, error: enc.error }));
            } else {
              for (const f of enc.frames) ws.send(f);
            }
          } else {
            ws.send(JSON.stringify(resObj));
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: "res", id: req.id, ok: false, error: (err as Error).message }));
        }
      }
    });
  }

  return { ws, welcome, challenge, extNonce, relayNonce, daemonProofVerified, receivedReqs };
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
    const pairing = JSON.parse(await readFile(setup.pairingFile, "utf8")) as {
      token: string;
      port: number;
      pairingId: string;
    };
    expect(setup.pairingId).toMatch(/^[0-9a-f]{32}$/);
    expect(pairing).toEqual({ token, port: 49222, pairingId: setup.pairingId });
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

describe("relay token files", () => {
  const { mkdtempSync, writeFileSync, statSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join: pjoin } = require("node:path") as typeof import("node:path");
  const { tmpdir: ptmp } = require("node:os") as typeof import("node:os");
  const { ensureRelayToken: ensure, setupExtensionPairing: setup } = require("../src/backends/extension") as typeof import("../src/backends/extension");

  test("concurrent first starts agree on one token", async () => {
    const file = pjoin(mkdtempSync(pjoin(ptmp(), "bc-tok-")), "extension-relay.json");
    const tokens = await Promise.all(Array.from({ length: 16 }, () => ensure(file)));
    expect(new Set(tokens).size).toBe(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("the daemon refuses a token file others can read, and setup replaces it", async () => {
    const dir = mkdtempSync(pjoin(ptmp(), "bc-tok-"));
    const file = pjoin(dir, "extension-relay.json");
    const leaked = "a".repeat(64);
    writeFileSync(file, JSON.stringify({ token: leaked }), { mode: 0o644 });
    await expect(ensure(file)).rejects.toThrow("not private or not valid");
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(leaked);
    const ext = pjoin(dir, "ext");
    require("node:fs").mkdirSync(ext);
    await setup(ext, { tokenFile: file });
    const token = JSON.parse(readFileSync(file, "utf8")).token;
    expect(token).not.toBe(leaked);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(pjoin(ext, "pairing.json"), "utf8")).token).toBe(token);
  });

  test("concurrent daemons never rotate a broken token file", async () => {
    const file = pjoin(mkdtempSync(pjoin(ptmp(), "bc-tok-")), "extension-relay.json");
    writeFileSync(file, "not json", { mode: 0o600 });
    const results = await Promise.allSettled(Array.from({ length: 16 }, () => ensure(file)));
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("not json");
  });

  test("pairing.json replaces an existing open file with a private one", async () => {
    const dir = mkdtempSync(pjoin(ptmp(), "bc-pair-"));
    const ext = pjoin(dir, "ext");
    require("node:fs").mkdirSync(ext);
    writeFileSync(pjoin(ext, "pairing.json"), "{}", { mode: 0o644 });
    const { pairingFile } = await setup(ext, { tokenFile: pjoin(dir, "relay.json") });
    expect(statSync(pairingFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(pairingFile, "utf8")).token).toMatch(/^[0-9a-f]{64}$/);
  });
});

function waitMessageOrClose(
  ws: WebSocket,
  timeoutMs = 3_000,
): Promise<{ kind: "msg"; msg: Record<string, unknown> } | { kind: "closed"; closed: { code: number; reason: string } }> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve({ kind: "closed", closed: { code: 1006, reason: "" } });
      return;
    }
    const timer = setTimeout(() => reject(new Error("timed out waiting for ws message or close")), timeoutMs);
    const onMsg = (ev: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      ws.removeEventListener("close", onClose);
      resolve({ kind: "msg", msg: JSON.parse(String(ev.data)) as Record<string, unknown> });
    };
    const onClose = (ev: CloseEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      ws.removeEventListener("close", onClose);
      resolve({ kind: "closed", closed: { code: ev.code, reason: ev.reason } });
    };
    ws.addEventListener("message", onMsg);
    ws.addEventListener("close", onClose);
  });
}

async function runCodePairingHandshake(
  port: number,
  code: string,
  opts: { profileId?: string; browser?: string; name?: string } = {},
): Promise<{
  ws: WebSocket;
  welcome?: Record<string, unknown>;
  unwrapped?: { token: string; tokenId: string; slug?: string };
  closed?: { code: number; reason: string };
}> {
  const profileId = opts.profileId ?? "pair-profile-1";
  const browser = opts.browser ?? "Brave";
  const ws = openWs(`ws://127.0.0.1:${port}/extension`, EXTENSION_ORIGIN);
  await waitOpen(ws);

  const started = await startCodePairing();
  const challengeOrClose = waitMessageOrClose(ws);
  ws.send(
    JSON.stringify({
      type: "pair.hello",
      profileId,
      browser,
      ...(opts.name ? { name: opts.name } : {}),
      version: "2.0.0",
      helpersVersion: PAGE_HELPERS_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      nonce: started.extNonce,
      ecdhPub: started.ecdhPub,
    }),
  );

  const first = await challengeOrClose;
  if (first.kind === "closed") return { ws, closed: first.closed };
  expect(first.msg["type"]).toBe("pair.challenge");

  const relayNonce = String(first.msg["nonce"]);
  const relayPubB64 = String(first.msg["ecdhPub"]);
  const salt = String(first.msg["salt"]);
  const iterations = Number(first.msg["iterations"]);

  const built = await buildPairResponse({
    code,
    port,
    extNonce: started.extNonce,
    relayNonce,
    extPubB64: started.ecdhPub,
    relayPubB64,
    keyPair: started.keyPair,
    salt,
    iterations,
  });

  const welcomeOrClose = waitMessageOrClose(ws);
  ws.send(JSON.stringify({ type: "pair.response", proof: built.extProof }));

  const second = await welcomeOrClose;
  if (second.kind === "closed") return { ws, closed: second.closed };

  const verified = await verifyPairWelcome({
    welcome: second.msg,
    expectedRelayProof: built.expectedRelayProof,
    pairKey: built.pairKey,
    port,
    extNonce: started.extNonce,
    relayNonce,
    profileId,
  });
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error(verified.error);

  return {
    ws,
    welcome: second.msg,
    unwrapped: { token: verified.token, tokenId: verified.tokenId, slug: verified.slug },
  };
}

describe("Phase 2 slice B: hardened relay pairing, BrowserLinks, and chunked frames", () => {
  test("per-browser token is minted, wrapped with AES-256-GCM/HKDF, persisted 0600, and reused on reconnect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-per-browser-"));
    tempDirs.push(dir);
    const tokenFile = join(dir, "extension-relay.json");
    const browsersFile = join(dir, "extension-browsers.json");
    const extDir = join(dir, "ext");

    const setup = await setupExtensionPairing(extDir, { tokenFile, port: 49222 });
    const pairingFile = JSON.parse(await readFile(setup.pairingFile, "utf8")) as {
      token: string;
      port: number;
      pairingId: string;
    };

    const backend = createExtensionBackend({
      ...allocPortWindow(),
      tokenFile,
      browsersFile,
      hostname: "MacBook-Pro.local",
      waitConnectMs: 500,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    // First connection authenticates with bootstrap token from pairing.json
    const firstCreds = selectAuthCredentials({}, pairingFile);
    expect(firstCreds.mode).toBe("bootstrap");
    expect(firstCreds.token).toBe(pairingFile.token);
    expect(firstCreds.tokenId).toBeUndefined();

    const first = await connectMockExtension(port, firstCreds.token, undefined, {
      profileId: "prof-chrome-1",
      browser: "Chrome",
    });
    expect(first.welcome["slug"]).toBe("chrome-macbook-pro");
    expect(first.welcome["wrappedToken"]).toBeDefined();

    // Unwrap per-browser token via extension/lib/pairing.js (Web Crypto AES-256-GCM + HKDF-SHA256)
    const unwrapped = await unwrapBootstrapToken({
      wrappedToken: first.welcome["wrappedToken"] as Record<string, unknown>,
      bootstrapToken: firstCreds.token,
      port,
      extNonce: first.extNonce,
      relayNonce: first.relayNonce,
      profileId: "prof-chrome-1",
    });
    expect(unwrapped.token).toMatch(/^[0-9a-f]{64}$/);
    expect(unwrapped.token).not.toBe(pairingFile.token);
    expect(unwrapped.tokenId).toMatch(/^[0-9a-f]{32}$/);

    // Wrong profileId (AAD mismatch) must fail AES-GCM unwrap
    await expect(
      unwrapBootstrapToken({
        wrappedToken: first.welcome["wrappedToken"] as Record<string, unknown>,
        bootstrapToken: firstCreds.token,
        port,
        extNonce: first.extNonce,
        relayNonce: first.relayNonce,
        profileId: "wrong-profile-id",
      }),
    ).rejects.toThrow();

    // Stored in extension-browsers.json with 0600 permissions
    const browsersStat = await stat(browsersFile);
    expect(browsersStat.mode & 0o777).toBe(0o600);
    const browsersData = JSON.parse(await readFile(browsersFile, "utf8")) as {
      browsers: Record<string, { slug: string; token: string; tokenId: string }>;
    };
    expect(browsersData.browsers["prof-chrome-1"]?.slug).toBe("chrome-macbook-pro");
    expect(browsersData.browsers["prof-chrome-1"]?.token).toBe(unwrapped.token);
    expect(browsersData.browsers["prof-chrome-1"]?.tokenId).toBe(unwrapped.tokenId);

    // Reconnect using stored per-browser token + tokenId (selectAuthCredentials chooses browser token)
    const stored = {
      browserToken: unwrapped.token,
      browserTokenId: unwrapped.tokenId,
      pairingId: pairingFile.pairingId,
    };
    const nextCreds = selectAuthCredentials(stored, pairingFile);
    expect(nextCreds.mode).toBe("browser");
    expect(nextCreds.token).toBe(unwrapped.token);
    expect(nextCreds.tokenId).toBe(unwrapped.tokenId);

    first.ws.close();
    await waitClose(first.ws);

    const second = await connectMockExtension(port, nextCreds.token, undefined, {
      profileId: "prof-chrome-1",
      browser: "Chrome",
      tokenId: nextCreds.tokenId,
    });
    expect(second.welcome["type"]).toBe("welcome");
    expect(second.welcome["slug"]).toBe("chrome-macbook-pro");
    expect(second.welcome["wrappedToken"]).toBeUndefined();

    // Unknown tokenId is refused with 4006
    const badWs = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(badWs);
    const badClosed = waitClose(badWs);
    badWs.send(
      JSON.stringify({
        type: "hello",
        profileId: "prof-chrome-1",
        browser: "Chrome",
        version: "2.0.0",
        helpersVersion: PAGE_HELPERS_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        nonce: randomBytes(16).toString("hex"),
        tokenId: "f".repeat(32),
      }),
    );
    expect((await badClosed).code).toBe(CLOSE_AUTH_REFUSED);
  });

  test("newer pairing.json pairingId wins over stored per-browser token and rotates cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-rotate-"));
    tempDirs.push(dir);
    const tokenFile = join(dir, "extension-relay.json");
    const browsersFile = join(dir, "extension-browsers.json");
    const extDir = join(dir, "ext");

    const setup1 = await setupExtensionPairing(extDir, { tokenFile, port: 49222 });
    const file1 = JSON.parse(await readFile(setup1.pairingFile, "utf8")) as {
      token: string;
      port: number;
      pairingId: string;
    };

    const backend = createExtensionBackend({
      ...allocPortWindow(),
      tokenFile,
      browsersFile,
      hostname: "studio",
      waitConnectMs: 500,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    // First bootstrap mints token T1
    const c1 = await connectMockExtension(port, file1.token, undefined, {
      profileId: "prof-rot",
      browser: "Chrome",
    });
    const t1 = await unwrapBootstrapToken({
      wrappedToken: c1.welcome["wrappedToken"] as Record<string, unknown>,
      bootstrapToken: file1.token,
      port,
      extNonce: c1.extNonce,
      relayNonce: c1.relayNonce,
      profileId: "prof-rot",
    });
    const stored = {
      browserToken: t1.token,
      browserTokenId: t1.tokenId,
      pairingId: file1.pairingId,
    };
    c1.ws.close();
    await waitClose(c1.ws);

    // Re-run setup -> new pairingId beats stored per-browser token
    const setup2 = await setupExtensionPairing(extDir, { tokenFile, port: 49222 });
    expect(setup2.pairingId).not.toBe(setup1.pairingId);
    const file2 = JSON.parse(await readFile(setup2.pairingFile, "utf8")) as {
      token: string;
      port: number;
      pairingId: string;
    };

    const creds = selectAuthCredentials(stored, file2);
    expect(creds.mode).toBe("bootstrap");
    expect(creds.token).toBe(file2.token);
    expect(creds.tokenId).toBeUndefined();
    expect(creds.pairingId).toBe(file2.pairingId);

    // Reconnecting with bootstrap mints a fresh per-browser token T2 and keeps stable slug
    const c2 = await connectMockExtension(port, creds.token, undefined, {
      profileId: "prof-rot",
      browser: "Chrome",
    });
    const t2 = await unwrapBootstrapToken({
      wrappedToken: c2.welcome["wrappedToken"] as Record<string, unknown>,
      bootstrapToken: creds.token,
      port,
      extNonce: c2.extNonce,
      relayNonce: c2.relayNonce,
      profileId: "prof-rot",
    });
    expect(t2.token).not.toBe(t1.token);
    expect(t2.tokenId).not.toBe(t1.tokenId);
    expect(c2.welcome["slug"]).toBe("chrome-studio");

    // Old T1 is no longer accepted
    const oldWs = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(oldWs);
    const oldClosed = waitClose(oldWs);
    oldWs.send(
      JSON.stringify({
        type: "hello",
        profileId: "prof-rot",
        browser: "Chrome",
        version: "2.0.0",
        helpersVersion: PAGE_HELPERS_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        nonce: randomBytes(16).toString("hex"),
        tokenId: t1.tokenId,
      }),
    );
    expect((await oldClosed).code).toBe(CLOSE_AUTH_REFUSED);
  });

  test("code pairing: Crockford normalization, ECDH+PBKDF2 success, token reuse, and single-use spend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-pair-code-"));
    tempDirs.push(dir);
    const tokenFile = join(dir, "extension-relay.json");
    const codesFile = join(dir, "extension-pairing-codes.json");
    const browsersFile = join(dir, "extension-browsers.json");

    expect(normalizePairingCode("o i l - 2 3 4 5 6")).toBe("01123456");
    expect(formatPairingCode("01123456")).toBe("0112-3456");
    expect(normalizePairingCode("bad!")).toBeNull();

    const backend = createExtensionBackend({
      ...allocPortWindow(),
      tokenFile,
      browsersFile,
      codesFile,
      hostname: "mini",
      waitConnectMs: 500,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    // Mint code via standalone helper (same path as `bun ./cli.ts extension-pair`)
    const issued = await createPairingCode({ codesFile });
    expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(issued.url).toBe(
      `chrome-extension://${EXTENSION_ID}/onboarding.html#code=${encodeURIComponent(issued.code)}`,
    );
    expect(issued.expiresInSeconds).toBe(600);
    // Stored hashed (plaintext code never appears on disk) and 0600
    const rawCodesFile = await readFile(codesFile, "utf8");
    expect((await stat(codesFile)).mode & 0o777).toBe(0o600);
    expect(rawCodesFile).not.toContain(issued.code);
    expect(rawCodesFile).not.toContain(normalizePairingCode(issued.code)!);

    // Pair using lowercase + confusable formatting to verify Crockford normalization
    const paired = await runCodePairingHandshake(port, issued.code.toLowerCase().replace("-", " "), {
      profileId: "prof-brave-1",
      browser: "Brave",
    });
    expect(paired.closed).toBeUndefined();
    expect(paired.unwrapped?.slug).toBe("brave-mini");
    expect(paired.unwrapped?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(backend.isConnected()).toBe(true);

    // verifyPairWelcome rejects a forged relay proof before unwrapping
    const forgedCheck = await verifyPairWelcome({
      welcome: { ...(paired.welcome ?? {}), proof: "0".repeat(64) },
      expectedRelayProof: "1".repeat(64),
      pairKey: new Uint8Array(32),
      port,
      extNonce: "a".repeat(32),
      relayNonce: "b".repeat(32),
      profileId: "prof-brave-1",
    });
    expect(forgedCheck.ok).toBe(false);

    // Reusing the same code a second time fails with 4006 (spent)
    const reuse = await runCodePairingHandshake(port, issued.code, {
      profileId: "prof-brave-2",
      browser: "Brave",
    });
    expect(reuse.closed?.code).toBe(CLOSE_AUTH_REFUSED);
    expect(reuse.closed?.reason).toMatch(/used/i);

    // The newly paired browser can disconnect and reconnect with its per-browser token
    paired.ws.close();
    await waitClose(paired.ws);

    const reconnected = await connectMockExtension(port, paired.unwrapped!.token, undefined, {
      profileId: "prof-brave-1",
      browser: "Brave",
      tokenId: paired.unwrapped!.tokenId,
    });
    expect(reconnected.welcome["type"]).toBe("welcome");
    expect(reconnected.welcome["slug"]).toBe("brave-mini");
  });

  test("code pairing: wrong code closes 4006, 5 failures burn the code, and expiry rejects", async () => {
    let fakeNow = 1_700_000_000_000;
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({
      ...allocPortWindow(),
      token,
      waitConnectMs: 500,
      now: () => fakeNow,
      pairRateLimitMax: 20,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const issued = await backend.createPairingCode({ ttlMs: 10 * 60 * 1000 });
    const wrongCode = issued.code.startsWith("0") ? "1111-1111" : "0000-0000";

    // 5 wrong attempts all close with 4006 and burn the code
    for (let i = 0; i < PAIR_CODE_MAX_FAILURES; i++) {
      const attempt = await runCodePairingHandshake(port, wrongCode, { profileId: `bad-${i}` });
      expect(attempt.closed?.code).toBe(CLOSE_AUTH_REFUSED);
    }

    // Even the real code is now rejected with 4006 because it was burned
    const afterBurn = await runCodePairingHandshake(port, issued.code, { profileId: "good-too-late" });
    expect(afterBurn.closed?.code).toBe(CLOSE_AUTH_REFUSED);
    expect(afterBurn.closed?.reason).toMatch(/burned/i);

    // Expiry test: mint a new code, advance clock past 10 minutes -> rejected with 4006
    const expiring = await backend.createPairingCode({ ttlMs: 10 * 60 * 1000 });
    fakeNow += 10 * 60 * 1000 + 1;
    const afterExpiry = await runCodePairingHandshake(port, expiring.code, { profileId: "expired-prof" });
    expect(afterExpiry.closed?.code).toBe(CLOSE_AUTH_REFUSED);
    expect(afterExpiry.closed?.reason).toMatch(/expired/i);
  });

  test("code pairing: rate-limits repeated failed attempts with 4006", async () => {
    let fakeNow = 1_700_000_000_000;
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({
      ...allocPortWindow(),
      token,
      waitConnectMs: 500,
      now: () => fakeNow,
      pairRateLimitMax: 3,
      pairRateLimitWindowMs: 60_000,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const issued = await backend.createPairingCode();
    const wrongCode = issued.code.startsWith("0") ? "1111-1111" : "0000-0000";

    for (let i = 0; i < 3; i++) {
      const res = await runCodePairingHandshake(port, wrongCode);
      expect(res.closed?.code).toBe(CLOSE_AUTH_REFUSED);
    }

    // 4th attempt hits rate limit immediately even with the correct code
    const limited = await runCodePairingHandshake(port, issued.code);
    expect(limited.closed?.code).toBe(CLOSE_AUTH_REFUSED);
    expect(limited.closed?.reason).toMatch(/rate limit/i);

    // After window passes, the correct code works (only 3 failures recorded on it < 5)
    fakeNow += 61_000;
    const ok = await runCodePairingHandshake(port, issued.code);
    expect(ok.closed).toBeUndefined();
    expect(ok.unwrapped?.token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("BrowserLinks: stable slugs with -2 collision, distinct target IDs for same tabId, and browser routing", async () => {
    // Slug allocation unit check
    const used = new Set<string>();
    const s1 = allocateBrowserSlug("Chrome", used, { hostname: "MacBook.local" });
    used.add(s1);
    const s2 = allocateBrowserSlug("Chrome", used, { hostname: "MacBook.local" });
    used.add(s2);
    const s3 = allocateBrowserSlug("Brave", used, { hostname: "MacBook.local" });
    expect([s1, s2, s3]).toEqual(["chrome-macbook", "chrome-macbook-2", "brave-macbook"]);

    expect(parseExtensionTargetId("extension:42")).toEqual({ tabId: 42 });
    expect(parseExtensionTargetId("extension:chrome-macbook:42")).toEqual({
      slug: "chrome-macbook",
      tabId: 42,
    });

    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({
      ...allocPortWindow(),
      token,
      hostname: "MacBook.local",
      waitConnectMs: 1_000,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    // Connect first browser (Chrome) — with 1 browser connected, target IDs stay `extension:<tabId>`
    const chrome1 = await connectMockExtension(
      port,
      token,
      (op, params) => {
        if (op === "list_tabs") return { tabs: [{ tabId: 42, url: "https://one.test", title: "One" }] };
        if (op === "eval") return { value: `chrome1:${params["tabId"]}` };
        if (op === "navigate") return { tabId: 101, loaded: true, url: String(params["url"]), title: "New1" };
        return { ok: true };
      },
      { profileId: "p-chrome-1", browser: "Chrome" },
    );
    expect(chrome1.welcome["slug"]).toBe("chrome-macbook");
    const singleTargets = await backend.listTargets();
    expect(singleTargets.map((t) => t.targetId)).toEqual(["extension:42"]);

    // Connect second browser (another Chrome profile -> -2 slug) with the EXACT SAME tabId 42
    const chrome2 = await connectMockExtension(
      port,
      token,
      (op, params) => {
        if (op === "list_tabs") return { tabs: [{ tabId: 42, url: "https://two.test", title: "Two" }] };
        if (op === "eval") return { value: `chrome2:${params["tabId"]}` };
        if (op === "navigate") return { tabId: 202, loaded: true, url: String(params["url"]), title: "New2" };
        return { ok: true };
      },
      { profileId: "p-chrome-2", browser: "Chrome" },
    );
    expect(chrome2.welcome["slug"]).toBe("chrome-macbook-2");

    // With 2 browsers connected, target IDs become `extension:<slug>:<tabId>` and never collide
    const multiTargets = await backend.listTargets();
    expect(multiTargets.map((t) => t.targetId).sort()).toEqual([
      "extension:chrome-macbook-2:42",
      "extension:chrome-macbook:42",
    ]);

    // Evaluating on each qualified target routes strictly to the matching browser
    const ev1 = (await backend.invoke("evaluate", {
      expression: "1",
      targetId: "extension:chrome-macbook:42",
    })) as { value: string };
    const ev2 = (await backend.invoke("evaluate", {
      expression: "1",
      targetId: "extension:chrome-macbook-2:42",
    })) as { value: string };
    expect(ev1.value).toBe("chrome1:42");
    expect(ev2.value).toBe("chrome2:42");

    // Ambiguous unqualified `extension:42` is rejected when multiple browsers are connected
    await expect(
      backend.invoke("evaluate", { expression: "1", targetId: "extension:42" }),
    ).rejects.toThrow(/ambiguous extension targetId/i);

    // Input `browser` chooses which connected browser opens a new tab
    const nav2 = (await backend.invoke("navigate", {
      url: "https://two.new",
      browser: "chrome-macbook-2",
    })) as { targetId: string; browser: string };
    expect(nav2.targetId).toBe("extension:chrome-macbook-2:202");
    expect(nav2.browser).toBe("chrome-macbook-2");

    const nav1 = (await backend.invoke("navigate", {
      url: "https://one.new",
      browser: "chrome-macbook",
    })) as { targetId: string; browser: string };
    expect(nav1.targetId).toBe("extension:chrome-macbook:101");
    expect(nav1.browser).toBe("chrome-macbook");

    // Events on tab 42 from two browsers do not collide
    chrome1.ws.send(JSON.stringify({ type: "event", tabId: 42, method: "Page.loadEventFired", params: { from: 1 } }));
    chrome2.ws.send(JSON.stringify({ type: "event", tabId: 42, method: "Page.loadEventFired", params: { from: 2 } }));
    await new Promise((r) => setTimeout(r, 30));
    const evs1 = (await backend.invoke("read_events", {
      targetId: "extension:chrome-macbook:42",
      method: "Page.loadEventFired",
    })) as { events: Array<{ params: { from: number } }> };
    const evs2 = (await backend.invoke("read_events", {
      targetId: "extension:chrome-macbook-2:42",
      method: "Page.loadEventFired",
    })) as { events: Array<{ params: { from: number } }> };
    expect(evs1.events.map((e) => e.params.from)).toEqual([1]);
    expect(evs2.events.map((e) => e.params.from)).toEqual([2]);
  });

  test("chunked post-auth frames reassemble payloads > 1 MiB, and reject out-of-order or oversized streams per-request", async () => {
    // Pure extension/lib/frames.js round-trip + surrogate pair preservation
    const bigText = "A".repeat(700_000) + "😀".repeat(100_000) + '"\\"'.repeat(100_000);
    const encoded = encodeMessage({ type: "res", id: 99, ok: true, result: { text: bigText } });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error(encoded.error);
    expect(encoded.chunked).toBe(true);
    expect(encoded.frames.length).toBeGreaterThan(2);
    for (const f of encoded.frames) {
      expect(Buffer.byteLength(f, "utf8")).toBeLessThan(TRANSPORT_MAX_PAYLOAD_BYTES);
      const parsed = JSON.parse(f) as { type: string; data: string };
      expect(parsed.type).toBe("chunk");
      expect(Buffer.byteLength(parsed.data, "utf8")).toBeLessThanOrEqual(CHUNK_MAX_DATA_BYTES);
    }
    const localDecoder = createFrameDecoder();
    let reassembled: unknown;
    for (const f of encoded.frames) {
      const r = localDecoder.push(JSON.parse(f));
      if (r.kind === "message") reassembled = r.message;
    }
    expect((reassembled as { result: { text: string } }).result.text).toBe(bigText);

    // Live WebSocket round-trip across the 1 MiB transport cap using chunked frames
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({
      ...allocPortWindow(),
      token,
      maxPostAuthBytes: 4 * 1024 * 1024,
      waitConnectMs: 1_000,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const largePayload = "X".repeat(1_600_000); // > 1 MiB transport cap, < 4 MiB test cap
    const client = await connectMockExtension(
      port,
      token,
      (op, params) => {
        if (op === "eval") {
          if (params["expression"] === "echo_large") {
            return { value: largePayload };
          }
          if (params["expression"] === "len") {
            return { value: String(params["expression"]).length };
          }
          return { value: String(params["expression"]).length };
        }
        return { ok: true };
      },
      { chunkedResponses: true },
    );

    await backend.invoke("select_target", { targetId: "extension:10" });

    // 1. Large response (> 1 MiB) from extension arrives chunked and reassembles cleanly
    const largeRes = (await backend.invoke("evaluate", { expression: "echo_large" })) as { value: string };
    expect(largeRes.value).toBe(largePayload);

    // 2. Large request (> 1 MiB) from daemon is chunked to extension and decoded cleanly
    const hugeExpr = `"${"Z".repeat(1_200_000)}"`;
    const hugeReqRes = (await backend.invoke("evaluate", { expression: hugeExpr })) as { value: number };
    expect(hugeReqRes.value).toBe(hugeExpr.length);

    // 3. Out-of-order chunk stream fails ONLY that request; socket stays open for subsequent requests
    const badOrderClient = await connectMockExtension(port, token, undefined, {
      profileId: "p-chunk-err",
      manualRequests: true,
    });
    // Hijack a single request manually to send out-of-order chunks
    const outOfOrderReqId = new Promise<number>((resolve) => {
      const onMsg = (ev: MessageEvent) => {
        const m = JSON.parse(String(ev.data)) as { type?: string; id?: number; op?: string };
        if (m.type === "req" && m.op === "bad_order" && typeof m.id === "number") {
          badOrderClient.ws.removeEventListener("message", onMsg);
          resolve(m.id);
        }
      };
      badOrderClient.ws.addEventListener("message", onMsg);
    });
    const badOrderPromise = backend.request("bad_order", {}, 3_000, String(badOrderClient.welcome["slug"]));
    const reqId1 = await outOfOrderReqId;
    badOrderClient.ws.send(JSON.stringify({ type: "chunk", id: String(reqId1), seq: 0, last: false, data: '{"type":"res",' }));
    badOrderClient.ws.send(JSON.stringify({ type: "chunk", id: String(reqId1), seq: 2, last: true, data: '"ok":true}' }));
    await expect(badOrderPromise).rejects.toThrow(/out of order/i);

    // 4. Oversized chunk stream (> maxPostAuthBytes) fails ONLY that request; socket stays open
    const oversizedReqId = new Promise<number>((resolve) => {
      const onMsg = (ev: MessageEvent) => {
        const m = JSON.parse(String(ev.data)) as { type?: string; id?: number; op?: string };
        if (m.type === "req" && m.op === "too_big" && typeof m.id === "number") {
          badOrderClient.ws.removeEventListener("message", onMsg);
          resolve(m.id);
        }
      };
      badOrderClient.ws.addEventListener("message", onMsg);
    });
    const oversizedPromise = backend.request("too_big", {}, 3_000, String(badOrderClient.welcome["slug"]));
    const reqId2 = await oversizedReqId;
    const halfMeg = "B".repeat(500_000);
    for (let seq = 0; seq < 10; seq++) {
      badOrderClient.ws.send(
        JSON.stringify({ type: "chunk", id: String(reqId2), seq, last: seq === 9, data: halfMeg }),
      );
    }
    await expect(oversizedPromise).rejects.toThrow(/too large/i);

    // 5. Single chunk with data > 512 KiB (under 1 MiB transport cap) fails ONLY that request
    const oversizedChunkReqId = new Promise<number>((resolve) => {
      const onMsg = (ev: MessageEvent) => {
        const m = JSON.parse(String(ev.data)) as { type?: string; id?: number; op?: string };
        if (m.type === "req" && m.op === "big_chunk" && typeof m.id === "number") {
          badOrderClient.ws.removeEventListener("message", onMsg);
          resolve(m.id);
        }
      };
      badOrderClient.ws.addEventListener("message", onMsg);
    });
    const oversizedChunkPromise = backend.request("big_chunk", {}, 3_000, String(badOrderClient.welcome["slug"]));
    const reqId3 = await oversizedChunkReqId;
    badOrderClient.ws.send(
      JSON.stringify({ type: "chunk", id: String(reqId3), seq: 0, last: true, data: "C".repeat(CHUNK_MAX_DATA_BYTES + 1024) }),
    );
    await expect(oversizedChunkPromise).rejects.toThrow(/chunk data too large/i);

    // Socket is STILL alive after all three rejected chunk streams!
    const pongP = waitMessage(badOrderClient.ws);
    badOrderClient.ws.send(JSON.stringify({ type: "ping" }));
    expect(await pongP).toEqual({ type: "pong" });
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
  });

  test("transport rejects a > 1 MiB pre-auth frame at the WebSocket layer", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 500 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const ws = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ws);
    const closed = waitClose(ws);
    // Exceeds TRANSPORT_MAX_PAYLOAD_BYTES (1 MiB) so Bun closes the socket at the transport layer.
    ws.send("x".repeat(TRANSPORT_MAX_PAYLOAD_BYTES + 4096));
    const result = await closed;
    expect([1006, 1009]).toContain(result.code);
    expect(backend.isConnected()).toBe(false);
  });

  test("cli.ts extension-pair prints Crockford code and onboarding URL under XDG_CONFIG_HOME", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-cli-pair-"));
    tempDirs.push(dir);
    const proc = Bun.spawn(["bun", "./cli.ts", "extension-pair"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, XDG_CONFIG_HOME: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const parsed = JSON.parse(out) as { code: string; url: string; expiresInSeconds: number; codesFile: string };
    expect(parsed.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(parsed.url).toBe(
      `chrome-extension://${EXTENSION_ID}/onboarding.html#code=${encodeURIComponent(parsed.code)}`,
    );
    expect(parsed.expiresInSeconds).toBe(600);
    expect(parsed.codesFile).toBe(join(dir, "browser-control", "extension-pairing-codes.json"));
    expect((await stat(parsed.codesFile)).mode & 0o777).toBe(0o600);
  });
});
