import { afterEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvokeResult, OperationHandler } from "@agent-software/core";
import { applyNavBrowserScope, type NavBrowserScope } from "../daemon";
import {
  CHUNK_MAX_DATA_BYTES,
  CLOSE_AUTH_REFUSED,
  CLOSE_BAD_HELLO,
  CLOSE_VERSION_MISMATCH,
  EXTENSION_ORIGIN,
  HANDSHAKE_TIMEOUT_MS,
  MAX_ABORTED_CHUNK_STREAMS,
  MAX_CONCURRENT_CHUNK_STREAMS,
  MAX_TRACKED_HANDSHAKES,
  PRE_AUTH_MAX_BYTES,
  PROTOCOL_VERSION,
  RELAY_VERSION,
  TRANSPORT_MAX_PAYLOAD_BYTES,
  ChunkReassembler,
  OutboundFrameQueue,
  browserSlugFor,
  createExtensionBackend,
  ensureRelayToken,
  extProofMessage,
  extensionDiagnosticsReport,
  extensionStatusReport,
  formatHandshakeFix,
  hmacHex,
  parseExtensionTargetId,
  relayProofMessage,
  setupExtensionPairing,
  type ExtensionBackend,
  type RelayHandshakeRecord,
} from "../src/backends/extension";
// @ts-expect-error plain JS MV3 module
import * as extFramesRaw from "../extension/lib/frames.js";
import { route } from "../src/backends/router";
import { BackendUnavailable } from "../src/backends/types";
import { PAGE_HELPERS_VERSION } from "../src/page-helpers";
import { createPageHelperHandler } from "../src/page-runner";

type ExtFramesMod = {
  MAX_CONCURRENT_STREAMS: number;
  STREAM_TIMEOUT_MS: number;
  MAX_ABORTED_STREAMS: number;
  encodeMessage(
    obj: Record<string, unknown>,
    options?: { id?: string; maxDataBytes?: number; maxFrameBytes?: number; maxTotalBytes?: number },
  ):
    | { ok: true; frames: string[]; chunked: boolean; totalBytes: number; id?: string }
    | { ok: false; error: string; totalBytes: number };
  createFrameDecoder(options?: {
    maxDataBytes?: number;
    maxTotalBytes?: number;
    maxBufferedBytes?: number;
    maxConcurrent?: number;
    streamTimeoutMs?: number;
    maxAbortedIds?: number;
    onExpire?: (info: { id: string; reqId?: number }) => void;
  }): {
    push(msg: Record<string, unknown>):
      | { kind: "message"; message: Record<string, unknown> }
      | { kind: "pending" }
      | { kind: "ignored" }
      | { kind: "error"; id: string; reqId?: number; error: string };
    clear(id?: string): void;
    size(): number;
    bufferedBytes(): number;
    abortedSize(): number;
  };
};

