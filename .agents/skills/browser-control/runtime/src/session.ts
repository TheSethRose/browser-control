/**
 * Chromium browser discovery and one retained browser-level CDP WebSocket.
 *
 * The connection correlates JSON messages by id, injects `sessionId` for
 * target-scoped methods, and exempts browser-level methods. It holds:
 *  - the socket, pending calls, and the single active target route;
 *  - the bounded event buffer and any one-shot event waiters.
 *
 * `initialize()` allocates this object; `dispose()` closes it. No browser contact
 * happens until `connect()`.
 */

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventBuffer, eventMatches, type CdpEvent, type EventMatcher } from "./events";

export const WS_OPEN = 1;

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type ConnectOptions = {
  /** Full browser endpoint, e.g. ws://127.0.0.1:9222/devtools/browser/<uuid>. */
  wsUrl?: string;
  /** Profile dir containing DevToolsActivePort. */
  profileDir?: string;
  /** Explicit debugging port (probed via /json/version for the endpoint). */
  port?: number;
  /** Browser name ("chrome", "beta", "brave"). Found by its live port; opened if not running. */
  browser?: string;
  /** Host for the explicit port form. Default 127.0.0.1. */
  host?: string;
  /** Per-attempt socket-open timeout in ms. Default 5000. */
  timeoutMs?: number;
};

export type BrowserEndpoint = {
  name?: string;
  profileDir?: string;
  port?: number;
  wsUrl: string;
};

/** A running browser with a debugging port, found by its port file or its listening socket. */
export type DetectedBrowser = {
  name: string;
  port: number;
  /** Known only when the port file was readable; otherwise resolved from the port. */
  wsUrl?: string;
  profileDir?: string;
  mtimeMs?: number;
  pid?: number;
};

export type PageTarget = {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  openerId?: string;
};

export class CdpError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(`CDP ${code}: ${message}`);
    this.name = "CdpError";
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId?: string;
};

