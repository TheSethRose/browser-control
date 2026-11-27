/**
 * browser-control — executable browser/CDP primitives.
 *
 * The general operation is `execute_cdp`. Dedicated operations exist where a raw
 * protocol call is insufficient (binary artifacts, cross-call event state) or where
 * one call dominates real use and its raw form is costly to write and unwrap
 * (`evaluate`, `navigate`). Other browser procedures live in agent skills.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { CapabilityModule, OperationHandler } from "@agent-software/core";
import {
  CdpConnection,
  detectBrowsers,
  findBrowserPorts,
  type ConnectOptions,
  type PageTarget,
} from "./session";
import { createBackends } from "./backends/registry";
import { backendOrder, route } from "./backends/router";

/** The connection operations act on. */
let connection: CdpConnection | undefined;
/**
 * Live connections to other browsers. Switching browsers parks the current one instead of
 * closing it, so switching back needs no new "Allow" prompt and keeps its selected tab.
 */
let parked: CdpConnection[] = [];
let artifactDir = resolveArtifactDir();

function numericEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function resolveArtifactDir(): string {
  const configured = process.env["BROWSER_ARTIFACT_DIR"];
  return configured && configured.trim() !== ""
    ? resolvePath(configured)
    : resolvePath(join(tmpdir(), "browser-control"));
}

/** The user's preferred browser name: env first, then the one-line config file. */
async function preferredBrowser(): Promise<string | undefined> {
  const fromEnv = process.env["BROWSER_CONTROL_BROWSER"]?.trim();
  if (fromEnv) return fromEnv;
  const config = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  const text = await readFile(join(config, "browser-control", "default-browser"), "utf8").catch(() => "");
  return text.trim() || undefined;
}

function newConnection(): CdpConnection {
  return new CdpConnection({
    eventBufferSize: numericEnv("BROWSER_EVENT_BUFFER_SIZE") ?? 1000,
    defaultTimeoutMs: numericEnv("BROWSER_CDP_TIMEOUT_MS") ?? 5000,
    callTimeoutMs: numericEnv("BROWSER_CDP_CALL_TIMEOUT_MS") ?? 120_000,
  });
}

/** Lazily allocate the connection so direct operation calls also work. */
function getConnection(): CdpConnection {
  connection ??= newConnection();
  return connection;
}

/**
 * Connect, re-using a live connection whenever one already serves the request. A request
 * for a different browser parks the current connection rather than closing it.
 */
