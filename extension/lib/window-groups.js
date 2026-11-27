// Background non-minimized tab placement, collapsed "Agents · N" tab groups, and popup adoption.
// Patterns adapted from anomalyco/browse (MIT License).

const AGENT_GROUP_TITLE_RE = /^Agents(?:\s*·\s*\d+)?$/;
const TAB_GROUP_ID_NONE = -1;

/** Strip `#...` from `about:blank#...` before navigate (avoids Chrome/Vivaldi crash). */
export function normalizeNavigateUrl(rawUrl) {
  const url = String(rawUrl || "");
  if (url.startsWith("about:blank#")) return "about:blank";
  return url;
}

/** Find the last-focused non-minimized normal window, or any non-minimized normal window. */
export async function findTargetWindow(chromeApi = globalThis.chrome) {
  try {
    if (typeof chromeApi.windows?.getLastFocused === "function") {
      const last = await chromeApi.windows.getLastFocused({ windowTypes: ["normal"] });
      if (last && last.type === "normal" && last.state !== "minimized") {
        return last;
      }
    }
  } catch {
    /* fall through to getAll */
  }

  try {
    const all = (await chromeApi.windows?.getAll?.({ populate: false })) || [];
    const normals = all.filter((w) => w && w.type === "normal" && w.state !== "minimized");
    if (normals.length === 0) return null;
    return normals.find((w) => w.focused) || normals[0];
  } catch {
    return null;
  }
}

/** Wait for a newly created `about:blank` tab to leave `status === "loading"`. */
export async function waitForBlankTabReady(tabId, chromeApi = globalThis.chrome, timeoutMs = 5_000) {
  const initial = await chromeApi.tabs.get(tabId).catch(() => null);
  if (!initial || initial.status !== "loading") return initial;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chromeApi.tabs.onUpdated?.removeListener?.(onUpdated);
      chromeApi.tabs.onRemoved?.removeListener?.(onRemoved);
      resolve(tab);
    };

    const onUpdated = (updatedId, changeInfo, tab) => {
      if (updatedId !== tabId) return;
      if (changeInfo?.status && changeInfo.status !== "loading") {
        finish(tab || null);
      }
    };

    const onRemoved = (removedId) => {
      if (removedId === tabId) finish(null);
    };

    const timer = setTimeout(async () => {
      const cur = await chromeApi.tabs.get(tabId).catch(() => null);
      finish(cur);
    }, timeoutMs);

    chromeApi.tabs.onUpdated?.addListener?.(onUpdated);
    chromeApi.tabs.onRemoved?.addListener?.(onRemoved);

    // Re-check once after attaching listeners to avoid a race with status changing before addListener.
    chromeApi.tabs
      .get(tabId)
      .then((cur) => {
        if (!cur || cur.status !== "loading") finish(cur);
      })
      .catch(() => finish(null));
  });
}

/**
 * Open a new agent tab with `active: false` by default in the last-focused non-minimized normal
 * window (creating an unfocused normal window only if `newWindow` is true or all windows are minimized).
 */
export async function openAgentTab(options = {}, chromeApi = globalThis.chrome) {
  const url = normalizeNavigateUrl(options.url || "about:blank");
  const active = options.active === true;
  const newWindow = options.newWindow === true;

  let tab = null;
  if (newWindow) {
    const win = await chromeApi.windows.create({ url, focused: active, type: "normal" });
    tab = win?.tabs?.[0] || null;
  } else {
    const targetWin = await findTargetWindow(chromeApi);
    if (targetWin && typeof targetWin.id === "number") {
      tab = await chromeApi.tabs.create({ url, windowId: targetWin.id, active });
    } else {
      const win = await chromeApi.windows.create({ url, focused: active, type: "normal" });
      tab = win?.tabs?.[0] || null;
    }
  }

  if (tab && typeof tab.id === "number" && url === "about:blank" && tab.status === "loading") {
    const ready = await waitForBlankTabReady(tab.id, chromeApi);
    if (ready) tab = ready;
  }
  return tab;
}

