// Agent session -> last agent tab. A tab-less navigate that carries a session key reuses that
// session's tab instead of opening a new one. Keys are short hashes made by the CLI; raw session ids
// never reach the extension. Kept in chrome.storage.session so a worker restart keeps it.

export const SESSION_TABS_STORAGE_KEY = "bcSessionTabs";
const SESSION_KEY_RE = /^[0-9a-f]{8,64}$/;
const MAX_SESSIONS = 200;
// A reserved tab is held from selection until its URL update; a Chrome call that never settles must not
// hold one forever, so a reservation older than this is treated as free again.
export const RESERVATION_TTL_MS = 180_000;

export function validSessionKey(raw) {
  return typeof raw === "string" && SESSION_KEY_RE.test(raw) ? raw : undefined;
}

export function createSessionTabs({
  chrome,
  isAgentTab,
  isTabInHandoff,
  isTabBusy = () => false,
  now = () => Date.now(),
}) {
  const map = new Map();
  const reserved = new Map(); // tabId -> reserved-at ms
  const replaced = new Map(); // removedTabId -> addedTabId, registered synchronously by replace()
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
    Promise.resolve(chrome.storage?.session?.set?.({ [SESSION_TABS_STORAGE_KEY]: Object.fromEntries(map) })).catch(() => {});

  function isReserved(tabId) {
    const at = reserved.get(tabId);
    if (at === undefined) return false;
    if (now() - at < RESERVATION_TTL_MS) return true;
    reserved.delete(tabId);
    return false;
  }

  /** Chrome's own view: the tab still exists, is not pinned, and is in a normal, open window. */
  async function chromeBlocked(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.pinned) return true;
    const win = await chrome.windows?.get?.(tab.windowId)?.catch?.(() => null);
    return Boolean(win && (win.type !== "normal" || win.state === "minimized"));
  }

  return {
    ready,
    /** The session's tab, reserved for this caller: two concurrent calls can never pick the same tab. */
    async reserve(sessionKey) {
      const key = validSessionKey(sessionKey);
      if (!key) return undefined;
      await ready;
      const tabId = map.get(key);
      if (typeof tabId !== "number") return undefined;
      // No await between these checks and the reservation: a second call cannot pick the same tab.
      if (!isAgentTab(tabId) || isTabInHandoff(tabId) || isTabBusy(tabId) || isReserved(tabId)) return undefined;
      reserved.set(tabId, now());
      // Chrome's facts need awaits; the hold above already keeps other callers out of this tab.
      if ((await chromeBlocked(tabId)) || !isAgentTab(tabId) || isTabInHandoff(tabId) || isTabBusy(tabId)) {
        reserved.delete(tabId);
        return undefined;
      }
      return tabId;
    },
    /** Is a reserved tab still this session's, owned, unclaimed and unpinned? Checked before the update. */
    async confirm(sessionKey, tabId) {
      const key = validSessionKey(sessionKey);
      if (!key || !Number.isInteger(tabId) || map.get(key) !== tabId) return false;
      if (!isAgentTab(tabId) || isTabInHandoff(tabId) || (await chromeBlocked(tabId))) return false;
      // Ownership and the mapping can change while Chrome answers; judge them again after the awaits.
      return isAgentTab(tabId) && !isTabInHandoff(tabId) && map.get(key) === tabId;
    },
    /** Drop a reservation. Idempotent, so a late finish frees a tab exactly once. */
    release(tabId) {
      if (Number.isInteger(tabId)) reserved.delete(tabId);
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
      if (!Number.isInteger(tabId)) return;
      // Chrome replaced this id instead of closing the tab: replace() moves the mapping to the new id,
      // and the purge of the old id must not drop it first.
      if (replaced.has(tabId)) return;
      reserved.delete(tabId);
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
    /** Move a session from the tab Chrome replaced to the tab that replaced it. */
    async replace(addedTabId, removedTabId) {
      if (!Number.isInteger(addedTabId) || !Number.isInteger(removedTabId)) return;
      // Registered before the first await so a purge of the old id cannot win the race.
      replaced.set(removedTabId, addedTabId);
      await ready;
      const target = replaced.get(removedTabId);
      replaced.delete(removedTabId);
      reserved.delete(removedTabId);
      let changed = false;
      for (const [k, t] of map) {
        if (t !== removedTabId) continue;
        if (typeof target === "number" && isAgentTab(target)) map.set(k, target);
        else map.delete(k);
        changed = true;
      }
      if (changed) await persist();
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}
