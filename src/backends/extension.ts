/**
 * The `extension` backend: drives a real Chromium browser through the local MV3 companion
 * extension over a loopback WebSocket relay (127.0.0.1, ports 49222-49229).
 *
 * Needs no remote-debugging flag and no per-connection "Allow" click. Silent reads run in the
 * extension's ISOLATED content-script world via `bc_call`; trusted input and DevTools calls
 * attach `chrome.debugger` on demand via `cdp`.
 *
 * Mutual HMAC-SHA256 challenge-response handshake and MV3 keepalive patterns adapted from
 * anomalyco/browse (MIT License).
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { EventBuffer, eventMatches, type CdpEvent, type EventMatcher } from "../events";
import { PAGE_HELPERS_VERSION, type HelperStep, type NormalizedHelperCall } from "../page-helpers";
import { isBlockedCdpMethod, isBrowserLevelMethod } from "../session";
import { BackendUnavailable, prefixOf, type Backend, type BackendTarget, type OpInput } from "./types";

export const NAME = "extension";
export const EXTENSION_ID = "gdoaemlogkgnnojmjcgjfaphohadilcf";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
export const RELAY_VERSION = "2.0.0";
export const PROTOCOL_VERSION = 1;

export const PORT_RANGE_START = 49222;
export const PORT_RANGE_END = 49229;

export const PRE_AUTH_MAX_BYTES = 64 * 1024;
export const POST_AUTH_MAX_BYTES = 64 * 1024 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export const CLOSE_REPLACED = 4001;
export const CLOSE_BAD_HELLO = 4002;
export const CLOSE_VERSION_MISMATCH = 4003;
export const CLOSE_AUTH_REFUSED = 4006;

const DEFAULT_WAIT_CONNECT_MS = 35_000;
const DEFAULT_LIST_WAIT_MS = 5_000;
const DEFAULT_REQ_TIMEOUT_MS = 60_000;

const OPS = new Set([
  "select_target",
  "navigate",
  "evaluate",
  "execute_cdp",
  "capture_screenshot",
  "capture_pdf",
  "read_events",
  "wait_for_event",
]);

const HEX_32_RE = /^[0-9a-f]{32}$/i;
const HEX_64_RE = /^[0-9a-f]{64}$/i;

export function relayProofMessage(port: number, extNonce: string, relayNonce: string): string {
  return `bc-v2|relay|127.0.0.1:${port}/extension|${extNonce}|${relayNonce}`;
}

export function extProofMessage(port: number, relayNonce: string, extNonce: string): string {
  return `bc-v2|ext|127.0.0.1:${port}/extension|${relayNonce}|${extNonce}`;
}

export function hmacHex(token: string, message: string): string {
  return createHmac("sha256", token).update(message, "utf8").digest("hex");
}

function safeEqualHex(expectedHex: string, actualHex: unknown): boolean {
  if (typeof actualHex !== "string" || !HEX_64_RE.test(actualHex)) return false;
  const a = Buffer.from(expectedHex.toLowerCase(), "hex");
  const b = Buffer.from(actualHex.toLowerCase(), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function defaultTokenFilePath(): string {
  const config = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(config, "browser-control", "extension-relay.json");
}

type TokenRead = { token: string } | { state: "missing" | "bad" };

async function readPrivateToken(tokenFile: string): Promise<TokenRead> {
  let info;
  try {
    info = await stat(tokenFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    throw error;
  }
  if ((info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    return { state: "bad" };
  }
  try {
    const parsed = JSON.parse(await readFile(tokenFile, "utf8")) as { token?: unknown };
    if (typeof parsed.token === "string" && HEX_64_RE.test(parsed.token)) return { token: parsed.token.toLowerCase() };
  } catch {
    /* unreadable or not JSON */
  }
  return { state: "bad" };
}

