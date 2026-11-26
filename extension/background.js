// Browser Control Companion — MV3 background service worker.
// Two-tier local-only relay (127.0.0.1, ports 49222-49229):
//   1. Silent tier (no yellow banner): chrome.tabs + chrome.scripting (ISOLATED world) for __bc reads.
//   2. Full CDP tier (on-demand): chrome.debugger per tab, auto-detached after 30s idle.
//
// Keepalive (`chrome.runtime.getPlatformInfo`) and mutual HMAC handshake patterns adapted from
// anomalyco/browse (MIT License).

import {
  PROTOCOL_VERSION,
  detectBrowserBrand,
  extProofMessage,
  getOrCreateProfileId,
  hmacHex,
  isValidNonceHex,
  randomNonceHex,
  relayProofMessage,
  verifyHmacHex,
} from "./lib/pairing.js";

const DEFAULT_PORT = 49222;
const PORT_RANGE_START = 49222;
const PORT_RANGE_END = 49229;
const VERSION_PROBE_TIMEOUT_MS = 800;
const DEBUGGER_IDLE_MS = 30_000;
const KEEPALIVE_MS = 20_000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const PAGE_HELPERS_FILE = "page-helpers.js";
const PAGE_HELPERS_VERSION = 7;

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_IDLE_CAP_MS = 15_000;
const WAITING = "Waiting for relay";

let config = { port: DEFAULT_PORT, token: "", mode: "all" }; // mode: "all" | "lent"
let lastError = "";
const lentTabs = new Set();
const agentTabs = new Set();
const attachedTabs = new Map(); // tabId -> { timer, holdUntil?, isolatedContextId? }
const connections = new Map(); // port -> { port, ws, state, extNonce, instanceId, keepaliveTimer, touchedTabs }

let scanTimer = null;
let scanning = false;
let backoffMs = BACKOFF_MIN_MS;
let cachedProfileId = null;

function connectedPorts() {
  const ports = [];
  for (const [port, entry] of connections) {
    if (entry.state === "ready" && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
      ports.push(port);
    }
  }
  return ports.sort((a, b) => a - b);
}

function isAnyConnected() {
  return connectedPorts().length > 0;
}

function nextBackoff() {
  const ms = backoffMs;
  backoffMs = Math.min(Math.round(backoffMs * 2), BACKOFF_IDLE_CAP_MS);
  return ms;
}

function candidatePorts() {
  const ports = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) ports.push(p);
  if (
    Number.isInteger(config.port) &&
    config.port > 0 &&
    config.port <= 65535 &&
    !ports.includes(config.port)
  ) {
    ports.unshift(config.port);
  }
  return ports;
}

