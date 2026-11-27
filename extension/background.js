// Browser Control Companion — MV3 background service worker.
// Two-tier local-only relay (127.0.0.1, ports 49222-49229):
//   1. Silent tier (no yellow banner): chrome.tabs + chrome.scripting (ISOLATED world) for __bc reads.
//   2. Full CDP tier (on-demand): chrome.debugger per tab, auto-detached after 30s idle.
//
// Keepalive (`chrome.runtime.getPlatformInfo`) and mutual HMAC handshake patterns adapted from
// anomalyco/browse (MIT License).

import { createDebuggerHub } from "./lib/debugger-hub.js";
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
import { createTabCleanup } from "./lib/tab-cleanup.js";
import { createWindowGroups, normalizeNavigateUrl } from "./lib/window-groups.js";

const DEFAULT_PORT = 49222;
const PORT_RANGE_START = 49222;
const PORT_RANGE_END = 49229;
const VERSION_PROBE_TIMEOUT_MS = 800;
const DEBUGGER_IDLE_MS = 30_000;
const KEEPALIVE_MS = 20_000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const PAGE_HELPERS_FILE = "page-helpers.js";
const PAGE_HELPERS_VERSION = 7;
const OVERLAY_FILE = "content-overlay.js";
const HANDOFF_NOTIF_PREFIX = "bc-handoff-";
const HANDOFF_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==";

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_IDLE_CAP_MS = 15_000;
const WAITING = "Waiting for relay";

const DEFAULT_SETTINGS = {
  tabGroupMode: "shared", // "shared" | "none"
  autoCollapse: true,
  idleCleanupMinutes: 30, // 0 = Never
  muteAgentTabs: false,
};

let config = { port: DEFAULT_PORT, token: "", mode: "all" }; // mode: "all" | "lent"
let settings = { ...DEFAULT_SETTINGS };
let lastError = "";
const lentTabs = new Set();
const agentTabs = new Set();
const handoffTabs = new Map(); // tabId -> { message, origin }
const connections = new Map(); // port -> { port, ws, state, extNonce, instanceId, keepaliveTimer, touchedTabs }

let scanTimer = null;
let scanning = false;
let backoffMs = BACKOFF_MIN_MS;
let cachedProfileId = null;
let idleSweepTimer = null;

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

function normalizeSettings(raw = {}) {
  const tabGroupMode = raw.tabGroupMode === "none" ? "none" : "shared";
  const autoCollapse = raw.autoCollapse !== false;
  const rawIdle = raw.idleCleanupMinutes;
  const idleCleanupMinutes =
    rawIdle === 0 || rawIdle === "0" || rawIdle === "never" || rawIdle === null
      ? 0
      : Number.isFinite(Number(rawIdle)) && Number(rawIdle) > 0
        ? Number(rawIdle)
        : DEFAULT_SETTINGS.idleCleanupMinutes;
  const muteAgentTabs = raw.muteAgentTabs === true;
  return { tabGroupMode, autoCollapse, idleCleanupMinutes, muteAgentTabs };
}

function scheduleIdleSweepTimer() {
  if (idleSweepTimer) {
    clearInterval(idleSweepTimer);
    idleSweepTimer = null;
  }
  // Normal multi-minute intervals are handled by the 30 s chrome.alarms wakeup; sub-minute
  // timeouts (used by automated tests) also get an in-worker interval so sweeps fire promptly.
  if (settings.idleCleanupMinutes > 0 && settings.idleCleanupMinutes < 1) {
    const intervalMs = Math.max(250, Math.round((settings.idleCleanupMinutes * 60_000) / 2));
    idleSweepTimer = setInterval(() => {
      tabCleanup.runIdleSweep().catch(() => {});
    }, intervalMs);
  }
}

async function loadConfig() {
  const stored = await chrome.storage.local.get([
    "port",
    "token",
    "mode",
    "tabGroupMode",
    "autoCollapse",
    "idleCleanupMinutes",
    "muteAgentTabs",
  ]);
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
  settings = normalizeSettings(stored);
  scheduleIdleSweepTimer();
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

function broadcastEventToTouched(tabId, payload) {
  for (const conn of connections.values()) {
    if (conn.state === "ready" && conn.touchedTabs.has(tabId)) {
      sendJsonTo(conn, payload);
    }
  }
}

function updateBadge() {
  if (handoffTabs.size > 0) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
  } else if (debuggerHub.size() > 0) {
    chrome.action.setBadgeText({ text: String(debuggerHub.size()) });
    chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  } else if (isAnyConnected()) {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function ensureOverlayInjected(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    files: [OVERLAY_FILE],
  });
}

