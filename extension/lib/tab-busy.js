// Per-tab in-flight request count. A hold frees its slot at most once, so a late finish after a timeout
// never drives the count negative. It is released only when its command settles: a hung command leaves
// the tab busy, so the tab is never reused and the session gets a new tab.

export function createTabBusy() {
  const counts = new Map(); // tabId -> in-flight request count

  function usable(tabId) {
    return typeof tabId === "number" && !Number.isNaN(tabId);
  }

  return {
    /** Take one slot on a tab. The returned release is idempotent and never goes below zero. */
    hold(tabId) {
      if (!usable(tabId)) return () => {};
      counts.set(tabId, (counts.get(tabId) ?? 0) + 1);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        const n = (counts.get(tabId) ?? 0) - 1;
        if (n > 0) counts.set(tabId, n);
        else counts.delete(tabId);
      };
    },
    isBusy(tabId) {
      return usable(tabId) && (counts.get(tabId) ?? 0) > 0;
    },
    count(tabId) {
      return usable(tabId) ? (counts.get(tabId) ?? 0) : 0;
    },
  };
}