// A missing relay is normal. Chrome lists every refused WebSocket on chrome://extensions,
// so probe /version with a caught fetch first and open a WebSocket only when app === "browser-control".
async function probeVersion(port) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/version`, {
      cache: "no-store",
      signal: AbortSignal.timeout(VERSION_PROBE_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data && data.app === "browser-control") return data;
    return null;
  } catch {
    return null;
  }
}

function isBlockedCdp(method) {
  return method === "Browser.close" || /^[A-Za-z0-9_]+\.crash/i.test(String(method || ""));
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(["port", "token", "mode"]);
  let fileCfg = null;
  try {
    const resp = await fetch(chrome.runtime.getURL("pairing.json"));
    if (resp.ok) fileCfg = await resp.json();
  } catch {
    /* Store build or setup not yet run */
  }
  // pairing.json wins: `extension setup` rewrites it, so a rotated token must beat a stale stored one.
  config = {
    port: Number(fileCfg?.port || stored.port || DEFAULT_PORT),
    token: String(fileCfg?.token || stored.token || "").trim(),
    mode: stored.mode === "lent" ? "lent" : "all",
  };
  return config;
}

// Tab ids are reused after a browser restart, so lent and agent tabs live in session storage only.
async function loadTabSets() {
  const stored = await chrome.storage.session.get(["lentTabs", "agentTabs"]);
  for (const id of stored.lentTabs || []) lentTabs.add(Number(id));
  for (const id of stored.agentTabs || []) agentTabs.add(Number(id));
}
const tabSetsReady = loadTabSets().catch(() => {});

async function saveTabSets() {
  await chrome.storage.session.set({ lentTabs: [...lentTabs], agentTabs: [...agentTabs] });
}

function scriptTarget(tabId, frameId) {
  return typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId };
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`EXECUTION_FAILED: ${what} got no answer in ${ms} ms (a JavaScript dialog may be blocking the page)`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function scriptingError(err, tabId) {
  const text = String(err?.message || err);
  if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\/|error page/i.test(text)) {
    return new Error(`RESTRICTED_PAGE: the extension cannot run on tab ${tabId} (${text}); use a DevTools (cdp) tab for it`);
  }
  return err instanceof Error ? err : new Error(text);
}

function tabAllowed(tabId) {
  if (config.mode === "all") return true;
  return lentTabs.has(tabId) || agentTabs.has(tabId);
}

function updateBadge() {
  if (attachedTabs.size > 0) {
    chrome.action.setBadgeText({ text: String(attachedTabs.size) });
    chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  } else if (isAnyConnected()) {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function touchDebuggerTimer(tabId) {
  const entry = attachedTabs.get(tabId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  // A hold (long wait_for_event, perf trace, flow record) keeps the debugger attached past the idle limit.
  const ms = Math.max(DEBUGGER_IDLE_MS, (entry.holdUntil || 0) - Date.now());
  entry.timer = setTimeout(() => {
    detachTab(tabId).catch(() => {});
  }, ms);
}

async function ensureAttached(tabId) {
  if (!tabAllowed(tabId)) {
    throw new Error(`REFUSED: tab ${tabId} is not lent to Browser Control (click the extension icon to lend it or switch to All tabs)`);
  }
  if (attachedTabs.has(tabId)) {
    touchDebuggerTimer(tabId);
    return attachedTabs.get(tabId);
  }
  await chrome.debugger.attach({ tabId }, "1.3");
  const entry = { timer: null, isolatedContextId: undefined };
  attachedTabs.set(tabId, entry);
  // Keep background tabs unthrottled while debugger is attached.
  await chrome.debugger
    .sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true })
    .catch(() => {});
  touchDebuggerTimer(tabId);
  updateBadge();
  return entry;
}

async function detachTab(tabId) {
  const entry = attachedTabs.get(tabId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already detached */
  }
  updateBadge();
}

async function detachAll() {
  for (const tabId of [...attachedTabs.keys()]) {
    await detachTab(tabId);
  }
}

// Silent Tier: run __bc v7 methods in Chrome's ISOLATED content-script world (no yellow debugger banner).
async function runBcSilent(tabId, steps, opts = {}) {
  if (!tabAllowed(tabId)) {
    throw new Error(`REFUSED: tab ${tabId} is not lent to Browser Control`);
  }
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30_000;
  try {
    return await withTimeout(runBcSteps(tabId, steps, opts.frameId), timeoutMs, `tab ${tabId}`);
  } catch (err) {
    throw scriptingError(err, tabId);
  }
}

async function runBcSteps(tabId, steps, frameId) {
  const target = scriptTarget(tabId, frameId);
  const probe = await chrome.scripting.executeScript({
    target,
    world: "ISOLATED",
    func: (v) => Boolean(globalThis.__bc && globalThis.__bc.v === v),
    args: [PAGE_HELPERS_VERSION],
  });
  if (!probe?.[0]?.result) {
    await chrome.scripting.executeScript({
      target,
      world: "ISOLATED",
      files: [PAGE_HELPERS_FILE],
    });
  }
  const exec = await chrome.scripting.executeScript({
    target,
    world: "ISOLATED",
    func: async (stepList) => {
      try {
        const bc = globalThis.__bc;
        if (!bc) return { ok: false, error: "INTERNAL: __bc failed to install" };
        const out = [];
        for (const s of stepList) {
          if (s.kind === "href") {
            out.push(location.href);
          } else if (s.kind === "readyState") {
            out.push(document.readyState);
          } else if (s.kind === "origin") {
            out.push(location.origin);
          } else if (s.kind === "host") {
            out.push(location.host);
          } else if (s.kind === "title") {
            out.push(document.title);
          } else if (s.kind === "bc") {
            const fn = bc[s.method];
            if (typeof fn !== "function") return { ok: false, error: `INPUT_INVALID: unknown __bc.${s.method}` };
            out.push(await fn(...(s.args || [])));
          }
        }
        return { ok: true, values: out };
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
    },
    args: [steps],
  });
  const payload = exec?.[0]?.result;
  if (!payload) throw new Error("EXECUTION_FAILED: scripting returned no result");
  if (!payload.ok) throw new Error(payload.error || "EXECUTION_FAILED: __bc step failed");
  return payload.values;
}

// Bridge a ref from the silent ISOLATED world to a CDP nodeId/objectId for upload and styles.
async function resolveBcNode(tabId, refOrSelector) {
  if (!tabAllowed(tabId)) throw new Error(`REFUSED: tab ${tabId} is not lent to Browser Control`);
  const marker = `bc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const stamped = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (ref, tok) => {
      try {
        const el = /^@?e\d+$/.test(ref) ? globalThis.__bc?.el(ref) : document.querySelector(ref);
        if (!el || !el.isConnected) return { ok: false, error: `STALE_REF: ${ref} not found` };
        el.setAttribute("data-bc-resolve", tok);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
    },
    args: [String(refOrSelector), marker],
  });
  const res = stamped?.[0]?.result;
  if (!res?.ok) throw new Error(res?.error || `NO_MATCH: could not resolve ${refOrSelector}`);
  try {
    await ensureAttached(tabId);
    const doc = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: 1 });
    const rootId = doc?.root?.nodeId;
    if (!rootId) throw new Error("EXECUTION_FAILED: DOM.getDocument returned no root");
    const q = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
      nodeId: rootId,
      selector: `[data-bc-resolve="${marker}"]`,
    });
    if (!q?.nodeId) throw new Error(`NO_MATCH: CDP could not locate ${refOrSelector}`);
    const resolved = await chrome.debugger.sendCommand({ tabId }, "DOM.resolveNode", { nodeId: q.nodeId });
    return { nodeId: q.nodeId, objectId: resolved?.object?.objectId };
  } finally {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: (tok) => {
        const el = document.querySelector(`[data-bc-resolve="${tok}"]`);
        if (el) el.removeAttribute("data-bc-resolve");
      },
      args: [marker],
    }).catch(() => {});
  }
}

