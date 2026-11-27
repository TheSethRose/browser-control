// Debugger lifecycle hub: on-demand attach/detach with 30 s idle timeout, hold_debugger,
// Emulation.setFocusEmulationEnabled, child OOPIF sessionId forwarding, MV3 service-worker restart
// recovery (serial-queued storage + Target.getTargetInfo ownedByUs probe), and foreign extension
// frame eviction with up to 2 retries (never during a handoff).
// Patterns adapted from anomalyco/browse (MIT License).

export const DEFAULT_DEBUGGER_IDLE_MS = 30_000;
export const MAX_HOLD_MS = 600_000;
export const MAX_FOREIGN_FRAME_RETRIES = 2;
export const ATTACHED_STORAGE_KEY = "bc_attached_tabs";

/**
 * Detect Chrome debugger failures caused by foreign extension frames (1Password, LastPass, Bitwarden)
 * injected into a still-open tab.
 */
export function isForeignFrameError(err, lastDetachReason = "") {
  const msg = String(err?.message || err || "");
  if (/Cannot access a chrome-extension:\/\//i.test(msg)) return true;
  if (lastDetachReason === "target_closed") return true;
  if (/target_closed|Detached while handling command/i.test(msg)) return true;
  return false;
}

/** Serializes async operations so out-of-order storage writes never clobber newer state. */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const next = tail.then(fn, fn);
    tail = next.catch(() => {});
    return next;
  };
}

function getPersistStorage(chromeApi) {
  return chromeApi?.storage?.session || chromeApi?.storage?.local || null;
}