type Waiter = {
  matcher: EventMatcher;
  resolve: (event: CdpEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Chrome's code for "Session with given id not found". */
const SESSION_NOT_FOUND = -32001;

/** Browser-level methods never take a sessionId. */
export function isBrowserLevelMethod(method: string): boolean {
  return (
    method.startsWith("Browser.") ||
    method.startsWith("Target.") ||
    method.startsWith("Extensions.")
  );
}

/** CDP methods that kill or crash the user's browser or tab are blocked at the transport layer. */
export function isBlockedCdpMethod(method: string): boolean {
  return method === "Browser.close" || /^[A-Za-z0-9_]+\.crash/i.test(method);
}

/** Parse both lines of DevToolsActivePort (port, then WS path). */
export function parseDevToolsActivePort(text: string): { port: number; path: string } | undefined {
  const [portLine, pathLine] = text.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isFinite(port) || port <= 0) return undefined;
  if (!pathLine || !pathLine.startsWith("/devtools/")) return undefined;
  return { port, path: pathLine };
}

type BrowserCandidate = { name: string; profileDir: string };

/** OS-specific user-data dirs for Chromium-based browsers. */
export function getBrowserCandidates(
  platform: string = process.platform,
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): BrowserCandidate[] {
  const list: BrowserCandidate[] = [];
  const push = (name: string, profileDir: string) => list.push({ name, profileDir });

  if (platform === "darwin") {
    const base = `${home}/Library/Application Support`;
    push("Google Chrome", `${base}/Google/Chrome`);
    push("Google Chrome Beta", `${base}/Google/Chrome Beta`);
    push("Google Chrome Dev", `${base}/Google/Chrome Dev`);
    push("Chromium", `${base}/Chromium`);
    push("Microsoft Edge", `${base}/Microsoft Edge`);
    push("Brave", `${base}/BraveSoftware/Brave-Browser`);
    push("Arc", `${base}/Arc/User Data`);
    push("Vivaldi", `${base}/Vivaldi`);
    push("Opera", `${base}/com.operasoftware.Opera`);
    push("Comet", `${base}/Comet`);
    push("Ardia", `${base}/Ardia`);
    push("Google Chrome Canary", `${base}/Google/Chrome Canary`);
  } else if (platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? `${home}\\AppData\\Local`;
    push("Google Chrome", `${local}\\Google\\Chrome\\User Data`);
    push("Google Chrome Beta", `${local}\\Google\\Chrome Beta\\User Data`);
    push("Chromium", `${local}\\Chromium\\User Data`);
    push("Microsoft Edge", `${local}\\Microsoft\\Edge\\User Data`);
    push("Brave", `${local}\\BraveSoftware\\Brave-Browser\\User Data`);
    push("Arc", `${local}\\Arc\\User Data`);
    push("Vivaldi", `${local}\\Vivaldi\\User Data`);
    push("Opera", `${local}\\Opera Software\\Opera Stable`);
    push("Google Chrome Canary", `${local}\\Google\\Chrome SxS\\User Data`);
  } else {
    const cfg = `${home}/.config`;
    push("Google Chrome", `${cfg}/google-chrome`);
    push("Google Chrome Beta", `${cfg}/google-chrome-beta`);
    push("Chromium", `${cfg}/chromium`);
    push("Microsoft Edge", `${cfg}/microsoft-edge`);
    push("Brave", `${cfg}/BraveSoftware/Brave-Browser`);
    push("Vivaldi", `${cfg}/vivaldi`);
    push("Opera", `${cfg}/opera`);
    push("Ardia", `${cfg}/ardia`);
    push("Google Chrome Canary", `${cfg}/google-chrome-unstable`);
  }
  return list;
}

/** Read and parse a profile's DevToolsActivePort once. Returns undefined if absent/malformed. */
export async function tryReadDevToolsActivePort(
  profileDir: string,
): Promise<{ port: number; path: string; mtimeMs: number } | undefined> {
  try {
    const filePath = join(profileDir, "DevToolsActivePort");
    const [text, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    const parsed = parseDevToolsActivePort(text);
    if (!parsed) return undefined;
    return { ...parsed, mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

/** Poll DevToolsActivePort until parseable or the deadline passes. */
export async function readDevToolsActivePort(
  profileDir: string,
  deadlineMs = 30_000,
): Promise<{ port: number; path: string }> {
  const deadline = Date.now() + deadlineMs;
  let lastErr = "not found";
  while (Date.now() < deadline) {
    const parsed = await tryReadDevToolsActivePort(profileDir);
    if (parsed) return { port: parsed.port, path: parsed.path };
    lastErr = `could not parse ${join(profileDir, "DevToolsActivePort")}`;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `INPUT_INVALID: ${lastErr} after ${deadlineMs}ms. Enable remote debugging in that browser.`,
  );
}

const CHROMIUM_NAME = /chrom|edge|brave|vivaldi|opera|comet|helium|ardia|\barc\b|\bdia\b/i;

/** Loopback TCP listeners from `lsof -nP -iTCP -sTCP:LISTEN -Fpn` output. */
export function parseLsofListeners(text: string): Array<{ pid: number; port: number }> {
  const listeners: Array<{ pid: number; port: number }> = [];
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    const port = /^n(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)$/.exec(line)?.[1];
    if (port && pid > 0) listeners.push({ pid, port: Number(port) });
  }
  return listeners;
}

/** Browser name from a process command line, or undefined for helpers and non-browsers. */
export function browserNameFromCommand(command: string): string | undefined {
  if (command.includes(" --type=")) return undefined;
  const name =
    /\/([^/]+)\.app\/Contents\/MacOS\/\1(?: |$)/.exec(command)?.[1] ??
    command.split(" ")[0]!.split("/").pop()!;
  return CHROMIUM_NAME.test(name) && !/helper|crashpad/i.test(name) ? name : undefined;
}

/** Run a read-only system command; any failure yields whatever stdout there was. */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (_error, stdout) => resolve(String(stdout ?? "")));
  });
}

/**
 * Browsers found by asking the OS which Chromium processes listen on loopback. Needs no
 * access to the profile folder (macOS privacy often blocks it) and always reports the
 * live port, which changes whenever the browser restarts.
 */