async function getIsolatedContextForDebugger(tabId, forceFresh = false) {
  const entry = await ensureAttached(tabId);
  if (!forceFresh && typeof entry.isolatedContextId === "number") return entry.isolatedContextId;
  entry.isolatedContextId = undefined;
  const tree = await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree", {});
  const frameId = tree?.frameTree?.frame?.id;
  if (!frameId) return undefined;
  const world = await chrome.debugger.sendCommand({ tabId }, "Page.createIsolatedWorld", {
    frameId,
    worldName: "browser-control",
    grantUniveralAccess: true,
  });
  if (typeof world?.executionContextId === "number") {
    entry.isolatedContextId = world.executionContextId;
    return entry.isolatedContextId;
  }
  return undefined;
}

function stripHash(url) {
  const idx = String(url || "").indexOf("#");
  return idx >= 0 ? String(url).slice(0, idx) : String(url || "");
}

async function navigateTab(tabId, rawUrl, until, timeoutMs) {
  let url = String(rawUrl || "");
  if (url.startsWith("about:blank#")) url = "about:blank";
  const wantDcl = until === "domcontentloaded";

  if (tabId) {
    if (!tabAllowed(tabId)) throw new Error(`REFUSED: tab ${tabId} is not lent`);
    const existing = await chrome.tabs.get(tabId).catch(() => null);
    if (existing?.url && url.includes("#") && stripHash(existing.url) === stripHash(url) && existing.url !== url) {
      await chrome.tabs.update(tabId, { url });
      const updated = await chrome.tabs.get(tabId).catch(() => null);
      return { tabId, loaded: true, url: updated?.url || url, title: updated?.title || "" };
    }
  }

  let tid = tabId;
  let resolveLoaded;
  let done = false;
  const pendingEvents = [];

  const loadedPromise = new Promise((resolve) => {
    resolveLoaded = resolve;
  });

  const finish = (ok) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    if (chrome.webNavigation?.onDOMContentLoaded) {
      chrome.webNavigation.onDOMContentLoaded.removeListener(onDcl);
    }
    resolveLoaded(ok);
  };

  const timer = setTimeout(() => finish(false), timeoutMs);

  const onUpdated = (updatedId, info) => {
    if (tid === undefined) {
      pendingEvents.push({ type: "updated", tabId: updatedId, status: info.status });
      return;
    }
    if (updatedId !== tid) return;
    if (info.status === "complete") finish(true);
  };

  const onDcl = (details) => {
    if (details.frameId !== 0) return;
    if (tid === undefined) {
      pendingEvents.push({ type: "dcl", tabId: details.tabId });
      return;
    }
    if (details.tabId !== tid) return;
    finish(true);
  };

  chrome.tabs.onUpdated.addListener(onUpdated);
  if (wantDcl && chrome.webNavigation?.onDOMContentLoaded) {
    chrome.webNavigation.onDOMContentLoaded.addListener(onDcl);
  }

  try {
    if (!tid) {
      const created = await chrome.tabs.create({ url, active: false });
      tid = created.id;
      agentTabs.add(tid);
      await saveTabSets();
      for (const ev of pendingEvents) {
        if (ev.tabId !== tid) continue;
        if (ev.type === "dcl" || (ev.type === "updated" && ev.status === "complete")) {
          finish(true);
          break;
        }
      }
      if (!done) {
        const cur = await chrome.tabs.get(tid).catch(() => null);
        if (cur && cur.status === "complete" && cur.url && cur.url !== "about:blank") {
          finish(true);
        } else if (cur && cur.status === "complete" && url === "about:blank") {
          finish(true);
        }
      }
    } else {
      await chrome.tabs.update(tid, { url });
      if (!done) {
        const cur = await chrome.tabs.get(tid).catch(() => null);
        if (cur && cur.status === "complete" && stripHash(cur.url || "") === stripHash(url)) {
          finish(true);
        }
      }
    }
  } catch (err) {
    finish(false);
    throw err;
  }

  const loaded = await loadedPromise;
  const finalTab = await chrome.tabs.get(tid).catch(() => null);
  return { tabId: tid, loaded, url: finalTab?.url || url, title: finalTab?.title || "" };
}