export function createDebuggerHub({
  chrome: chromeApi = globalThis.chrome,
  idleMs = DEFAULT_DEBUGGER_IDLE_MS,
  isTabAllowed = () => true,
  isTabInHandoff = () => false,
  evictForeignFrames = async () => ({ removed: 0 }),
  onEvent = () => {},
  onDetach = () => {},
  onBadgeChange = () => {},
} = {}) {
  const attachedTabs = new Map(); // tabId -> { timer, holdUntil, isolatedContextId, url }
  const inFlightAttach = new Map(); // tabId -> Promise<entry>
  const inFlightDetach = new Map(); // tabId -> Promise<void>
  const lastDetachReason = new Map(); // tabId -> string
  const enqueuePersist = createSerialQueue();

  function snapshotPersisted() {
    const list = [];
    for (const [tabId, entry] of attachedTabs) {
      list.push({ tabId, url: entry.url || "" });
    }
    return list;
  }

  function persistAttached() {
    const storage = getPersistStorage(chromeApi);
    if (!storage) return Promise.resolve();
    const payload = snapshotPersisted();
    return enqueuePersist(async () => {
      try {
        await storage.set({ [ATTACHED_STORAGE_KEY]: payload });
      } catch {
        /* ignore storage errors */
      }
    });
  }

  async function clearPersisted() {
    const storage = getPersistStorage(chromeApi);
    if (!storage) return;
    await enqueuePersist(async () => {
      try {
        if (typeof storage.remove === "function") {
          await storage.remove([ATTACHED_STORAGE_KEY]);
        } else {
          await storage.set({ [ATTACHED_STORAGE_KEY]: [] });
        }
      } catch {
        /* ignore */
      }
    });
  }

  function touchTimer(tabId) {
    const entry = attachedTabs.get(tabId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    const ms = Math.max(idleMs, (entry.holdUntil || 0) - Date.now());
    entry.timer = setTimeout(() => {
      detachTab(tabId).catch(() => {});
    }, ms);
  }

  async function enableFocusEmulation(tabId) {
    await chromeApi.debugger
      .sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true })
      .catch(() => {});
  }

  async function ensureAttached(tabId) {
    if (!isTabAllowed(tabId)) {
      throw new Error(
        `REFUSED: tab ${tabId} is not lent to Browser Control (click the extension icon to lend it or switch to All tabs)`,
      );
    }
    const existing = attachedTabs.get(tabId);
    if (existing) {
      touchTimer(tabId);
      return existing;
    }
    if (inFlightAttach.has(tabId)) {
      return inFlightAttach.get(tabId);
    }

    const work = (async () => {
      while (inFlightDetach.has(tabId)) {
        await inFlightDetach.get(tabId).catch(() => {});
      }
      lastDetachReason.delete(tabId);
      await chromeApi.debugger.attach({ tabId }, "1.3");
      const tab = await chromeApi.tabs?.get?.(tabId).catch(() => null);
      const entry = {
        timer: null,
        holdUntil: 0,
        isolatedContextId: undefined,
        url: tab?.url || "",
      };
      attachedTabs.set(tabId, entry);
      await enableFocusEmulation(tabId);
      touchTimer(tabId);
      await persistAttached();
      onBadgeChange();
      return entry;
    })().finally(() => {
      inFlightAttach.delete(tabId);
    });

    inFlightAttach.set(tabId, work);
    return work;
  }

  async function detachTab(tabId) {
    if (inFlightDetach.has(tabId)) {
      return inFlightDetach.get(tabId);
    }
    const entry = attachedTabs.get(tabId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    attachedTabs.delete(tabId);

    const work = (async () => {
      await persistAttached();
      try {
        await chromeApi.debugger.detach({ tabId });
      } catch {
        /* already detached */
      }
      onBadgeChange();
    })().finally(() => {
      if (inFlightDetach.get(tabId) === work) {
        inFlightDetach.delete(tabId);
      }
    });

    inFlightDetach.set(tabId, work);
    return work;
  }

  async function detachAll() {
    for (const tabId of [...attachedTabs.keys()]) {
      await detachTab(tabId);
    }
  }

  async function holdDebugger(tabId, ms) {
    const entry = await ensureAttached(tabId);
    const duration = Math.min(Number(ms) || idleMs, MAX_HOLD_MS);
    entry.holdUntil = Math.max(entry.holdUntil || 0, Date.now() + duration);
    touchTimer(tabId);
    return entry;
  }

  /**
   * Run a CDP command on `tabId` (or child OOPIF `sessionId`), with automatic foreign-extension-frame
   * eviction and up to 2 retries when Chrome rejects or drops the session on a still-open tab.
   * Never evicts foreign frames while a tab is in human handoff.
   */
  async function sendCommand(tabId, method, params = {}, opts = {}) {
    const sessionId = typeof opts.sessionId === "string" && opts.sessionId !== "" ? opts.sessionId : undefined;
    const target = sessionId ? { tabId, sessionId } : { tabId };

    for (let attempt = 0; attempt <= MAX_FOREIGN_FRAME_RETRIES; attempt++) {
      await ensureAttached(tabId);
      lastDetachReason.delete(tabId);
      try {
        const result = await chromeApi.debugger.sendCommand(target, method, params);
        touchTimer(tabId);
        return result;
      } catch (err) {
        const reason = lastDetachReason.get(tabId) || "";
        const foreignLike = isForeignFrameError(err, reason);
        if (!foreignLike || isTabInHandoff(tabId)) {
          throw err;
        }
        const stillOpen = await chromeApi.tabs?.get?.(tabId).catch(() => null);
        if (!stillOpen) {
          throw err;
        }
        if (attempt < MAX_FOREIGN_FRAME_RETRIES) {
          await evictForeignFrames(tabId).catch(() => {});
          await detachTab(tabId);
          // Re-attach happens at top of next loop iteration.
          continue;
        }
        if (method === "Page.navigate" && typeof params?.url === "string" && !sessionId) {
          await chromeApi.tabs.update(tabId, { url: params.url });
          return { frameId: "" };
        }
        throw err;
      }
    }
    return {};
  }

  /**
   * After an MV3 service worker restart, restore debugger attachments that still belong to this
   * extension (verified by `Target.getTargetInfo` succeeding -> `ownedByUs`), cleanly detaching
   * and re-attaching each one to clear any hung state from the dead worker.
   */
  async function restoreAttachedTabs() {
    const storage = getPersistStorage(chromeApi);
    if (!storage) return { restored: [], skipped: [] };

    let storedList = [];
    try {
      const data = await storage.get([ATTACHED_STORAGE_KEY]);
      if (Array.isArray(data?.[ATTACHED_STORAGE_KEY])) {
        storedList = data[ATTACHED_STORAGE_KEY];
      }
    } catch {
      return { restored: [], skipped: [] };
    }

    const restored = [];
    const skipped = [];

    for (const item of storedList) {
      const tabId = Number(item?.tabId);
      if (!Number.isInteger(tabId)) continue;
      const tab = await chromeApi.tabs?.get?.(tabId).catch(() => null);
      if (!tab) {
        skipped.push(tabId);
        continue;
      }

      // Probe ownership: sendCommand only succeeds if THIS extension holds the debugger attachment.
      let ownedByUs = false;
      try {
        await chromeApi.debugger.sendCommand({ tabId }, "Target.getTargetInfo", {});
        ownedByUs = true;
      } catch {
        ownedByUs = false;
      }

      if (!ownedByUs) {
        skipped.push(tabId);
        continue;
      }

      try {
        await chromeApi.debugger.detach({ tabId }).catch(() => {});
        await chromeApi.debugger.attach({ tabId }, "1.3");
        const entry = {
          timer: null,
          holdUntil: 0,
          isolatedContextId: undefined,
          url: tab.url || item.url || "",
        };
        attachedTabs.set(tabId, entry);
        await enableFocusEmulation(tabId);
        touchTimer(tabId);
        restored.push(tabId);
      } catch {
        skipped.push(tabId);
      }
    }

    await persistAttached();
    onBadgeChange();
    return { restored, skipped };
  }

  function handleDebuggerEvent(source, method, params) {
    if (typeof source?.tabId !== "number") return;
    if (method === "Page.frameNavigated" && !params?.frame?.parentId && !source.sessionId) {
      const entry = attachedTabs.get(source.tabId);
      if (entry) {
        entry.isolatedContextId = undefined;
        if (typeof params?.frame?.url === "string") {
          entry.url = params.frame.url;
          persistAttached().catch(() => {});
        }
      }
    }
    onEvent({
      type: "event",
      tabId: source.tabId,
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
      method,
      params: params || {},
    });
  }

  function handleDebuggerDetach(source, reason) {
    if (typeof source?.tabId !== "number") return;
    if (source.sessionId) {
      // Child OOPIF target detached: keep the top-level tab attachment alive and forward sessionId.
      onEvent({
        type: "event",
        tabId: source.tabId,
        sessionId: source.sessionId,
        method: "Target.detachedFromTarget",
        params: { sessionId: source.sessionId, reason: reason || "" },
      });
      onDetach(source, reason);
      return;
    }

    lastDetachReason.set(source.tabId, String(reason || ""));
    const entry = attachedTabs.get(source.tabId);
    if (entry?.timer) clearTimeout(entry.timer);
    attachedTabs.delete(source.tabId);
    persistAttached().catch(() => {});
    onBadgeChange();
    onDetach(source, reason);
  }

  function forgetTab(tabId) {
    lastDetachReason.delete(tabId);
    const entry = attachedTabs.get(tabId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    attachedTabs.delete(tabId);
    persistAttached().catch(() => {});
    onBadgeChange();
  }

  return {
    attachedTabs,
    ensureAttached,
    detachTab,
    detachAll,
    holdDebugger,
    sendCommand,
    touchTimer,
    restoreAttachedTabs,
    clearPersisted,
    persistAttached,
    handleDebuggerEvent,
    handleDebuggerDetach,
    forgetTab,
    size: () => attachedTabs.size,
  };
}
