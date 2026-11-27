// Agent session -> last agent tab. A tab-less navigate that carries a session key reuses that
// session's tab instead of opening a new one. Keys are short hashes made by the CLI; raw agent
// session ids never reach the extension. Kept in chrome.storage.session so a worker restart keeps it.

export const SESSION_TABS_STORAGE_KEY = "bcSessionTabs";
const SESSION_KEY_RE = /^[0-9a-f]{8,64}$/;
const MAX_SESSIONS = 200;

export function validSessionKey(raw) {
  return typeof raw === "string" && SESSION_KEY_RE.test(raw) ? raw : undefined;
}

export function createSessionTabs({ chrome, isAgentTab, isTabInHandoff, isTabBusy = () => false }) {
  const map = new Map();
  const ready = Promise.resolve(chrome.storage?.session?.get?.([SESSION_TABS_STORAGE_KEY]))
    .then((stored) => {
      const raw = stored?.[SESSION_TABS_STORAGE_KEY];
      if (!raw || typeof raw !== "object") return;
      for (const [key, tabId] of Object.entries(raw)) {
        if (validSessionKey(key) && Number.isInteger(tabId) && !map.has(key)) map.set(key, tabId);
      }
    })
    .catch(() => {});

  const persist = () =>
    Promise.resolve(chrome.storage?.session?.set?.({ [SESSION_TABS_STORAGE_KEY]: Object.fromEntries(map) })).catch(
      () => {},
    );

  /** Why the session's tab can't be reused, or "" when it can. */
  async function rejectReason(tabId) {
    if (!isAgentTab(tabId)) return "not-agent";
    if (isTabInHandoff(tabId)) return "handoff";
    if (isTabBusy(tabId)) return "busy";
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return "gone";
    if (tab.pinned) return "pinned";
    const win = await chrome.windows?.get?.(tab.windowId)?.catch?.(() => null);
    if (win && (win.type !== "normal" || win.state === "minimized")) return "window";
    return "";
  }

  return {
    ready,
    /** The session's last tab when it is still a free agent tab, else undefined. */
    async reusableTab(sessionKey) {
      const key = validSessionKey(sessionKey);
      if (!key) return undefined;
      await ready;
      const tabId = map.get(key);
      if (typeof tabId !== "number") return undefined;
      return (await rejectReason(tabId)) === "" ? tabId : undefined;
    },
    /** Record `tabId` as the session's last tab. A tab belongs to one session at a time. */
    async remember(sessionKey, tabId) {
      const key = validSessionKey(sessionKey);
      if (!key || !Number.isInteger(tabId) || !isAgentTab(tabId)) return;
      await ready;
      for (const [k, t] of map) if (t === tabId && k !== key) map.delete(k);
      map.delete(key);
      map.set(key, tabId);
      while (map.size > MAX_SESSIONS) map.delete(map.keys().next().value);
      await persist();
    },
    /** Drop every session entry for a closed or user-claimed tab. */
    async forget(tabId) {
      await ready;
      let changed = false;
      for (const [k, t] of map) {
        if (t === tabId) {
          map.delete(k);
          changed = true;
        }
      }
      if (changed) await persist();
    },
    async replace(addedTabId, removedTabId) {
      await ready;
      let changed = false;
      for (const [k, t] of map) {
        if (t === removedTabId) {
          map.set(k, addedTabId);
          changed = true;
        }
      }
      if (changed) await persist();
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}