async function handleRequest(msg) {
  const { op, params = {} } = msg;
  const tabId = params.tabId !== undefined ? Number(params.tabId) : undefined;

  switch (op) {
    case "list_tabs": {
      const all = await chrome.tabs.query({});
      const includeAll = params.includeAll === true;
      const tabs = all
        .filter((t) => typeof t.id === "number" && tabAllowed(t.id))
        .filter((t) => includeAll || (!String(t.url || "").startsWith("chrome://") && !String(t.url || "").startsWith("devtools://")))
        .map((t) => ({
          tabId: t.id,
          url: t.url || "",
          title: t.title || "",
          active: Boolean(t.active),
        }));
      return { tabs, mode: config.mode };
    }

    case "open_tab": {
      const url = String(params.url || "about:blank");
      const tab = await chrome.tabs.create({ url, active: params.active === true });
      if (typeof tab.id === "number") {
        agentTabs.add(tab.id);
        await saveTabSets();
      }
      return { tabId: tab.id, url: tab.url || url, title: tab.title || "" };
    }

    case "activate_tab": {
      if (!tabAllowed(tabId)) throw new Error(`REFUSED: tab ${tabId} is not lent`);
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return { ok: true };
    }

    case "close_tab": {
      if (!tabAllowed(tabId)) throw new Error(`REFUSED: tab ${tabId} is not lent`);
      await detachTab(tabId);
      await chrome.tabs.remove(tabId);
      agentTabs.delete(tabId);
      lentTabs.delete(tabId);
      await saveTabSets();
      return { ok: true };
    }

    case "reload": {
      if (!tabAllowed(tabId)) throw new Error(`REFUSED: tab ${tabId} is not lent`);
      await chrome.tabs.reload(tabId, { bypassCache: params.bypassCache === true });
      return { ok: true };
    }

    case "list_frames": {
      if (!tabAllowed(tabId)) throw new Error(`REFUSED: tab ${tabId} is not lent`);
      const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
      return {
        frames: frames.map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url || "" })),
      };
    }

    case "hold_debugger": {
      const entry = await ensureAttached(tabId);
      entry.holdUntil = Date.now() + Math.min(Number(params.ms) || DEBUGGER_IDLE_MS, 600_000);
      touchDebuggerTimer(tabId);
      return { ok: true };
    }

    case "navigate": {
      const timeoutMs = Number(params.timeoutMs) || 30_000;
      return await navigateTab(tabId, params.url, params.until, timeoutMs);
    }

    case "bc_call": {
      const values = await runBcSilent(tabId, params.steps || [], { frameId: params.frameId, timeoutMs: params.timeoutMs });
      return { values };
    }

    case "resolve_bc_node": {
      return await resolveBcNode(tabId, params.ref);
    }

    case "screenshot": {
      const format = params.format === "jpeg" ? "jpeg" : "png";
      const quality = typeof params.quality === "number" ? params.quality : 60;
      // Use silent captureVisibleTab for plain viewport shots of the active tab; otherwise CDP.
      if (!params.fullPage && !params.clip) {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.active && tabAllowed(tabId)) {
          try {
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
              format,
              ...(format === "jpeg" ? { quality } : {}),
            });
            const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
            return { data: b64 };
          } catch {
            /* fall through to debugger capture */
          }
        }
      }
      await ensureAttached(tabId);
      const cdpParams = {
        format,
        ...(format === "jpeg" ? { quality } : {}),
        ...(params.fullPage ? { captureBeyondViewport: true } : {}),
        ...(params.clip ? { clip: params.clip } : {}),
      };
      const res = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", cdpParams);
      return { data: res.data };
    }

    case "cdp": {
      const method = String(params.method || "");
      if (isBlockedCdp(method)) {
        throw new Error(`REFUSED: ${method} is blocked so browser-control never closes or crashes the user's browser`);
      }
      await ensureAttached(tabId);
      const target = typeof params.sessionId === "string" && params.sessionId !== ""
        ? { tabId, sessionId: params.sessionId }
        : { tabId };
      const result = await chrome.debugger.sendCommand(target, method, params.params || {});
      return { result: result ?? {} };
    }

    case "eval": {
      const expression = String(params.expression || "");
      const isolated = params.isolated === true;
      await ensureAttached(tabId);
      let contextId;
      if (isolated) contextId = await getIsolatedContextForDebugger(tabId);
      const evalParams = {
        expression,
        returnByValue: true,
        awaitPromise: true,
        ...(contextId !== undefined ? { contextId } : { replMode: true }),
      };
      let res;
      try {
        res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", evalParams);
      } catch (err) {
        if (isolated && /Cannot find context|Execution context was destroyed/i.test(String(err?.message || err))) {
          contextId = await getIsolatedContextForDebugger(tabId, true);
          res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { ...evalParams, contextId });
        } else {
          throw err;
        }
      }
      if (res?.exceptionDetails) {
        const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text || "unknown";
        throw new Error(`JS_EXCEPTION: ${String(detail).slice(0, 600)}`);
      }
      const r = res?.result;
      const value = r && "value" in r ? r.value : (r?.unserializableValue ?? r?.description);
      return { value, ...(contextId !== undefined ? { contextId } : {}) };
    }

    case "detach_all": {
      await detachAll();
      return { ok: true };
    }

    default:
      throw new Error(`INPUT_INVALID: unknown extension op "${op}"`);
  }
}

