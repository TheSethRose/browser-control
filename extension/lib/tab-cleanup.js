// Agent tab lifecycle hygiene: autoDiscardable:false, optional mute/unmute, leaveLastWindowOpen,
// idle cleanup for agent-opened tabs, and onRemoved/onReplaced purging.
// Patterns adapted from anomalyco/browse (MIT License).

const TAB_GROUP_ID_NONE = -1;

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
export async function closeTabSafely(tabId, { beforeUngroup, afterUngroup } = {}, chromeApi = globalThis.chrome) {
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
    const last = lastUsedAt.get(tabId) ?? 0;
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
 * idle sweeps, and uniform `onRemoved` / `onReplaced` purging.
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

  function touchTab(tabId, now = Date.now()) {
    if (typeof tabId === "number") {
      lastUsedAt.set(tabId, now);
    }
  }

  function markKeepOpen(tabId, keepOpen) {
    if (keepOpen) keepOpenTabs.add(tabId);
    else keepOpenTabs.delete(tabId);
  }

  async function protect(tabId) {
    const settings = getSettings();
    await protectAgentTab(tabId, { mute: settings.muteAgentTabs === true }, chromeApi);
  }

  async function release(tabId) {
    keepOpenTabs.delete(tabId);
    lastUsedAt.delete(tabId);
    return releaseAgentTab(tabId, chromeApi);
  }

  async function closeSafely(tabId) {
    return closeTabSafely(tabId, { beforeUngroup, afterUngroup }, chromeApi);
  }

  function purge(tabId) {
    lastUsedAt.delete(tabId);
    keepOpenTabs.delete(tabId);
    const wasAgent = agentTabs?.delete(tabId) ?? false;
    const wasLent = lentTabs?.delete(tabId) ?? false;
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