async function detectListeningBrowsers(): Promise<DetectedBrowser[]> {
  if (process.platform === "win32") return [];
  const listeners = parseLsofListeners(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]));
  if (listeners.length === 0) return [];
  const pids = [...new Set(listeners.map((l) => l.pid))];
  const commands = new Map<number, string>();
  for (const line of (await run("ps", ["-o", "pid=,command=", "-p", pids.join(",")])).split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2]!);
  }
  const detected: DetectedBrowser[] = [];
  for (const { pid, port } of listeners) {
    const name = browserNameFromCommand(commands.get(pid) ?? "");
    if (name) detected.push({ name, port, pid });
  }
  return detected;
}

/** Running Chromium browsers with remote debugging: readable port files first, newest first. */
export async function detectBrowsers(): Promise<DetectedBrowser[]> {
  const detected: DetectedBrowser[] = [];
  for (const candidate of getBrowserCandidates()) {
    const parsed = await tryReadDevToolsActivePort(candidate.profileDir);
    if (!parsed) continue;
    detected.push({
      name: candidate.name,
      profileDir: candidate.profileDir,
      port: parsed.port,
      wsUrl: `ws://127.0.0.1:${parsed.port}${parsed.path}`,
      mtimeMs: parsed.mtimeMs,
    });
  }
  detected.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  const listening = await detectListeningBrowsers();
  // A port file can be stale after a restart; a live listener is the truth.
  const live = new Set(listening.map((b) => b.port));
  const fromFiles = listening.length > 0 ? detected.filter((b) => live.has(b.port)) : detected;
  const known = new Set(fromFiles.map((b) => b.port));
  return [...fromFiles, ...listening.filter((b) => !known.has(b.port))];
}

/** Match a short name ("chrome", "beta") against browser names: exact first, then substring. */
export function matchBrowser<T extends { name: string }>(query: string, browsers: T[]): T[] {
  const q = query.trim().toLowerCase();
  const exact = browsers.filter((b) => {
    const name = b.name.toLowerCase();
    return name === q || name.replace(/^(google|microsoft) /, "") === q;
  });
  return exact.length > 0 ? exact : browsers.filter((b) => b.name.toLowerCase().includes(q));
}

/** Debugging ports of the running browsers that match a name. */
export async function findBrowserPorts(query: string): Promise<number[]> {
  return matchBrowser(query, await detectBrowsers()).map((b) => b.port);
}

/** Open the named browser (macOS) and wait for its debugging port to appear. */
async function launchAndDetect(query: string, waitMs = 15_000): Promise<DetectedBrowser[]> {
  const app = matchBrowser(query, getBrowserCandidates())[0]?.name;
  if (!app) throw new Error(`INPUT_INVALID: no known browser matches "${query}"`);
  if (process.platform === "darwin") await run("open", ["-g", "-a", app]);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const found = matchBrowser(query, await detectBrowsers());
    if (found.length > 0) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `NOT_CONNECTED: ${app} is not exposing remote debugging. In ${app}, open chrome://inspect/#remote-debugging and tick "Allow remote debugging for this browser instance" (it stays on across restarts), then retry.`,
  );
}

/** Resolve an explicit endpoint. Auto-detect is `connect()` with no options. */
export async function resolveWsUrl(opts: ConnectOptions): Promise<string> {
  if (opts.wsUrl) return opts.wsUrl;
  if (opts.profileDir) {
    const { port, path } = await readDevToolsActivePort(opts.profileDir);
    return `ws://127.0.0.1:${port}${path}`;
  }
  if (opts.port !== undefined) {
    const host = opts.host ?? "127.0.0.1";
    const url = `http://${host}:${opts.port}/json/version`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new Error(
        `INPUT_INVALID: could not read ${url} for the explicit port form: ${(error as Error).message}`,
      );
    }
    if (response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        | { webSocketDebuggerUrl?: string }
        | undefined;
      if (payload?.webSocketDebuggerUrl) return payload.webSocketDebuggerUrl;
    }
    // The port is reachable but exposes no /json/version discovery. This is the
    // shape of Chrome's user-enabled remote-debugging server
    // (chrome://inspect#remote-debugging), which serves a raw WebSocket at
    // /devtools/browser. Chrome started with --remote-debugging-port returns the
    // webSocketDebuggerUrl above instead.
    return `ws://${host}:${opts.port}/devtools/browser`;
  }
  throw new Error("INPUT_INVALID: resolveWsUrl needs wsUrl, profileDir, or port");
}