function sendJsonTo(entry, obj) {
  if (!entry?.ws || entry.ws.readyState !== WebSocket.OPEN) return false;
  const serialized = JSON.stringify(obj);
  const bytes = serialized.length * 3 > MAX_FRAME_BYTES ? new TextEncoder().encode(serialized).length : serialized.length;
  if (bytes > MAX_FRAME_BYTES) {
    if (obj.type === "res" && obj.id !== undefined) {
      entry.ws.send(
        JSON.stringify({
          type: "res",
          id: obj.id,
          ok: false,
          error: `EXECUTION_FAILED: Result too large (${bytes} bytes > ${MAX_FRAME_BYTES} limit)`,
        }),
      );
    }
    return false;
  }
  entry.ws.send(serialized);
  return true;
}

function closeConnection(port) {
  const entry = connections.get(port);
  if (!entry) return;
  if (entry.keepaliveTimer) {
    clearInterval(entry.keepaliveTimer);
    entry.keepaliveTimer = null;
  }
  connections.delete(port);
  try {
    entry.ws?.close();
  } catch {
    /* ignore */
  }
}

function closeAllConnections() {
  for (const port of [...connections.keys()]) {
    closeConnection(port);
  }
}

function scheduleScan(delayMs) {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scanAndConnect().catch(() => {});
  }, delayMs);
}

