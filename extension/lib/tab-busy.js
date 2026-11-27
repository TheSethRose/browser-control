// Per-tab in-flight request count. A hold frees its slot at most once, so a late finish after a timeout
// can neither drive the count negative nor keep a tab busy for the life of the worker.

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

/** Bound a call that may never settle. The timer is cleared either way, so no slot leaks. */
export function withDeadline(promise, ms, what = "the request") {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`EXECUTION_FAILED: ${what} did not finish in ${ms} ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
