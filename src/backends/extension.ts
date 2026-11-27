/**
 * The `extension` backend: drives a real Chromium browser through the local MV3 companion
 * extension over a loopback WebSocket relay (127.0.0.1, ports 49222-49229).
 *
 * Needs no remote-debugging flag and no per-connection "Allow" click. Silent reads run in the
 * extension's ISOLATED content-script world via `bc_call`; trusted input and DevTools calls
 * attach `chrome.debugger` on demand via `cdp`.
 *
 * Mutual HMAC-SHA256 challenge-response handshake, ephemeral P-256 ECDH + PBKDF2 pairing,
 * per-browser token minting/wrapping, BrowserLinks multi-browser identity, and MV3 keepalive
 * patterns adapted from anomalyco/browse (MIT License).
 */

import {
  createCipheriv,
  createECDH,
  createHmac,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { link as fsLink, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname as osHostname, tmpdir } from "node:os";
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
export const TRANSPORT_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const CHUNK_MAX_DATA_BYTES = 512 * 1024;
export const POST_AUTH_MAX_BYTES = 64 * 1024 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
export const PAIR_CODE_MAX_FAILURES = 5;
export const PAIR_PBKDF2_ITERATIONS = 100_000;
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const CLOSE_REPLACED = 4001;
export const CLOSE_BAD_HELLO = 4002;
export const CLOSE_VERSION_MISMATCH = 4003;
export const CLOSE_AUTH_REFUSED = 4006;

const DEFAULT_WAIT_CONNECT_MS = 35_000;
const DEFAULT_LIST_WAIT_MS = 5_000;
const DEFAULT_REQ_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_FRAME_BYTES = 900 * 1024;
const DEFAULT_MAX_CONCURRENT_CHUNKS = 32;
const DEFAULT_CHUNK_STREAM_TIMEOUT_MS = 60_000;
const DEFAULT_PAIR_RATE_LIMIT_MAX = 10;
const DEFAULT_PAIR_RATE_LIMIT_WINDOW_MS = 60_000;
const RETAIN_EXPIRED_CODE_MS = 60 * 60 * 1000;

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
const CROCKFORD_8_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const DIGITS_RE = /^\d+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

export function relayProofMessage(port: number, extNonce: string, relayNonce: string): string {
  return `bc-v2|relay|127.0.0.1:${port}/extension|${extNonce}|${relayNonce}`;
}

export function extProofMessage(port: number, relayNonce: string, extNonce: string): string {
  return `bc-v2|ext|127.0.0.1:${port}/extension|${relayNonce}|${extNonce}`;
}

export function wrapInfoMessage(port: number, extNonce: string, relayNonce: string): string {
  return `bc-v2|wrap|127.0.0.1:${port}/extension|${extNonce}|${relayNonce}`;
}

export function pairKeyInfoMessage(
  port: number,
  extNonce: string,
  relayNonce: string,
  extPubB64: string,
  relayPubB64: string,
): string {
  return `bc-v2|pair-key|127.0.0.1:${port}/extension|${extNonce}|${relayNonce}|${extPubB64}|${relayPubB64}`;
}

export function pairExtProofMessage(
  port: number,
  relayNonce: string,
  extNonce: string,
  extPubB64: string,
  relayPubB64: string,
): string {
  return `bc-v2|pair-ext|127.0.0.1:${port}/extension|${relayNonce}|${extNonce}|${extPubB64}|${relayPubB64}`;
}

export function pairRelayProofMessage(
  port: number,
  extNonce: string,
  relayNonce: string,
  extPubB64: string,
  relayPubB64: string,
): string {
  return `bc-v2|pair-relay|127.0.0.1:${port}/extension|${extNonce}|${relayNonce}|${extPubB64}|${relayPubB64}`;
}

export function pairWrapInfoMessage(port: number, extNonce: string, relayNonce: string): string {
  return `bc-v2|pair-wrap|127.0.0.1:${port}/extension|${extNonce}|${relayNonce}`;
}

export function wrapAadMessage(profileId: string, tokenId: string): string {
  return `bc-v2|token|${profileId}|${tokenId}`;
}

export function hmacHex(token: string | Buffer | Uint8Array, message: string): string {
  return createHmac("sha256", token).update(message, "utf8").digest("hex");
}

function safeEqualHex(expectedHex: string, actualHex: unknown): boolean {
  if (typeof actualHex !== "string" || !HEX_64_RE.test(actualHex)) return false;
  const a = Buffer.from(expectedHex.toLowerCase(), "hex");
  const b = Buffer.from(actualHex.toLowerCase(), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type WrappedToken = {
  tokenId: string;
  iv: string;
  ciphertext: string;
};

/** Wrap a 32-byte hex per-browser token with AES-256-GCM using an HKDF-SHA256 derived key. */
export function wrapBrowserToken(params: {
  token: string;
  tokenId: string;
  ikm: string | Buffer | Uint8Array;
  info: string;
  profileId: string;
}): WrappedToken {
  const ikmBuf = typeof params.ikm === "string" ? Buffer.from(params.ikm, "utf8") : Buffer.from(params.ikm);
  const keyBuf = Buffer.from(
    hkdfSync("sha256", ikmBuf, Buffer.alloc(0), Buffer.from(params.info, "utf8"), 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBuf, iv);
  cipher.setAAD(Buffer.from(wrapAadMessage(params.profileId, params.tokenId), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(params.token.toLowerCase(), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    tokenId: params.tokenId,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Normalize an 8-character Crockford Base32 pairing code, or return null if invalid. */
export function normalizePairingCode(raw: string): string | null {
  const cleaned = String(raw || "")
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return CROCKFORD_8_RE.test(cleaned) ? cleaned : null;
}

/** Format an 8-character Crockford pairing code as `XXXX-XXXX`. */
export function formatPairingCode(raw: string): string {
  const norm = normalizePairingCode(raw);
  if (!norm) throw new Error("INPUT_INVALID: invalid pairing code");
  return `${norm.slice(0, 4)}-${norm.slice(4)}`;
}

/** Generate an unbiased 8-character Crockford Base32 pairing code (40 bits from 5 random bytes). */
export function generatePairingCode(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let raw = "";
  for (let i = 7; i >= 0; i--) {
    const idx = Number((bits >> BigInt(i * 5)) & 31n);
    raw += CROCKFORD_ALPHABET[idx]!;
  }
  return formatPairingCode(raw);
}

function configRootDir(): string {
  const config = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(config, "browser-control");
}

export function defaultTokenFilePath(): string {
  return join(configRootDir(), "extension-relay.json");
}

export function defaultBrowsersFilePath(): string {
  return join(configRootDir(), "extension-browsers.json");
}

export function defaultPairingCodesFilePath(): string {
  return join(configRootDir(), "extension-pairing-codes.json");
}

type TokenRead = { token: string } | { state: "missing" | "bad" };

async function isPrivateFileOwnedBySelf(file: string): Promise<"ok" | "missing" | "bad"> {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if ((info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    return "bad";
  }
  return "ok";
}

async function readPrivateToken(tokenFile: string): Promise<TokenRead> {
  const perms = await isPrivateFileOwnedBySelf(tokenFile);
  if (perms !== "ok") return { state: perms };
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
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
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
    const read = await readPrivateToken(tokenFile);
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
  const read = await readPrivateToken(tokenFile);
  if (!("token" in read) && read.state === "bad") {
    await publishPrivateFile(tokenFile, newTokenBody(randomBytes(32).toString("hex")), true);
  }
  return ensureRelayToken(tokenFile);
}

export async function setupExtensionPairing(
  extensionDir: string,
  options: { tokenFile?: string; port?: number; pairingId?: string } = {},
): Promise<{ tokenFile: string; pairingFile: string; port: number; pairingId: string }> {
  const tokenFile = options.tokenFile ?? defaultTokenFilePath();
  const port = options.port ?? PORT_RANGE_START;
  const token = await repairRelayToken(tokenFile);
  const pairingId = options.pairingId ?? randomBytes(16).toString("hex");
  const resolvedDir = resolvePath(extensionDir);
  await mkdir(resolvedDir, { recursive: true });
  const pairingFile = join(resolvedDir, "pairing.json");
  await publishPrivateFile(pairingFile, `${JSON.stringify({ token, port, pairingId }, null, 2)}\n`, true);
  return { tokenFile, pairingFile, port, pairingId };
}

// ---------------------------------------------------------------------------
// Per-browser token store & stable browser slug allocation
// ---------------------------------------------------------------------------

export type BrowserRecord = {
  profileId: string;
  slug: string;
  browser: string;
  name?: string;
  tokenId: string;
  token: string;
  createdAt: string;
  lastSeenAt: string;
};

type BrowsersFileData = {
  version: 1;
  browsers: Record<string, BrowserRecord>;
};

function slugifyPart(raw: string, fallback: string): string {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function hostSlugOf(host?: string): string {
  const raw = (host ?? osHostname()).replace(/\.local$/i, "").split(".")[0] ?? "";
  return slugifyPart(raw, "local");
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

/** Allocate a stable collision-free slug (`chrome-<host>`, `brave-<host>`, `-2`, `-3`, ...). */
export function allocateBrowserSlug(
  browser: string,
  existingSlugs: ReadonlySet<string>,
  options: { name?: string; hostname?: string } = {},
): string {
  const prefix = browserSlugPrefix(browser);
  const custom = typeof options.name === "string" && options.name.trim() !== ""
    ? slugifyPart(options.name, "")
    : "";
  let base = custom ? (DIGITS_RE.test(custom) ? `${prefix}-${custom}` : custom) : `${prefix}-${hostSlugOf(options.hostname)}`;
  if (DIGITS_RE.test(base)) base = `${prefix}-${base}`;
  if (!existingSlugs.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}-${n}`;
    if (!existingSlugs.has(candidate)) return candidate;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

class BrowserStore {
  private readonly file?: string;
  private readonly host?: string;
  private readonly now: () => number;
  private readonly memory = new Map<string, BrowserRecord>();
  private lock: Promise<void> = Promise.resolve();

  constructor(options: { file?: string; hostname?: string; now?: () => number }) {
    this.file = options.file;
    this.host = options.hostname;
    this.now = options.now ?? (() => Date.now());
  }

  private async runLocked<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async loadMap(): Promise<Map<string, BrowserRecord>> {
    if (!this.file) return new Map(this.memory);
    const perms = await isPrivateFileOwnedBySelf(this.file);
    if (perms === "missing") return new Map();
    if (perms === "bad") {
      throw new Error(`EXECUTION_FAILED: browsers file ${this.file} is not private`);
    }
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<BrowsersFileData>;
      const map = new Map<string, BrowserRecord>();
      if (parsed && typeof parsed.browsers === "object" && parsed.browsers !== null) {
        for (const [profileId, rec] of Object.entries(parsed.browsers)) {
          if (
            rec &&
            typeof rec.profileId === "string" &&
            typeof rec.slug === "string" &&
            typeof rec.browser === "string" &&
            typeof rec.tokenId === "string" &&
            typeof rec.token === "string" &&
            HEX_64_RE.test(rec.token)
          ) {
            map.set(profileId, { ...rec, token: rec.token.toLowerCase() });
          }
        }
      }
      return map;
    } catch {
      throw new Error(`EXECUTION_FAILED: browsers file ${this.file} is invalid JSON`);
    }
  }

  private async saveMap(map: Map<string, BrowserRecord>): Promise<void> {
    if (!this.file) {
      this.memory.clear();
      for (const [k, v] of map) this.memory.set(k, v);
      return;
    }
    const browsers: Record<string, BrowserRecord> = {};
    for (const [k, v] of map) browsers[k] = v;
    const body = `${JSON.stringify({ version: 1, browsers } satisfies BrowsersFileData, null, 2)}\n`;
    await publishPrivateFile(this.file, body, true);
  }

  async lookupByProfileAndTokenId(profileId: string, tokenId: string): Promise<BrowserRecord | undefined> {
    const map = await this.loadMap();
    const rec = map.get(profileId);
    if (!rec || rec.tokenId !== tokenId) return undefined;
    return rec;
  }

  async mintOrRotate(input: {
    profileId: string;
    browser: string;
    name?: string;
    extraUsedSlugs?: Iterable<string>;
  }): Promise<BrowserRecord> {
    return this.runLocked(async () => {
      const map = await this.loadMap();
      const existing = map.get(input.profileId);
      const usedSlugs = new Set<string>();
      for (const rec of map.values()) {
        if (rec.profileId !== input.profileId) usedSlugs.add(rec.slug);
      }
      if (input.extraUsedSlugs) {
        for (const s of input.extraUsedSlugs) usedSlugs.add(s);
      }
      const slug = existing?.slug ?? allocateBrowserSlug(input.browser, usedSlugs, {
        name: input.name,
        hostname: this.host,
      });
      const stamp = new Date(this.now()).toISOString();
      const rec: BrowserRecord = {
        profileId: input.profileId,
        slug,
        browser: input.browser,
        ...(input.name ? { name: input.name } : {}),
        tokenId: randomBytes(16).toString("hex"),
        token: randomBytes(32).toString("hex"),
        createdAt: existing?.createdAt ?? stamp,
        lastSeenAt: stamp,
      };
      map.set(input.profileId, rec);
      await this.saveMap(map);
      return rec;
    });
  }

  async touchSeen(profileId: string, browser: string, name?: string): Promise<BrowserRecord | undefined> {
    return this.runLocked(async () => {
      const map = await this.loadMap();
      const existing = map.get(profileId);
      if (!existing) return undefined;
      const updated: BrowserRecord = {
        ...existing,
        browser,
        ...(name ? { name } : {}),
        lastSeenAt: new Date(this.now()).toISOString(),
      };
      map.set(profileId, updated);
      await this.saveMap(map);
      return updated;
    });
  }
}

// ---------------------------------------------------------------------------
// One-time Crockford pairing code store (hashed PBKDF2, 10m TTL, 5-fail burn)
// ---------------------------------------------------------------------------

type PairingCodeEntry = {
  id: string;
  salt: string;
  codeHash: string;
  iterations: number;
  createdAt: number;
  expiresAt: number;
  failures: number;
  spent: boolean;
  burned: boolean;
};

type PairingCodesFileData = {
  version: 1;
  codes: PairingCodeEntry[];
};

export type PairingCodeResult = {
  id: string;
  code: string;
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
  codesFile?: string;
};

class PairingCodeStore {
  private readonly file?: string;
  private readonly now: () => number;
  private memory: PairingCodeEntry[] = [];
  private lock: Promise<void> = Promise.resolve();

  constructor(options: { file?: string; now?: () => number }) {
    this.file = options.file;
    this.now = options.now ?? (() => Date.now());
  }

  private async runLocked<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async loadList(): Promise<PairingCodeEntry[]> {
    if (!this.file) return this.memory.map((c) => ({ ...c }));
    const perms = await isPrivateFileOwnedBySelf(this.file);
    if (perms === "missing") return [];
    if (perms === "bad") {
      throw new Error(`EXECUTION_FAILED: pairing codes file ${this.file} is not private`);
    }
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<PairingCodesFileData>;
      if (!parsed || !Array.isArray(parsed.codes)) return [];
      return parsed.codes.filter(
        (c): c is PairingCodeEntry =>
          Boolean(c) &&
          typeof c.id === "string" &&
          typeof c.salt === "string" &&
          HEX_32_RE.test(c.salt) &&
          typeof c.codeHash === "string" &&
          HEX_64_RE.test(c.codeHash) &&
          typeof c.iterations === "number" &&
          typeof c.createdAt === "number" &&
          typeof c.expiresAt === "number" &&
          typeof c.failures === "number" &&
          typeof c.spent === "boolean" &&
          typeof c.burned === "boolean",
      );
    } catch {
      return [];
    }
  }

  private async saveList(codes: PairingCodeEntry[]): Promise<void> {
    const cutoff = this.now() - RETAIN_EXPIRED_CODE_MS;
    const pruned = codes.filter((c) => c.expiresAt > cutoff).slice(-20);
    if (!this.file) {
      this.memory = pruned.map((c) => ({ ...c }));
      return;
    }
    const body = `${JSON.stringify({ version: 1, codes: pruned } satisfies PairingCodesFileData, null, 2)}\n`;
    await publishPrivateFile(this.file, body, true);
  }

  async create(options: { ttlMs?: number; port?: number; iterations?: number } = {}): Promise<PairingCodeResult> {
    return this.runLocked(async () => {
      const list = await this.loadList();
      const code = generatePairingCode();
      const normalized = normalizePairingCode(code)!;
      const salt = randomBytes(16).toString("hex");
      const iterations = options.iterations ?? PAIR_PBKDF2_ITERATIONS;
      const codeHash = pbkdf2Sync(
        Buffer.from(normalized, "utf8"),
        Buffer.from(salt, "hex"),
        iterations,
        32,
        "sha256",
      ).toString("hex");
      const createdAt = this.now();
      const ttlMs = options.ttlMs ?? PAIR_CODE_TTL_MS;
      const expiresAt = createdAt + ttlMs;
      const id = randomBytes(16).toString("hex");
      list.push({
        id,
        salt,
        codeHash,
        iterations,
        createdAt,
        expiresAt,
        failures: 0,
        spent: false,
        burned: false,
      });
      await this.saveList(list);
      const portSuffix = typeof options.port === "number" ? `&port=${options.port}` : "";
      return {
        id,
        code,
        url: `chrome-extension://${EXTENSION_ID}/onboarding.html#code=${encodeURIComponent(code)}${portSuffix}`,
        expiresAt: new Date(expiresAt).toISOString(),
        expiresInSeconds: Math.max(0, Math.round(ttlMs / 1000)),
        ...(this.file ? { codesFile: this.file } : {}),
      };
    });
  }

  /** Pick the most recent active pairing code, or report why none is available. */
  async getActive(): Promise<{ ok: true; entry: PairingCodeEntry } | { ok: false; reason: string }> {
    const list = await this.loadList();
    const t = this.now();
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]!;
      if (!entry.spent && !entry.burned && entry.failures < PAIR_CODE_MAX_FAILURES && t < entry.expiresAt) {
        return { ok: true, entry };
      }
    }
    const latest = list[list.length - 1];
    if (!latest) return { ok: false, reason: "no active pairing code" };
    if (latest.spent) return { ok: false, reason: "pairing code already used" };
    if (latest.burned || latest.failures >= PAIR_CODE_MAX_FAILURES) return { ok: false, reason: "pairing code burned" };
    if (t >= latest.expiresAt) return { ok: false, reason: "pairing code expired" };
    return { ok: false, reason: "no active pairing code" };
  }

  async recordFailure(codeId: string): Promise<{ burned: boolean; failures: number }> {
    return this.runLocked(async () => {
      const list = await this.loadList();
      const entry = list.find((c) => c.id === codeId);
      if (!entry) return { burned: true, failures: PAIR_CODE_MAX_FAILURES };
      entry.failures += 1;
      if (entry.failures >= PAIR_CODE_MAX_FAILURES) entry.burned = true;
      await this.saveList(list);
      return { burned: entry.burned, failures: entry.failures };
    });
  }

  async consume(codeId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.runLocked(async () => {
      const list = await this.loadList();
      const entry = list.find((c) => c.id === codeId);
      const t = this.now();
      if (!entry) return { ok: false, reason: "pairing code not found" };
      if (entry.spent) return { ok: false, reason: "pairing code already used" };
      if (entry.burned || entry.failures >= PAIR_CODE_MAX_FAILURES) return { ok: false, reason: "pairing code burned" };
      if (t >= entry.expiresAt) return { ok: false, reason: "pairing code expired" };
      entry.spent = true;
      await this.saveList(list);
      return { ok: true };
    });
  }
}

/** Generate and persist a one-time 8-character Crockford pairing code (10-minute expiry). */
export async function createPairingCode(
  options: { codesFile?: string; ttlMs?: number; port?: number; now?: () => number } = {},
): Promise<PairingCodeResult> {
  const store = new PairingCodeStore({
    file: options.codesFile ?? defaultPairingCodesFilePath(),
    now: options.now,
  });
  return store.create({ ttlMs: options.ttlMs, port: options.port });
}

// ---------------------------------------------------------------------------
// Chunked post-auth frame encoder & reassembler (keeps all WS frames < 1 MiB)
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
): { ok: true; frames: string[]; chunked: boolean; totalBytes: number } | { ok: false; error: string; totalBytes: number } {
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
    options.id ??
    (obj["id"] !== undefined ? String(obj["id"]) : `d-${autoChunkStreamId++}`);
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

type ChunkDecodeResult =
  | { kind: "message"; message: Record<string, unknown> }
  | { kind: "pending" }
  | { kind: "ignored" }
  | { kind: "error"; id: string; reqId?: number; error: string };

type ChunkStream = {
  nextSeq: number;
  totalBytes: number;
  parts: string[];
  startedAt: number;
};

function numericReqIdOf(rawId: unknown, explicitReqId?: unknown): number | undefined {
  if (typeof explicitReqId === "number" && Number.isInteger(explicitReqId)) return explicitReqId;
  if (typeof rawId === "number" && Number.isInteger(rawId)) return rawId;
  if (typeof rawId === "string" && DIGITS_RE.test(rawId)) return Number(rawId);
  return undefined;
}

class ChunkReassembler {
  private readonly maxDataBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly streams = new Map<string, ChunkStream>();
  private readonly aborted = new Map<string, number>();

  constructor(options: {
    maxDataBytes?: number;
    maxTotalBytes?: number;
    maxConcurrent?: number;
    timeoutMs?: number;
    now?: () => number;
  } = {}) {
    this.maxDataBytes = options.maxDataBytes ?? CHUNK_MAX_DATA_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? POST_AUTH_MAX_BYTES;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_CHUNKS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CHUNK_STREAM_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  private pruneExpired(): void {
    const t = this.now();
    for (const [id, s] of this.streams) {
      if (t - s.startedAt > this.timeoutMs) this.streams.delete(id);
    }
    for (const [id, ts] of this.aborted) {
      if (t - ts > this.timeoutMs) this.aborted.delete(id);
    }
  }

  private abort(id: string, isLast: boolean): void {
    this.streams.delete(id);
    if (isLast) this.aborted.delete(id);
    else this.aborted.set(id, this.now());
  }

  push(msg: Record<string, unknown>): ChunkDecodeResult {
    if (msg["type"] !== "chunk") return { kind: "message", message: msg };
    this.pruneExpired();

    const rawId = msg["id"];
    const validId =
      (typeof rawId === "string" && rawId.trim() !== "") ||
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
      stream = { nextSeq: 0, totalBytes: 0, parts: [], startedAt: this.now() };
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

    if (stream.totalBytes + chunkBytes > this.maxTotalBytes) {
      this.abort(id, last);
      return {
        kind: "error",
        id,
        reqId,
        error: `EXECUTION_FAILED: chunked message too large (stream ${id} exceeds ${this.maxTotalBytes} bytes)`,
      };
    }

    stream.parts.push(data);
    stream.totalBytes += chunkBytes;
    stream.nextSeq += 1;

    if (!last) return { kind: "pending" };

    this.streams.delete(id);
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
    this.streams.clear();
    this.aborted.clear();
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

/** Parse `extension:<tabId>` or `extension:<slug>:<tabId>`. */
export function parseExtensionTargetId(targetId: unknown): { slug?: string; tabId: number } | undefined {
  if (prefixOf(targetId) !== NAME) return undefined;
  const rest = (targetId as string).slice(NAME.length + 1);
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

// ---------------------------------------------------------------------------
// Relay WebSocket server & BrowserLinks
// ---------------------------------------------------------------------------

type WsState = {
  stage: "awaiting_hello" | "awaiting_response" | "awaiting_pair_response" | "ready";
  authenticated: boolean;
  closed: boolean;
  queue: Promise<void>;
  handshakeTimer?: ReturnType<typeof setTimeout>;
  extNonce?: string;
  relayNonce?: string;
  profileId?: string;
  browser?: string;
  name?: string;
  extensionVersion?: string;
  slug?: string;
  authKind?: "bootstrap" | "browser" | "pair";
  authToken?: string;
  tokenId?: string;
  pairCodeId?: string;
  pairCodeHash?: string;
  pairSharedSecret?: Buffer;
  pairExtPubB64?: string;
  pairRelayPubB64?: string;
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
  name?: string;
  extensionVersion: string;
  ws: ServerWebSocket<WsState>;
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
  name?: string;
  extensionVersion: string;
};

export type ExtensionBackendOptions = {
  portStart?: number;
  portEnd?: number;
  expectedOrigin?: string;
  tokenFile?: string;
  token?: string;
  browsersFile?: string;
  codesFile?: string;
  hostname?: string;
  handshakeTimeoutMs?: number;
  waitConnectMs?: number;
  listTargetsWaitMs?: number;
  helpersVersion?: number;
  artifactDir?: () => string;
  eventBufferSize?: number;
  registerGlobal?: boolean;
  maxPostAuthBytes?: number;
  pairRateLimitMax?: number;
  pairRateLimitWindowMs?: number;
  now?: () => number;
};

export interface ExtensionBackend extends Backend {
  readonly instanceId: string;
  getPort(): number | undefined;
  isConnected(): boolean;
  getConnectedBrowsers(): ConnectedBrowserInfo[];
  createPairingCode(options?: { ttlMs?: number; port?: number }): Promise<PairingCodeResult>;
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
  const pairRateLimitMax = options.pairRateLimitMax ?? DEFAULT_PAIR_RATE_LIMIT_MAX;
  const pairRateLimitWindowMs = options.pairRateLimitWindowMs ?? DEFAULT_PAIR_RATE_LIMIT_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const instanceId = randomUUID();

  const resolvedBrowsersFile =
    options.browsersFile ??
    (options.tokenFile
      ? join(dirname(options.tokenFile), "extension-browsers.json")
      : options.token === undefined
        ? defaultBrowsersFilePath()
        : undefined);

  const resolvedCodesFile =
    options.codesFile ??
    (options.tokenFile
      ? join(dirname(options.tokenFile), "extension-pairing-codes.json")
      : options.token === undefined
        ? defaultPairingCodesFilePath()
        : undefined);

  const browserStore = new BrowserStore({ file: resolvedBrowsersFile, hostname: options.hostname, now });
  const codeStore = new PairingCodeStore({ file: resolvedCodesFile, now });

  let server: Server<WsState> | undefined;
  let boundPort: number | undefined;
  let relayToken: string | undefined;
  let startPromise: Promise<void> | undefined;
  let startError: string | undefined;

  // BrowserLinks: profileId -> live authenticated BrowserLink
  const links = new Map<string, BrowserLink>();
  let activeTab: ActiveTabRef | undefined;
  let nextReqId = 1;
  const connectWaiters = new Set<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const events = new EventBuffer(options.eventBufferSize ?? 1000);
  const eventWaiters = new Set<EventWaiter>();
  const pairFailureTimestamps: number[] = [];

  function isPairRateLimited(): boolean {
    const cutoff = now() - pairRateLimitWindowMs;
    while (pairFailureTimestamps.length > 0 && pairFailureTimestamps[0]! < cutoff) {
      pairFailureTimestamps.shift();
    }
    return pairFailureTimestamps.length >= pairRateLimitMax;
  }

  function notePairFailure(): void {
    const cutoff = now() - pairRateLimitWindowMs;
    while (pairFailureTimestamps.length > 0 && pairFailureTimestamps[0]! < cutoff) {
      pairFailureTimestamps.shift();
    }
    pairFailureTimestamps.push(now());
  }

  function formatTargetId(slug: string, tabId: number): string {
    return links.size > 1 ? `${NAME}:${slug}:${tabId}` : `${NAME}:${tabId}`;
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
          ? formatTargetId(link.slug, tabId)
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

  function sendToSocket(ws: ServerWebSocket<WsState>, obj: Record<string, unknown>): void {
    const encoded = encodeChunkedFrames(obj, { maxTotalBytes: maxPostAuthBytes });
    if (!encoded.ok) {
      throw new Error(encoded.error);
    }
    for (const frame of encoded.frames) {
      ws.send(frame);
    }
  }

  function attachAuthenticatedLink(
    ws: ServerWebSocket<WsState>,
    record: BrowserRecord,
    welcomeExtra: Record<string, unknown> = {},
  ): void {
    const data = ws.data;
    clearHandshakeTimer(ws);
    data.stage = "ready";
    data.authenticated = true;
    data.slug = record.slug;

    const existing = links.get(record.profileId);
    if (existing && existing.ws !== ws) {
      try {
        existing.ws.close(CLOSE_REPLACED, "replaced by newer connection");
      } catch {
        /* ignore */
      }
      failLinkPending(existing, "replaced by newer connection");
    }

    const link: BrowserLink = {
      profileId: record.profileId,
      slug: record.slug,
      browser: record.browser,
      ...(record.name ? { name: record.name } : {}),
      extensionVersion: data.extensionVersion ?? "",
      ws,
      pending: new Map(),
      decoder: new ChunkReassembler({ maxTotalBytes: maxPostAuthBytes, now }),
      connectedAt: now(),
    };
    links.set(record.profileId, link);

    ws.send(
      JSON.stringify({
        type: "welcome",
        instanceId,
        version: RELAY_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        helpersVersion: expectedHelpersVersion,
        slug: record.slug,
        ...welcomeExtra,
      }),
    );
    notifyConnected();
  }

  function handleAuthenticatedMessage(link: BrowserLink, msg: Record<string, unknown>): void {
    const type = msg["type"];
    if (type === "ping") {
      link.ws.send(JSON.stringify({ type: "pong" }));
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

  async function processWsMessage(ws: ServerWebSocket<WsState>, raw: string | Buffer): Promise<void> {
    const data = ws.data;
    if (data.closed) return;

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
      const msgType = msg["type"];
      if (msgType === "chunk") {
        clearHandshakeTimer(ws);
        ws.close(CLOSE_BAD_HELLO, "chunked frames not allowed before auth");
        return;
      }
      if (msgType !== "hello" && msgType !== "pair.hello") {
        clearHandshakeTimer(ws);
        ws.close(CLOSE_BAD_HELLO, "bad hello: expected hello or pair.hello");
        return;
      }

      const profileId = msg["profileId"];
      const browser = msg["browser"];
      const version = msg["version"];
      const helpersVersion = msg["helpersVersion"];
      const protocolVersion = msg["protocolVersion"];
      const nonce = msg["nonce"];
      const name = typeof msg["name"] === "string" && msg["name"].trim() !== "" ? msg["name"].trim() : undefined;

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
      data.name = name;
      data.extensionVersion = version;

      if (msgType === "pair.hello") {
        if (isPairRateLimited()) {
          clearHandshakeTimer(ws);
          ws.close(CLOSE_AUTH_REFUSED, "pairing rate limited");
          return;
        }
        const ecdhPub = msg["ecdhPub"];
        if (typeof ecdhPub !== "string" || ecdhPub.trim() === "") {
          clearHandshakeTimer(ws);
          ws.close(CLOSE_BAD_HELLO, "bad pair.hello: missing ecdhPub");
          return;
        }
        let extPubBytes: Buffer;
        try {
          extPubBytes = Buffer.from(ecdhPub, "base64");
        } catch {
          clearHandshakeTimer(ws);
          ws.close(CLOSE_BAD_HELLO, "bad pair.hello: invalid ecdhPub");
          return;
        }
        if (extPubBytes.length !== 65 || extPubBytes[0] !== 0x04) {
          clearHandshakeTimer(ws);
          ws.close(CLOSE_BAD_HELLO, "bad pair.hello: invalid P-256 public key");
          return;
        }

        const activeCode = await codeStore.getActive();
        if (data.closed) return;
        if (!activeCode.ok) {
          notePairFailure();
          clearHandshakeTimer(ws);
          ws.close(CLOSE_AUTH_REFUSED, activeCode.reason);
          return;
        }

        let relayPubB64: string;
        let sharedSecret: Buffer;
        try {
          const ecdh = createECDH("prime256v1");
          ecdh.generateKeys();
          relayPubB64 = ecdh.getPublicKey().toString("base64");
          sharedSecret = ecdh.computeSecret(extPubBytes);
        } catch {
          clearHandshakeTimer(ws);
          ws.close(CLOSE_BAD_HELLO, "bad pair.hello: invalid P-256 curve point");
          return;
        }

        data.authKind = "pair";
        data.pairCodeId = activeCode.entry.id;
        data.pairCodeHash = activeCode.entry.codeHash;
        data.pairSharedSecret = sharedSecret;
        data.pairExtPubB64 = ecdhPub;
        data.pairRelayPubB64 = relayPubB64;
        data.stage = "awaiting_pair_response";

        ws.send(
          JSON.stringify({
            type: "pair.challenge",
            nonce: relayNonce,
            ecdhPub: relayPubB64,
            salt: activeCode.entry.salt,
            iterations: activeCode.entry.iterations,
          }),
        );
        return;
      }

      // Standard mutual HMAC hello (either per-browser tokenId or bootstrap token)
      const tokenId = typeof msg["tokenId"] === "string" && msg["tokenId"].trim() !== "" ? msg["tokenId"].trim() : undefined;
      if (tokenId) {
        let rec: BrowserRecord | undefined;
        try {
          rec = await browserStore.lookupByProfileAndTokenId(profileId, tokenId);
        } catch {
          clearHandshakeTimer(ws);
          ws.close(CLOSE_AUTH_REFUSED, "browser token store unreadable");
          return;
        }
        if (data.closed) return;
        if (!rec) {
          clearHandshakeTimer(ws);
          ws.close(CLOSE_AUTH_REFUSED, "unknown or revoked browser token");
          return;
        }
        data.authKind = "browser";
        data.authToken = rec.token;
        data.tokenId = rec.tokenId;
      } else {
        data.authKind = "bootstrap";
        data.authToken = relayToken!;
      }

      data.stage = "awaiting_response";
      const proof = hmacHex(data.authToken, relayProofMessage(boundPort!, extNonce, relayNonce));
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
        data.authToken!,
        extProofMessage(boundPort!, data.relayNonce!, data.extNonce!),
      );
      if (!safeEqualHex(expectedProof, msg["proof"])) {
        clearHandshakeTimer(ws);
        ws.close(CLOSE_AUTH_REFUSED, "auth refused");
        return;
      }

      if (data.authKind === "bootstrap") {
        let rec: BrowserRecord;
        try {
          rec = await browserStore.mintOrRotate({
            profileId: data.profileId!,
            browser: data.browser!,
            name: data.name,
            extraUsedSlugs: [...links.values()]
              .filter((l) => l.profileId !== data.profileId)
              .map((l) => l.slug),
          });
        } catch {
          clearHandshakeTimer(ws);
          ws.close(CLOSE_AUTH_REFUSED, "failed to store browser token");
          return;
        }
        if (data.closed) return;
        const wrappedToken = wrapBrowserToken({
          token: rec.token,
          tokenId: rec.tokenId,
          ikm: Buffer.from(data.authToken!, "utf8"),
          info: wrapInfoMessage(boundPort!, data.extNonce!, data.relayNonce!),
          profileId: data.profileId!,
        });
        attachAuthenticatedLink(ws, rec, { wrappedToken });
        return;
      }

      // Per-browser token authenticated cleanly
      let rec: BrowserRecord | undefined;
      try {
        rec = await browserStore.touchSeen(data.profileId!, data.browser!, data.name);
      } catch {
        rec = undefined;
      }
      if (data.closed) return;
      if (!rec) {
        clearHandshakeTimer(ws);
        ws.close(CLOSE_AUTH_REFUSED, "unknown or revoked browser token");
        return;
      }
      attachAuthenticatedLink(ws, rec);
      return;
    }

    if (data.stage === "awaiting_pair_response") {
      if (msg["type"] !== "pair.response") {
        clearHandshakeTimer(ws);
        ws.close(CLOSE_BAD_HELLO, "expected pair.response");
        return;
      }
      const codeKey = Buffer.from(data.pairCodeHash!, "hex");
      const ikm = Buffer.concat([data.pairSharedSecret!, codeKey]);
      const pairKey = Buffer.from(
        hkdfSync(
          "sha256",
          ikm,
          Buffer.alloc(0),
          Buffer.from(
            pairKeyInfoMessage(
              boundPort!,
              data.extNonce!,
              data.relayNonce!,
              data.pairExtPubB64!,
              data.pairRelayPubB64!,
            ),
            "utf8",
          ),
          32,
        ),
      );
      const expectedExtProof = hmacHex(
        pairKey,
        pairExtProofMessage(
          boundPort!,
          data.relayNonce!,
          data.extNonce!,
          data.pairExtPubB64!,
          data.pairRelayPubB64!,
        ),
      );

      if (!safeEqualHex(expectedExtProof, msg["proof"])) {
        notePairFailure();
        await codeStore.recordFailure(data.pairCodeId!).catch(() => {});
        clearHandshakeTimer(ws);
        ws.close(CLOSE_AUTH_REFUSED, "pairing refused");
        return;
      }

      const consumed = await codeStore.consume(data.pairCodeId!);
      if (data.closed) return;
      if (!consumed.ok) {
        notePairFailure();
        clearHandshakeTimer(ws);
        ws.close(CLOSE_AUTH_REFUSED, consumed.reason);
        return;
      }

      let rec: BrowserRecord;
      try {
        rec = await browserStore.mintOrRotate({
          profileId: data.profileId!,
          browser: data.browser!,
          name: data.name,
          extraUsedSlugs: [...links.values()]
            .filter((l) => l.profileId !== data.profileId)
            .map((l) => l.slug),
        });
      } catch {
        clearHandshakeTimer(ws);
        ws.close(CLOSE_AUTH_REFUSED, "failed to store browser token");
        return;
      }
      if (data.closed) return;

      const relayProof = hmacHex(
        pairKey,
        pairRelayProofMessage(
          boundPort!,
          data.extNonce!,
          data.relayNonce!,
          data.pairExtPubB64!,
          data.pairRelayPubB64!,
        ),
      );
      const wrappedToken = wrapBrowserToken({
        token: rec.token,
        tokenId: rec.tokenId,
        ikm: pairKey,
        info: pairWrapInfoMessage(boundPort!, data.extNonce!, data.relayNonce!),
        profileId: data.profileId!,
      });
      // Wipe ephemeral secret references from socket state after handshake completes.
      data.pairSharedSecret = undefined;
      data.pairCodeHash = undefined;
      attachAuthenticatedLink(ws, rec, { proof: relayProof, wrappedToken });
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

  function handleWsMessage(ws: ServerWebSocket<WsState>, raw: string | Buffer): void {
    const data = ws.data;
    const byteLen = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
    if (!data.authenticated && byteLen > PRE_AUTH_MAX_BYTES) {
      clearHandshakeTimer(ws);
      data.closed = true;
      ws.close(1009, "pre-auth message too large");
      return;
    }
    data.queue = data.queue
      .then(() => processWsMessage(ws, raw))
      .catch(() => {
        if (!data.authenticated && !data.closed) {
          clearHandshakeTimer(ws);
          ws.close(CLOSE_AUTH_REFUSED, "handshake error");
        }
      });
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
                    queue: Promise.resolve(),
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
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(reqId);
        reject(new Error(`CDP_TIMEOUT: extension op "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      link.pending.set(reqId, { resolve, reject, timer });
      try {
        sendToSocket(link.ws, { type: "req", id: reqId, op, params });
      } catch (err) {
        clearTimeout(timer);
        link.pending.delete(reqId);
        const message = (err as Error).message;
        if (message.startsWith("EXECUTION_FAILED:")) {
          reject(err as Error);
        } else {
          reject(new BackendUnavailable(NAME, `failed to send to extension: ${message}`));
        }
      }
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
      if (links.size === 1) {
        const only = links.values().next().value!;
        return { link: only, tabId: parsed.tabId };
      }
      if (links.size === 0) {
        throw new BackendUnavailable(NAME, "extension is not connected");
      }
      if (activeTab && activeTab.tabId === parsed.tabId) {
        const activeLink = links.get(activeTab.profileId);
        if (activeLink) return { link: activeLink, tabId: parsed.tabId };
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
        ...(typeof input.frameId === "number" ? { frameId: input.frameId } : {}),
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
      ...(l.name ? { name: l.name } : {}),
      extensionVersion: l.extensionVersion,
    }));
  }

  return {
    name: NAME,
    instanceId,

    getPort() {
      return boundPort;
    },

    isConnected() {
      return links.size > 0;
    },

    getConnectedBrowsers,

    createPairingCode(opts?: { ttlMs?: number; port?: number }) {
      return codeStore.create(opts);
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
      if (op === "navigate" && typeof input["browser"] === "string" && findLinkBySlug(input["browser"])) {
        return true;
      }
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
          const targetId = formatTargetId(resolved.link.slug, resolved.tabId);
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
          if (input["targetId"] !== undefined) {
            const resolved = resolveTarget(input["targetId"]);
            if (!resolved) throw new Error("INPUT_INVALID: invalid extension targetId");
            targetLink = resolved.link;
            tabId = resolved.tabId;
          } else if (browserSlug) {
            const matched = findLinkBySlug(browserSlug);
            if (!matched) {
              throw new Error(
                `INPUT_INVALID: browser "${browserSlug}" is not connected (connected: ${connectedSlugs().join(", ") || "none"})`,
              );
            }
            targetLink = matched;
            // Explicit `browser` picks where a new tab opens (never hijacks a tab in another browser).
            tabId = undefined;
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

          const res = (await requestOnLink(
            targetLink,
            "navigate",
            {
              ...(tabId !== undefined ? { tabId } : {}),
              url,
              until,
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
            targetId: tid === undefined ? null : formatTargetId(targetLink.slug, tid),
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
            { tabId: resolved.tabId, expression, isolated: input["isolated"] === true },
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
              ...(sessionId ? { sessionId } : {}),
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
            targetId: formatTargetId(resolved.link.slug, resolved.tabId),
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
            targetId: formatTargetId(resolved.link.slug, resolved.tabId),
            backend: NAME,
          };
        }

        case "read_events": {
          const resolved = links.size > 0 ? resolveTarget(input["targetId"]) : undefined;
          const sessionId =
            typeof input["sessionId"] === "string"
              ? input["sessionId"]
              : resolved
                ? formatTargetId(resolved.link.slug, resolved.tabId)
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
          const resolved = links.size > 0 ? resolveTarget(input["targetId"]) : undefined;
          const sessionId =
            typeof input["sessionId"] === "string"
              ? input["sessionId"]
              : resolved
                ? formatTargetId(resolved.link.slug, resolved.tabId)
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
            targetId: formatTargetId(link.slug, t.tabId),
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
        activeTargetId: activeTab ? formatTargetId(activeTab.slug, activeTab.tabId) : null,
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
}