async function openRelaySocket(port, versionInfo) {
  if (connections.has(port)) return;
  if (!cachedProfileId) cachedProfileId = await getOrCreateProfileId();
  const browser = detectBrowserBrand();
  const extVersion = chrome.runtime.getManifest().version;
  const token = config.token;
  const extNonce = randomNonceHex(16);

  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  } catch {
    return;
  }

  const entry = {
    port,
    ws,
    state: "connecting",
    extNonce,
    instanceId: versionInfo?.instanceId || "",
    keepaliveTimer: null,
    touchedTabs: new Set(),
  };
  connections.set(port, entry);

  ws.addEventListener("open", () => {
    if (connections.get(port) !== entry) return;
    entry.state = "hello";
    sendJsonTo(entry, {
      type: "hello",
      profileId: cachedProfileId,
      browser,
      version: extVersion,
      helpersVersion: PAGE_HELPERS_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      nonce: extNonce,
    });
  });

  ws.addEventListener("message", async (ev) => {
    if (connections.get(port) !== entry) return;
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }

    if (entry.state === "hello" && msg.type === "auth.challenge") {
      entry.state = "verifying";
      const relayNonce = msg.nonce;
      const relayProof = msg.proof;
      if (!isValidNonceHex(relayNonce)) {
        ws.close(4006, "invalid relay nonce");
        return;
      }
      const validRelay = await verifyHmacHex(
        token,
        relayProofMessage(port, extNonce, relayNonce.toLowerCase()),
        relayProof,
      );
      if (!validRelay) {
        lastError = `Relay auth failed on port ${port}`;
        ws.close(4006, "invalid relay proof");
        return;
      }
      const extProof = await hmacHex(
        token,
        extProofMessage(port, relayNonce.toLowerCase(), extNonce),
      );
      entry.state = "auth_sent";
      sendJsonTo(entry, { type: "auth.response", proof: extProof });
      return;
    }

    if (msg.type === "welcome") {
      // Only a relay that proved the token and got our proof back may open the session.
      if (entry.state !== "auth_sent") {
        ws.close(4006, "welcome before auth");
        return;
      }
      entry.state = "ready";
      if (msg.instanceId) entry.instanceId = msg.instanceId;
      lastError = "";
      backoffMs = BACKOFF_MIN_MS;
      updateBadge();
      if (entry.keepaliveTimer) clearInterval(entry.keepaliveTimer);
      entry.keepaliveTimer = setInterval(async () => {
        // Calling chrome.runtime.getPlatformInfo() resets Chromium's 30 s MV3 worker idle timer.
        try {
          await chrome.runtime.getPlatformInfo();
        } catch {
          /* ignore */
        }
        sendJsonTo(entry, { type: "ping" });
      }, KEEPALIVE_MS);
      return;
    }

    if (msg.type === "pong") return;

    if (entry.state === "ready" && msg.type === "req" && msg.id !== undefined) {
      try {
        await tabSetsReady;
        if (msg.params && msg.params.tabId !== undefined) {
          entry.touchedTabs.add(Number(msg.params.tabId));
        }
        const result = await handleRequest(msg);
        if (result && typeof result.tabId === "number") {
          entry.touchedTabs.add(result.tabId);
        }
        sendJsonTo(entry, { type: "res", id: msg.id, ok: true, result });
      } catch (err) {
        sendJsonTo(entry, { type: "res", id: msg.id, ok: false, error: String(err?.message || err) });
      }
    }
  });

  ws.addEventListener("close", (ev) => {
    if (entry.keepaliveTimer) {
      clearInterval(entry.keepaliveTimer);
      entry.keepaliveTimer = null;
    }
    if (connections.get(port) === entry) {
      connections.delete(port);
    }
    if (!isAnyConnected()) {
      lastError = ev.reason && ev.code !== 1000 && ev.code !== 1001 ? ev.reason : WAITING;
      scheduleScan(nextBackoff());
    }
    updateBadge();
  });

  ws.addEventListener("error", () => {
    if (!isAnyConnected()) lastError = WAITING;
  });
}