async function connectOrSwitch(opts: ConnectOptions) {
  const current = getConnection();
  if (!current.isConnected() || (opts.browser === undefined && opts.port === undefined)) {
    return current.connect(opts);
  }
  const ports = opts.browser !== undefined ? await findBrowserPorts(opts.browser) : [opts.port!];
  const serves = (c: CdpConnection) => c.isConnected() && ports.includes(c.getStatus().port ?? -1);
  if (serves(current)) return current.connect(opts);

  parked = parked.filter((c) => c.isConnected());
  const next = parked.find(serves) ?? newConnection();
  try {
    const result = await next.connect(opts);
    parked = [...parked.filter((c) => c !== next), current];
    connection = next;
    return result;
  } catch (error) {
    if (!parked.includes(next)) next.close();
    throw error;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function uniqueFile(prefix: string, extension: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(artifactDir, `${prefix}-${stamp}-${randomUUID().slice(0, 8)}.${extension}`);
}

/** Write to the caller's `path` when given, else to a unique file in the artifact dir. */
async function writeArtifact(
  path: string | undefined,
  prefix: string,
  extension: string,
  data: Buffer,
): Promise<string> {
  const fileName = path ? resolvePath(path) : uniqueFile(prefix, extension);
  try {
    await mkdir(dirname(fileName), { recursive: true });
    await writeFile(fileName, data);
  } catch (error) {
    throw new Error(`ARTIFACT_WRITE_FAILED: ${(error as Error).message} (${fileName})`);
  }
  return fileName;
}

/** Resolve an event filter's sessionId, attaching a target if one is named. */
async function eventSession(
  conn: CdpConnection,
  targetId: string | undefined,
  sessionId: string | undefined,
): Promise<string | undefined> {
  if (sessionId !== undefined) return sessionId;
  const target = targetId ?? conn.getActiveTargetId();
  return target === undefined ? undefined : conn.ensureSession(target);
}

export const initialize: NonNullable<CapabilityModule["initialize"]> = async () => {
  artifactDir = resolveArtifactDir();
  await mkdir(artifactDir, { recursive: true }).catch(() => {
    /* surfacing happens on the first artifact write */
  });
  getConnection();
  const order = backendOrder();
  for (const b of backends) {
    if (order.includes(b.name)) {
      await Promise.resolve(b.start?.()).catch(() => {
        /* unavailability surfaces cleanly on the first call / status */
      });
    }
  }
};

export const dispose: NonNullable<CapabilityModule["dispose"]> = async () => {
  for (const c of [connection, ...parked]) c?.close();
  connection = undefined;
  parked = [];
  for (const b of backends) await b.dispose?.();
};

/** The built-in DevTools (CDP) operations: default when unpaired, explicit by name, or opt-in fallback. */
const cdpOperations: Record<string, OperationHandler> = {
  list_browsers: async () => {
    const browsers = await detectBrowsers();
    return {
      browsers: browsers.map((b) => ({ name: b.name, port: b.port, pid: b.pid, profileDir: b.profileDir })),
    };
  },

  connect_browser: async (input) => {
    const opts: ConnectOptions = {};
    const wsUrl = str(input["wsUrl"]);
    const profileDir = str(input["profileDir"]);
    const port = num(input["port"]);
    if (wsUrl !== undefined) opts.wsUrl = wsUrl;
    if (profileDir !== undefined) opts.profileDir = profileDir;
    if (port !== undefined) opts.port = port;
    const host = str(input["host"]);
    if (host !== undefined) opts.host = host;
    const timeoutMs = num(input["timeoutMs"]);
    if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs;

    const browser = str(input["browser"]);
    const provided = [opts.wsUrl, opts.profileDir, opts.port, browser].filter((v) => v !== undefined).length;
    if (provided > 1) {
      throw new Error("INPUT_INVALID: provide only one of browser, wsUrl, profileDir, or port");
    }

    if (provided === 0) {
      const envWsUrl = process.env["BROWSER_CDP_WS_URL"];
      const envProfile = process.env["BROWSER_PROFILE_DIR"];
      if (envWsUrl) opts.wsUrl = envWsUrl;
      else if (envProfile) opts.profileDir = envProfile;
      // Keep an existing connection; the preference only picks where a new one goes.
      else if (!getConnection().isConnected()) opts.browser = await preferredBrowser();
    } else if (browser !== undefined) {
      opts.browser = browser;
    }
    if (opts.timeoutMs === undefined) opts.timeoutMs = numericEnv("BROWSER_CDP_TIMEOUT_MS");

    return connectOrSwitch(opts);
  },

  disconnect_browser: async () => {
    for (const c of [getConnection(), ...parked]) c.close();
    parked = [];
    return { connected: false };
  },

  get_browser_status: async () => {
    const others = parked.filter((c) => c.isConnected()).map((c) => c.getStatus().browser ?? "unknown");
    return { ...getConnection().getStatus(), ...(others.length > 0 ? { alsoConnected: others } : {}), artifactDir };
  },

  list_targets: async (input) => {
    const typesRaw = input["types"];
    const types = Array.isArray(typesRaw)
      ? typesRaw.filter((t): t is string => typeof t === "string")
      : undefined;
    const targets: PageTarget[] = await getConnection().listTargets({
      includeAll: input["includeAll"] === true,
      types,
    });
    return { targets };
  },

  select_target: async (input) => {
    const targetId = str(input["targetId"]);
    if (!targetId) throw new Error("INPUT_INVALID: targetId is required");
    return getConnection().use(targetId);
  },

  clear_target: async () => {
    getConnection().clearActive();
    return { activeTargetId: null, activeSessionId: null };
  },

  close_target: async () => {
    throw new Error("INPUT_INVALID: close_target is only available on extension tabs; on cdp use execute_cdp with Target.closeTarget");
  },

  execute_cdp: async (input) => {
    const method = str(input["method"]);
    if (!method) throw new Error("INPUT_INVALID: method is required");
    const params = obj(input["params"]) ?? {};
    const result = await getConnection().call(method, params, {
      sessionId: str(input["sessionId"]),
      targetId: str(input["targetId"]),
      timeoutMs: num(input["timeoutMs"]),
    });
    return { result };
  },

  evaluate: async (input) => {
    const expression = str(input["expression"]);
    if (!expression) throw new Error("INPUT_INVALID: expression is required");
    const conn = getConnection();
    const targetId = str(input["targetId"]);
    const timeoutMs = num(input["timeoutMs"]);
    const isolated = input["isolated"] === true;

    const runEval = async (contextId?: number) =>
      (await conn.call(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
          ...(contextId !== undefined ? { contextId } : { replMode: true }),
        },
        { targetId, timeoutMs },
      )) as {
        result?: { value?: unknown; unserializableValue?: string; description?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };

    let contextId: number | undefined;
    let reply: Awaited<ReturnType<typeof runEval>>;
    if (isolated) {
      contextId = await conn.getIsolatedContextId(targetId);
      try {
        reply = await runEval(contextId);
      } catch (err) {
        if (contextId !== undefined && /Cannot find context with specified id|Execution context was destroyed/i.test((err as Error).message)) {
          contextId = await conn.getIsolatedContextId(targetId, true);
          reply = await runEval(contextId);
        } else {
          throw err;
        }
      }
    } else {
      reply = await runEval(undefined);
    }

    const { result, exceptionDetails } = reply;
    if (exceptionDetails) {
      const detail = exceptionDetails.exception?.description ?? exceptionDetails.text ?? "unknown";
      throw new Error(`JS_EXCEPTION: ${detail.slice(0, 600)}`);
    }
    if (!result) return contextId !== undefined ? { contextId } : {};
    return {
      value: "value" in result ? result.value : (result.unserializableValue ?? result.description),
      ...(contextId !== undefined ? { contextId } : {}),
    };
  },

  navigate: async (input) => {
    const url = str(input["url"]);
    if (!url) throw new Error("INPUT_INVALID: url is required");
    const conn = getConnection();
    const targetId = str(input["targetId"]);
    await conn.call("Page.enable", {}, { targetId });
    const sessionId = await eventSession(conn, targetId, undefined);
    const until = str(input["until"]) ?? "load";
    if (until !== "load" && until !== "domcontentloaded") {
      throw new Error("INPUT_INVALID: until must be load or domcontentloaded");
    }
    const loadEvent = {
      method: until === "load" ? "Page.loadEventFired" : "Page.domContentEventFired",
      sessionId,
    };
    // Drop stale load events so only this navigation's can match.
    conn.readEvents(loadEvent, 0, true);
    const nav = (await conn.call("Page.navigate", { url }, { targetId })) as {
      frameId?: string;
      loaderId?: string;
      errorText?: string;
    };
    if (nav.errorText) throw new Error(`NAVIGATION_FAILED: ${nav.errorText} (${url})`);
    // No loaderId means a same-document navigation: no load event will fire.
    const loaded =
      !nav.loaderId ||
      (await conn.waitForEvent(loadEvent, num(input["timeoutMs"]) ?? 30_000, true)).found;
    return { loaded, frameId: nav.frameId };
  },

  capture_screenshot: async (input) => {
    const conn = getConnection();
    const format = input["format"] === "jpeg" ? "jpeg" : "png";
    const params: Record<string, unknown> = { format };
    const quality = num(input["quality"]);
    if (format === "jpeg" && quality !== undefined) params["quality"] = quality;
    if (input["fullPage"] === true) params["captureBeyondViewport"] = true;
    const clip = obj(input["clip"]);
    if (clip) params["clip"] = clip;

    const targetId = str(input["targetId"]);
    const result = await conn
      .call("Page.captureScreenshot", params, { targetId })
      .catch(async (error: Error) => {
        // Chrome can't capture beyond the viewport in a background tab ("Unable to capture
        // screenshot"). Resize the viewport to the page instead, capture, then restore it.
        if (input["fullPage"] !== true || clip || !/Unable to capture screenshot/.test(error.message)) throw error;
        const metrics = (await conn.call("Page.getLayoutMetrics", {}, { targetId })) as {
          cssContentSize?: { width: number; height: number };
        };
        const size = metrics.cssContentSize;
        if (!size) throw error;
        await conn.call(
          "Emulation.setDeviceMetricsOverride",
          {
            width: Math.ceil(size.width),
            height: Math.min(Math.ceil(size.height), 16_384),
            deviceScaleFactor: 1,
            mobile: false,
          },
          { targetId },
        );
        try {
          const { captureBeyondViewport: _, ...rest } = params;
          return await conn.call("Page.captureScreenshot", rest, { targetId });
        } finally {
          await conn.call("Emulation.clearDeviceMetricsOverride", {}, { targetId }).catch(() => {});
        }
      });
    const { data: b64 } = result as { data: string };
    const data = Buffer.from(b64, "base64");
    const extension = format === "jpeg" ? "jpg" : "png";
    const filePath = await writeArtifact(str(input["path"]), "screenshot", extension, data);

    const output: Record<string, unknown> = {
      path: filePath,
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      bytes: data.length,
      targetId: targetId ?? conn.getActiveTargetId() ?? null,
    };
    if (clip) {
      if (num(clip["width"]) !== undefined) output["width"] = clip["width"];
      if (num(clip["height"]) !== undefined) output["height"] = clip["height"];
    }
    return output;
  },

  capture_pdf: async (input) => {
    const conn = getConnection();
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
      const value = input[key];
      if (value !== undefined) params[key] = value;
    }
    const targetId = str(input["targetId"]);
    const result = (await conn.call("Page.printToPDF", params, { targetId })) as { data?: string };
    if (!result.data) {
      throw new Error("EXECUTION_FAILED: printToPDF returned no data (unexpected transferMode)");
    }
    const data = Buffer.from(result.data, "base64");
    const filePath = await writeArtifact(str(input["path"]), "page", "pdf", data);
    return {
      path: filePath,
      mimeType: "application/pdf",
      bytes: data.length,
      targetId: targetId ?? conn.getActiveTargetId() ?? null,
    };
  },

  read_events: async (input) => {
    const conn = getConnection();
    const sessionId = await eventSession(
      conn,
      str(input["targetId"]),
      str(input["sessionId"]),
    );
    const limit = num(input["limit"]) ?? 100;
    const result = conn.readEvents(
      { method: str(input["method"]), sessionId, sinceSeq: num(input["sinceSeq"]) },
      limit,
      input["clear"] !== false,
    );
    return result;
  },

  wait_for_event: async (input) => {
    const conn = getConnection();
    const method = str(input["method"]);
    if (!method) throw new Error("INPUT_INVALID: method is required");
    const sessionId = await eventSession(
      conn,
      str(input["targetId"]),
      str(input["sessionId"]),
    );
    return conn.waitForEvent(
      { method, match: obj(input["match"]), sessionId },
      num(input["timeoutMs"]) ?? 10_000,
      input["consumeBuffer"] !== false,
    );
  },
};

/** Extra backends (see `src/backends/`); CDP handles explicit requests and opt-in fallback orders. */
const backends = createBackends();

export const operations: Record<string, OperationHandler> = route(cdpOperations, backends);
