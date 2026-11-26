// Browser Control Companion — MV3 background service worker.
// Two-tier local-only relay (127.0.0.1):
//   1. Silent tier (no yellow banner): chrome.tabs + chrome.scripting (ISOLATED world) for __bc reads.
//   2. Full CDP tier (on-demand): chrome.debugger per tab, auto-detached after 30s idle.

const DEFAULT_PORT = 49222;
const DEBUGGER_IDLE_MS = 30_000;
const KEEPALIVE_MS = 20_000;
const PAGE_HELPERS_FILE = "page-helpers.js";
const PAGE_HELPERS_VERSION = 7;

let ws = null;
let connected = false;
let lastError = "";
let config = { port: DEFAULT_PORT, token: "", mode: "all" }; // mode: "all" | "lent"
const lentTabs = new Set();
const agentTabs = new Set();
const attachedTabs = new Map(); // tabId -> { timer, isolatedContextId? }
let keepaliveTimer = null;
let reconnectTimer = null;

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
    token: String(fileCfg?.token || stored.token || ""),
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
  } else if (connected) {
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
      const url = String(params.url || "");
      const until = params.until === "domcontentloaded" ? "loading" : "complete";
      const timeoutMs = Number(params.timeoutMs) || 30_000;
      let tid = tabId;
      if (!tid) {
        const created = await chrome.tabs.create({ url, active: false });
        tid = created.id;
        agentTabs.add(tid);
        await saveTabSets();
      } else {
        if (!tabAllowed(tid)) throw new Error(`REFUSED: tab ${tid} is not lent`);
        await chrome.tabs.update(tid, { url });
      }
      const loaded = await new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(onUpd);
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        const onUpd = (updatedId, info) => {
          if (updatedId !== tid) return;
          if (info.status === "complete" || (until === "loading" && info.status === "loading")) {
            finish(true);
          }
        };
        chrome.tabs.onUpdated.addListener(onUpd);
      });
      const finalTab = await chrome.tabs.get(tid).catch(() => null);
      return { tabId: tid, loaded, url: finalTab?.url || url, title: finalTab?.title || "" };
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
      const result = await chrome.debugger.sendCommand({ tabId }, method, params.params || {});
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

function sendJson(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function scheduleReconnect(delayMs = 3000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => {});
  }, delayMs);
}

async function connect() {
  await loadConfig();
  if (!config.token) {
    connected = false;
    lastError = "Not paired yet. Run: browser-control-daemon extension setup";
    updateBadge();
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const url = `ws://127.0.0.1:${config.port}/extension`;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    lastError = String(err?.message || err);
    scheduleReconnect(5000);
    return;
  }

  ws.addEventListener("open", () => {
    sendJson({ type: "hello", token: config.token, version: chrome.runtime.getManifest().version });
  });

  ws.addEventListener("message", async (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === "welcome") {
      connected = true;
      lastError = "";
      updateBadge();
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = setInterval(() => sendJson({ type: "ping" }), KEEPALIVE_MS);
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "req" && msg.id !== undefined) {
      try {
        await tabSetsReady;
        const result = await handleRequest(msg);
        sendJson({ type: "res", id: msg.id, ok: true, result });
      } catch (err) {
        sendJson({ type: "res", id: msg.id, ok: false, error: String(err?.message || err) });
      }
    }
  });

  ws.addEventListener("close", (ev) => {
    connected = false;
    ws = null;
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    lastError = ev.reason || "Daemon not running";
    updateBadge();
    scheduleReconnect(3000);
  });

  ws.addEventListener("error", () => {
    lastError = `Cannot reach 127.0.0.1:${config.port}`;
  });
}

// Forward CDP events from attached tabs straight back into browser-control's EventBuffer.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") return;
  if (method === "Page.frameNavigated" && !params?.frame?.parentId) {
    const entry = attachedTabs.get(source.tabId);
    if (entry) entry.isolatedContextId = undefined;
  }
  sendJson({ type: "event", tabId: source.tabId, method, params: params || {} });
});

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId !== "number") return;
  const entry = attachedTabs.get(source.tabId);
  if (entry?.timer) clearTimeout(entry.timer);
  attachedTabs.delete(source.tabId);
  updateBadge();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const wasAgent = agentTabs.delete(tabId);
  const wasLent = lentTabs.delete(tabId);
  if (wasAgent || wasLent) saveTabSets().catch(() => {});
  const entry = attachedTabs.get(tabId);
  if (entry?.timer) clearTimeout(entry.timer);
  attachedTabs.delete(tabId);
  updateBadge();
});

// Popup control messages.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await tabSetsReady;
    if (msg.type === "status") {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeId = activeTab?.id;
      sendResponse({
        connected,
        lastError,
        port: config.port,
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
      if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
      await connect();
      sendResponse({ ok: true });
    } else if (msg.type === "reconnect") {
      if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
      await connect();
      sendResponse({ ok: true });
    }
  })();
  return true;
});

// 30 s is Chrome's minimum alarm period (Chrome 120+); it bounds how long a freshly started daemon waits for us.
chrome.alarms.create("bc-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bc-keepalive" && !connected) connect().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => connect().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => connect().catch(() => {}));
connect().catch(() => {});