const {
  MAX_ABORTED_STREAMS: EXT_MAX_ABORTED_STREAMS,
  MAX_CONCURRENT_STREAMS: EXT_MAX_CONCURRENT_STREAMS,
  STREAM_TIMEOUT_MS: EXT_STREAM_TIMEOUT_MS,
  createFrameDecoder,
  encodeMessage,
} = extFramesRaw as unknown as ExtFramesMod;

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
  receivedChunkFrames: number[];
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
  const receivedChunkFrames: number[] = [];
  const decoder = createFrameDecoder();
  if (!opts.manualRequests) {
    ws.addEventListener("message", async (ev) => {
      const rawMsg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (rawMsg["type"] === "chunk" && typeof rawMsg["seq"] === "number") {
        receivedChunkFrames.push(rawMsg["seq"]);
      }
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

  return {
    ws,
    welcome,
    challenge,
    extNonce,
    relayNonce,
    daemonProofVerified,
    receivedReqs,
    receivedChunkFrames,
  };
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

    // Helpers version mismatch (verifies pairing proof first, then closes 4003)
    const wsMismatch = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(wsMismatch);
    const mismatchNonce = randomBytes(16).toString("hex");
    const mismatchChallengeP = waitMessage(wsMismatch);
    wsMismatch.send(
      JSON.stringify({
        type: "hello",
        profileId: "p1",
        browser: "Chrome",
        version: "2.0.0",
        helpersVersion: PAGE_HELPERS_VERSION + 1,
        protocolVersion: PROTOCOL_VERSION,
        nonce: mismatchNonce,
      }),
    );
    const mismatchChallenge = await mismatchChallengeP;
    expect(mismatchChallenge["type"]).toBe("auth.challenge");
    const closedMismatch = waitClose(wsMismatch);
    wsMismatch.send(
      JSON.stringify({
        type: "auth.response",
        proof: hmacHex(token, extProofMessage(port, String(mismatchChallenge["nonce"]), mismatchNonce)),
      }),
    );
    expect((await closedMismatch).code).toBe(CLOSE_VERSION_MISMATCH);

    // Protocol version mismatch closes 4003 immediately without a challenge
    const wsProtoMismatch = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(wsProtoMismatch);
    const closedProto = waitClose(wsProtoMismatch);
    wsProtoMismatch.send(
      JSON.stringify({
        type: "hello",
        profileId: "p1",
        browser: "Chrome",
        version: "2.0.0",
        helpersVersion: PAGE_HELPERS_VERSION,
        protocolVersion: PROTOCOL_VERSION + 1,
        nonce: randomBytes(16).toString("hex"),
      }),
    );
    expect((await closedProto).code).toBe(CLOSE_VERSION_MISMATCH);
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
        return { values: ['# App | http://127.0.0.1/app\n- button "Go" [e1]'] };
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
    };
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

describe("Phase 2 slice B: BrowserLinks and chunked frames", () => {
  test("slug is deterministic and differs per profile", async () => {
    const expectedA = `chrome-${createHash("sha256").update("profile-alpha", "utf8").digest("hex").slice(0, 6)}`;
    const expectedB = `chrome-${createHash("sha256").update("profile-beta", "utf8").digest("hex").slice(0, 6)}`;
    const expectedBrave = `brave-${createHash("sha256").update("profile-alpha", "utf8").digest("hex").slice(0, 6)}`;

    expect(browserSlugFor("Chrome", "profile-alpha")).toBe(expectedA);
    expect(browserSlugFor("Google Chrome", "profile-alpha")).toBe(expectedA);
    expect(browserSlugFor("Chrome", "profile-beta")).toBe(expectedB);
    expect(browserSlugFor("Brave", "profile-alpha")).toBe(expectedBrave);
    expect(expectedA).not.toBe(expectedB);

    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 500 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const first = await connectMockExtension(port, token, undefined, {
      profileId: "profile-alpha",
      browser: "Chrome",
    });
    expect(first.welcome["slug"]).toBe(expectedA);
    first.ws.close();
    await waitClose(first.ws);

    const reconnected = await connectMockExtension(port, token, undefined, {
      profileId: "profile-alpha",
      browser: "Chrome",
    });
    expect(reconnected.welcome["slug"]).toBe(expectedA);

    const second = await connectMockExtension(port, token, undefined, {
      profileId: "profile-beta",
      browser: "Chrome",
    });
    expect(second.welcome["slug"]).toBe(expectedB);
    expect(second.welcome["slug"]).not.toBe(reconnected.welcome["slug"]);
  });

  test("BrowserLinks: distinct target IDs for same tabId, unbound short id ambiguity, and event isolation", async () => {
    const slug1 = browserSlugFor("Chrome", "p-chrome-1");
    const slug2 = browserSlugFor("Chrome", "p-chrome-2");
    expect(parseExtensionTargetId("extension:42")).toEqual({ tabId: 42 });
    expect(parseExtensionTargetId(`extension:${slug1}:42`)).toEqual({ slug: slug1, tabId: 42 });

    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 1_000 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    // With 1 browser connected, target IDs stay `extension:<tabId>`
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
    expect(chrome1.welcome["slug"]).toBe(slug1);
    const singleTargets = await backend.listTargets();
    expect(singleTargets.map((t) => t.targetId)).toEqual(["extension:42"]);

    // Connect second browser with the EXACT SAME tabId 42
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
    expect(chrome2.welcome["slug"]).toBe(slug2);

    // With 2 browsers connected, target IDs become `extension:<slug>:<tabId>` and never collide
    const multiTargets = await backend.listTargets();
    expect(multiTargets.map((t) => t.targetId).sort()).toEqual(
      [`extension:${slug1}:42`, `extension:${slug2}:42`].sort(),
    );

    // Evaluating on each qualified target routes strictly to the matching browser
    const ev1 = (await backend.invoke("evaluate", {
      expression: "1",
      targetId: `extension:${slug1}:42`,
    })) as { value: string };
    const ev2 = (await backend.invoke("evaluate", {
      expression: "1",
      targetId: `extension:${slug2}:42`,
    })) as { value: string };
    expect(ev1.value).toBe("chrome1:42");
    expect(ev2.value).toBe("chrome2:42");

    // Unbound short id is rejected as ambiguous when multiple browsers are connected
    await expect(
      backend.invoke("evaluate", { expression: "1", targetId: "extension:99" }),
    ).rejects.toThrow(/ambiguous extension targetId/i);

    // Events on tab 42 from two browsers do not collide
    chrome1.ws.send(JSON.stringify({ type: "event", tabId: 42, method: "Page.loadEventFired", params: { from: 1 } }));
    chrome2.ws.send(JSON.stringify({ type: "event", tabId: 42, method: "Page.loadEventFired", params: { from: 2 } }));
    await new Promise((r) => setTimeout(r, 30));
    const evs1 = (await backend.invoke("read_events", {
      targetId: `extension:${slug1}:42`,
      method: "Page.loadEventFired",
    })) as { events: Array<{ params: { from: number } }> };
    const evs2 = (await backend.invoke("read_events", {
      targetId: `extension:${slug2}:42`,
      method: "Page.loadEventFired",
    })) as { events: Array<{ params: { from: number } }> };
    expect(evs1.events.map((e) => e.params.from)).toEqual([1]);
    expect(evs2.events.map((e) => e.params.from)).toEqual([2]);
  });

  test("offline: named nav stays on the extension and targeted event reads fail", async () => {
    const backend = createExtensionBackend({ ...allocPortWindow(), token: randomBytes(32).toString("hex"), waitConnectMs: 50 });
    disposables.push(backend);
    await backend.start!();
    expect(backend.handles("navigate", { url: "https://x", browser: "chrome-abc123" }, false)).toBe(true);
    await expect(backend.invoke("navigate", { url: "https://x", browser: "chrome-abc123" })).rejects.toThrow(
      /BACKEND_UNAVAILABLE/,
    );
    await expect(backend.invoke("read_events", { targetId: "extension:42" })).rejects.toThrow(/not connected/);
    await expect(
      backend.invoke("wait_for_event", { method: "x", targetId: "extension:42", timeoutMs: 10 }),
    ).rejects.toThrow(/not connected/);
  });

  test("an event waiter keeps matching after a second browser connects", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 1_000 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;
    const list = (op: string) => (op === "list_tabs" ? { tabs: [{ tabId: 42, title: "t", url: "u" }] } : { ok: true });

    const first = await connectMockExtension(port, token, list, { profileId: "wait-a", browser: "Chrome" });
    expect((await backend.listTargets()).map((t) => t.targetId)).toEqual(["extension:42"]);
    const waited = backend.invoke("wait_for_event", {
      method: "bc.handoffDone",
      targetId: "extension:42",
      match: { handoffId: "h1" },
      timeoutMs: 2_000,
    }) as Promise<{ found: boolean }>;

    await connectMockExtension(port, token, list, { profileId: "wait-b", browser: "Brave" });
    first.ws.send(JSON.stringify({ type: "event", tabId: 42, method: "bc.handoffDone", params: { handoffId: "h1" } }));
    expect((await waited).found).toBe(true);
  });

  test("S5: stale short id rejected after its profile leaves instead of routing to another profile", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 1_000 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    // Browser A is the sole connected browser and issues short target id `extension:42`
    const browserA = await connectMockExtension(
      port,
      token,
      (op) => {
        if (op === "list_tabs") return { tabs: [{ tabId: 42, url: "https://a.test", title: "A" }] };
        if (op === "eval") return { value: "from-A" };
        return { ok: true };
      },
      { profileId: "profile-a", browser: "Chrome" },
    );
    const tabsA = await backend.listTargets();
    expect(tabsA.map((t) => t.targetId)).toEqual(["extension:42"]);

    // Browser A disconnects
    browserA.ws.close();
    await waitClose(browserA.ws);
    await new Promise((r) => setTimeout(r, 20));
    expect(backend.isConnected()).toBe(false);

    // Browser B connects as the ONLY browser and also happens to have tabId 42
    const browserB = await connectMockExtension(
      port,
      token,
      (op) => {
        if (op === "list_tabs") return { tabs: [{ tabId: 42, url: "https://b.test", title: "B" }] };
        if (op === "eval") return { value: "from-B" };
        return { ok: true };
      },
      { profileId: "profile-b", browser: "Brave" },
    );

    // Reusing Browser A's stale `extension:42` must fail with NO_ACTIVE_TARGET, never hit Browser B
    await expect(
      backend.invoke("evaluate", { expression: "1", targetId: "extension:42" }),
    ).rejects.toThrow("NO_ACTIVE_TARGET: tab extension:42 belonged to a browser that disconnected; list tabs again");
    expect(browserB.receivedReqs.filter((r) => r.op === "eval")).toHaveLength(0);

    // Listing tabs again issues Browser B a qualified id; A's stale `extension:42` stays rejected
    const slugB = browserSlugFor("Brave", "profile-b");
    const tabsB = await backend.listTargets();
    expect(tabsB.map((t) => t.targetId)).toEqual([`extension:${slugB}:42`]);
    await expect(
      backend.invoke("evaluate", { expression: "1", targetId: "extension:42" }),
    ).rejects.toThrow("NO_ACTIVE_TARGET");
    const resB = (await backend.invoke("evaluate", { expression: "1", targetId: `extension:${slugB}:42` })) as {
      value: string;
    };
    expect(resB.value).toBe("from-B");
  });

  test("S4: browser-named nav ignores the active tab of another browser and rejects explicit cross-browser targetId", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 1_000 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const slug1 = browserSlugFor("Chrome", "nav-prof-1");
    const slug2 = browserSlugFor("Brave", "nav-prof-2");

    const browser1 = await connectMockExtension(
      port,
      token,
      (op, params) => {
        if (op === "navigate") return { tabId: 10, loaded: true, url: String(params["url"]), title: "B1" };
        if (op === "bc_call") return { values: [undefined, String(params["tabId"]), ""] };
        return { ok: true };
      },
      { profileId: "nav-prof-1", browser: "Chrome" },
    );
    const browser2 = await connectMockExtension(
      port,
      token,
      (op, params) => {
        if (op === "navigate") return { tabId: 202, loaded: true, url: String(params["url"]), title: "B2" };
        if (op === "bc_call") return { values: [undefined, "https://two.new", ""] };
        return { ok: true };
      },
      { profileId: "nav-prof-2", browser: "Brave" },
    );

    // Wire route + daemon.ts AsyncLocalStorage nav-browser scoping + page-runner `handlePage("nav", ...)`
    const ops = route(fakeCdp([]), [backend], () => ["extension", "cdp"]);
    const requestBrowser = new AsyncLocalStorage<NavBrowserScope | undefined>();
    const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
      try {
        const effective = applyNavBrowserScope(op, input, requestBrowser.getStore());
        const data = await ops[op]!(effective);
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

    // Make Browser 1's tab 10 the active tab (so page-runner's resolveTargetBackend(undefined) returns it!)
    await ops["select_target"]!({ targetId: `extension:${slug1}:10` });

    // /nav?browser=<slug2> and /page/nav { url, browser: slug2 } have no explicit targetId:
    // must ignore Browser 1's active targetId and open a new tab in Browser 2
    const navRes = await requestBrowser.run({ browser: slug2 }, () =>
      handlePage("nav", { url: "https://two.new", until: "load" }),
    );
    expect(navRes.ok).toBe(true);
    if (navRes.ok) {
      const firstLine = JSON.parse(String((navRes.data as Record<string, unknown>)["value"]).split("\n")[0]!) as {
        targetId: string;
        browser: string;
      };
      expect(firstLine.browser).toBe(slug2);
      expect(firstLine.targetId).toBe(`extension:${slug2}:202`);
    }
    expect(browser1.receivedReqs.filter((r) => r.op === "navigate")).toHaveLength(0);
    const b2Navs = browser2.receivedReqs.filter((r) => r.op === "navigate");
    expect(b2Navs).toHaveLength(1);
    expect(b2Navs[0]!.params["tabId"]).toBeUndefined();

    // Explicit targetId belonging to Browser 1 while naming Browser 2 MUST fail with INPUT_INVALID
    const mismatchRes = await requestBrowser.run(
      { browser: slug2, explicitTargetId: `extension:${slug1}:10` },
      () => handlePage("nav", { url: "https://mismatch.test", until: "load" }, `extension:${slug1}:10`),
    );
    expect(mismatchRes.ok).toBe(false);
    if (!mismatchRes.ok) {
      expect(mismatchRes.error.message).toMatch(/INPUT_INVALID:.*belongs to browser/i);
    }
    expect(browser1.receivedReqs.filter((r) => r.op === "navigate")).toHaveLength(0);
    expect(browser2.receivedReqs.filter((r) => r.op === "navigate")).toHaveLength(1);
  });

  test("nav newWindow/keepOpen reach the extension's navigate; newWindow opens a new tab", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 1_000 });
    disposables.push(backend);
    await backend.start!();
    const ext = await connectMockExtension(backend.getPort()!, token, (op, params) => {
      if (op === "navigate") return { tabId: 77, loaded: true, url: String(params["url"]), title: "N" };
      if (op === "bc_call") return { values: [undefined, String(params["url"] ?? ""), ""] };
      return { ok: true };
    });
    const ops = route(fakeCdp([]), [backend], () => ["extension", "cdp"]);
    const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
      try {
        return { ok: true, data: await ops[op]!(input) };
      } catch (err) {
        return { ok: false, error: { code: "EXECUTION_FAILED", message: (err as Error).message } };
      }
    };
    const handlePage = createPageHelperHandler(invoke, undefined, undefined, {
      bcCall: (input) => backend.bcCall(input),
      sleep: async () => {},
      rng: () => 0.5,
    });
    await ops["select_target"]!({ targetId: "extension:5" });
    const navs = () => ext.receivedReqs.filter((r) => r.op === "navigate");

    expect((await handlePage("nav", { url: "https://a.test/", newWindow: true, keepOpen: true })).ok).toBe(true);
    expect(navs().at(-1)!.params["newWindow"]).toBe(true);
    expect(navs().at(-1)!.params["keepOpen"]).toBe(true);
    expect(navs().at(-1)!.params["tabId"]).toBeUndefined();

    await ops["select_target"]!({ targetId: "extension:5" });
    expect((await handlePage("nav", { url: "https://b.test/", keepOpen: true })).ok).toBe(true);
    expect(navs().at(-1)!.params["tabId"]).toBe(5);
    expect(navs().at(-1)!.params["keepOpen"]).toBe(true);
    expect(navs().at(-1)!.params["newWindow"]).toBeUndefined();

    expect((await handlePage("nav", { url: "https://c.test/" })).ok).toBe(true);
    expect(navs().at(-1)!.params["keepOpen"]).toBeUndefined();
  });

  test("cancelUnsent drops a queued batch that never started sending", async () => {
    const sent: string[] = [];
    let blocked = true;
    const queue = new OutboundFrameQueue({
      send(frame: string): number {
        sent.push(frame);
        return blocked ? -1 : frame.length;
      },
    });
    const first = queue.enqueue(["a1", "a2"]);
    const secondFrames = ["b1"];
    const second = queue.enqueue(secondFrames);
    queue.cancelUnsent(secondFrames);
    await expect(second).rejects.toThrow(/cancelled before it was sent/);
    blocked = false;
    queue.drain();
    await first;
    expect(sent).toEqual(["a1", "a2"]);
  });

  test("S6: a large outbound batch (>=250 chunks) completes with backpressure", async () => {
    // 1. Deterministic backpressure proof: pause on -1, resume on drain(), deliver >=250 chunks in order
    const sent: string[] = [];
    let paused = false;
    let backpressureHits = 0;
    const mockSocket = {
      send(frame: string): number {
        if (paused) throw new Error("sent while paused under backpressure");
        sent.push(frame);
        if (sent.length % 5 === 0) {
          paused = true;
          backpressureHits += 1;
          return -1;
        }
        return frame.length;
      },
    };
    const queue = new OutboundFrameQueue(mockSocket);
    const frames = Array.from({ length: 260 }, (_, i) => JSON.stringify({ type: "chunk", id: "b", seq: i }));
    let settled = false;
    const sendPromise = queue.enqueue(frames).then(() => {
      settled = true;
    });

    expect(sent.length).toBe(5);
    expect(queue.isPaused).toBe(true);
    expect(settled).toBe(false);

    while (queue.isPaused) {
      paused = false;
      queue.drain();
    }
    await sendPromise;
    expect(settled).toBe(true);
    expect(backpressureHits).toBe(52);
    expect(sent).toEqual(frames);

    // 2. Live WebSocket round-trip of >=250 outbound chunks (~26 MiB >> backpressureLimit)
    //    exercising real Bun ServerWebSocket backpressure (-1) and `drain` resume
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({
      ...allocPortWindow(),
      token,
      maxChunkDataBytes: 100 * 1024,
      backpressureLimit: 256 * 1024,
      waitConnectMs: 1_000,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const client = await connectMockExtension(port, token, (op, params) => {
      if (op === "eval") {
        return { value: String(params["expression"]).length };
      }
      return { ok: true };
    });

    await backend.invoke("select_target", { targetId: "extension:10" });
    // 26 MiB split at 100 KiB/chunk = 267 outbound chunks (> 250) exceeding kernel + 256 KiB backpressure limit
    const hugeExpr = `"${"Q".repeat(26 * 1024 * 1024)}"`;
    const res = (await backend.invoke("evaluate", { expression: hugeExpr })) as { value: number };
    expect(res.value).toBe(hugeExpr.length);
    expect(client.receivedChunkFrames.length).toBeGreaterThanOrEqual(250);
    // Verify strictly monotonic sequence numbers 0..N-1
    for (let i = 0; i < client.receivedChunkFrames.length; i++) {
      expect(client.receivedChunkFrames[i]).toBe(i);
    }
  });

  test("S6: dropped send (ws.send returning 0) fails the request and never reports success", async () => {
    // Partial send: first 2 chunks succeed, 3rd returns 0 (dropped) -> must reject cleanly
    let calls = 0;
    const queue = new OutboundFrameQueue({
      send(frame: string): number {
        calls += 1;
        return calls === 3 ? 0 : frame.length;
      },
    });
    const frames = Array.from({ length: 5 }, (_, i) => `frame-${i}`);
    await expect(queue.enqueue(frames)).rejects.toThrow("EXECUTION_FAILED: WebSocket frame dropped (sent 2/5 frames)");
    expect(calls).toBe(3);

    // Subsequent queued message after a dropped one still runs cleanly when socket recovers
    let okCalls = 0;
    const queue2 = new OutboundFrameQueue({
      send(frame: string): number {
        okCalls += 1;
        return okCalls === 1 ? 0 : frame.length;
      },
    });
    await expect(queue2.enqueue(["bad"])).rejects.toThrow(/WebSocket frame dropped/);
    await expect(queue2.enqueue(["good"])).resolves.toBeUndefined();
  });

  test("S7: aggregate unfinished-bytes cap, max 16 streams, and capped remembered rejected IDs", async () => {
    // Verify default constants match across daemon and extension/lib/frames.js
    expect(MAX_CONCURRENT_CHUNK_STREAMS).toBe(16);
    expect(EXT_MAX_CONCURRENT_STREAMS).toBe(16);
    expect(EXT_STREAM_TIMEOUT_MS).toBe(30_000);
    expect(MAX_ABORTED_CHUNK_STREAMS).toBe(64);
    expect(EXT_MAX_ABORTED_STREAMS).toBe(64);

    // 1. frames.js decoder: 3 streams each under per-stream cap (1 MiB) exceed aggregate 1 MiB cap
    const extDec = createFrameDecoder({
      maxDataBytes: 512 * 1024,
      maxTotalBytes: 1024 * 1024,
      maxBufferedBytes: 1024 * 1024,
      maxConcurrent: 16,
      maxAbortedIds: 64,
    });
    const chunk400k = "A".repeat(400 * 1024);
    expect(extDec.push({ type: "chunk", id: "s1", seq: 0, last: false, data: chunk400k }).kind).toBe("pending");
    expect(extDec.push({ type: "chunk", id: "s2", seq: 0, last: false, data: chunk400k }).kind).toBe("pending");
    expect(extDec.bufferedBytes()).toBe(800 * 1024);
    const overAgg = extDec.push({ type: "chunk", id: "s3", seq: 0, last: false, data: chunk400k });
    expect(overAgg.kind).toBe("error");
    if (overAgg.kind === "error") expect(overAgg.error).toMatch(/aggregate unfinished bytes/i);
    expect(extDec.size()).toBe(2);
    expect(extDec.bufferedBytes()).toBe(800 * 1024);
    extDec.clear();

    // 2. Max 16 concurrent open streams + max 64 remembered rejected stream IDs in both decoders
    const daemonDec = new ChunkReassembler({ maxBufferedBytes: 1024 * 1024, maxConcurrent: 16, maxAbortedIds: 64 });
    for (let i = 0; i < 16; i++) {
      expect(daemonDec.push({ type: "chunk", id: `open-${i}`, seq: 0, last: false, data: "{" }).kind).toBe("pending");
      expect(extDec.push({ type: "chunk", id: `open-${i}`, seq: 0, last: false, data: "{" }).kind).toBe("pending");
    }
    const stream17Daemon = daemonDec.push({ type: "chunk", id: "open-16", seq: 0, last: false, data: "{" });
    const stream17Ext = extDec.push({ type: "chunk", id: "open-16", seq: 0, last: false, data: "{" });
    expect(stream17Daemon.kind).toBe("error");
    expect(stream17Ext.kind).toBe("error");
    if (stream17Daemon.kind === "error") expect(stream17Daemon.error).toMatch(/limit 16/);
    if (stream17Ext.kind === "error") expect(stream17Ext.error).toMatch(/limit 16/);

    // Trigger 80 distinct rejected non-last streams -> aborted map stays capped at 64
    for (let i = 0; i < 80; i++) {
      daemonDec.push({ type: "chunk", id: `bad-${i}`, seq: 1, last: false, data: "x" });
      extDec.push({ type: "chunk", id: `bad-${i}`, seq: 1, last: false, data: "x" });
    }
    expect(daemonDec.abortedSize()).toBe(64);
    expect(extDec.abortedSize()).toBe(64);
    daemonDec.clear();
    extDec.clear();

    // 3. Live WebSocket test: two unfinished streams + 3rd stream pushes over aggregate unfinished-bytes cap
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({
      ...allocPortWindow(),
      token,
      maxPostAuthBytes: 1024 * 1024,
      maxBufferedChunkBytes: 1024 * 1024,
      waitConnectMs: 1_000,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const client = await connectMockExtension(port, token, undefined, {
      profileId: "p-agg-cap",
      manualRequests: true,
    });
    const slug = String(client.welcome["slug"]);

    const waitReqId = (expectedOp: string) =>
      new Promise<number>((resolve) => {
        const onMsg = (ev: MessageEvent) => {
          const m = JSON.parse(String(ev.data)) as { type?: string; id?: number; op?: string };
          if (m.type === "req" && m.op === expectedOp && typeof m.id === "number") {
            client.ws.removeEventListener("message", onMsg);
            resolve(m.id);
          }
        };
        client.ws.addEventListener("message", onMsg);
      });

    const pId1 = waitReqId("agg_1");
    const req1 = backend.request("agg_1", {}, 3_000, slug);
    const id1 = await pId1;

    const pId2 = waitReqId("agg_2");
    const req2 = backend.request("agg_2", {}, 3_000, slug);
    const id2 = await pId2;

    const pId3 = waitReqId("agg_3");
    const req3 = backend.request("agg_3", {}, 3_000, slug);
    const id3 = await pId3;

    // Streams 1 and 2 buffer 400 KiB each (800 KiB total < 1 MiB)
    client.ws.send(JSON.stringify({ type: "chunk", id: String(id1), seq: 0, last: false, data: `{"type":"res","id":${id1},"ok":true,"result":{"v":"${"a".repeat(400 * 1024)}` }));
    client.ws.send(JSON.stringify({ type: "chunk", id: String(id2), seq: 0, last: false, data: `{"type":"res","id":${id2},"ok":true,"result":{"v":"${"b".repeat(400 * 1024)}` }));
    // Stream 3 tries to buffer 400 KiB -> total 1.2 MiB > 1 MiB aggregate cap -> fails req3 cleanly!
    client.ws.send(JSON.stringify({ type: "chunk", id: String(id3), seq: 0, last: false, data: `{"type":"res","id":${id3},"ok":true,"result":{"v":"${"c".repeat(400 * 1024)}` }));
    await expect(req3).rejects.toThrow(/aggregate unfinished bytes/i);

    // Streams 1 and 2 still finish cleanly on the same open socket
    client.ws.send(JSON.stringify({ type: "chunk", id: String(id1), seq: 1, last: true, data: '"}}' }));
    client.ws.send(JSON.stringify({ type: "chunk", id: String(id2), seq: 1, last: true, data: '"}}' }));
    expect(((await req1) as { v: string }).v.length).toBe(400 * 1024);
    expect(((await req2) as { v: string }).v.length).toBe(400 * 1024);
  });

  test("S7: abandoned stream expires on timer without new traffic, and activity resets the timer", async () => {
    // 1. frames.js decoder: abandoned stream expires on timer with ZERO new push() calls
    const expiredExt: string[] = [];
    const extDec = createFrameDecoder({
      streamTimeoutMs: 60,
      onExpire: ({ id }) => expiredExt.push(id),
    });
    expect(extDec.push({ type: "chunk", id: "abandoned", seq: 0, last: false, data: "hello" }).kind).toBe("pending");
    expect(extDec.size()).toBe(1);
    expect(extDec.bufferedBytes()).toBe(5);

    // Wait past timeout without pushing any new frame
    await new Promise((r) => setTimeout(r, 120));
    expect(expiredExt).toEqual(["abandoned"]);
    expect(extDec.size()).toBe(0);
    expect(extDec.bufferedBytes()).toBe(0);

    // Activity resets the timer: chunks spaced < timeoutMs complete cleanly even when total > timeoutMs
    expect(extDec.push({ type: "chunk", id: "active", seq: 0, last: false, data: '{"a":' }).kind).toBe("pending");
    await new Promise((r) => setTimeout(r, 40));
    expect(extDec.push({ type: "chunk", id: "active", seq: 1, last: false, data: "1" }).kind).toBe("pending");
    await new Promise((r) => setTimeout(r, 40));
    const finished = extDec.push({ type: "chunk", id: "active", seq: 2, last: true, data: "}" });
    expect(finished).toMatchObject({ kind: "message", message: { a: 1 } });
    expect(extDec.size()).toBe(0);
    expect(extDec.bufferedBytes()).toBe(0);

    // 2. Live WebSocket test: abandoned incoming chunk stream fails its pending request on timer with zero new traffic
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({
      ...allocPortWindow(),
      token,
      chunkStreamTimeoutMs: 70,
      waitConnectMs: 1_000,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const client = await connectMockExtension(port, token, undefined, {
      profileId: "p-expire",
      manualRequests: true,
    });
    const reqIdP = new Promise<number>((resolve) => {
      const onMsg = (ev: MessageEvent) => {
        const m = JSON.parse(String(ev.data)) as { type?: string; id?: number; op?: string };
        if (m.type === "req" && m.op === "stall" && typeof m.id === "number") {
          client.ws.removeEventListener("message", onMsg);
          resolve(m.id);
        }
      };
      client.ws.addEventListener("message", onMsg);
    });

    // Request timeout is 5s, but chunk stream timeout is 70ms -> must fail via stream expiry without new traffic
    const reqP = backend.request("stall", {}, 5_000, String(client.welcome["slug"]));
    const reqId = await reqIdP;
    client.ws.send(JSON.stringify({ type: "chunk", id: String(reqId), seq: 0, last: false, data: '{"type":"res",' }));
    await expect(reqP).rejects.toThrow(/chunked stream .* expired/i);
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
});

describe("relay handshake tracking, fix lines, and timeout", () => {
  async function sendPairedHelpersMismatch(
    port: number,
    token: string,
    opts: { profileId?: string; browser?: string; version?: string; helpersVersion?: number } = {},
  ): Promise<{ code: number; reason: string }> {
    const ws = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ws);
    const extNonce = randomBytes(16).toString("hex");
    const challengeP = waitMessage(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        profileId: opts.profileId ?? "p-old",
        browser: opts.browser ?? "Chrome",
        version: opts.version ?? "2.0.0",
        helpersVersion: opts.helpersVersion ?? 8,
        protocolVersion: PROTOCOL_VERSION,
        nonce: extNonce,
      }),
    );
    const challenge = await challengeP;
    expect(challenge["type"]).toBe("auth.challenge");
    const closedP = waitClose(ws);
    const relayNonce = String(challenge["nonce"]);
    ws.send(
      JSON.stringify({
        type: "auth.response",
        proof: hmacHex(token, extProofMessage(port, relayNonce, extNonce)),
      }),
    );
    return closedP;
  }

  test("S5: fresh in-progress handshake reports pending (not hung) until timeout fires", async () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBe(5_000);
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({
      ...allocPortWindow(),
      token,
      handshakeTimeoutMs: 140,
      waitConnectMs: 200,
      listTargetsWaitMs: 200,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    // Client completes hello, receives auth.challenge, then stalls without auth.response.
    const ws = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ws);
    const challengeP = waitMessage(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        profileId: "p-stall",
        browser: "Chrome",
        version: "2.0.0",
        helpersVersion: PAGE_HELPERS_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        nonce: randomBytes(16).toString("hex"),
      }),
    );
    const challenge = await challengeP;
    expect(challenge["type"]).toBe("auth.challenge");

    // While in-progress before timeout, status reports "pending" and never "hung" or reload advice.
    const pendingRecs = backend.getHandshakeRecords();
    expect(pendingRecs).toHaveLength(1);
    expect(pendingRecs[0]).toMatchObject({
      stage: "challenge_sent",
      protocolVersion: PROTOCOL_VERSION,
      helpersVersion: PAGE_HELPERS_VERSION,
      browser: "Chrome",
    });
    expect(typeof pendingRecs[0]!.remotePort).toBe("number");
    expect(typeof pendingRecs[0]!.timestamp).toBe("number");

    const pendingStatus = await extensionStatusReport(backend, ["extension"], undefined, 0);
    expect(pendingStatus["browsers"]).toBe(0);
    expect(String(pendingStatus["fix"])).toBe("Extension handshake pending (challenge_sent).");
    expect(String(pendingStatus["fix"])).not.toMatch(/hung|timed out|reload Browser Control/i);

    // Wait for the handshake timeout to close the stalled socket.
    const closed = await waitClose(ws, 2_000);
    expect(closed.code).toBe(CLOSE_AUTH_REFUSED);
    expect(closed.reason).toContain("handshake timeout");
    expect(closed.reason).toContain("auth.response");

    const afterRecs = backend.getHandshakeRecords();
    expect(afterRecs).toHaveLength(1);
    expect(afterRecs[0]).toMatchObject({
      stage: "rejected",
      lastStage: "challenge_sent",
      failureKind: "handshake_timeout",
      paired: "unknown",
      closeCode: CLOSE_AUTH_REFUSED,
      reason: "handshake_timeout_auth_response",
    });

    const afterStatus = await extensionStatusReport(backend, ["extension"], undefined, 0);
    expect(String(afterStatus["fix"])).toMatch(/handshake timed out \(challenge_sent\)/i);
    expect(String(afterStatus["fix"])).not.toContain("reload Browser Control");

    // Same profile reconnecting cleanly clears its rejection and stale fix.
    const good = await connectMockExtension(port, token, undefined, { profileId: "p-stall", browser: "Chrome" });
    expect(good.welcome["type"]).toBe("welcome");
    const healthyStatus = await extensionStatusReport(backend, ["extension"], undefined, 0);
    expect(healthyStatus["browsers"]).toBe(1);
    expect(healthyStatus["fix"]).toBeUndefined();
    expect(backend.getHandshakeRecords()).toEqual([]);
  });

  test("R1: paired helpers mismatch (4003) verifies proof first, records paired: true, and shows reload fix", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({
      ...allocPortWindow(),
      token,
      helpersVersion: 9,
      waitConnectMs: 80,
      listTargetsWaitMs: 80,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const closed = await sendPairedHelpersMismatch(port, token, { profileId: "p-old", helpersVersion: 8 });
    expect(closed.code).toBe(CLOSE_VERSION_MISMATCH);
    expect(closed.reason).toContain("helpers=9");

    const expectedFix = "Extension connected but uses helpers v8 (need v9): reload Browser Control at chrome://extensions.";

    const st = await extensionStatusReport(backend, ["extension"], undefined, 0);
    expect(st["browsers"]).toBe(0);
    expect(st["helpersVersion"]).toBe(9);
    expect(st["fix"]).toBe(expectedFix);
    expect(st["handshakes"]).toHaveLength(1);
    expect((st["handshakes"] as RelayHandshakeRecord[])[0]).toMatchObject({
      stage: "rejected",
      lastStage: "challenge_sent",
      failureKind: "version_mismatch",
      paired: true,
      closeCode: CLOSE_VERSION_MISMATCH,
      reason: "helpers_version_mismatch",
      protocolVersion: PROTOCOL_VERSION,
      helpersVersion: 8,
    });

    const diag = (await extensionDiagnosticsReport(backend, ["extension"], { waitMs: 0 })) as {
      daemon: Record<string, unknown>;
      browsers: unknown[];
    };
    expect(diag.browsers).toEqual([]);
    expect(diag.daemon["fix"]).toBe(expectedFix);
    expect((diag.daemon["handshakes"] as RelayHandshakeRecord[])[0]).toMatchObject({
      helpersVersion: 8,
      paired: true,
    });

    const ops = route(fakeCdp([]), [backend], () => ["extension"]);
    const err = await Promise.resolve(ops["list_targets"]!({})).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("EXTENSION_ONLY:");
    expect((err as Error).message).toContain(expectedFix.replace(/\.$/, ""));
    expect((err as Error).message).not.toContain("did not connect within");
  });

  test("R1: unpaired helpers mismatch, client invalid relay proof, and protocol mismatch report other client with no reload/setup advice", async () => {
    const token = randomBytes(32).toString("hex");
    const wrongToken = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({
      ...allocPortWindow(),
      token,
      helpersVersion: 9,
      waitConnectMs: 80,
      listTargetsWaitMs: 80,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    // 1. Helpers mismatch with WRONG token proof -> 4006 pairing_mismatch, paired: false, no reload/setup advice.
    const wrongClosed = await sendPairedHelpersMismatch(port, wrongToken, { profileId: "p-unpaired", helpersVersion: 8 });
    expect(wrongClosed.code).toBe(CLOSE_AUTH_REFUSED);
    let st = await extensionStatusReport(backend, ["extension"], undefined, 0);
    expect(String(st["fix"])).toContain("other client (not your paired extension)");
    expect(String(st["fix"])).not.toMatch(/reload Browser Control|extension setup/i);
    expect((st["handshakes"] as RelayHandshakeRecord[]).at(-1)).toMatchObject({
      stage: "rejected",
      lastStage: "challenge_sent",
      failureKind: "pairing_mismatch",
      paired: false,
      closeCode: CLOSE_AUTH_REFUSED,
      reason: "auth_refused",
    });

    // 2. Client-side 4006 "invalid relay proof" -> pairing_mismatch, paired: false, no reload/setup advice.
    const ws = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ws);
    const challengeP = waitMessage(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        profileId: "p-bad-pair",
        browser: "Chrome",
        version: "2.0.0",
        helpersVersion: 9,
        protocolVersion: PROTOCOL_VERSION,
        nonce: randomBytes(16).toString("hex"),
      }),
    );
    await challengeP;
    ws.close(CLOSE_AUTH_REFUSED, "invalid relay proof");
    await waitClose(ws);
    await new Promise((r) => setTimeout(r, 30));

    st = await extensionStatusReport(backend, ["extension"], undefined, 0);
    expect(String(st["fix"])).toContain("other client (not your paired extension)");
    expect(String(st["fix"])).not.toMatch(/reload Browser Control|extension setup/i);
    expect((st["handshakes"] as RelayHandshakeRecord[]).at(-1)).toMatchObject({
      stage: "rejected",
      lastStage: "challenge_sent",
      failureKind: "pairing_mismatch",
      paired: false,
      closeCode: CLOSE_AUTH_REFUSED,
      reason: "invalid_relay_proof",
    });

    const ops = route(fakeCdp([]), [backend], () => ["extension"]);
    const err = await Promise.resolve(ops["list_targets"]!({})).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("EXTENSION_ONLY:");
    expect((err as Error).message).toContain("other client (not your paired extension)");
    expect((err as Error).message).not.toMatch(/reload Browser Control|extension setup/i);

    // 3. Protocol mismatch cannot be verified -> 4003, paired: "unknown", no reload/setup advice.
    const wsProto = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(wsProto);
    const closedProto = waitClose(wsProto);
    wsProto.send(
      JSON.stringify({
        type: "hello",
        profileId: "p-proto",
        browser: "Chrome",
        version: "2.0.0",
        helpersVersion: 9,
        protocolVersion: PROTOCOL_VERSION + 1,
        nonce: randomBytes(16).toString("hex"),
      }),
    );
    expect((await closedProto).code).toBe(CLOSE_VERSION_MISMATCH);
    st = await extensionStatusReport(backend, ["extension"], undefined, 0);
    expect(String(st["fix"])).toContain("other client (not your paired extension)");
    expect(String(st["fix"])).not.toMatch(/reload Browser Control|extension setup/i);
    expect((st["handshakes"] as RelayHandshakeRecord[]).at(-1)).toMatchObject({
      stage: "rejected",
      lastStage: "hello_received",
      failureKind: "version_mismatch",
      paired: "unknown",
      closeCode: CLOSE_VERSION_MISMATCH,
      reason: "protocol_version_mismatch",
      protocolVersion: PROTOCOL_VERSION + 1,
    });
  });

  test("S6: client 4006 with non-proof reasons is protocol_error with no setup or reload advice", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 60, listTargetsWaitMs: 60 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    for (const [peerReason, expectedReason] of [
      ["invalid relay nonce", "invalid_relay_nonce"],
      ["welcome before auth", "welcome_before_auth"],
      ["custom auth error from peer", "client_protocol_error"],
    ] as const) {
      const ws = openWs(`ws://127.0.0.1:${port}/extension`);
      await waitOpen(ws);
      const challengeP = waitMessage(ws);
      ws.send(
        JSON.stringify({
          type: "hello",
          profileId: `p-${expectedReason}`,
          browser: "Chrome",
          version: "2.0.0",
          helpersVersion: PAGE_HELPERS_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          nonce: randomBytes(16).toString("hex"),
        }),
      );
      await challengeP;
      ws.close(CLOSE_AUTH_REFUSED, peerReason);
      await waitClose(ws);
      await new Promise((r) => setTimeout(r, 30));

      const st = await extensionStatusReport(backend, ["extension"], undefined, 0);
      expect((st["handshakes"] as RelayHandshakeRecord[]).at(-1)).toMatchObject({
        stage: "rejected",
        failureKind: "protocol_error",
        paired: "unknown",
        closeCode: CLOSE_AUTH_REFUSED,
        reason: expectedReason,
      });
      expect(String(st["fix"])).toContain("protocol error");
      expect(String(st["fix"])).not.toMatch(/extension setup|pairing|reload Browser Control/i);
    }
  });

  test("S1: never stores raw peer close text or unsanitized hello fields with embedded secrets", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 50, listTargetsWaitMs: 50 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const embeddedSecret = "ab".repeat(32);
    const ws = openWs(`ws://127.0.0.1:${port}/extension`);
    await waitOpen(ws);
    const challengeP = waitMessage(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        profileId: `p-leak-${embeddedSecret}`,
        browser: `Chrome token=${embeddedSecret}`,
        version: `2.0.0-${embeddedSecret}`,
        helpersVersion: PAGE_HELPERS_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        nonce: randomBytes(16).toString("hex"),
      }),
    );
    await challengeP;
    ws.close(CLOSE_AUTH_REFUSED, `peer leak secret=${embeddedSecret} tail`);
    await waitClose(ws);
    await new Promise((r) => setTimeout(r, 30));

    const records = backend.getHandshakeRecords();
    const st = await extensionStatusReport(backend, ["extension"], undefined, 0);
    const diag = await extensionDiagnosticsReport(backend, ["extension"], { waitMs: 0 });
    const serialized = JSON.stringify({ records, st, diag });

    expect(serialized).not.toContain(embeddedSecret);
    expect(serialized).not.toContain("peer leak");
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain("p-leak-");
    expect(records[0]).toMatchObject({
      stage: "rejected",
      failureKind: "protocol_error",
      reason: "client_protocol_error",
      protocolVersion: PROTOCOL_VERSION,
      helpersVersion: PAGE_HELPERS_VERSION,
    });
    expect(records[0]!.browser).toBeUndefined();
    expect(records[0]!.extensionVersion).toBeUndefined();
  });

  test("S3: healthy Chrome profile keeps another profile's rejection and old failures never resurface in EXTENSION_ONLY after disconnect", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({
      ...allocPortWindow(),
      token,
      helpersVersion: PAGE_HELPERS_VERSION,
      waitConnectMs: 60,
      listTargetsWaitMs: 60,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    // Profile B (Chrome) fails with paired helpers version mismatch.
    const closedB = await sendPairedHelpersMismatch(port, token, {
      profileId: "p-chrome-b",
      browser: "Chrome",
      helpersVersion: PAGE_HELPERS_VERSION - 1,
    });
    expect(closedB.code).toBe(CLOSE_VERSION_MISMATCH);
    expect(backend.getHandshakeRecords()).toHaveLength(1);

    // Healthy Profile A (also Chrome!) connects: must NOT erase Profile B's rejection.
    const healthyA = await connectMockExtension(port, token, undefined, {
      profileId: "p-chrome-a",
      browser: "Chrome",
    });
    expect(healthyA.welcome["type"]).toBe("welcome");
    const recsWhileConnected = backend.getHandshakeRecords();
    expect(recsWhileConnected).toHaveLength(1);
    expect(recsWhileConnected[0]).toMatchObject({
      stage: "rejected",
      failureKind: "version_mismatch",
      paired: true,
      helpersVersion: PAGE_HELPERS_VERSION - 1,
    });

    // Profile A disconnects: Profile B's older rejection must NOT resurface in EXTENSION_ONLY.
    healthyA.ws.close(1000, "bye");
    await waitClose(healthyA.ws);
    await new Promise((r) => setTimeout(r, 30));

    const ops = route(fakeCdp([]), [backend], () => ["extension"]);
    const err = await Promise.resolve(ops["list_targets"]!({})).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("EXTENSION_ONLY:");
    expect((err as Error).message).toContain("did not connect within");
    expect((err as Error).message).not.toContain("reload Browser Control");

    // When Profile B itself later connects healthy, Profile B's rejection IS cleared.
    const healthyB = await connectMockExtension(port, token, undefined, {
      profileId: "p-chrome-b",
      browser: "Chrome",
    });
    expect(healthyB.welcome["type"]).toBe("welcome");
    expect(backend.getHandshakeRecords()).toEqual([]);
  });

  test("S7: diagnostic storage is capped at MAX_TRACKED_HANDSHAKES (8) independently of per-socket timers", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({
      ...allocPortWindow(),
      token,
      handshakeTimeoutMs: 160,
      waitConnectMs: 50,
    });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    // 1. Rejected history stays bounded to 8.
    for (let i = 0; i < MAX_TRACKED_HANDSHAKES + 4; i++) {
      const ws = openWs(`ws://127.0.0.1:${port}/extension`);
      await waitOpen(ws);
      const closedP = waitClose(ws);
      ws.send(
        JSON.stringify({
          type: "hello",
          profileId: `p-${i}`,
          browser: "Chrome",
          version: "2.0.0",
          helpersVersion: 100 + i,
          protocolVersion: PROTOCOL_VERSION + 1,
          nonce: randomBytes(16).toString("hex"),
        }),
      );
      await closedP;
    }
    const rejectedRecords = backend.getHandshakeRecords();
    expect(rejectedRecords).toHaveLength(MAX_TRACKED_HANDSHAKES);
    expect(rejectedRecords[0]!.helpersVersion).toBe(104);
    expect(rejectedRecords.at(-1)!.helpersVersion).toBe(100 + MAX_TRACKED_HANDSHAKES + 3);

    // 2. Concurrent pre-auth sockets > 8 cap pending diagnostic storage at 8 while EVERY socket still times out.
    const totalConcurrent = MAX_TRACKED_HANDSHAKES + 6;
    const pendingSockets: WebSocket[] = [];
    const closePromises: Promise<{ code: number; reason: string }>[] = [];
    for (let i = 0; i < totalConcurrent; i++) {
      const ws = openWs(`ws://127.0.0.1:${port}/extension`);
      await waitOpen(ws);
      pendingSockets.push(ws);
      closePromises.push(waitClose(ws, 2_000));
    }
    expect(backend.getHandshakeRecords()).toHaveLength(MAX_TRACKED_HANDSHAKES);

    const closedAll = await Promise.all(closePromises);
    expect(closedAll).toHaveLength(totalConcurrent);
    expect(closedAll.every((c) => c.code === CLOSE_AUTH_REFUSED && c.reason.includes("handshake timeout"))).toBe(true);
    expect(backend.getHandshakeRecords()).toHaveLength(MAX_TRACKED_HANDSHAKES);
  });

  test("formatHandshakeFix covers paired helpers mismatch, unpaired clients, protocol errors, pending and timed-out handshakes", () => {
    expect(formatHandshakeFix([])).toBeUndefined();
    expect(
      formatHandshakeFix(
        [
          {
            remotePort: 50001,
            stage: "rejected",
            failureKind: "version_mismatch",
            paired: true,
            closeCode: 4003,
            helpersVersion: 8,
            protocolVersion: 1,
            timestamp: 1,
          },
        ],
        { protocolVersion: 1, helpersVersion: 9 },
      ),
    ).toBe("Extension connected but uses helpers v8 (need v9): reload Browser Control at chrome://extensions.");
    expect(
      formatHandshakeFix(
        [
          {
            remotePort: 50002,
            stage: "rejected",
            failureKind: "version_mismatch",
            paired: "unknown",
            closeCode: 4003,
            helpersVersion: 9,
            protocolVersion: 2,
            timestamp: 1,
          },
        ],
        { protocolVersion: 1, helpersVersion: 9 },
      ),
    ).toBe("Rejected handshake from other client (not your paired extension): uses protocol v2 (need v1).");
    expect(
      formatHandshakeFix([
        {
          remotePort: 50003,
          stage: "rejected",
          failureKind: "pairing_mismatch",
          paired: false,
          closeCode: 4006,
          reason: "invalid_relay_proof",
          timestamp: 1,
        },
      ]),
    ).toBe("Rejected handshake from other client (not your paired extension): pairing proof failed.");
    expect(
      formatHandshakeFix([
        {
          remotePort: 50004,
          stage: "rejected",
          failureKind: "protocol_error",
          paired: "unknown",
          closeCode: 4006,
          reason: "invalid_relay_nonce",
          timestamp: 1,
        },
      ]),
    ).toBe("Rejected handshake from other client (not your paired extension): protocol error (invalid_relay_nonce).");
    expect(
      formatHandshakeFix([{ remotePort: 50005, stage: "opened", timestamp: 1 }]),
    ).toBe("Extension handshake pending (opened).");
    expect(
      formatHandshakeFix([
        {
          remotePort: 50006,
          stage: "rejected",
          lastStage: "opened",
          failureKind: "handshake_timeout",
          paired: "unknown",
          closeCode: 4006,
          reason: "handshake_timeout_hello",
          timestamp: 1,
        },
      ]),
    ).toBe("Extension handshake timed out (opened) before pairing proof.");
  });

  test("GET /version sends Connection: close so probe sockets do not linger", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ ...allocPortWindow(), token, waitConnectMs: 200 });
    disposables.push(backend);
    await backend.start!();
    const port = backend.getPort()!;

    const resp = await fetch(`http://127.0.0.1:${port}/version`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("connection")?.toLowerCase()).toBe("close");
  });
});