async function evictForeignFramesOnTab(tabId) {
  if (handoffTabs.has(tabId)) return { ok: true, removed: 0 };
  try {
    await ensureOverlayInjected(tabId);
    const res = await chrome.tabs.sendMessage(tabId, { type: "bc:evict-foreign-frames" });
    return res || { ok: true, removed: 0 };
  } catch {
    return { ok: false, removed: 0 };
  }
}

const debuggerHub = createDebuggerHub({
  chrome,
  idleMs: DEBUGGER_IDLE_MS,
  isTabAllowed: tabAllowed,
  isTabInHandoff: (tabId) => handoffTabs.has(tabId),
  evictForeignFrames: evictForeignFramesOnTab,
  onEvent: (payload) => {
    broadcastEventToTouched(payload.tabId, payload);
  },
  onBadgeChange: updateBadge,
});

const restoreReady = debuggerHub.restoreAttachedTabs().catch(() => ({ restored: [], skipped: [] }));

const windowGroups = createWindowGroups({
  chrome,
  getSettings: () => settings,
  isAgentTab: (tabId) => agentTabs.has(tabId),
  isTabInHandoff: (tabId) => handoffTabs.has(tabId),
  onUserClaimTab: async (tabId) => {
    if (agentTabs.delete(tabId)) {
      await saveTabSets().catch(() => {});
    }
    await tabCleanup.release(tabId);
  },
  onAdoptPopup: async ({ openerTabId, tabId }) => {
    agentTabs.add(tabId);
    tabCleanup.touchTab(tabId);
    await saveTabSets().catch(() => {});
    await tabCleanup.protect(tabId);
    for (const conn of connections.values()) {
      if (conn.touchedTabs.has(openerTabId)) {
        conn.touchedTabs.add(tabId);
      }
    }
  },
  onPopupAdoptedEvent: ({ openerTabId, tabId, url }) => {
    broadcastEventToTouched(openerTabId, {
      type: "event",
      tabId,
      method: "bc.popupAdopted",
      params: { openerTabId, tabId, url },
    });
  },
});

const tabCleanup = createTabCleanup({
  chrome,
  agentTabs,
  lentTabs,
  getSettings: () => settings,
  isTabInHandoff: (tabId) => handoffTabs.has(tabId),
  beforeUngroup: (tabId) => windowGroups.beginInternalGroupOp(tabId),
  afterUngroup: (tabId) => windowGroups.endInternalGroupOp(tabId),
  onCloseTab: async (tabId) => {
    await closeTabInternal(tabId);
  },
  onPurgeTab: (tabId, { wasAgent, wasLent }) => {
    if (wasAgent || wasLent) saveTabSets().catch(() => {});
    handoffTabs.delete(tabId);
    chrome.notifications?.clear?.(`${HANDOFF_NOTIF_PREFIX}${tabId}`)?.catch?.(() => {});
    debuggerHub.forgetTab(tabId);
    windowGroups.handleTabRemoved(tabId);
    for (const conn of connections.values()) {
      conn.touchedTabs.delete(tabId);
    }
    updateBadge();
  },
});

windowGroups.seedActiveTabs().catch(() => {});

async function closeTabInternal(tabId) {
  await debuggerHub.detachTab(tabId);
  handoffTabs.delete(tabId);
  chrome.notifications?.clear?.(`${HANDOFF_NOTIF_PREFIX}${tabId}`)?.catch?.(() => {});
  await tabCleanup.closeSafely(tabId);
  tabCleanup.purge(tabId);
}

async function trackNewAgentTab(tabId, { keepOpen = false } = {}) {
  agentTabs.add(tabId);
  tabCleanup.touchTab(tabId);
  if (keepOpen) tabCleanup.markKeepOpen(tabId, true);
  await saveTabSets();
  await tabCleanup.protect(tabId);
  await windowGroups.addTabToAgentGroup(tabId);
}

function originOfUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || "")).origin;
  } catch {
    return String(rawUrl || "");
  }
}

async function sendHandoffOverlay(tabId, message, origin) {
  try {
    await ensureOverlayInjected(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "bc:handoff-start",
      message,
      origin,
    });
  } catch (err) {
    throw scriptingError(err, tabId);
  }
}

async function handoffStart(tabId, rawMessage) {
  if (!tabAllowed(tabId)) {
    throw new Error(`REFUSED: tab ${tabId} is not lent to Browser Control`);
  }
  const tab = await chrome.tabs.get(tabId);
  const message = String(rawMessage || "Complete this step in the browser, then click Continue.");
  const origin = originOfUrl(tab?.url || "");

  handoffTabs.set(tabId, { message, origin });
  tabCleanup.touchTab(tabId);
  await windowGroups.expandGroupForTab(tabId);
  await sendHandoffOverlay(tabId, message, origin);
  updateBadge();

  if (chrome.notifications?.create) {
    try {
      await chrome.notifications.create(`${HANDOFF_NOTIF_PREFIX}${tabId}`, {
        type: "basic",
        iconUrl: HANDOFF_ICON_DATA_URL,
        title: "Browser Control — Your turn",
        message: origin ? `${origin}\n${message}` : message,
        buttons: [{ title: "Continue" }],
        requireInteraction: true,
      });
    } catch {
      /* notifications may be unavailable or denied in headless/test Chrome */
    }
  }

  return { ok: true, tabId };
}

async function handoffClear(tabId) {
  handoffTabs.delete(tabId);
  if (chrome.notifications?.clear) {
    try {
      await chrome.notifications.clear(`${HANDOFF_NOTIF_PREFIX}${tabId}`);
    } catch {
      /* ignore */
    }
  }
  await chrome.tabs.sendMessage(tabId, { type: "bc:handoff-clear" }).catch(() => {});
  updateBadge();
  return { ok: true, tabId };
}