export type ConnectionStatus = {
  connected: boolean;
  browser?: string;
  port?: number;
  wsUrl?: string;
  browserVersion?: string;
  activeTargetId?: string;
  activeSessionId?: string;
  eventsBuffered: number;
};

export class CdpConnection {
  private ws?: WebSocketLike;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private waiters: Waiter[] = [];
  private activeTargetId?: string;
  private sessionByTarget = new Map<string, string>();
  private crashedTargets = new Set<string>();
  private isolatedContextByTarget = new Map<string, number>();
  private inspectorEnabledTargets = new Set<string>();
  private via?: BrowserEndpoint;
  private browserVersion?: string;
  private readonly createWebSocket: WebSocketFactory;
  private readonly defaultTimeoutMs: number;
  private readonly callTimeoutMs: number;

  readonly events: EventBuffer;

  constructor(opts?: {
    eventBufferSize?: number;
    /** Socket-open timeout. Default 5000. */
    defaultTimeoutMs?: number;
    /** Per-call reply timeout when a call gives none. Default 120000. */
    callTimeoutMs?: number;
    createWebSocket?: WebSocketFactory;
  }) {
    this.events = new EventBuffer(opts?.eventBufferSize ?? 1000);
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? 5000;
    this.callTimeoutMs = opts?.callTimeoutMs ?? 120_000;
    this.createWebSocket =
      opts?.createWebSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  getStatus(): ConnectionStatus {
    return {
      connected: this.isConnected(),
      browser: this.via?.name,
      port: this.via?.port,
      wsUrl: this.via?.wsUrl,
      browserVersion: this.browserVersion,
      activeTargetId: this.activeTargetId,
      activeSessionId: this.activeTargetId && this.sessionByTarget.get(this.activeTargetId),
      eventsBuffered: this.events.size,
    };
  }

  getActiveTargetId(): string | undefined {
    return this.activeTargetId;
  }

  /**
   * Open and retain the browser-level socket. An explicit endpoint (wsUrl, profileDir,
   * port) is used as given. Otherwise running browsers are detected by their live port:
   * `browser` picks one by name and opens it when it is not running; with no options the
   * current connection is kept, else the first detected browser that accepts is used.
   */
  async connect(opts: ConnectOptions = {}): Promise<{ connected: true; via: BrowserEndpoint; browserVersion?: string }> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const current = () => ({ connected: true as const, via: this.via!, browserVersion: this.browserVersion });

    if (opts.wsUrl !== undefined || opts.profileDir !== undefined || opts.port !== undefined) {
      const resolved = await resolveWsUrl(opts);
      if (!this.isConnected() || resolved !== this.via?.wsUrl) {
        this.close();
        await this.open({ profileDir: opts.profileDir, port: opts.port, wsUrl: resolved }, timeoutMs);
      }
      return current();
    }
    if (!opts.browser && this.isConnected()) return current();

    let browsers = await detectBrowsers();
    if (opts.browser) {
      browsers = matchBrowser(opts.browser, browsers);
      if (browsers.length === 0) browsers = await launchAndDetect(opts.browser);
      if (this.isConnected() && browsers.some((b) => b.port === this.via?.port)) return current();
    }
    if (browsers.length === 0) {
      throw new Error(
        `NOT_CONNECTED: no running browser with remote debugging detected. Open chrome://inspect/#remote-debugging and tick "Allow remote debugging for this browser instance", or name a browser to open it.`,
      );
    }
    this.close();
    const errors: string[] = [];
    for (const browser of browsers) {
      try {
        const wsUrl = browser.wsUrl ?? (await resolveWsUrl({ port: browser.port }));
        await this.open({ name: browser.name, port: browser.port, wsUrl }, timeoutMs);
        return current();
      } catch (error) {
        errors.push(`  ${browser.name} on port ${browser.port}: ${(error as Error).message}`);
      }
    }
    throw new Error(`NOT_CONNECTED: no detected browser accepted a connection.\n${errors.join("\n")}`);
  }

