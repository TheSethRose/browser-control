// Agent tab lifecycle hygiene: autoDiscardable:false, optional mute/unmute, leaveLastWindowOpen,
// idle cleanup for agent-opened tabs, and onRemoved/onReplaced purging.
// Patterns adapted from anomalyco/browse (MIT License).

export const TAB_STATE_STORAGE_KEYS = ["lentTabs", "agentTabs", "agentTabLastUsed", "keepOpenTabs"];
const TAB_GROUP_ID_NONE = -1;

let closeQueueTail = Promise.resolve();
function enqueueClose(fn) {
  const next = closeQueueTail.then(fn, fn);
  closeQueueTail = next.catch(() => {});
  return next;
}

/** Mark an agent-opened tab non-discardable and optionally mute it. */
export async function protectAgentTab(tabId, { mute = false } = {}, chromeApi = globalThis.chrome) {
  await chromeApi.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  if (mute === true) {
    await chromeApi.tabs.update(tabId, { muted: true }).catch(() => {});
  }
}

/**
 * Unmute a tab ONLY if this extension muted it (`mutedInfo.reason === "extension"` and
 * `mutedInfo.extensionId === chrome.runtime.id`). Never override a user's own mute.
 */
export async function unmuteIfOurs(tabId, chromeApi = globalThis.chrome) {
  const tab = await chromeApi.tabs.get(tabId).catch(() => null);
  if (!tab?.mutedInfo?.muted) return false;
  if (tab.mutedInfo.reason !== "extension" || tab.mutedInfo.extensionId !== chromeApi.runtime?.id) {
    return false;
  }
  await chromeApi.tabs.update(tabId, { muted: false }).catch(() => {});
  return true;
}

/** Release an agent tab claimed by the user: unmute if ours and re-allow Memory Saver. */
export async function releaseAgentTab(tabId, chromeApi = globalThis.chrome) {
  const unmuted = await unmuteIfOurs(tabId, chromeApi);
  await chromeApi.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
  return { unmuted };
}

/**
 * Ensure removing `tabId` never closes the user's last browser window, and ungroup before removing
 * so Chrome does not leave orphaned saved tab groups.
 */
export async function leaveLastWindowOpen(tab, chromeApi = globalThis.chrome) {
  const allWindows = (await chromeApi.windows?.getAll?.({ populate: true }).catch(() => [])) || [];
  const normalWindows = allWindows.filter((w) => w && w.type === "normal");

  if (normalWindows.length === 1 && normalWindows[0].id === tab.windowId) {
    const tabsInWin = normalWindows[0].tabs || [];
    if (tabsInWin.length <= 1) {
      await chromeApi.tabs.create({ windowId: tab.windowId, url: "about:blank", active: true });
      return { created: "tab" };
    }
  } else if (normalWindows.length === 0 && allWindows.length === 1 && allWindows[0].id === tab.windowId) {
    const tabsInWin = allWindows[0].tabs || [];
    if (tabsInWin.length <= 1) {
      await chromeApi.windows.create({ url: "about:blank", type: "normal", focused: false });
      return { created: "window" };
    }
  }
  return { created: null };
}

/** Safely close a tab: preserve the last open window, ungroup first, then remove. */
export function closeTabSafely(tabId, { beforeUngroup, afterUngroup } = {}, chromeApi = globalThis.chrome) {
  return enqueueClose(async () => {
    const tab = await chromeApi.tabs.get(tabId).catch(() => null);
    if (!tab) return { closed: false, replacement: null };

    const { created } = await leaveLastWindowOpen(tab, chromeApi);

    if (typeof tab.groupId === "number" && tab.groupId !== TAB_GROUP_ID_NONE && typeof chromeApi.tabs?.ungroup === "function") {
      beforeUngroup?.(tabId);
      try {
        await chromeApi.tabs.ungroup(tabId).catch(() => {});
      } finally {
        afterUngroup?.(tabId);
      }
    }

    await chromeApi.tabs.remove(tabId);
    return { closed: true, replacement: created };
  });
}

/**
 * Close agent-opened tabs that no socket has used for `idleCleanupMinutes` minutes.
 * Never closes user tabs, `keepOpen` tabs, or tabs currently in handoff.
 */
