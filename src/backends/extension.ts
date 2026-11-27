/**
 * The `extension` backend: drives real Chromium browsers through the local MV3 companion
 * extension over a loopback WebSocket relay (127.0.0.1, ports 49222-49229).
 *
 * Needs no remote-debugging flag and no per-connection "Allow" click. Silent reads run in the
 * extension's ISOLATED content-script world via `bc_call`; trusted input and DevTools calls
 * attach `chrome.debugger` on demand via `cdp`.
 *
 * Mutual HMAC-SHA256 challenge-response handshake, BrowserLinks multi-browser identity, and MV3
 * keepalive patterns adapted from anomalyco/browse (MIT License).
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link as fsLink, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { EventBuffer, eventMatches, type CdpEvent, type EventMatcher } from "../events";
import { PAGE_HELPERS_VERSION, type HelperStep, type NormalizedHelperCall } from "../page-helpers";
import { isBlockedCdpMethod, isBrowserLevelMethod } from "../session";
import { backendOrder, defaultTokenFilePath, readPrivateTokenSync } from "./router";
import { BackendUnavailable, prefixOf, type Backend, type BackendTarget, type OpInput } from "./types";

export { defaultTokenFilePath };

export const NAME = "extension";
export const EXTENSION_ID = "gdoaemlogkgnnojmjcgjfaphohadilcf";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
export const RELAY_VERSION = "2.0.0";
export const PROTOCOL_VERSION = 1;

export const PORT_RANGE_START = 49222;
export const PORT_RANGE_END = 49229;

export const PRE_AUTH_MAX_BYTES = 64 * 1024;
export const TRANSPORT_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const CHUNK_MAX_DATA_BYTES = 512 * 1024;
export const POST_AUTH_MAX_BYTES = 64 * 1024 * 1024;
export const MAX_CONCURRENT_CHUNK_STREAMS = 16;
export const CHUNK_STREAM_TIMEOUT_MS = 30_000;
export const MAX_ABORTED_CHUNK_STREAMS = 64;
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export const CLOSE_REPLACED = 4001;
export const CLOSE_BAD_HELLO = 4002;
export const CLOSE_VERSION_MISMATCH = 4003;
export const CLOSE_AUTH_REFUSED = 4006;

const DEFAULT_WAIT_CONNECT_MS = 35_000;
const DEFAULT_LIST_WAIT_MS = 5_000;
const DEFAULT_REQ_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_FRAME_BYTES = 900 * 1024;
const MAX_SHORT_TARGET_OWNERS = 2048;

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
const DIGITS_RE = /^\d+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

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
      await fsLink(tmp, file);
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
    const read = readPrivateTokenSync(tokenFile);
    if ("token" in read) return read.token;
    if (read.state === "bad") {
      throw new Error(
        `EXECUTION_FAILED: relay token file ${tokenFile} is not private or not valid; run: bun ./cli.ts extension-setup <extensionDir> to replace it`,
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
  const read = readPrivateTokenSync(tokenFile);
  if (!("token" in read) && read.state === "bad") {
    await publishPrivateFile(tokenFile, newTokenBody(randomBytes(32).toString("hex")), true);
  }
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

// ---------------------------------------------------------------------------
// Deterministic stateless browser slug: <brand>-<first 6 hex chars of sha256(profileId)>
// ---------------------------------------------------------------------------

function slugifyPart(raw: string, fallback: string): string {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function browserSlugPrefix(browser: string): string {
  const lower = String(browser || "").toLowerCase();
  if (lower.includes("brave")) return "brave";
  if (lower.includes("edge")) return "edge";
  if (lower.includes("opera")) return "opera";
  if (lower.includes("vivaldi")) return "vivaldi";
  if (lower.includes("arc")) return "arc";
  if (lower.includes("comet")) return "comet";
  if (lower.includes("chromium")) return "chromium";
  if (lower.includes("chrome")) return "chrome";
  return slugifyPart(browser, "browser");
}

/** Deterministic slug `<brand>-<first 6 hex chars of sha256(profileId)>` (no stored state). */
export function browserSlugFor(browser: string, profileId: string): string {
  const brand = browserSlugPrefix(browser);
  const suffix = createHash("sha256").update(profileId, "utf8").digest("hex").slice(0, 6);
  return `${brand}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Chunked post-auth frame encoder, backpressure queue & reassembler
// ---------------------------------------------------------------------------

function sliceUtf8Chunk(text: string, start: number, maxDataBytes: number): string {
  const remaining = text.length - start;
  if (remaining <= 0) return "";
  let end = Math.min(text.length, start + maxDataBytes);
  if (end < text.length) {
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  }
  const initial = text.slice(start, end);
  if (Buffer.byteLength(initial, "utf8") <= maxDataBytes) return initial;

  let lo = 1;
  let hi = end - start;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(start, start + mid), "utf8") <= maxDataBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  if (start + lo < text.length) {
    const c = text.charCodeAt(start + lo - 1);
    if (c >= 0xd800 && c <= 0xdbff && lo > 1) lo -= 1;
  }
  return text.slice(start, start + lo);
}

let autoChunkStreamId = 1;

export function encodeChunkedFrames(
  obj: Record<string, unknown>,
  options: { id?: string; maxDataBytes?: number; maxFrameBytes?: number; maxTotalBytes?: number } = {},
):
  | { ok: true; frames: string[]; chunked: boolean; totalBytes: number }
  | { ok: false; error: string; totalBytes: number } {
  const maxDataBytes = options.maxDataBytes ?? CHUNK_MAX_DATA_BYTES;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? POST_AUTH_MAX_BYTES;
  const serialized = JSON.stringify(obj);
  const totalBytes = Buffer.byteLength(serialized, "utf8");

  if (totalBytes > maxTotalBytes) {
    return {
      ok: false,
      error: `EXECUTION_FAILED: Message too large (${totalBytes} bytes > ${maxTotalBytes} limit)`,
      totalBytes,
    };
  }

  const singleThreshold = Math.min(maxDataBytes, maxFrameBytes);
  if (totalBytes <= singleThreshold) {
    return { ok: true, frames: [serialized], chunked: false, totalBytes };
  }

  const streamId =
    options.id ?? (obj["id"] !== undefined ? String(obj["id"]) : `d-${autoChunkStreamId++}`);
  const frames: string[] = [];
  let offset = 0;
  let seq = 0;
  while (offset < serialized.length) {
    let data = sliceUtf8Chunk(serialized, offset, maxDataBytes);
    let last = offset + data.length >= serialized.length;
    let frame = JSON.stringify({ type: "chunk", id: streamId, seq, last, data });
    while (Buffer.byteLength(frame, "utf8") > maxFrameBytes && data.length > 1) {
      let nextLen = Math.max(1, Math.floor(data.length / 2));
      const c = data.charCodeAt(nextLen - 1);
      if (c >= 0xd800 && c <= 0xdbff && nextLen > 1) nextLen -= 1;
      data = data.slice(0, nextLen);
      last = offset + data.length >= serialized.length;
      frame = JSON.stringify({ type: "chunk", id: streamId, seq, last, data });
    }
    frames.push(frame);
    offset += data.length;
    seq += 1;
  }
  return { ok: true, frames, chunked: true, totalBytes };
}

export type FrameSocket = {
  send(data: string): number;
  getBufferedAmount?(): number;
};

// Bun's ServerWebSocket default; a send that would exceed it is dropped (returns 0).
const DEFAULT_BACKPRESSURE_LIMIT = 16 * 1024 * 1024;

type QueuedFrames = {
  frames: string[];
  index: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * Per-connection outbound frame queue that respects Bun ServerWebSocket send return codes:
 * - `> 0`: sent immediately
 * - `-1`: buffered under backpressure -> pause and resume on `drain()`
 * - `0`: dropped -> fail that message cleanly; never report success for a partially sent message
 */
export class OutboundFrameQueue {
  private readonly queue: QueuedFrames[] = [];
  private paused = false;
  private closedReason?: string;

  constructor(
    private readonly ws: FrameSocket,
    private readonly backpressureLimit: number = DEFAULT_BACKPRESSURE_LIMIT,
  ) {}

  enqueue(frames: string[]): Promise<void> {
    if (this.closedReason !== undefined) {
      return Promise.reject(new BackendUnavailable(NAME, this.closedReason));
    }
    if (frames.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ frames, index: 0, resolve, reject });
      if (!this.paused) this.flush();
    });
  }

  drain(): void {
    if (this.closedReason !== undefined) return;
    this.paused = false;
    this.flush();
  }

  /** Drop a batch that hasn't started sending, so a timed-out request never runs later. */
  cancelUnsent(frames: string[]): void {
    const index = this.queue.findIndex((q) => q.frames === frames && q.index === 0);
    if (index === -1) return;
    const [batch] = this.queue.splice(index, 1);
    batch!.reject(new Error("EXECUTION_FAILED: request cancelled before it was sent"));
  }

  failAll(reason: string): void {
    this.closedReason = reason;
    this.paused = false;
    const err = new BackendUnavailable(NAME, reason);
    while (this.queue.length > 0) {
      this.queue.shift()!.reject(err);
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private flush(): void {
    while (!this.paused && this.queue.length > 0) {
      const current = this.queue[0]!;
      while (current.index < current.frames.length) {
        const frame = current.frames[current.index]!;
        // drain() can fire while data is still buffered; wait for the next drain instead of overflowing.
        const buffered = this.ws.getBufferedAmount?.() ?? 0;
        if (buffered > 0 && buffered + Buffer.byteLength(frame) > this.backpressureLimit) {
          this.paused = true;
          return;
        }
        let status: number;
        try {
          status = this.ws.send(frame);
        } catch (err) {
          this.queue.shift();
          current.reject(
            new BackendUnavailable(NAME, `failed to send to extension: ${(err as Error).message}`),
          );
          break;
        }
        if (status === 0) {
          this.queue.shift();
          current.reject(
            new Error(
              `EXECUTION_FAILED: WebSocket frame dropped (sent ${current.index}/${current.frames.length} frames)`,
            ),
          );
          break;
        }
        current.index += 1;
        if (status === -1) {
          this.paused = true;
          return;
        }
      }
      if (this.queue[0] === current && current.index >= current.frames.length) {
        this.queue.shift();
        current.resolve();
      }
    }
  }
}

type ChunkDecodeResult =
  | { kind: "message"; message: Record<string, unknown> }
  | { kind: "pending" }
  | { kind: "ignored" }
  | { kind: "error"; id: string; reqId?: number; error: string };

type ChunkStream = {
  nextSeq: number;
  totalBytes: number;
  parts: string[];
  lastActivityAt: number;
  timer?: ReturnType<typeof setTimeout>;
  reqId?: number;
};

function numericReqIdOf(rawId: unknown, explicitReqId?: unknown): number | undefined {
  if (typeof explicitReqId === "number" && Number.isInteger(explicitReqId)) return explicitReqId;
  if (typeof rawId === "number" && Number.isInteger(rawId)) return rawId;
  if (typeof rawId === "string" && DIGITS_RE.test(rawId)) return Number(rawId);
  return undefined;
}

// Bounds per-chunk bookkeeping so tiny or empty chunks can't outgrow the byte budget.
const MAX_CHUNKS_PER_STREAM = 4096;
const MAX_STREAM_ID_LENGTH = 128;

export class ChunkReassembler {
  private readonly maxDataBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private readonly maxAbortedIds: number;
  private readonly now: () => number;
  private readonly onExpire?: (info: { id: string; reqId?: number }) => void;
  private readonly streams = new Map<string, ChunkStream>();
  private readonly aborted = new Map<string, number>();
  private totalBufferedBytes = 0;

  constructor(options: {
    maxDataBytes?: number;
    maxTotalBytes?: number;
    maxBufferedBytes?: number;
    maxConcurrent?: number;
    timeoutMs?: number;
    maxAbortedIds?: number;
    now?: () => number;
    onExpire?: (info: { id: string; reqId?: number }) => void;
  } = {}) {
    this.maxDataBytes = options.maxDataBytes ?? CHUNK_MAX_DATA_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? POST_AUTH_MAX_BYTES;
    this.maxBufferedBytes = options.maxBufferedBytes ?? this.maxTotalBytes;
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_CHUNK_STREAMS;
    this.timeoutMs = options.timeoutMs ?? CHUNK_STREAM_TIMEOUT_MS;
    this.maxAbortedIds = options.maxAbortedIds ?? MAX_ABORTED_CHUNK_STREAMS;
    this.now = options.now ?? (() => Date.now());
    this.onExpire = options.onExpire;
  }

  private deleteStream(id: string): ChunkStream | undefined {
    const entry = this.streams.get(id);
    if (!entry) return undefined;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - entry.totalBytes);
    this.streams.delete(id);
    return entry;
  }

  private rememberAborted(id: string): void {
    this.aborted.delete(id);
    this.aborted.set(id, this.now());
    while (this.aborted.size > this.maxAbortedIds) {
      const oldest = this.aborted.keys().next().value;
      if (oldest === undefined) break;
      this.aborted.delete(oldest);
    }
  }

  private scheduleExpiry(id: string, stream: ChunkStream): void {
    if (stream.timer !== undefined) clearTimeout(stream.timer);
    stream.lastActivityAt = this.now();
    const timer = setTimeout(() => {
      if (this.streams.get(id) !== stream) return;
      this.deleteStream(id);
      this.onExpire?.({ id, reqId: stream.reqId });
    }, this.timeoutMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
    stream.timer = timer;
  }

  private pruneExpiredAborted(): void {
    const t = this.now();
    for (const [id, ts] of this.aborted) {
      if (t - ts > this.timeoutMs) this.aborted.delete(id);
    }
  }

  private abort(id: string, isLast: boolean): void {
    this.deleteStream(id);
    if (isLast) this.aborted.delete(id);
    else this.rememberAborted(id);
  }

  push(msg: Record<string, unknown>): ChunkDecodeResult {
    if (msg["type"] !== "chunk") return { kind: "message", message: msg };
    this.pruneExpiredAborted();

    const rawId = msg["id"];
    const validId =
      (typeof rawId === "string" && rawId.trim() !== "" && rawId.length <= MAX_STREAM_ID_LENGTH) ||
      (typeof rawId === "number" && Number.isInteger(rawId));
    const seq = msg["seq"];
    const last = msg["last"];
    const data = msg["data"];
    const reqId = numericReqIdOf(rawId, msg["reqId"]);

    if (
      !validId ||
      typeof seq !== "number" ||
      !Number.isInteger(seq) ||
      seq < 0 ||
      typeof last !== "boolean" ||
      typeof data !== "string"
    ) {
      return {
        kind: "error",
        id: validId ? String(rawId) : "",
        reqId,
        error: "EXECUTION_FAILED: malformed chunk frame",
      };
    }

    const id = String(rawId);
    if (this.aborted.has(id)) {
      if (last) this.aborted.delete(id);
      return { kind: "ignored" };
    }

    const chunkBytes = Buffer.byteLength(data, "utf8");
    if (chunkBytes > this.maxDataBytes) {
      this.abort(id, last);
      return {
        kind: "error",
        id,
        reqId,
        error: `EXECUTION_FAILED: chunk data too large (${chunkBytes} bytes > ${this.maxDataBytes} limit)`,
      };
    }

    let stream = this.streams.get(id);
    if (!stream) {
      if (seq !== 0) {
        this.abort(id, last);
        return {
          kind: "error",
          id,
          reqId,
          error: `EXECUTION_FAILED: chunked frame out of order (stream ${id}: expected seq 0, got ${seq})`,
        };
      }
      if (this.streams.size >= this.maxConcurrent) {
        this.abort(id, last);
        return {
          kind: "error",
          id,
          reqId,
          error: `EXECUTION_FAILED: too many concurrent chunked streams (limit ${this.maxConcurrent})`,
        };
      }
      stream = { nextSeq: 0, totalBytes: 0, parts: [], lastActivityAt: this.now(), reqId };
      this.streams.set(id, stream);
    }

    if (seq !== stream.nextSeq) {
      this.abort(id, last);
      return {
        kind: "error",
        id,
        reqId,
        error: `EXECUTION_FAILED: chunked frame out of order (stream ${id}: expected seq ${stream.nextSeq}, got ${seq})`,
      };
    }

    if (stream.parts.length >= MAX_CHUNKS_PER_STREAM) {
      this.abort(id, last);
      return {
        kind: "error",
        id,
        reqId,
        error: `EXECUTION_FAILED: too many chunks in stream ${id} (limit ${MAX_CHUNKS_PER_STREAM})`,
      };
    }

    if (stream.totalBytes + chunkBytes > this.maxTotalBytes) {
      this.abort(id, last);
      return {
        kind: "error",
        id,
        reqId,
        error: `EXECUTION_FAILED: chunked message too large (stream ${id} exceeds ${this.maxTotalBytes} bytes)`,
      };
    }

    if (this.totalBufferedBytes + chunkBytes > this.maxBufferedBytes) {
      this.abort(id, last);
      return {
        kind: "error",
        id,
        reqId,
        error: `EXECUTION_FAILED: chunked buffer limit exceeded (aggregate unfinished bytes > ${this.maxBufferedBytes} limit)`,
      };
    }

    stream.parts.push(data);
    stream.totalBytes += chunkBytes;
    this.totalBufferedBytes += chunkBytes;
    stream.nextSeq += 1;

    if (!last) {
      this.scheduleExpiry(id, stream);
      return { kind: "pending" };
    }

    this.deleteStream(id);
    try {
      const parsed = JSON.parse(stream.parts.join(""));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("reassembled payload is not a JSON object");
      }
      return { kind: "message", message: parsed as Record<string, unknown> };
    } catch (err) {
      return {
        kind: "error",
        id,
        reqId,
        error: `EXECUTION_FAILED: invalid JSON in reassembled chunk stream ${id}: ${(err as Error).message}`,
      };
    }
  }

  clear(): void {
    for (const id of [...this.streams.keys()]) this.deleteStream(id);
    this.totalBufferedBytes = 0;
    this.aborted.clear();
  }

  size(): number {
    return this.streams.size;
  }

  bufferedBytes(): number {
    return this.totalBufferedBytes;
  }

  abortedSize(): number {
    return this.aborted.size;
  }
}

// ---------------------------------------------------------------------------
// Target IDs & structured helper step combiner
// ---------------------------------------------------------------------------

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

/**
 * Parse `extension:<tabId>` or `extension:<slug>:<tabId>`, optionally followed by `@<frameId>`
 * (a chrome.webNavigation frame id) to address a child frame of that tab.
 */
export function parseExtensionTargetId(
  targetId: unknown,
): { slug?: string; tabId: number; frameId?: number } | undefined {
  if (prefixOf(targetId) !== NAME) return undefined;
  let rest = (targetId as string).slice(NAME.length + 1);
  const at = rest.lastIndexOf("@");
  if (at !== -1) {
    const framePart = rest.slice(at + 1);
    if (!DIGITS_RE.test(framePart)) return undefined;
    const frameId = Number(framePart);
    const base = parseExtensionTargetId(`${NAME}:${rest.slice(0, at)}`);
    return base && Number.isSafeInteger(frameId) ? { ...base, frameId } : undefined;
  }
  if (!rest) return undefined;
  const colon = rest.indexOf(":");
  if (colon === -1) {
    if (!DIGITS_RE.test(rest)) return undefined;
    const n = Number(rest);
    return Number.isSafeInteger(n) ? { tabId: n } : undefined;
  }
  const slug = rest.slice(0, colon);
  const tabPart = rest.slice(colon + 1);
  if (!slug || !SLUG_RE.test(slug) || !DIGITS_RE.test(tabPart)) return undefined;
  const n = Number(tabPart);
  return Number.isSafeInteger(n) ? { slug: slug.toLowerCase(), tabId: n } : undefined;
}

export function extensionTabOf(targetId: unknown): number | undefined {
  return parseExtensionTargetId(targetId)?.tabId;
}

/** The child frame id a frame target (`extension:…:<tabId>@<frameId>`) addresses, if any. */
export function extensionFrameOf(targetId: unknown): number | undefined {
  return parseExtensionTargetId(targetId)?.frameId;
}

/** Address child frame `frameId` of extension tab target `targetId`. */
export function extensionFrameTarget(targetId: string, frameId: number): string {
  const at = targetId.lastIndexOf("@");
  const base = at !== -1 && extensionFrameOf(targetId) !== undefined ? targetId.slice(0, at) : targetId;
  return `${base}@${frameId}`;
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

const EXTENSION_REQUEST_SYMBOL = Symbol.for("browser-control.extension-request");
const TARGET_REQUEST_OPS = new Set(["handoff_start", "handoff_clear", "resolve_bc_node", "list_frames"]);
const EXTENSION_DISABLED_MSG = "INPUT_INVALID: the extension backend is disabled; run: extension enable";

export type ExtensionRequestFn = (
  op: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

function registerExtensionRequest(fn: ExtensionRequestFn | undefined): void {
  const holder = globalThis as Record<symbol, unknown>;
  if (fn) {
    holder[EXTENSION_REQUEST_SYMBOL] = fn;
  } else {
    delete holder[EXTENSION_REQUEST_SYMBOL];
  }
}

const frameParam = (frameId: number | undefined): { frameId?: number } =>
  typeof frameId === "number" ? { frameId } : {};

export function getRegisteredExtensionBcCall(): BcCallFn | undefined {
  return (globalThis as Record<symbol, unknown>)[BC_CALL_SYMBOL] as BcCallFn | undefined;
}

// ---------------------------------------------------------------------------
// Relay WebSocket server & BrowserLinks
// ---------------------------------------------------------------------------

type WsState = {
  stage: "awaiting_hello" | "awaiting_response" | "ready";
  authenticated: boolean;
  closed: boolean;
  handshakeTimer?: ReturnType<typeof setTimeout>;
  extNonce?: string;
  relayNonce?: string;
  profileId?: string;
  browser?: string;
  extensionVersion?: string;
  slug?: string;
};

type PendingReq = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type BrowserLink = {
  profileId: string;
  slug: string;
  browser: string;
  extensionVersion: string;
  ws: ServerWebSocket<WsState>;
  outbound: OutboundFrameQueue;
  pending: Map<number, PendingReq>;
  decoder: ChunkReassembler;
  connectedAt: number;
};

type ActiveTabRef = {
  profileId: string;
  slug: string;
  tabId: number;
};

type EventWaiter = {
  matcher: EventMatcher;
  resolve: (event: CdpEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ConnectedBrowserInfo = {
  slug: string;
  profileId: string;
  browser: string;
  extensionVersion: string;
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
  maxPostAuthBytes?: number;
  maxChunkDataBytes?: number;
  maxBufferedChunkBytes?: number;
  maxConcurrentChunkStreams?: number;
  chunkStreamTimeoutMs?: number;
  backpressureLimit?: number;
  now?: () => number;
};

export interface ExtensionBackend extends Backend {
  readonly instanceId: string;
  getPort(): number | undefined;
  isConnected(): boolean;
  getConnectedBrowsers(): ConnectedBrowserInfo[];
  request(op: string, params?: Record<string, unknown>, timeoutMs?: number, browserSlug?: string): Promise<unknown>;
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
  const maxPostAuthBytes = options.maxPostAuthBytes ?? POST_AUTH_MAX_BYTES;
  const maxChunkDataBytes = options.maxChunkDataBytes ?? CHUNK_MAX_DATA_BYTES;
  const maxBufferedChunkBytes = options.maxBufferedChunkBytes ?? maxPostAuthBytes;
  const maxConcurrentChunkStreams = options.maxConcurrentChunkStreams ?? MAX_CONCURRENT_CHUNK_STREAMS;
  const chunkStreamTimeoutMs = options.chunkStreamTimeoutMs ?? CHUNK_STREAM_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const instanceId = randomUUID();

  let server: Server<WsState> | undefined;
  let boundPort: number | undefined;
  let relayToken: string | undefined;
  let startPromise: Promise<void> | undefined;
  let startError: string | undefined;

  // BrowserLinks: profileId -> live authenticated BrowserLink
  const links = new Map<string, BrowserLink>();
  // Short target id (`extension:<tabId>`) -> profileId that it was issued for
  const shortTargetOwners = new Map<number, string>();
  let activeTab: ActiveTabRef | undefined;
  let nextReqId = 1;
  const connectWaiters = new Set<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const events = new EventBuffer(options.eventBufferSize ?? 1000);
  const eventWaiters = new Set<EventWaiter>();

  // Bindings are never evicted, so a stale short id can't be reissued to another browser.
  // Once the table is full, new tabs get qualified ids instead.
  function rememberShortTarget(tabId: number, profileId: string): boolean {
    const owner = shortTargetOwners.get(tabId);
    if (owner !== undefined) return owner === profileId;
    if (shortTargetOwners.size >= MAX_SHORT_TARGET_OWNERS) return false;
    shortTargetOwners.set(tabId, profileId);
    return true;
  }

  function formatTargetId(link: { profileId: string; slug: string }, tabId: number): string {
    if (links.size > 1 || !rememberShortTarget(tabId, link.profileId)) {
      return eventKey(link, tabId);
    }
    return `${NAME}:${tabId}`;
  }

  // Events are keyed by the qualified id so the key can't change when a second browser connects.
  function eventKey(link: { slug: string }, tabId: number): string {
    return `${NAME}:${link.slug}:${tabId}`;
  }

  function findLinkBySlug(slug: string): BrowserLink | undefined {
    const want = slug.trim().toLowerCase();
    for (const link of links.values()) {
      if (link.slug.toLowerCase() === want) return link;
    }
    return undefined;
  }

  function defaultLink(): BrowserLink | undefined {
    if (activeTab) {
      const active = links.get(activeTab.profileId);
      if (active) return active;
    }
    return links.values().next().value;
  }

  function connectedSlugs(): string[] {
    return [...links.values()].map((l) => l.slug);
  }

  function clearHandshakeTimer(ws: ServerWebSocket<WsState>): void {
    if (ws.data.handshakeTimer) {
      clearTimeout(ws.data.handshakeTimer);
      ws.data.handshakeTimer = undefined;
    }
  }

  function failLinkPending(link: BrowserLink, reason: string): void {
    link.outbound.failAll(reason);
    const err = new BackendUnavailable(NAME, reason);
    for (const [reqId, p] of link.pending) {
      clearTimeout(p.timer);
      link.pending.delete(reqId);
      p.reject(err);
    }
    link.decoder.clear();
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

  function dispatchEvent(
    link: BrowserLink,
    msg: { tabId?: unknown; sessionId?: unknown; method?: unknown; params?: unknown },
  ): void {
    if (typeof msg.method !== "string") return;
    const tabId = typeof msg.tabId === "number" ? msg.tabId : undefined;
    const sessionId =
      typeof msg.sessionId === "string"
        ? msg.sessionId
        : tabId !== undefined
          ? eventKey(link, tabId)
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

  function attachAuthenticatedLink(ws: ServerWebSocket<WsState>): void {
    const data = ws.data;
    const profileId = data.profileId!;
    const browser = data.browser!;
    const slug = browserSlugFor(browser, profileId);

    clearHandshakeTimer(ws);
    data.stage = "ready";
    data.authenticated = true;
    data.slug = slug;

    const existing = links.get(profileId);
    if (existing && existing.ws !== ws) {
      try {
        existing.ws.close(CLOSE_REPLACED, "replaced by newer connection");
      } catch {
        /* ignore */
      }
      failLinkPending(existing, "replaced by newer connection");
    }

    const pending = new Map<number, PendingReq>();
    const decoder = new ChunkReassembler({
      maxDataBytes: CHUNK_MAX_DATA_BYTES,
      maxTotalBytes: maxPostAuthBytes,
      maxBufferedBytes: maxBufferedChunkBytes,
      maxConcurrent: maxConcurrentChunkStreams,
      timeoutMs: chunkStreamTimeoutMs,
      now,
      onExpire: ({ id, reqId }) => {
        if (reqId === undefined) return;
        const p = pending.get(reqId);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(reqId);
        p.reject(new Error(`EXECUTION_FAILED: chunked stream ${id} expired after ${chunkStreamTimeoutMs}ms`));
      },
    });

    const link: BrowserLink = {
      profileId,
      slug,
      browser,
      extensionVersion: data.extensionVersion ?? "",
      ws,
      outbound: new OutboundFrameQueue(ws, options.backpressureLimit),
      pending,
      decoder,
      connectedAt: now(),
    };
    links.set(profileId, link);

    ws.send(
      JSON.stringify({
        type: "welcome",
        instanceId,
        version: RELAY_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        helpersVersion: expectedHelpersVersion,
        slug,
      }),
    );
    notifyConnected();
  }

  function handleAuthenticatedMessage(link: BrowserLink, msg: Record<string, unknown>): void {
    const type = msg["type"];
    if (type === "ping") {
      link.outbound.enqueue([JSON.stringify({ type: "pong" })]).catch(() => {});
      return;
    }
    if (type === "res" && typeof msg["id"] === "number") {
      const p = link.pending.get(msg["id"]);
      if (!p) return;
      clearTimeout(p.timer);
      link.pending.delete(msg["id"]);
      if (msg["ok"] === true) {
        p.resolve(msg["result"]);
      } else {
        const errText = String(msg["error"] ?? "extension request failed");
        if (errText.startsWith("RESTRICTED_PAGE:")) {
          p.reject(new BackendUnavailable(NAME, errText));
        } else if (/^Cannot access (a chrome:\/\/ URL|a chrome-extension:\/\/ URL|contents of)/i.test(errText)) {
          // Debugger attach on a restricted page reports Chrome's raw message.
          p.reject(new BackendUnavailable(NAME, `RESTRICTED_PAGE: ${errText}`));
        } else {
          p.reject(new Error(errText));
        }
      }
      return;
    }
    if (type === "event") {
      dispatchEvent(link, msg as { tabId?: unknown; sessionId?: unknown; method?: unknown; params?: unknown });
    }
  }

  function handleWsMessage(ws: ServerWebSocket<WsState>, raw: string | Buffer): void {
    const data = ws.data;
    if (data.closed) return;

    const byteLen = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
    if (!data.authenticated && byteLen > PRE_AUTH_MAX_BYTES) {
      clearHandshakeTimer(ws);
      data.closed = true;
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

      attachAuthenticatedLink(ws);
      return;
    }

    // Authenticated traffic
    const link = data.profileId ? links.get(data.profileId) : undefined;
    if (!link || link.ws !== ws) return;

    const decoded = link.decoder.push(msg);
    if (decoded.kind === "pending" || decoded.kind === "ignored") return;
    if (decoded.kind === "error") {
      if (decoded.reqId !== undefined) {
        const p = link.pending.get(decoded.reqId);
        if (p) {
          clearTimeout(p.timer);
          link.pending.delete(decoded.reqId);
          p.reject(new Error(decoded.error));
        }
      }
      return;
    }
    handleAuthenticatedMessage(link, decoded.message);
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
                    closed: false,
                  },
                });
                if (upgraded) return undefined;
                return new Response("Upgrade Required", { status: 426 });
              }
              return new Response("Not Found", { status: 404 });
            },
            websocket: {
              maxPayloadLength: TRANSPORT_MAX_PAYLOAD_BYTES,
              perMessageDeflate: false,
              ...(options.backpressureLimit !== undefined ? { backpressureLimit: options.backpressureLimit } : {}),
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
              drain(ws) {
                const profileId = ws.data.profileId;
                if (!profileId) return;
                const link = links.get(profileId);
                if (link && link.ws === ws) {
                  link.outbound.drain();
                }
              },
              close(ws) {
                ws.data.closed = true;
                clearHandshakeTimer(ws);
                const profileId = ws.data.profileId;
                if (profileId) {
                  const link = links.get(profileId);
                  if (link && link.ws === ws) {
                    links.delete(profileId);
                    failLinkPending(link, "extension disconnected");
                  }
                }
              },
            },
          });
          server = srv;
          boundPort = srv.port;
          if (options.registerGlobal) {
            registerExtensionBcCall(bcCall);
            registerExtensionRequest(targetRequest);
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
    if (links.size > 0) return;
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

  async function requestOnLink(
    link: BrowserLink,
    op: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_REQ_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!link.ws.data.authenticated || link.ws.data.closed) {
      throw new BackendUnavailable(NAME, `browser "${link.slug}" is not connected`);
    }
    const reqId = nextReqId++;
    const encoded = encodeChunkedFrames(
      { type: "req", id: reqId, op, params },
      { maxDataBytes: maxChunkDataBytes, maxTotalBytes: maxPostAuthBytes },
    );
    if (!encoded.ok) {
      throw new Error(encoded.error);
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(reqId);
        link.outbound.cancelUnsent(encoded.frames);
        reject(new Error(`CDP_TIMEOUT: extension op "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      link.pending.set(reqId, { resolve, reject, timer });
      link.outbound.enqueue(encoded.frames).catch((err) => {
        const p = link.pending.get(reqId);
        if (!p) return;
        clearTimeout(p.timer);
        link.pending.delete(reqId);
        reject(err as Error);
      });
    });
  }

  async function request(
    op: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_REQ_TIMEOUT_MS,
    browserSlug?: string,
  ): Promise<unknown> {
    await waitForConnection();
    const link = browserSlug ? findLinkBySlug(browserSlug) : defaultLink();
    if (!link) {
      if (browserSlug) {
        throw new Error(
          `INPUT_INVALID: browser "${browserSlug}" is not connected (connected: ${connectedSlugs().join(", ") || "none"})`,
        );
      }
      throw new BackendUnavailable(NAME, "extension is not connected");
    }
    return requestOnLink(link, op, params, timeoutMs);
  }

  function resolveTarget(targetId: unknown): { link: BrowserLink; tabId: number } | undefined {
    if (targetId !== undefined) {
      const parsed = parseExtensionTargetId(targetId);
      if (!parsed) return undefined;
      if (parsed.slug) {
        const link = findLinkBySlug(parsed.slug);
        if (!link) {
          throw new BackendUnavailable(NAME, `browser "${parsed.slug}" is not connected`);
        }
        return { link, tabId: parsed.tabId };
      }
      const boundProfileId = shortTargetOwners.get(parsed.tabId);
      if (boundProfileId !== undefined) {
        const boundLink = links.get(boundProfileId);
        if (!boundLink) {
          throw new Error(
            `NO_ACTIVE_TARGET: tab ${String(targetId)} belonged to a browser that disconnected; list tabs again`,
          );
        }
        return { link: boundLink, tabId: parsed.tabId };
      }
      if (links.size === 1) {
        const only = links.values().next().value!;
        rememberShortTarget(parsed.tabId, only.profileId);
        return { link: only, tabId: parsed.tabId };
      }
      if (links.size === 0) {
        throw new BackendUnavailable(NAME, "extension is not connected");
      }
      throw new Error(
        `INPUT_INVALID: ambiguous extension targetId "${String(targetId)}" with multiple browsers connected (${connectedSlugs().join(", ")}); use extension:<slug>:${parsed.tabId}`,
      );
    }
    if (!activeTab) return undefined;
    const link = links.get(activeTab.profileId);
    if (!link) {
      throw new BackendUnavailable(NAME, `browser "${activeTab.slug}" is not connected`);
    }
    return { link, tabId: activeTab.tabId };
  }

  async function targetRequest(
    op: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_REQ_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!backendOrder().includes(NAME)) {
      throw new Error(EXTENSION_DISABLED_MSG);
    }
    if (!TARGET_REQUEST_OPS.has(op)) {
      throw new Error(`INPUT_INVALID: extension op "${op}" is not allowed`);
    }
    await waitForConnection();
    const { targetId, tabId: _ignored, ...rest } = params;
    const resolved = resolveTarget(targetId);
    if (!resolved) {
      throw new BackendUnavailable(NAME, "no extension tab selected");
    }
    return requestOnLink(
      resolved.link,
      op,
      { ...frameParam(extensionFrameOf(targetId)), ...rest, tabId: resolved.tabId },
      timeoutMs,
    );
  }

  // An explicit target must never widen into "all events" while no browser is connected.
  function eventTarget(targetId: unknown): { link: BrowserLink; tabId: number } | undefined {
    if (links.size > 0) return resolveTarget(targetId);
    if (targetId !== undefined) throw new BackendUnavailable(NAME, "extension is not connected");
    return undefined;
  }

  async function bcCall(input: BcCallInput): Promise<{ value: unknown }> {
    await waitForConnection();
    const resolved = resolveTarget(input.targetId);
    if (!resolved) {
      throw new BackendUnavailable(NAME, "no extension tab selected");
    }
    const reqTimeout = typeof input.timeoutMs === "number" ? input.timeoutMs + 5_000 : DEFAULT_REQ_TIMEOUT_MS;
    const res = (await requestOnLink(
      resolved.link,
      "bc_call",
      {
        tabId: resolved.tabId,
        steps: input.steps,
        ...frameParam(input.frameId ?? extensionFrameOf(input.targetId)),
        ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
      },
      reqTimeout,
    )) as { values?: unknown[] };
    const values = Array.isArray(res?.values) ? res.values : [];
    const value = combineStepValues({ steps: input.steps, join: input.join }, values);
    return { value };
  }

  function getConnectedBrowsers(): ConnectedBrowserInfo[] {
    return [...links.values()].map((l) => ({
      slug: l.slug,
      profileId: l.profileId,
      browser: l.browser,
      extensionVersion: l.extensionVersion,
    }));
  }

  const backend: ExtensionBackend = {
    name: NAME,
    instanceId,

    getPort() {
      return boundPort;
    },

    isConnected() {
      return links.size > 0;
    },

    getConnectedBrowsers,

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
      // A named browser is always ours; invoke reports it if that browser is offline.
      if (op === "navigate" && typeof input["browser"] === "string") return true;
      if (input["targetId"] !== undefined) return false;
      return op === "navigate" ? isActive || activeTab === undefined : isActive && activeTab !== undefined;
    },

    async invoke(op, input) {
      const timeoutMs = typeof input["timeoutMs"] === "number" ? input["timeoutMs"] : undefined;

      switch (op) {
        case "select_target": {
          await waitForConnection();
          const resolved = resolveTarget(input["targetId"]);
          if (!resolved) throw new Error("INPUT_INVALID: invalid extension targetId");
          activeTab = {
            profileId: resolved.link.profileId,
            slug: resolved.link.slug,
            tabId: resolved.tabId,
          };
          const targetId = formatTargetId(resolved.link, resolved.tabId);
          return { activeTargetId: targetId, targetId, browser: resolved.link.slug, backend: NAME };
        }

        case "navigate": {
          const url = String(input["url"] ?? "");
          if (!url) throw new Error("INPUT_INVALID: url is required");
          const until = input["until"] === "domcontentloaded" ? "domcontentloaded" : "load";
          const browserSlug =
            typeof input["browser"] === "string" && input["browser"].trim() !== ""
              ? input["browser"].trim()
              : undefined;

          await waitForConnection();

          let targetLink: BrowserLink;
          let tabId: number | undefined;
          if (browserSlug) {
            const matched = findLinkBySlug(browserSlug);
            if (!matched) {
              throw new Error(
                `INPUT_INVALID: browser "${browserSlug}" is not connected (connected: ${connectedSlugs().join(", ") || "none"})`,
              );
            }
            if (input["targetId"] !== undefined) {
              const resolved = resolveTarget(input["targetId"]);
              if (!resolved) {
                throw new Error(
                  `INPUT_INVALID: targetId "${String(input["targetId"])}" does not belong to browser "${matched.slug}"`,
                );
              }
              if (resolved.link.profileId !== matched.profileId) {
                throw new Error(
                  `INPUT_INVALID: targetId "${String(input["targetId"])}" belongs to browser "${resolved.link.slug}", not "${matched.slug}"`,
                );
              }
              targetLink = resolved.link;
              tabId = resolved.tabId;
            } else {
              // Explicit `browser` ignores any implicit/active target and opens in that browser.
              targetLink = matched;
              tabId = undefined;
            }
          } else if (input["targetId"] !== undefined) {
            const resolved = resolveTarget(input["targetId"]);
            if (!resolved) throw new Error("INPUT_INVALID: invalid extension targetId");
            targetLink = resolved.link;
            tabId = resolved.tabId;
          } else {
            const resolved = resolveTarget(undefined);
            if (resolved) {
              targetLink = resolved.link;
              tabId = resolved.tabId;
            } else {
              const fallback = defaultLink();
              if (!fallback) throw new BackendUnavailable(NAME, "extension is not connected");
              targetLink = fallback;
              tabId = undefined;
            }
          }

          const newWindow = input["newWindow"] === true;
          const keepOpen = input["keepOpen"] === true;
          // A new window always means a new tab, so the resolved tab only picks the browser.
          if (newWindow) tabId = undefined;

          const res = (await requestOnLink(
            targetLink,
            "navigate",
            {
              ...(tabId !== undefined ? { tabId } : {}),
              url,
              until,
              ...(newWindow ? { newWindow: true } : {}),
              ...(keepOpen ? { keepOpen: true } : {}),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            },
            (timeoutMs ?? 30_000) + 10_000,
          )) as { tabId?: number; loaded?: boolean; url?: string; title?: string };
          const tid = typeof res?.tabId === "number" ? res.tabId : tabId;
          if (tid !== undefined) {
            activeTab = { profileId: targetLink.profileId, slug: targetLink.slug, tabId: tid };
          }
          return {
            loaded: res?.loaded !== false,
            targetId: tid === undefined ? null : formatTargetId(targetLink, tid),
            url: res?.url ?? url,
            title: res?.title ?? "",
            browser: targetLink.slug,
            backend: NAME,
          };
        }

        case "evaluate": {
          const expression = typeof input["expression"] === "string" ? input["expression"] : "";
          if (!expression) throw new Error("INPUT_INVALID: expression is required");
          if (/\b__bc\b/.test(expression)) {
            throw new Error("INTERNAL: __bc calls on extension tabs must use bc_call, never evaluate");
          }
          await waitForConnection();
          const resolved = resolveTarget(input["targetId"]);
          if (!resolved) throw new BackendUnavailable(NAME, "no extension tab selected");
          const res = (await requestOnLink(
            resolved.link,
            "eval",
            {
              tabId: resolved.tabId,
              expression,
              isolated: input["isolated"] === true,
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            },
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
          await waitForConnection();
          const resolved = resolveTarget(input["targetId"]);
          if (!resolved) throw new BackendUnavailable(NAME, "no extension tab selected");
          const params =
            typeof input["params"] === "object" && input["params"] !== null && !Array.isArray(input["params"])
              ? (input["params"] as Record<string, unknown>)
              : {};
          const sessionId = typeof input["sessionId"] === "string" ? input["sessionId"] : undefined;
          const res = (await requestOnLink(
            resolved.link,
            "cdp",
            {
              tabId: resolved.tabId,
              method,
              params,
              ...(sessionId ? { sessionId } : frameParam(extensionFrameOf(input["targetId"]))),
            },
            timeoutMs ?? DEFAULT_REQ_TIMEOUT_MS,
          )) as { result?: unknown };
          return { result: res?.result ?? {} };
        }

        case "capture_screenshot": {
          await waitForConnection();
          const resolved = resolveTarget(input["targetId"]);
          if (!resolved) throw new BackendUnavailable(NAME, "no extension tab selected");
          const format = input["format"] === "jpeg" ? "jpeg" : "png";
          const quality = typeof input["quality"] === "number" ? input["quality"] : undefined;
          const fullPage = input["fullPage"] === true;
          const clip =
            typeof input["clip"] === "object" && input["clip"] !== null && !Array.isArray(input["clip"])
              ? (input["clip"] as Record<string, unknown>)
              : undefined;
          const res = (await requestOnLink(resolved.link, "screenshot", {
            tabId: resolved.tabId,
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
            targetId: formatTargetId(resolved.link, resolved.tabId),
            backend: NAME,
          };
          if (clip) {
            if (typeof clip["width"] === "number") output["width"] = clip["width"];
            if (typeof clip["height"] === "number") output["height"] = clip["height"];
          }
          return output;
        }

        case "capture_pdf": {
          await waitForConnection();
          const resolved = resolveTarget(input["targetId"]);
          if (!resolved) throw new BackendUnavailable(NAME, "no extension tab selected");
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
          const res = (await requestOnLink(resolved.link, "cdp", {
            tabId: resolved.tabId,
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
            targetId: formatTargetId(resolved.link, resolved.tabId),
            backend: NAME,
          };
        }

        case "read_events": {
          const resolved = eventTarget(input["targetId"]);
          const sessionId =
            typeof input["sessionId"] === "string"
              ? input["sessionId"]
              : resolved
                ? eventKey(resolved.link, resolved.tabId)
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
          const resolved = eventTarget(input["targetId"]);
          const sessionId =
            typeof input["sessionId"] === "string"
              ? input["sessionId"]
              : resolved
                ? eventKey(resolved.link, resolved.tabId)
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
      const allLinks = [...links.values()];
      const settled = await Promise.allSettled(
        allLinks.map(async (link) => {
          const res = (await requestOnLink(link, "list_tabs", {}, 15_000)) as {
            tabs?: Array<{ tabId: number; url?: string; title?: string }>;
          };
          return (res?.tabs ?? []).map((t) => ({
            targetId: formatTargetId(link, t.tabId),
            type: "page" as const,
            title: t.title ?? "",
            url: t.url ?? "",
            backend: NAME,
          }));
        }),
      );
      const targets: BackendTarget[] = [];
      let firstErr: unknown;
      for (const r of settled) {
        if (r.status === "fulfilled") targets.push(...r.value);
        else if (firstErr === undefined) firstErr = r.reason;
      }
      if (targets.length === 0 && firstErr !== undefined) throw firstErr;
      return targets;
    },

    async status() {
      try {
        if (!server && !startError) await start();
      } catch {
        /* report unavailable below */
      }
      const connected = links.size > 0;
      const primary = defaultLink();
      const browsers = getConnectedBrowsers();
      return {
        available: connected,
        listening: Boolean(server),
        port: boundPort ?? null,
        instanceId,
        protocolVersion: PROTOCOL_VERSION,
        browsers,
        ...(connected && primary
          ? {
              slug: primary.slug,
              browser: primary.browser,
              profileId: primary.profileId,
              extensionVersion: primary.extensionVersion,
            }
          : {}),
        ...(startError ? { reason: startError } : {}),
        activeTargetId:
          activeTab && links.has(activeTab.profileId)
            ? formatTargetId(activeTab, activeTab.tabId)
            : null,
      };
    },

    clearActive() {
      activeTab = undefined;
    },

    async dispose() {
      if (options.registerGlobal) {
        registerExtensionBcCall(undefined);
        registerExtensionRequest(undefined);
      }
      failConnectWaiters("relay disposed");
      for (const link of [...links.values()]) {
        failLinkPending(link, "relay disposed");
        clearHandshakeTimer(link.ws);
        try {
          link.ws.close(1001, "relay shutting down");
        } catch {
          /* ignore */
        }
      }
      links.clear();
      shortTargetOwners.clear();
      for (const w of [...eventWaiters]) {
        clearTimeout(w.timer);
        eventWaiters.delete(w);
        w.reject(new Error("relay disposed"));
      }
      if (server) {
        server.stop(true);
        server = undefined;
      }
      boundPort = undefined;
      activeTab = undefined;
    },
  };
  if (options.registerGlobal) (globalThis as Record<symbol, unknown>)[EXTENSION_BACKEND_SYMBOL] = backend;
  return backend;
}

// ---------------------------------------------------------------------------
// `extension status|browsers|diagnostics` reports (wrapper subcommands). Never include secrets.
// ---------------------------------------------------------------------------

const EXTENSION_BACKEND_SYMBOL = Symbol.for("browser-control.extension-backend");

/** The daemon's extension backend (set when created with `registerGlobal`). */
export function getRegisteredExtensionBackend(): ExtensionBackend | undefined {
  return (globalThis as Record<symbol, unknown>)[EXTENSION_BACKEND_SYMBOL] as ExtensionBackend | undefined;
}

export type ExtensionReportBackend = Pick<
  ExtensionBackend,
  "instanceId" | "getPort" | "status" | "getConnectedBrowsers" | "request" | "waitForConnection"
>;

/** `paired` when the relay token file exists, is private, and is valid. */
export async function relayPairingState(tokenFile: string = defaultTokenFilePath()): Promise<"paired" | "missing" | "bad"> {
  const read = readPrivateTokenSync(tokenFile);
  return "token" in read ? "paired" : read.state;
}

const SECRET_KEY_RE = /token|secret|nonce|proof|password|hmac|cookie|key$/i;

/** Replace secret-looking values (by key name, or any 64-hex string) with "[redacted]". Booleans stay. */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return HEX_64_RE.test(value) ? "[redacted]" : value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) && typeof v !== "boolean" && v !== null ? "[redacted]" : redactSecrets(v);
    }
    return out;
  }
  return value;
}

const offMessage = "INPUT_INVALID: the extension backend is off for this daemon; run: browser-control-daemon extension enable";

export async function extensionStatusReport(
  backend: ExtensionReportBackend | undefined,
  order: string[],
  tokenFile?: string,
  waitMs = 2000,
): Promise<Record<string, unknown>> {
  const enabled = order.includes(NAME) && backend !== undefined;
  const pairing = await relayPairingState(tokenFile);
  const base: Record<string, unknown> = {
    enabled,
    backends: order.join(","),
    paired: pairing === "paired",
    ...(pairing === "bad" ? { pairingProblem: "relay token file is not private or not valid; run: extension setup" } : {}),
  };
  if (!enabled) {
    const port = backend?.getPort() ?? null;
    const listening = port !== null;
    return {
      ...base,
      listening,
      port,
      browsers: listening ? backend!.getConnectedBrowsers().length : 0,
    };
  }
  let s = (await backend.status()) as Record<string, unknown>;
  // A relay that just started needs a moment for the extension to find it.
  if (s["listening"] && backend.getConnectedBrowsers().length === 0 && waitMs > 0) {
    await backend.waitForConnection(waitMs).catch(() => {});
    s = (await backend.status()) as Record<string, unknown>;
  }
  return {
    ...base,
    listening: Boolean(s["listening"]),
    port: s["port"] ?? null,
    protocolVersion: s["protocolVersion"] ?? PROTOCOL_VERSION,
    relayVersion: RELAY_VERSION,
    browsers: Array.isArray(s["browsers"]) ? s["browsers"].length : 0,
    ...(typeof s["reason"] === "string" ? { reason: s["reason"] } : {}),
  };
}

export type ExtensionBrowserRow = { slug: string; brand: string; browser: string; extensionVersion: string };

/** Connected browsers; waits up to `waitMs` for a first connection when none is up yet. */
export async function extensionBrowsersReport(
  backend: ExtensionReportBackend | undefined,
  order: string[],
  waitMs = 3000,
): Promise<ExtensionBrowserRow[]> {
  if (!order.includes(NAME) || !backend) throw new Error(offMessage);
  await backend.status();
  if (backend.getConnectedBrowsers().length === 0) await backend.waitForConnection(waitMs).catch(() => {});
  return backend.getConnectedBrowsers().map((b) => ({
    slug: b.slug,
    brand: browserSlugPrefix(b.browser),
    browser: b.browser,
    extensionVersion: b.extensionVersion,
  }));
}

/** Daemon relay state plus each connected browser's `diagnostics` op, with secrets redacted. */
export async function extensionDiagnosticsReport(
  backend: ExtensionReportBackend | undefined,
  order: string[],
  options: { tokenFile?: string; timeoutMs?: number; waitMs?: number } = {},
): Promise<unknown> {
  const daemon = await extensionStatusReport(backend, order, options.tokenFile, options.waitMs ?? 2000);
  if (!daemon["enabled"] || !backend) return redactSecrets({ daemon, browsers: [] });
  const rows = await extensionBrowsersReport(backend, order, options.waitMs ?? 3000);
  const browsers = await Promise.all(
    rows.map(async (row) => {
      try {
        return { ...row, diagnostics: await backend.request("diagnostics", {}, options.timeoutMs ?? 5000, row.slug) };
      } catch (error) {
        return { ...row, error: (error as Error).message };
      }
    }),
  );
  return redactSecrets({ daemon: { ...daemon, instanceId: backend.instanceId }, browsers });
}