  private open(via: BrowserEndpoint, timeoutMs: number): Promise<void> {
    const { wsUrl } = via;
    return new Promise<void>((resolve, reject) => {
      const ws = this.createWebSocket(wsUrl);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          if (this.ws === ws) this.ws = undefined;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(error);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `NOT_CONNECTED: timed out after ${timeoutMs}ms opening ${wsUrl}. If Chrome is showing an Allow prompt, click it and retry with a larger timeoutMs.`,
            ),
          ),
        timeoutMs,
      );
      ws.addEventListener("open", () => finish());
      ws.addEventListener("error", (event: any) =>
        finish(
          new Error(
            `NOT_CONNECTED: WebSocket error opening ${wsUrl}: ${event?.message ?? "connection refused, port closed, or permission denied (403)"}`,
          ),
        ),
      );
      ws.addEventListener("message", (event: any) => this.onMessage(String(event.data)));
      ws.addEventListener("close", () => {
        // A replaced socket closing late must not disturb the current one.
        if (this.ws === ws) this.close();
        finish(new Error("NOT_CONNECTED: socket closed before open"));
      });
      this.ws = ws;
    }).then(async () => {
      this.via = via;
      try {
        const version = (await this.call("Browser.getVersion")) as { product?: string };
        this.browserVersion = version?.product;
      } catch {
        /* version is informational */
      }
    });
  }

  close(): void {
    this.failPending("NOT_CONNECTED: CDP socket closed");
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("NOT_CONNECTED: CDP socket closed"));
    }
    this.waiters = [];
    const ws = this.ws;
    this.ws = undefined;
    this.via = undefined;
    this.browserVersion = undefined;
    this.activeTargetId = undefined;
    this.sessionByTarget.clear();
    this.crashedTargets.clear();
    this.isolatedContextByTarget.clear();
    this.inspectorEnabledTargets.clear();
    this.events.clear();
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }

  /** Attach to a target (flattened) and make it the active route. Idempotent per target. */
  async use(targetId: string): Promise<{ targetId: string; sessionId: string }> {
    const sessionId = await this.ensureSession(targetId);
    this.activeTargetId = targetId;
    return { targetId, sessionId };
  }

  clearActive(): void {
    this.activeTargetId = undefined;
  }

  /** Return (or lazily create) a cached isolated world executionContextId for a target. */
  async getIsolatedContextId(targetId?: string, forceFresh = false): Promise<number | undefined> {
    const tid = targetId ?? this.activeTargetId;
    if (!tid) return undefined;
    if (!forceFresh) {
      const existing = this.isolatedContextByTarget.get(tid);
      if (existing !== undefined) return existing;
    }
    this.isolatedContextByTarget.delete(tid);
    // Lazily enable Inspector once per target so Inspector.targetCrashed arrives promptly.
    if (!this.inspectorEnabledTargets.has(tid)) {
      this.inspectorEnabledTargets.add(tid);
      await this.call("Inspector.enable", {}, { targetId: tid, timeoutMs: 2000 }).catch(() => {});
    }
    try {
      const tree = (await this.call("Page.getFrameTree", {}, { targetId: tid, timeoutMs: 5000 })) as {
        frameTree?: { frame?: { id?: string } };
      };
      const frameId = tree?.frameTree?.frame?.id;
      if (!frameId) return undefined;
      const world = (await this.call(
        "Page.createIsolatedWorld",
        { frameId, worldName: "browser-control", grantUniveralAccess: true },
        { targetId: tid, timeoutMs: 5000 },
      )) as { executionContextId?: number };
      if (typeof world?.executionContextId === "number") {
        this.isolatedContextByTarget.set(tid, world.executionContextId);
        return world.executionContextId;
      }
    } catch {
      /* target may not support Page.createIsolatedWorld (e.g. worker) */
    }
    return undefined;
  }

  /** Clear cached isolated world context for a target (e.g. after navigation or context destruction). */
  clearIsolatedContext(targetId?: string): void {
    const tid = targetId ?? this.activeTargetId;
    if (tid) this.isolatedContextByTarget.delete(tid);
  }

  /** Attach to a target without changing the active route. */
  async ensureSession(targetId: string): Promise<string> {
    const existing = this.sessionByTarget.get(targetId);
    if (existing) return existing;
    const result = (await this.call("Target.attachToTarget", { targetId, flatten: true })) as {
      sessionId: string;
    };
    this.sessionByTarget.set(targetId, result.sessionId);
    return result.sessionId;
  }

  async listTargets(opts: { includeAll?: boolean; types?: string[] } = {}): Promise<PageTarget[]> {
    const { targetInfos } = (await this.call("Target.getTargets", {})) as {
      targetInfos: Array<{
        targetId: string;
        type: string;
        title: string;
        url: string;
        attached: boolean;
        openerId?: string;
      }>;
    };
    let targets: PageTarget[] = targetInfos.map((t) => ({
      targetId: t.targetId,
      type: t.type,
      title: t.title,
      url: t.url,
      attached: t.attached,
      openerId: t.openerId,
    }));
    if (!opts.includeAll) {
      targets = targets.filter(
        (t) => !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://"),
      );
    }
    if (opts.types && opts.types.length > 0) {
      const allowed = new Set(opts.types);
      targets = targets.filter((t) => allowed.has(t.type));
    }
    return targets;
  }

  /**
   * Call any CDP method and return the raw result. Routing:
   * explicit sessionId > browser-level exemption > explicit targetId > active route.
   * A session Chrome has dropped (tab swapped or re-created) is re-attached once.
   */
  async call(
    method: string,
    params: unknown = {},
    opts: { sessionId?: string; targetId?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (isBlockedCdpMethod(method)) {
      throw new Error(`REFUSED: ${method} is blocked so browser-control never closes or crashes the user's browser`);
    }
    if (!this.isConnected()) throw new Error("NOT_CONNECTED: call connect_browser first");
    const timeoutMs = opts.timeoutMs ?? this.callTimeoutMs;
    if (opts.sessionId !== undefined || isBrowserLevelMethod(method)) {
      return this.send(method, params, opts.sessionId, timeoutMs);
    }
    const targetId = opts.targetId ?? this.activeTargetId;
    if (targetId === undefined) {
      throw new Error(`NO_ACTIVE_TARGET: ${method} needs a target; call select_target first`);
    }
    if (this.crashedTargets.has(targetId)) {
      if (method === "Page.reload" || method === "Page.navigate") {
        this.crashedTargets.delete(targetId);
      } else {
        throw new Error(`TAB_CRASHED: tab ${targetId} renderer crashed; reload it (nav <url>) or pick another tab`);
      }
    }
    try {
      return await this.send(method, params, await this.attach(targetId), timeoutMs);
    } catch (error) {
      if (!(error instanceof CdpError) || error.code !== SESSION_NOT_FOUND) throw error;
      this.sessionByTarget.delete(targetId);
      return this.send(method, params, await this.attach(targetId), timeoutMs);
    }
  }

  /** ensureSession, with a clear error when the tab no longer exists. */
  private async attach(targetId: string): Promise<string> {
    try {
      return await this.ensureSession(targetId);
    } catch (error) {
      if (!(error instanceof CdpError)) throw error;
      if (targetId === this.activeTargetId) this.activeTargetId = undefined;
      throw new Error(`NO_ACTIVE_TARGET: tab ${targetId} is gone (${error.message}); list tabs and select one`);
    }
  }

  private send(
    method: string,
    params: unknown,
    sessionId: string | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const ws = this.ws;
    if (!ws || !this.isConnected()) {
      return Promise.reject(new Error("NOT_CONNECTED: call connect_browser first"));
    }
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params: params ?? {} };
    if (sessionId !== undefined) message["sessionId"] = sessionId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP_TIMEOUT: ${method} did not respond within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, sessionId });
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  readEvents(
    filter: { method?: string; sessionId?: string; sinceSeq?: number },
    limit: number,
    clear: boolean,
  ): { events: CdpEvent[]; nextSeq: number; dropped: number } {
    const dropped = this.events.droppedCount;
    const events = this.events.filter(filter, limit);
    if (clear && events.length > 0) {
      this.events.remove(events);
      if (this.events.size === 0) this.events.resetDropped();
    }
    return { events, nextSeq: this.events.nextSeq, dropped };
  }

  /**
   * Resolve on the next matching event, or time out as a normal result.
   * When `consumeBuffer` is true, a matching buffered event is returned immediately.
   */
  waitForEvent(
    matcher: EventMatcher,
    timeoutMs: number,
    consumeBuffer: boolean,
  ): Promise<{ found: true; event: CdpEvent } | { found: false; timedOut: true; waitedMs: number }> {
    if (!this.isConnected()) {
      return Promise.reject(new Error("NOT_CONNECTED: call connect_browser first"));
    }
    if (consumeBuffer) {
      const buffered = this.events.take(matcher, true);
      if (buffered) return Promise.resolve({ found: true, event: buffered });
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        reject,
        matcher,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve({ found: false, timedOut: true, waitedMs: timeoutMs });
        }, timeoutMs),
        resolve: (event) => resolve({ found: true, event }),
      };
      this.waiters.push(waiter);
    });
  }

  private failPending(message: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private onMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new CdpError(message.error.code, message.error.message, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      const event = this.events.push(message.method, message.params ?? {}, message.sessionId);
      if (message.method === "Target.detachedFromTarget") {
        for (const [targetId, sessionId] of this.sessionByTarget) {
          if (sessionId === message.params?.sessionId) {
            this.sessionByTarget.delete(targetId);
            this.crashedTargets.delete(targetId);
            this.isolatedContextByTarget.delete(targetId);
            this.inspectorEnabledTargets.delete(targetId);
          }
        }
      }
      if (message.method === "Page.frameNavigated" && !message.params?.frame?.parentId && typeof message.sessionId === "string") {
        for (const [targetId, sid] of this.sessionByTarget) {
          if (sid === message.sessionId) this.isolatedContextByTarget.delete(targetId);
        }
      }
      if (message.method === "Runtime.executionContextDestroyed" && typeof message.params?.executionContextId === "number") {
        for (const [targetId, ctxId] of this.isolatedContextByTarget) {
          if (ctxId === message.params.executionContextId) this.isolatedContextByTarget.delete(targetId);
        }
      }
      if (message.method === "Inspector.targetCrashed" && typeof message.sessionId === "string") {
        const crashedSid = message.sessionId;
        let crashedTarget = "";
        for (const [targetId, sid] of this.sessionByTarget) {
          if (sid === crashedSid) {
            crashedTarget = targetId;
            this.crashedTargets.add(targetId);
          }
        }
        const msg = `TAB_CRASHED: tab ${crashedTarget || crashedSid} renderer crashed; reload it (nav <url>) or pick another tab`;
        for (const [id, pending] of this.pending) {
          if (pending.sessionId === crashedSid) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(new Error(msg));
          }
        }
      }
      if (message.method === "Inspector.targetReloadedAfterCrash" && typeof message.sessionId === "string") {
        for (const [targetId, sid] of this.sessionByTarget) {
          if (sid === message.sessionId) this.crashedTargets.delete(targetId);
        }
      }
      for (const waiter of this.waiters) {
        if (eventMatches(event, waiter.matcher)) {
          clearTimeout(waiter.timer);
          this.waiters = this.waiters.filter((w) => w !== waiter);
          waiter.resolve(event);
          break;
        }
      }
    }
  }
}