export async function sweepIdleAgentTabs({
  agentTabs,
  keepOpenTabs = new Set(),
  lastUsedAt = new Map(),
  idleCleanupMinutes = 30,
  isTabInHandoff = () => false,
  isTabBusy = () => false,
  closeTab,
  now = Date.now(),
}) {
  const minutes = Number(idleCleanupMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return [];
  const thresholdMs = minutes * 60_000;
  const closed = [];

  for (const tabId of [...agentTabs]) {
    if (!agentTabs.has(tabId)) continue;
    if (keepOpenTabs.has(tabId)) continue;
    if (isTabInHandoff(tabId)) continue;
    if (isTabBusy(tabId)) continue;
    if (!lastUsedAt.has(tabId)) {
      lastUsedAt.set(tabId, now);
      continue;
    }
    const last = lastUsedAt.get(tabId);
    if (now - last >= thresholdMs) {
      try {
        await closeTab(tabId);
        closed.push(tabId);
      } catch {
        /* tab may already be closed */
      }
    }
  }
  return closed;
}

/**
 * Stateful tab-cleanup coordinator tracking `lastUsedAt`, `keepOpenTabs`, safe closes,
 * idle sweeps, session persistence across SW restarts, and uniform `onRemoved` / `onReplaced` purging.
 */
export function createTabCleanup({
  chrome: chromeApi = globalThis.chrome,
  agentTabs,
  lentTabs,
  getSettings = () => ({ idleCleanupMinutes: 30, muteAgentTabs: false }),
  isTabInHandoff = () => false,
  beforeUngroup,
  afterUngroup,
  onCloseTab,
  onPurgeTab,
} = {}) {
  const lastUsedAt = new Map();
  const keepOpenTabs = new Set();
  const purgedBeforeRestore = new Set();
  const keepOpenBeforeRestore = new Map();
  let restored = false;

  let persistTail = Promise.resolve();
  function enqueuePersist(fn) {
    const next = persistTail.then(fn, fn);
    persistTail = next.catch(() => {});
    return next;
  }

  async function restoreState(now = Date.now()) {
    const storage = chromeApi?.storage?.session;
    if (!storage || typeof storage.get !== "function") {
      restored = true;
      return;
    }
    try {
      const stored = (await storage.get(TAB_STATE_STORAGE_KEYS)) || {};
      for (const raw of stored.lentTabs || []) {
        const id = Number(raw);
        if (Number.isInteger(id) && !purgedBeforeRestore.has(id)) lentTabs?.add(id);
      }
      for (const raw of stored.agentTabs || []) {
        const id = Number(raw);
        if (Number.isInteger(id) && !purgedBeforeRestore.has(id)) agentTabs?.add(id);
      }
      for (const raw of stored.keepOpenTabs || []) {
        const id = Number(raw);
        if (Number.isInteger(id) && !purgedBeforeRestore.has(id) && !keepOpenBeforeRestore.has(id)) {
          keepOpenTabs.add(id);
        }
      }
      if (stored.agentTabLastUsed && typeof stored.agentTabLastUsed === "object") {
        for (const [rawId, rawTs] of Object.entries(stored.agentTabLastUsed)) {
          const id = Number(rawId);
          const ts = Number(rawTs);
          if (Number.isInteger(id) && Number.isFinite(ts) && !purgedBeforeRestore.has(id)) {
            const cur = lastUsedAt.get(id);
            if (cur === undefined || ts > cur) lastUsedAt.set(id, ts);
          }
        }
      }
      for (const id of agentTabs || []) {
        if (!lastUsedAt.has(id)) {
          lastUsedAt.set(id, now);
        }
      }
    } catch {
      /* ignore storage errors */
    } finally {
      restored = true;
      purgedBeforeRestore.clear();
      keepOpenBeforeRestore.clear();
    }
  }

  const stateReady = restoreState().catch(() => {});

  async function persistState() {
    await stateReady;
    const storage = chromeApi?.storage?.session;
    if (!storage || typeof storage.set !== "function") return;
    const lastUsedObj = {};
    for (const [id, ts] of lastUsedAt) {
      if (!agentTabs || agentTabs.has(id)) {
        lastUsedObj[String(id)] = ts;
      }
    }
    const payload = {
      lentTabs: lentTabs ? [...lentTabs] : [],
      agentTabs: agentTabs ? [...agentTabs] : [],
      agentTabLastUsed: lastUsedObj,
      keepOpenTabs: [...keepOpenTabs],
    };
    return enqueuePersist(async () => {
      try {
        await storage.set(payload);
      } catch {
        /* ignore storage errors */
      }
    });
  }

  function touchTab(tabId, now = Date.now()) {
    if (typeof tabId === "number") {
      lastUsedAt.set(tabId, now);
      if (!agentTabs || agentTabs.has(tabId)) {
        persistState().catch(() => {});
      }
    }
  }

  function markKeepOpen(tabId, keepOpen) {
    if (!restored) keepOpenBeforeRestore.set(tabId, Boolean(keepOpen));
    if (keepOpen) keepOpenTabs.add(tabId);
    else keepOpenTabs.delete(tabId);
    persistState().catch(() => {});
  }

  async function protect(tabId) {
    const settings = getSettings();
    await protectAgentTab(tabId, { mute: settings.muteAgentTabs === true }, chromeApi);
  }

  async function release(tabId) {
    if (!restored) keepOpenBeforeRestore.set(tabId, false);
    keepOpenTabs.delete(tabId);
    lastUsedAt.delete(tabId);
    persistState().catch(() => {});
    return releaseAgentTab(tabId, chromeApi);
  }

  async function closeSafely(tabId) {
    return closeTabSafely(tabId, { beforeUngroup, afterUngroup }, chromeApi);
  }

  function purge(tabId) {
    if (!restored) purgedBeforeRestore.add(tabId);
    const hadLastUsed = lastUsedAt.delete(tabId);
    const hadKeepOpen = keepOpenTabs.delete(tabId);
    const wasAgent = agentTabs?.delete(tabId) ?? false;
    const wasLent = lentTabs?.delete(tabId) ?? false;
    if (hadLastUsed || hadKeepOpen || wasAgent || wasLent) {
      persistState().catch(() => {});
    }
    onPurgeTab?.(tabId, { wasAgent, wasLent });
    return { wasAgent, wasLent };
  }

  function handleTabRemoved(tabId) {
    return purge(tabId);
  }

  function handleTabReplaced(_addedTabId, removedTabId) {
    return purge(removedTabId);
  }

  async function runIdleSweep(now = Date.now()) {
    await stateReady;
    const settings = getSettings();
    return sweepIdleAgentTabs({
      agentTabs,
      keepOpenTabs,
      lastUsedAt,
      idleCleanupMinutes: settings.idleCleanupMinutes,
      isTabInHandoff,
      closeTab: async (tabId) => {
        if (onCloseTab) {
          await onCloseTab(tabId);
        } else {
          await closeSafely(tabId);
          purge(tabId);
        }
      },
      now,
    });
  }

  return {
    lastUsedAt,
    keepOpenTabs,
    stateReady,
    restoreState,
    persistState,
    touchTab,
    markKeepOpen,
    protect,
    release,
    closeSafely,
    purge,
    handleTabRemoved,
    handleTabReplaced,
    runIdleSweep,
  };
}