/**
 * Stateful manager for agent tab groups ("Agents · N"), auto-collapse, user-claim detection,
 * and `webNavigation.onCreatedNavigationTarget` popup adoption.
 */
export function createWindowGroups({
  chrome: chromeApi = globalThis.chrome,
  getSettings = () => ({ tabGroupMode: "shared", autoCollapse: true }),
  isAgentTab = () => false,
  isTabInHandoff = () => false,
  onUserClaimTab = () => {},
  onAdoptPopup = async () => {},
  onPopupAdoptedEvent = () => {},
} = {}) {
  const knownGroupIds = new Set();
  const groupedAgentTabs = new Set();
  const internalGroupOps = new Set();
  const currentActiveByWindow = new Map();
  const previousActiveByWindow = new Map();

  function beginInternalGroupOp(tabId) {
    internalGroupOps.add(tabId);
  }

  function endInternalGroupOp(tabId) {
    internalGroupOps.delete(tabId);
  }

  async function seedActiveTabs() {
    try {
      const activeTabs = (await chromeApi.tabs.query({ active: true })) || [];
      for (const tab of activeTabs) {
        if (typeof tab.windowId === "number" && typeof tab.id === "number") {
          currentActiveByWindow.set(tab.windowId, tab.id);
        }
      }
    } catch {
      /* ignore */
    }
  }

  async function findAgentGroupInWindow(windowId) {
    if (!chromeApi.tabGroups?.query) return null;
    try {
      const groups = (await chromeApi.tabGroups.query({ windowId })) || [];
      const found =
        groups.find((g) => knownGroupIds.has(g.id)) ||
        groups.find((g) => AGENT_GROUP_TITLE_RE.test(String(g.title || "")));
      if (found) knownGroupIds.add(found.id);
      return found || null;
    } catch {
      return null;
    }
  }

  async function syncGroup(groupId, { allowCollapse = false } = {}) {
    if (!chromeApi.tabGroups?.update || typeof groupId !== "number" || groupId === TAB_GROUP_ID_NONE) {
      return;
    }
    let groupTabs = [];
    try {
      groupTabs = (await chromeApi.tabs.query({ groupId })) || [];
    } catch {
      knownGroupIds.delete(groupId);
      return;
    }
    if (groupTabs.length === 0) {
      knownGroupIds.delete(groupId);
      return;
    }
    const settings = getSettings();
    const hasActive = groupTabs.some((t) => t.active);
    const hasHandoff = groupTabs.some((t) => isTabInHandoff(t.id));
    const update = {
      title: `Agents · ${groupTabs.length}`,
      color: "blue",
    };
    if (hasHandoff) {
      update.collapsed = false;
    } else if (allowCollapse && settings.autoCollapse !== false && !hasActive) {
      update.collapsed = true;
    }
    await chromeApi.tabGroups.update(groupId, update).catch(() => {});
  }

  async function refreshAgentGroupsInWindow(windowId) {
    if (typeof windowId !== "number") return;
    const group = await findAgentGroupInWindow(windowId);
    if (group) await syncGroup(group.id, { allowCollapse: false });
  }

  async function refreshAllAgentGroups() {
    if (!chromeApi.tabGroups?.query) return;
    try {
      const groups = (await chromeApi.tabGroups.query({})) || [];
      for (const g of groups) {
        if (knownGroupIds.has(g.id) || AGENT_GROUP_TITLE_RE.test(String(g.title || ""))) {
          knownGroupIds.add(g.id);
          await syncGroup(g.id, { allowCollapse: false });
        }
      }
    } catch {
      /* ignore */
    }
  }

  async function addTabToAgentGroup(tabId, { preferredGroupId } = {}) {
    const settings = getSettings();
    if (settings.tabGroupMode === "none" || !chromeApi.tabGroups || typeof chromeApi.tabs?.group !== "function") {
      return null;
    }
    const tab = await chromeApi.tabs.get(tabId).catch(() => null);
    if (!tab || tab.pinned || typeof tab.windowId !== "number") return null;

    beginInternalGroupOp(tabId);
    try {
      let targetGroupId = null;
      if (typeof preferredGroupId === "number" && preferredGroupId !== TAB_GROUP_ID_NONE) {
        const winGroups = (await chromeApi.tabGroups.query?.({ windowId: tab.windowId }).catch(() => [])) || [];
        if (winGroups.some((g) => g.id === preferredGroupId)) {
          targetGroupId = preferredGroupId;
        }
      }
      if (targetGroupId === null) {
        const existing = await findAgentGroupInWindow(tab.windowId);
        if (existing) targetGroupId = existing.id;
      }

      const groupId =
        targetGroupId !== null
          ? await chromeApi.tabs.group({ groupId: targetGroupId, tabIds: [tabId] })
          : await chromeApi.tabs.group({ createProperties: { windowId: tab.windowId }, tabIds: [tabId] });

      knownGroupIds.add(groupId);
      groupedAgentTabs.add(tabId);

      // Position the agent group right after pinned tabs in this window.
      if (typeof chromeApi.tabGroups.move === "function") {
        try {
          const winTabs = (await chromeApi.tabs.query({ windowId: tab.windowId })) || [];
          const pinnedCount = winTabs.filter((t) => t.pinned).length;
          const groupTabs = winTabs.filter((t) => t.groupId === groupId);
          const minIndex = groupTabs.reduce((min, t) => Math.min(min, t.index ?? pinnedCount), Infinity);
          if (minIndex !== pinnedCount) {
            await chromeApi.tabGroups.move(groupId, { index: pinnedCount });
          }
        } catch {
          /* ignore transient Chrome tab-drag lock */
        }
      }

      await syncGroup(groupId, { allowCollapse: true });
      return groupId;
    } catch {
      return null;
    } finally {
      endInternalGroupOp(tabId);
    }
  }

  async function collapseAgentGroupInWindow(windowId, activatedTabId) {
    const settings = getSettings();
    if (settings.autoCollapse === false || !chromeApi.tabGroups?.update) return;
    const group = await findAgentGroupInWindow(windowId);
    if (!group) return;
    const groupTabs = (await chromeApi.tabs.query({ groupId: group.id }).catch(() => [])) || [];
    if (groupTabs.length === 0) {
      knownGroupIds.delete(group.id);
      return;
    }
    if (groupTabs.some((t) => t.id === activatedTabId) || groupTabs.some((t) => isTabInHandoff(t.id))) {
      return;
    }
    await chromeApi.tabGroups.update(group.id, { collapsed: true }).catch(() => {});
  }

  async function expandGroupForTab(tabId) {
    const tab = await chromeApi.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (chromeApi.tabGroups?.update && typeof tab.groupId === "number" && tab.groupId !== TAB_GROUP_ID_NONE) {
      await chromeApi.tabGroups.update(tab.groupId, { collapsed: false }).catch(() => {});
    }
    if (typeof tab.windowId === "number") {
      const win = await chromeApi.windows?.get?.(tab.windowId).catch(() => null);
      if (win?.state === "minimized") {
        await chromeApi.windows.update(tab.windowId, { state: "normal", focused: true }).catch(() => {});
      } else {
        await chromeApi.windows?.update?.(tab.windowId, { focused: true }).catch(() => {});
      }
    }
    await chromeApi.tabs.update(tabId, { active: true }).catch(() => {});
  }

  async function handleTabActivated({ tabId, windowId }) {
    if (typeof windowId === "number" && typeof tabId === "number") {
      const cur = currentActiveByWindow.get(windowId);
      if (cur !== undefined && cur !== tabId) {
        previousActiveByWindow.set(windowId, cur);
      }
      currentActiveByWindow.set(windowId, tabId);
      await collapseAgentGroupInWindow(windowId, tabId);
    }
  }

  async function handleTabUpdated(tabId, changeInfo, tab) {
    if (!isAgentTab(tabId)) return;

    if (changeInfo?.pinned === true) {
      groupedAgentTabs.delete(tabId);
      await onUserClaimTab(tabId);
      if (typeof tab?.windowId === "number") {
        await refreshAgentGroupsInWindow(tab.windowId);
      }
      return;
    }

    if (changeInfo && "groupId" in changeInfo && !internalGroupOps.has(tabId)) {
      const nextGroupId = changeInfo.groupId;
      if (groupedAgentTabs.has(tabId) && !knownGroupIds.has(nextGroupId)) {
        groupedAgentTabs.delete(tabId);
        await onUserClaimTab(tabId);
        if (typeof tab?.windowId === "number") {
          await refreshAgentGroupsInWindow(tab.windowId);
        }
      }
    }
  }

  function handleTabRemoved(tabId) {
    groupedAgentTabs.delete(tabId);
    internalGroupOps.delete(tabId);
    for (const [winId, cur] of currentActiveByWindow) {
      if (cur === tabId) currentActiveByWindow.delete(winId);
    }
    for (const [winId, prev] of previousActiveByWindow) {
      if (prev === tabId) previousActiveByWindow.delete(winId);
    }
    refreshAllAgentGroups().catch(() => {});
  }

  function getRestoreTabForWindow(windowId, popupTabId) {
    const cur = currentActiveByWindow.get(windowId);
    if (typeof cur === "number" && cur !== popupTabId) return cur;
    const prev = previousActiveByWindow.get(windowId);
    if (typeof prev === "number" && prev !== popupTabId) return prev;
    return undefined;
  }

  async function handleCreatedNavigationTarget(details) {
    const sourceTabId = details?.sourceTabId;
    const tabId = details?.tabId;
    if (typeof sourceTabId !== "number" || typeof tabId !== "number") return false;
    if (!isAgentTab(sourceTabId)) return false;

    const openerTab = await chromeApi.tabs.get(sourceTabId).catch(() => null);
    const popupTab = await chromeApi.tabs.get(tabId).catch(() => null);
    const targetWindowId = openerTab?.windowId ?? popupTab?.windowId;
    const restoreTabId =
      typeof targetWindowId === "number" ? getRestoreTabForWindow(targetWindowId, tabId) : undefined;

    // Immediately restore the user's previous active tab so the popup never steals focus.
    if (popupTab && typeof openerTab?.windowId === "number" && popupTab.windowId !== openerTab.windowId) {
      await chromeApi.tabs.move?.(tabId, { windowId: openerTab.windowId, index: -1 }).catch(() => {});
      await chromeApi.windows?.update?.(openerTab.windowId, { focused: true }).catch(() => {});
    }
    if (typeof restoreTabId === "number") {
      await chromeApi.tabs.update(restoreTabId, { active: true }).catch(() => {});
    }

    const url = String(details.url || popupTab?.url || "");
    await onAdoptPopup({ openerTabId: sourceTabId, tabId, url });

    // Move the popup into the opener's group (or the shared Agents group).
    const preferredGroupId =
      typeof openerTab?.groupId === "number" && openerTab.groupId !== TAB_GROUP_ID_NONE
        ? openerTab.groupId
        : undefined;
    if (preferredGroupId !== undefined || getSettings().tabGroupMode !== "none") {
      await addTabToAgentGroup(tabId, { preferredGroupId });
    }

    if (typeof restoreTabId === "number") {
      await chromeApi.tabs.update(restoreTabId, { active: true }).catch(() => {});
      if (typeof targetWindowId === "number") {
        await collapseAgentGroupInWindow(targetWindowId, restoreTabId);
      }
    }

    onPopupAdoptedEvent({ openerTabId: sourceTabId, tabId, url });
    return true;
  }

  return {
    openAgentTab: (opts) => openAgentTab(opts, chromeApi),
    findTargetWindow: () => findTargetWindow(chromeApi),
    seedActiveTabs,
    addTabToAgentGroup,
    syncGroup,
    refreshAgentGroupsInWindow,
    refreshAllAgentGroups,
    collapseAgentGroupInWindow,
    expandGroupForTab,
    beginInternalGroupOp,
    endInternalGroupOp,
    handleTabActivated,
    handleTabUpdated,
    handleTabRemoved,
    handleCreatedNavigationTarget,
    knownGroupIds,
    groupedAgentTabs,
  };
}