async function scanAndConnect() {
  if (scanning) return;
  scanning = true;
  try {
    await loadConfig();
    if (!config.token) {
      lastError = "Not paired yet. Run: browser-control-daemon extension setup";
      updateBadge();
      return;
    }

    const ports = candidatePorts().filter((p) => !connections.has(p));
    const results = await Promise.all(
      ports.map(async (port) => ({ port, info: await probeVersion(port) })),
    );

    let foundAny = false;
    for (const { port, info } of results) {
      if (info) {
        foundAny = true;
        await openRelaySocket(port, info);
      }
    }

    if (!foundAny && !isAnyConnected()) {
      lastError = WAITING;
      updateBadge();
      scheduleScan(nextBackoff());
    }
  } finally {
    scanning = false;
  }
}

// Forward CDP events from attached tabs only to authenticated daemon sockets that touched that tab.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") return;
  if (method === "Page.frameNavigated" && !params?.frame?.parentId) {
    const entry = attachedTabs.get(source.tabId);
    if (entry) entry.isolatedContextId = undefined;
  }
  const payload = {
    type: "event",
    tabId: source.tabId,
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    method,
    params: params || {},
  };
  for (const conn of connections.values()) {
    if (conn.state === "ready" && conn.touchedTabs.has(source.tabId)) {
      sendJsonTo(conn, payload);
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId !== "number" || source.sessionId) return;
  const entry = attachedTabs.get(source.tabId);
  if (entry?.timer) clearTimeout(entry.timer);
  attachedTabs.delete(source.tabId);
  updateBadge();
});

function forgetTab(tabId) {
  const wasAgent = agentTabs.delete(tabId);
  const wasLent = lentTabs.delete(tabId);
  if (wasAgent || wasLent) saveTabSets().catch(() => {});
  const entry = attachedTabs.get(tabId);
  if (entry?.timer) clearTimeout(entry.timer);
  attachedTabs.delete(tabId);
  for (const conn of connections.values()) {
    conn.touchedTabs.delete(tabId);
  }
  updateBadge();
}

chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));
chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => forgetTab(removedTabId));

// Popup control messages.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await tabSetsReady;
    if (msg.type === "status") {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeId = activeTab?.id;
      const ports = connectedPorts();
      sendResponse({
        connected: ports.length > 0,
        ports,
        lastError,
        port: ports[0] || config.port,
        hasToken: Boolean(config.token),
        mode: config.mode,
        attachedCount: attachedTabs.size,
        activeTabId: activeId,
        activeTabLent: typeof activeId === "number" ? lentTabs.has(activeId) : false,
      });
    } else if (msg.type === "setMode") {
      config.mode = msg.mode === "lent" ? "lent" : "all";
      await chrome.storage.local.set({ mode: config.mode });
      sendResponse({ ok: true, mode: config.mode });
    } else if (msg.type === "toggleLend" && typeof msg.tabId === "number") {
      if (lentTabs.has(msg.tabId)) {
        lentTabs.delete(msg.tabId);
        await detachTab(msg.tabId);
      } else {
        lentTabs.add(msg.tabId);
      }
      await saveTabSets();
      sendResponse({ ok: true, lent: lentTabs.has(msg.tabId) });
    } else if (msg.type === "detachAll") {
      await detachAll();
      sendResponse({ ok: true });
    } else if (msg.type === "pair") {
      await chrome.storage.local.set({ port: Number(msg.port || DEFAULT_PORT), token: String(msg.token || "").trim() });
      closeAllConnections();
      backoffMs = BACKOFF_MIN_MS;
      await scanAndConnect();
      sendResponse({ ok: true });
    } else if (msg.type === "reconnect") {
      closeAllConnections();
      backoffMs = BACKOFF_MIN_MS;
      await scanAndConnect();
      sendResponse({ ok: true });
    }
  })();
  return true;
});

// 30 s is Chrome's minimum alarm period (Chrome 120+); it bounds how long a freshly started daemon waits for us.
chrome.alarms.create("bc-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bc-keepalive") scanAndConnect().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => scanAndConnect().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => scanAndConnect().catch(() => {}));
scanAndConnect().catch(() => {});