async function completeHandoff(tabId) {
  if (!handoffTabs.has(tabId)) return { ok: true, completed: false };
  await handoffClear(tabId);
  broadcastEventToTouched(tabId, {
    type: "event",
    tabId,
    method: "bc.handoffDone",
    params: { tabId },
  });
  return { ok: true, completed: true };
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
    await restoreReady;
    const doc = await debuggerHub.sendCommand(tabId, "DOM.getDocument", { depth: 1 });
    const rootId = doc?.root?.nodeId;
    if (!rootId) throw new Error("EXECUTION_FAILED: DOM.getDocument returned no root");
    const q = await debuggerHub.sendCommand(tabId, "DOM.querySelector", {
      nodeId: rootId,
      selector: `[data-bc-resolve="${marker}"]`,
    });
    if (!q?.nodeId) throw new Error(`NO_MATCH: CDP could not locate ${refOrSelector}`);
    const resolved = await debuggerHub.sendCommand(tabId, "DOM.resolveNode", { nodeId: q.nodeId });
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
  await restoreReady;
  const entry = await debuggerHub.ensureAttached(tabId);
  if (!forceFresh && typeof entry.isolatedContextId === "number") return entry.isolatedContextId;
  entry.isolatedContextId = undefined;
  const tree = await debuggerHub.sendCommand(tabId, "Page.getFrameTree", {});
  const frameId = tree?.frameTree?.frame?.id;
  if (!frameId) return undefined;
  const world = await debuggerHub.sendCommand(tabId, "Page.createIsolatedWorld", {
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

async function navigateTab(tabId, rawUrl, until, timeoutMs, opts = {}) {
  const url = normalizeNavigateUrl(rawUrl);
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
      const created = await windowGroups.openAgentTab({
        url,
        active: false,
        newWindow: opts.newWindow === true,
      });
      tid = created?.id;
      if (typeof tid === "number") {
        await trackNewAgentTab(tid, { keepOpen: opts.keepOpen === true });
      }
      for (const ev of pendingEvents) {
        if (ev.tabId !== tid) continue;
        if (ev.type === "dcl" || (ev.type === "updated" && ev.status === "complete")) {
          finish(true);
          break;
        }
      }
      if (!done && typeof tid === "number") {
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
  const finalTab = typeof tid === "number" ? await chrome.tabs.get(tid).catch(() => null) : null;
  return { tabId: tid, loaded, url: finalTab?.url || url, title: finalTab?.title || "" };
}

async function handleRequest(msg) {
  const { op, params = {} } = msg;
  const tabId = params.tabId !== undefined ? Number(params.tabId) : undefined;
  if (typeof tabId === "number") {
    tabCleanup.touchTab(tabId);
  }

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
      const url = normalizeNavigateUrl(params.url || "about:blank");
      const tab = await windowGroups.openAgentTab({
        url,
        active: params.active === true,
        newWindow: params.newWindow === true,
      });
      if (typeof tab?.id === "number") {
        await trackNewAgentTab(tab.id, { keepOpen: params.keepOpen === true });
      }
      return { tabId: tab?.id, url: tab?.url || url, title: tab?.title || "" };
    }

    case "activate_tab": {
      if (!tabAllowed(tabId)) throw new Error(`REFUSED: tab ${tabId} is not lent`);
      await windowGroups.expandGroupForTab(tabId);
      return { ok: true };
    }

    case "close_tab": {
      if (!tabAllowed(tabId)) throw new Error(`REFUSED: tab ${tabId} is not lent`);
      await closeTabInternal(tabId);
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
      await restoreReady;
      await debuggerHub.holdDebugger(tabId, params.ms);
      return { ok: true };
    }

    case "handoff_start": {
      return await handoffStart(tabId, params.message);
    }

    case "handoff_clear": {
      return await handoffClear(tabId);
    }

    case "navigate": {
      const timeoutMs = Number(params.timeoutMs) || 30_000;
      return await navigateTab(tabId, params.url, params.until, timeoutMs, {
        newWindow: params.newWindow === true,
        keepOpen: params.keepOpen === true,
      });
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
      await restoreReady;
      const cdpParams = {
        format,
        ...(format === "jpeg" ? { quality } : {}),
        ...(params.fullPage ? { captureBeyondViewport: true } : {}),
        ...(params.clip ? { clip: params.clip } : {}),
      };
      const res = await debuggerHub.sendCommand(tabId, "Page.captureScreenshot", cdpParams);
      return { data: res.data };
    }

    case "cdp": {
      const method = String(params.method || "");
      // Silent relay-op pass-throughs for daemons that route via execute_cdp without attaching debugger.
      if (method === "bc.handoffStart") {
        const result = await handoffStart(tabId, params.params?.message);
        return { result };
      }
      if (method === "bc.handoffClear") {
        const result = await handoffClear(tabId);
        return { result };
      }
      if (isBlockedCdp(method)) {
        throw new Error(`REFUSED: ${method} is blocked so browser-control never closes or crashes the user's browser`);
      }
      await restoreReady;
      const result = await debuggerHub.sendCommand(tabId, method, params.params || {}, {
        sessionId: params.sessionId,
      });
      return { result: result ?? {} };
    }

    case "eval": {
      const expression = String(params.expression || "");
      const isolated = params.isolated === true;
      await restoreReady;
      await debuggerHub.ensureAttached(tabId);
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
        res = await debuggerHub.sendCommand(tabId, "Runtime.evaluate", evalParams);
      } catch (err) {
        if (isolated && /Cannot find context|Execution context was destroyed/i.test(String(err?.message || err))) {
          contextId = await getIsolatedContextForDebugger(tabId, true);
          res = await debuggerHub.sendCommand(tabId, "Runtime.evaluate", { ...evalParams, contextId });
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
      await debuggerHub.detachAll();
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

// Forward CDP events and child OOPIF detaches through debuggerHub.
chrome.debugger.onEvent.addListener((source, method, params) => {
  debuggerHub.handleDebuggerEvent(source, method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  debuggerHub.handleDebuggerDetach(source, reason);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabCleanup.handleTabRemoved(tabId);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  tabCleanup.handleTabReplaced(addedTabId, removedTabId);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  windowGroups.handleTabActivated(activeInfo).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  windowGroups.handleTabUpdated(tabId, changeInfo, tab).catch(() => {});
  // Re-show handoff overlay if the user navigates during a multi-step login/2FA handoff.
  if (changeInfo.status === "complete" && handoffTabs.has(tabId)) {
    const info = handoffTabs.get(tabId);
    const origin = originOfUrl(tab?.url || info.origin);
    info.origin = origin;
    sendHandoffOverlay(tabId, info.message, origin).catch(() => {});
  }
});

if (chrome.webNavigation?.onCreatedNavigationTarget) {
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    tabSetsReady
      .then(() => windowGroups.handleCreatedNavigationTarget(details))
      .catch(() => {});
  });
}

function tabIdFromNotificationId(notifId) {
  if (typeof notifId !== "string" || !notifId.startsWith(HANDOFF_NOTIF_PREFIX)) return null;
  const tabId = Number(notifId.slice(HANDOFF_NOTIF_PREFIX.length));
  return Number.isInteger(tabId) ? tabId : null;
}

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((notifId) => {
    const tabId = tabIdFromNotificationId(notifId);
    if (tabId !== null) completeHandoff(tabId).catch(() => {});
  });
}

if (chrome.notifications?.onButtonClicked) {
  chrome.notifications.onButtonClicked.addListener((notifId) => {
    const tabId = tabIdFromNotificationId(notifId);
    if (tabId !== null) completeHandoff(tabId).catch(() => {});
  });
}

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    let touched = false;
    const merged = { ...settings };
    for (const key of ["tabGroupMode", "autoCollapse", "idleCleanupMinutes", "muteAgentTabs"]) {
      if (key in changes) {
        merged[key] = changes[key].newValue;
        touched = true;
      }
    }
    if (touched) {
      settings = normalizeSettings(merged);
      scheduleIdleSweepTimer();
    }
  });
}

// Popup and content-overlay messages.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await tabSetsReady;
    if (msg?.type === "bc:handoff-done") {
      const tabId = typeof sender?.tab?.id === "number" ? sender.tab.id : Number(msg.tabId);
      if (Number.isInteger(tabId)) {
        await completeHandoff(tabId);
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "status") {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeId = activeTab?.id;
      const ports = connectedPorts();
      const activeHandoffs = [];
      for (const [tid, info] of handoffTabs) {
        activeHandoffs.push({ tabId: tid, message: info.message, origin: info.origin });
      }
      sendResponse({
        connected: ports.length > 0,
        ports,
        lastError,
        port: ports[0] || config.port,
        hasToken: Boolean(config.token),
        mode: config.mode,
        attachedCount: debuggerHub.size(),
        activeTabId: activeId,
        activeTabLent: typeof activeId === "number" ? lentTabs.has(activeId) : false,
        settings: { ...settings },
        handoffs: activeHandoffs,
      });
    } else if (msg.type === "setMode") {
      config.mode = msg.mode === "lent" ? "lent" : "all";
      await chrome.storage.local.set({ mode: config.mode });
      sendResponse({ ok: true, mode: config.mode });
    } else if (msg.type === "setSettings") {
      settings = normalizeSettings({ ...settings, ...(msg.settings || {}) });
      await chrome.storage.local.set({ ...settings });
      scheduleIdleSweepTimer();
      sendResponse({ ok: true, settings: { ...settings } });
    } else if (msg.type === "completeHandoff" && typeof msg.tabId === "number") {
      const res = await completeHandoff(msg.tabId);
      sendResponse(res);
    } else if (msg.type === "toggleLend" && typeof msg.tabId === "number") {
      if (lentTabs.has(msg.tabId)) {
        lentTabs.delete(msg.tabId);
        await debuggerHub.detachTab(msg.tabId);
      } else {
        lentTabs.add(msg.tabId);
      }
      await saveTabSets();
      sendResponse({ ok: true, lent: lentTabs.has(msg.tabId) });
    } else if (msg.type === "detachAll") {
      await debuggerHub.detachAll();
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
  if (alarm.name === "bc-keepalive") {
    scanAndConnect().catch(() => {});
    tabCleanup.runIdleSweep().catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  // Tab IDs recycle across browser restarts, so clear any persisted debugger attachments first.
  debuggerHub.clearPersisted().catch(() => {});
  scanAndConnect().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => scanAndConnect().catch(() => {}));
scanAndConnect().catch(() => {});