/** Write `body` to a new 0600 temp file beside `file`, then publish it. `replace: false` keeps an existing file. */
async function publishPrivateFile(file: string, body: string, replace: boolean): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, body, { mode: 0o600, flag: "wx" });
  try {
    if (replace) {
      await rename(tmp, file);
      return true;
    }
    try {
      await link(tmp, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

const newTokenBody = (token: string) => `${JSON.stringify({ token }, null, 2)}\n`;

/**
 * The daemon's token: read it, or create it once if missing (atomic; a concurrent creator wins and
 * everyone reads its file). A broken or non-private file is never reused or rotated here; only
 * `extension-setup` replaces it, so two daemons can never end up with different tokens.
 */
export async function ensureRelayToken(tokenFile: string = defaultTokenFilePath()): Promise<string> {
  await mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = await readPrivateToken(tokenFile);
    if ("token" in read) return read.token;
    if (read.state === "bad") {
      throw new Error(
        `EXECUTION_FAILED: relay token file ${tokenFile} is not private or not valid; run: browser-control-daemon extension setup (or bun ./cli.ts extension-setup <extensionDir>) to replace it`,
      );
    }
    const token = randomBytes(32).toString("hex");
    if (await publishPrivateFile(tokenFile, newTokenBody(token), false)) return token;
  }
  throw new Error(`EXECUTION_FAILED: could not read the relay token at ${tokenFile}`);
}

/** Replace a broken or non-private token file with a new private one (user-run setup only). */
async function repairRelayToken(tokenFile: string): Promise<string> {
  await mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
  const read = await readPrivateToken(tokenFile);
  if (!("token" in read) && read.state === "bad") await publishPrivateFile(tokenFile, newTokenBody(randomBytes(32).toString("hex")), true);
  return ensureRelayToken(tokenFile);
}

export async function setupExtensionPairing(
  extensionDir: string,
  options: { tokenFile?: string; port?: number } = {},
): Promise<{ tokenFile: string; pairingFile: string; port: number }> {
  const tokenFile = options.tokenFile ?? defaultTokenFilePath();
  const port = options.port ?? PORT_RANGE_START;
  const token = await repairRelayToken(tokenFile);
  const resolvedDir = resolvePath(extensionDir);
  await mkdir(resolvedDir, { recursive: true });
  const pairingFile = join(resolvedDir, "pairing.json");
  await publishPrivateFile(pairingFile, `${JSON.stringify({ token, port }, null, 2)}\n`, true);
  return { tokenFile, pairingFile, port };
}

/** Combine structured `bc_call` step results the same way `renderSteps()` evaluates them on CDP. */
export function combineStepValues(call: NormalizedHelperCall, values: readonly unknown[]): unknown {
  const { steps, join } = call;
  if (steps.length === 0) {
    throw new Error("INPUT_INVALID: helper call requires at least one step");
  }
  const valueAt = (index: number): unknown => {
    const step = steps[index]!;
    const value = values[index];
    return step.kind === "bc" && step.fallback === "" ? (value || "") : value;
  };
  if (join === undefined) {
    return valueAt(steps.length - 1);
  }
  const kept: unknown[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (!steps[i]!.discard) kept.push(valueAt(i));
  }
  return kept.map((v) => (v === null || v === undefined ? "" : String(v))).join(join);
}

const id = (tab: number) => `${NAME}:${tab}`;

export function extensionTabOf(targetId: unknown): number | undefined {
  if (prefixOf(targetId) !== NAME) return undefined;
  const n = Number((targetId as string).slice(NAME.length + 1));
  return Number.isInteger(n) ? n : undefined;
}

export type BcCallInput = {
  targetId?: string;
  steps: readonly HelperStep[];
  join?: string;
  frameId?: number;
  timeoutMs?: number;
};

export type BcCallFn = (input: BcCallInput) => Promise<{ value: unknown }>;

const BC_CALL_SYMBOL = Symbol.for("browser-control.extension-bc-call");

export function registerExtensionBcCall(fn: BcCallFn | undefined): void {
  const holder = globalThis as Record<symbol, unknown>;
  if (fn) {
    holder[BC_CALL_SYMBOL] = fn;
  } else {
    delete holder[BC_CALL_SYMBOL];
  }
}

export function getRegisteredExtensionBcCall(): BcCallFn | undefined {
  return (globalThis as Record<symbol, unknown>)[BC_CALL_SYMBOL] as BcCallFn | undefined;
}

type WsState = {
  stage: "awaiting_hello" | "awaiting_response" | "ready";
  authenticated: boolean;
  handshakeTimer?: ReturnType<typeof setTimeout>;
  extNonce?: string;
  relayNonce?: string;
  profileId?: string;
  browser?: string;
  extensionVersion?: string;
};

type PendingReq = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventWaiter = {
  matcher: EventMatcher;
  resolve: (event: CdpEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ExtensionBackendOptions = {
  portStart?: number;
  portEnd?: number;
  expectedOrigin?: string;
  tokenFile?: string;
  token?: string;
  handshakeTimeoutMs?: number;
  waitConnectMs?: number;
  listTargetsWaitMs?: number;
  helpersVersion?: number;
  artifactDir?: () => string;
  eventBufferSize?: number;
  registerGlobal?: boolean;
};

export interface ExtensionBackend extends Backend {
  readonly instanceId: string;
  getPort(): number | undefined;
  isConnected(): boolean;
  request(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  bcCall(input: BcCallInput): Promise<{ value: unknown }>;
  waitForConnection(timeoutMs?: number): Promise<void>;
}

function defaultArtifactDir(): string {
  const configured = process.env["BROWSER_ARTIFACT_DIR"];
  return configured && configured.trim() !== ""
    ? resolvePath(configured)
    : resolvePath(join(tmpdir(), "browser-control"));
}

async function writeArtifact(
  dir: string,
  path: string | undefined,
  prefix: string,
  extension: string,
  data: Buffer,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = path ? resolvePath(path) : join(dir, `${prefix}-${stamp}-${randomUUID().slice(0, 8)}.${extension}`);
  try {
    await mkdir(dirname(fileName), { recursive: true });
    await writeFile(fileName, data);
  } catch (error) {
    throw new Error(`ARTIFACT_WRITE_FAILED: ${(error as Error).message} (${fileName})`);
  }
  return fileName;
}

export function createExtensionBackend(options: ExtensionBackendOptions = {}): ExtensionBackend {
  const portStart = options.portStart ?? PORT_RANGE_START;
  const portEnd = options.portEnd ?? PORT_RANGE_END;
  const expectedOrigin = options.expectedOrigin ?? EXTENSION_ORIGIN;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const waitConnectMs = options.waitConnectMs ?? DEFAULT_WAIT_CONNECT_MS;
  const listTargetsWaitMs = options.listTargetsWaitMs ?? DEFAULT_LIST_WAIT_MS;
  const expectedHelpersVersion = options.helpersVersion ?? PAGE_HELPERS_VERSION;
  const resolveArtifacts = options.artifactDir ?? defaultArtifactDir;
  const instanceId = randomUUID();

  let server: Server<WsState> | undefined;
  let boundPort: number | undefined;
  let relayToken: string | undefined;
  let startPromise: Promise<void> | undefined;
  let startError: string | undefined;

  let activeSocket: ServerWebSocket<WsState> | undefined;
  let activeTab: number | undefined;
  let nextReqId = 1;
  const pending = new Map<number, PendingReq>();
  const connectWaiters = new Set<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const events = new EventBuffer(options.eventBufferSize ?? 1000);
  const eventWaiters = new Set<EventWaiter>();

  function clearHandshakeTimer(ws: ServerWebSocket<WsState>): void {
    if (ws.data.handshakeTimer) {
      clearTimeout(ws.data.handshakeTimer);
      ws.data.handshakeTimer = undefined;
    }
  }

  function failAllPending(reason: string): void {
    const err = new BackendUnavailable(NAME, reason);
    for (const [reqId, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(reqId);
      p.reject(err);
    }
  }

  function notifyConnected(): void {
    for (const w of [...connectWaiters]) {
      clearTimeout(w.timer);
      connectWaiters.delete(w);
      w.resolve();
    }
  }

  function failConnectWaiters(reason: string): void {
    const err = new BackendUnavailable(NAME, reason);
    for (const w of [...connectWaiters]) {
      clearTimeout(w.timer);
      connectWaiters.delete(w);
      w.reject(err);
    }
  }

  function dispatchEvent(msg: { tabId?: unknown; sessionId?: unknown; method?: unknown; params?: unknown }): void {
    if (typeof msg.method !== "string") return;
    const tabId = typeof msg.tabId === "number" ? msg.tabId : undefined;
    const sessionId =
      typeof msg.sessionId === "string"
        ? msg.sessionId
        : tabId !== undefined
          ? id(tabId)
          : undefined;
    const params =
      typeof msg.params === "object" && msg.params !== null && !Array.isArray(msg.params)
        ? (msg.params as Record<string, unknown>)
        : {};
    const event = events.push(msg.method, params, sessionId);
    for (const waiter of [...eventWaiters]) {
      if (eventMatches(event, waiter.matcher)) {
        clearTimeout(waiter.timer);
        eventWaiters.delete(waiter);
        events.remove([event]);
        waiter.resolve(event);
      }
    }
  }

  function handleWsMessage(ws: ServerWebSocket<WsState>, raw: string | Buffer): void {
    const data = ws.data;
    const byteLen = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;

    if (!data.authenticated && byteLen > PRE_AUTH_MAX_BYTES) {
      clearHandshakeTimer(ws);
      ws.close(1009, "pre-auth message too large");
      return;
    }

    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      msg = parsed as Record<string, unknown>;
    } catch {
      if (!data.authenticated) {
        clearHandshakeTimer(ws);
        ws.close(CLOSE_BAD_HELLO, "bad hello: invalid JSON");
      }
      return;
    }

    if (data.stage === "awaiting_hello") {
      if (msg["type"] !== "hello") {
        clearHandshakeTimer(ws);
        ws.close(CLOSE_BAD_HELLO, "bad hello: expected hello");
        return;
      }
      const profileId = msg["profileId"];
      const browser = msg["browser"];
      const version = msg["version"];
      const helpersVersion = msg["helpersVersion"];
      const protocolVersion = msg["protocolVersion"];
      const nonce = msg["nonce"];
      if (
        typeof profileId !== "string" || profileId.trim() === "" ||
        typeof browser !== "string" || browser.trim() === "" ||
        typeof version !== "string" || version.trim() === "" ||
        typeof helpersVersion !== "number" || !Number.isInteger(helpersVersion) ||
        typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion) ||
        typeof nonce !== "string" || !HEX_32_RE.test(nonce)
      ) {
        clearHandshakeTimer(ws);
        ws.close(CLOSE_BAD_HELLO, "bad hello: missing or malformed fields");
        return;
      }
      if (protocolVersion !== PROTOCOL_VERSION || helpersVersion !== expectedHelpersVersion) {
        clearHandshakeTimer(ws);
        ws.close(
          CLOSE_VERSION_MISMATCH,
          `version mismatch: expected protocol=${PROTOCOL_VERSION} helpers=${expectedHelpersVersion}`,
        );
        return;
      }

      const extNonce = nonce.toLowerCase();
      const relayNonce = randomBytes(16).toString("hex");
      data.extNonce = extNonce;
      data.relayNonce = relayNonce;
      data.profileId = profileId;
      data.browser = browser;
      data.extensionVersion = version;
      data.stage = "awaiting_response";

      const proof = hmacHex(relayToken!, relayProofMessage(boundPort!, extNonce, relayNonce));
      ws.send(JSON.stringify({ type: "auth.challenge", nonce: relayNonce, proof }));
      return;
    }

    if (data.stage === "awaiting_response") {
      if (msg["type"] !== "auth.response") {
        clearHandshakeTimer(ws);
        ws.close(CLOSE_BAD_HELLO, "expected auth.response");
        return;
      }
      const expectedProof = hmacHex(
        relayToken!,
        extProofMessage(boundPort!, data.relayNonce!, data.extNonce!),
      );
      if (!safeEqualHex(expectedProof, msg["proof"])) {
        clearHandshakeTimer(ws);
        ws.close(CLOSE_AUTH_REFUSED, "auth refused");
        return;
      }

      clearHandshakeTimer(ws);
      data.stage = "ready";
      data.authenticated = true;

      if (activeSocket && activeSocket !== ws) {
        try {
          activeSocket.close(CLOSE_REPLACED, "replaced by newer connection");
        } catch {
          /* ignore */
        }
      }
      activeSocket = ws;
      ws.send(
        JSON.stringify({
          type: "welcome",
          instanceId,
          version: RELAY_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          helpersVersion: expectedHelpersVersion,
        }),
      );
      notifyConnected();
      return;
    }

    // Authenticated traffic
    const type = msg["type"];
    if (type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (type === "res" && typeof msg["id"] === "number") {
      const p = pending.get(msg["id"]);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg["id"]);
      if (msg["ok"] === true) {
        p.resolve(msg["result"]);
      } else {
        const errText = String(msg["error"] ?? "extension request failed");
        if (errText.startsWith("RESTRICTED_PAGE:")) {
          p.reject(new BackendUnavailable(NAME, errText));
        } else {
          p.reject(new Error(errText));
        }
      }
      return;
    }
    if (type === "event") {
      dispatchEvent(msg as { tabId?: unknown; sessionId?: unknown; method?: unknown; params?: unknown });
    }
  }

  async function start(): Promise<void> {
    if (server) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      startError = undefined;
      try {
        relayToken = options.token ?? (await ensureRelayToken(options.tokenFile));
      } catch (error) {
        startError = (error as Error).message.replace(/^EXECUTION_FAILED: /, "");
        throw new BackendUnavailable(NAME, startError);
      }
      let lastErr: unknown;
      for (let port = portStart; port <= portEnd; port++) {
        try {
          const srv = Bun.serve<WsState>({
            hostname: "127.0.0.1",
            port,
            fetch(request, s) {
              const url = new URL(request.url);
              if (request.method === "GET" && url.pathname === "/version") {
                return new Response(
                  JSON.stringify({
                    app: "browser-control",
                    version: RELAY_VERSION,
                    instanceId,
                    protocolVersion: PROTOCOL_VERSION,
                  }),
                  {
                    status: 200,
                    headers: {
                      "content-type": "application/json",
                      "cache-control": "no-store",
                    },
                  },
                );
              }
              if (url.pathname === "/extension") {
                const origin = request.headers.get("origin");
                if (origin !== expectedOrigin) {
                  return new Response("Forbidden", { status: 403 });
                }
                const upgraded = s.upgrade(request, {
                  data: {
                    stage: "awaiting_hello",
                    authenticated: false,
                  },
                });
                if (upgraded) return undefined;
                return new Response("Upgrade Required", { status: 426 });
              }
              return new Response("Not Found", { status: 404 });
            },
            websocket: {
              maxPayloadLength: POST_AUTH_MAX_BYTES,
              perMessageDeflate: false,
              open(ws) {
                ws.data.handshakeTimer = setTimeout(() => {
                  if (!ws.data.authenticated) {
                    ws.close(CLOSE_AUTH_REFUSED, "handshake timeout");
                  }
                }, handshakeTimeoutMs);
              },
              message(ws, message) {
                handleWsMessage(ws, message);
              },
              close(ws) {
                clearHandshakeTimer(ws);
                if (activeSocket === ws) {
                  activeSocket = undefined;
                  failAllPending("extension disconnected");
                }
              },
            },
          });
          server = srv;
          boundPort = srv.port;
          if (options.registerGlobal) {
            registerExtensionBcCall(bcCall);
          }
          return;
        } catch (err) {
          lastErr = err;
        }
      }
      startError = lastErr instanceof Error ? `no free relay port (${lastErr.message})` : "no free relay port";
      throw new BackendUnavailable(NAME, startError);
    })().finally(() => {
      startPromise = undefined;
    });
    return startPromise;
  }

  async function waitForConnection(timeoutMs: number = waitConnectMs): Promise<void> {
    await start();
    if (activeSocket && activeSocket.data.authenticated) return;
    if (timeoutMs <= 0) {
      throw new BackendUnavailable(NAME, "extension is not connected");
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          connectWaiters.delete(entry);
          reject(
            new BackendUnavailable(
              NAME,
              `extension did not connect within ${timeoutMs}ms (relay listening on 127.0.0.1:${boundPort})`,
            ),
          );
        }, timeoutMs),
      };
      connectWaiters.add(entry);
    });
  }

  async function request(
    op: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_REQ_TIMEOUT_MS,
  ): Promise<unknown> {
    await waitForConnection();
    const ws = activeSocket;
    if (!ws || !ws.data.authenticated) {
      throw new BackendUnavailable(NAME, "extension is not connected");
    }
    const reqId = nextReqId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`CDP_TIMEOUT: extension op "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(reqId, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ type: "req", id: reqId, op, params }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(reqId);
        reject(new BackendUnavailable(NAME, `failed to send to extension: ${(err as Error).message}`));
      }
    });
  }

  function tabFor(input: OpInput): number | undefined {
    return extensionTabOf(input["targetId"]) ?? activeTab;
  }

  async function bcCall(input: BcCallInput): Promise<{ value: unknown }> {
    const tab = extensionTabOf(input.targetId) ?? activeTab;
    if (tab === undefined) {
      throw new BackendUnavailable(NAME, "no extension tab selected");
    }
    const reqTimeout = typeof input.timeoutMs === "number" ? input.timeoutMs + 5_000 : DEFAULT_REQ_TIMEOUT_MS;
    const res = (await request(
      "bc_call",
      {
        tabId: tab,
        steps: input.steps,
        ...(typeof input.frameId === "number" ? { frameId: input.frameId } : {}),
        ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
      },
      reqTimeout,
    )) as { values?: unknown[] };
    const values = Array.isArray(res?.values) ? res.values : [];
    const value = combineStepValues({ steps: input.steps, join: input.join }, values);
    return { value };
  }

  return {
    name: NAME,
    instanceId,

    getPort() {
      return boundPort;
    },

    isConnected() {
      return Boolean(activeSocket && activeSocket.data.authenticated);
    },

    start,
    waitForConnection,
    request,
    bcCall,

    handles(op, input, isActive) {
      if (!OPS.has(op)) return false;
      if (op === "navigate" && (typeof input["url"] !== "string" || input["url"] === "")) return false;
      if (op === "select_target") return extensionTabOf(input["targetId"]) !== undefined;
      if (op === "execute_cdp") {
        const method = input["method"];
        if (typeof method !== "string" || method === "") return false;
        if (isBrowserLevelMethod(method)) return false;
      }
      if (extensionTabOf(input["targetId"]) !== undefined) return true;
      if (input["targetId"] !== undefined) return false;
      return op === "navigate" ? isActive || activeTab === undefined : isActive && activeTab !== undefined;
    },

    async invoke(op, input) {
      const timeoutMs = typeof input["timeoutMs"] === "number" ? input["timeoutMs"] : undefined;

      switch (op) {
        case "select_target": {
          const tab = extensionTabOf(input["targetId"]);
          if (tab === undefined) throw new Error("INPUT_INVALID: invalid extension targetId");
          activeTab = tab;
          return { activeTargetId: id(tab), targetId: id(tab), backend: NAME };
        }

        case "navigate": {
          const url = String(input["url"] ?? "");
          if (!url) throw new Error("INPUT_INVALID: url is required");
          const tab = tabFor(input);
          const until = input["until"] === "domcontentloaded" ? "domcontentloaded" : "load";
          const res = (await request(
            "navigate",
            {
              ...(tab !== undefined ? { tabId: tab } : {}),
              url,
              until,
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            },
            (timeoutMs ?? 30_000) + 10_000,
          )) as { tabId?: number; loaded?: boolean; url?: string; title?: string };
          const tid = typeof res?.tabId === "number" ? res.tabId : tab;
          if (tid !== undefined) activeTab = tid;
          return {
            loaded: res?.loaded !== false,
            targetId: tid === undefined ? null : id(tid),
            url: res?.url ?? url,
            title: res?.title ?? "",
            backend: NAME,
          };
        }

        case "evaluate": {
          const expression = typeof input["expression"] === "string" ? input["expression"] : "";
          if (!expression) throw new Error("INPUT_INVALID: expression is required");
          if (/\b__bc\b/.test(expression)) {
            throw new Error("INTERNAL: __bc calls on extension tabs must use bc_call, never evaluate");
          }
          const tab = tabFor(input);
          if (tab === undefined) throw new BackendUnavailable(NAME, "no extension tab selected");
          const res = (await request(
            "eval",
            { tabId: tab, expression, isolated: input["isolated"] === true },
            timeoutMs ?? DEFAULT_REQ_TIMEOUT_MS,
          )) as { value?: unknown; contextId?: number };
          return {
            value: res?.value,
            ...(res?.contextId !== undefined ? { contextId: res.contextId } : {}),
          };
        }

        case "execute_cdp": {
          const method = typeof input["method"] === "string" ? input["method"] : "";
          if (!method) throw new Error("INPUT_INVALID: method is required");
          if (isBlockedCdpMethod(method)) {
            throw new Error(`REFUSED: ${method} is blocked so browser-control never closes or crashes the user's browser`);
          }
          const tab = tabFor(input);
          if (tab === undefined) throw new BackendUnavailable(NAME, "no extension tab selected");
          const params =
            typeof input["params"] === "object" && input["params"] !== null && !Array.isArray(input["params"])
              ? (input["params"] as Record<string, unknown>)
              : {};
          const sessionId = typeof input["sessionId"] === "string" ? input["sessionId"] : undefined;
          const res = (await request(
            "cdp",
            {
              tabId: tab,
              method,
              params,
              ...(sessionId ? { sessionId } : {}),
            },
            timeoutMs ?? DEFAULT_REQ_TIMEOUT_MS,
          )) as { result?: unknown };
          return { result: res?.result ?? {} };
        }

        case "capture_screenshot": {
          const tab = tabFor(input);
          if (tab === undefined) throw new BackendUnavailable(NAME, "no extension tab selected");
          const format = input["format"] === "jpeg" ? "jpeg" : "png";
          const quality = typeof input["quality"] === "number" ? input["quality"] : undefined;
          const fullPage = input["fullPage"] === true;
          const clip =
            typeof input["clip"] === "object" && input["clip"] !== null && !Array.isArray(input["clip"])
              ? (input["clip"] as Record<string, unknown>)
              : undefined;
          const res = (await request("screenshot", {
            tabId: tab,
            format,
            ...(quality !== undefined ? { quality } : {}),
            ...(fullPage ? { fullPage: true } : {}),
            ...(clip ? { clip } : {}),
          })) as { data?: string };
          if (!res?.data) throw new Error("EXECUTION_FAILED: screenshot returned no image data");
          const buf = Buffer.from(res.data, "base64");
          const ext = format === "jpeg" ? "jpg" : "png";
          const filePath = await writeArtifact(
            resolveArtifacts(),
            typeof input["path"] === "string" ? input["path"] : undefined,
            "screenshot",
            ext,
            buf,
          );
          const output: Record<string, unknown> = {
            path: filePath,
            mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
            bytes: buf.length,
            targetId: id(tab),
            backend: NAME,
          };
          if (clip) {
            if (typeof clip["width"] === "number") output["width"] = clip["width"];
            if (typeof clip["height"] === "number") output["height"] = clip["height"];
          }
          return output;
        }

        case "capture_pdf": {
          const tab = tabFor(input);
          if (tab === undefined) throw new BackendUnavailable(NAME, "no extension tab selected");
          const params: Record<string, unknown> = {
            printBackground: input["printBackground"] !== false,
          };
          for (const key of [
            "landscape",
            "paperWidth",
            "paperHeight",
            "marginTop",
            "marginBottom",
            "marginLeft",
            "marginRight",
            "pageRanges",
            "scale",
            "preferCSSPageSize",
          ] as const) {
            if (input[key] !== undefined) params[key] = input[key];
          }
          const res = (await request("cdp", {
            tabId: tab,
            method: "Page.printToPDF",
            params,
          })) as { result?: { data?: string } };
          const b64 = res?.result?.data;
          if (!b64) throw new Error("EXECUTION_FAILED: printToPDF returned no data");
          const buf = Buffer.from(b64, "base64");
          const filePath = await writeArtifact(
            resolveArtifacts(),
            typeof input["path"] === "string" ? input["path"] : undefined,
            "page",
            "pdf",
            buf,
          );
          return {
            path: filePath,
            mimeType: "application/pdf",
            bytes: buf.length,
            targetId: id(tab),
            backend: NAME,
          };
        }

        case "read_events": {
          const tab = tabFor(input);
          const sessionId =
            typeof input["sessionId"] === "string"
              ? input["sessionId"]
              : tab !== undefined
                ? id(tab)
                : undefined;
          const limit = typeof input["limit"] === "number" ? input["limit"] : 100;
          const clear = input["clear"] !== false;
          const matched = events.filter(
            {
              method: typeof input["method"] === "string" ? input["method"] : undefined,
              sessionId,
              sinceSeq: typeof input["sinceSeq"] === "number" ? input["sinceSeq"] : undefined,
            },
            limit,
          );
          const dropped = events.droppedCount;
          if (clear) {
            events.remove(matched);
            events.resetDropped();
          }
          return { events: matched, nextSeq: events.nextSeq, dropped };
        }

        case "wait_for_event": {
          const method = typeof input["method"] === "string" ? input["method"] : "";
          if (!method) throw new Error("INPUT_INVALID: method is required");
          const tab = tabFor(input);
          const sessionId =
            typeof input["sessionId"] === "string"
              ? input["sessionId"]
              : tab !== undefined
                ? id(tab)
                : undefined;
          const match =
            typeof input["match"] === "object" && input["match"] !== null && !Array.isArray(input["match"])
              ? (input["match"] as Record<string, unknown>)
              : undefined;
          const matcher: EventMatcher = { method, match, sessionId };
          const consumeBuffer = input["consumeBuffer"] !== false;
          const started = Date.now();
          if (consumeBuffer) {
            const buffered = events.take(matcher, true);
            if (buffered) {
              return { found: true, event: buffered, timedOut: false, waitedMs: 0 };
            }
          }
          const waitMs = timeoutMs ?? 10_000;
          return new Promise<Record<string, unknown>>((resolve) => {
            const waiter: EventWaiter = {
              matcher,
              resolve: (event) => resolve({ found: true, event, timedOut: false, waitedMs: Date.now() - started }),
              reject: () => resolve({ found: false, timedOut: true, waitedMs: Date.now() - started }),
              timer: setTimeout(() => {
                eventWaiters.delete(waiter);
                resolve({ found: false, timedOut: true, waitedMs: Date.now() - started });
              }, waitMs),
            };
            eventWaiters.add(waiter);
          });
        }
      }

      throw new BackendUnavailable(NAME, `${op} is not supported`);
    },

    async listTargets(): Promise<BackendTarget[]> {
      await waitForConnection(listTargetsWaitMs);
      const res = (await request("list_tabs", {}, 15_000)) as {
        tabs?: Array<{ tabId: number; url?: string; title?: string }>;
      };
      return (res?.tabs ?? []).map((t) => ({
        targetId: id(t.tabId),
        type: "page",
        title: t.title ?? "",
        url: t.url ?? "",
        backend: NAME,
      }));
    },

    async status() {
      try {
        if (!server && !startError) await start();
      } catch {
        /* report unavailable below */
      }
      const connected = Boolean(activeSocket && activeSocket.data.authenticated);
      return {
        available: connected,
        listening: Boolean(server),
        port: boundPort ?? null,
        instanceId,
        protocolVersion: PROTOCOL_VERSION,
        ...(connected
          ? {
              browser: activeSocket!.data.browser ?? null,
              profileId: activeSocket!.data.profileId ?? null,
              extensionVersion: activeSocket!.data.extensionVersion ?? null,
            }
          : {}),
        ...(startError ? { reason: startError } : {}),
        activeTargetId: activeTab === undefined ? null : id(activeTab),
      };
    },

    clearActive() {
      activeTab = undefined;
    },

    async dispose() {
      if (options.registerGlobal) {
        registerExtensionBcCall(undefined);
      }
      failConnectWaiters("relay disposed");
      failAllPending("relay disposed");
      for (const w of [...eventWaiters]) {
        clearTimeout(w.timer);
        eventWaiters.delete(w);
        w.reject(new Error("relay disposed"));
      }
      if (activeSocket) {
        clearHandshakeTimer(activeSocket);
        try {
          activeSocket.close(1001, "relay shutting down");
        } catch {
          /* ignore */
        }
        activeSocket = undefined;
      }
      if (server) {
        server.stop(true);
        server = undefined;
      }
      boundPort = undefined;
      activeTab = undefined;
    },
  };
}
