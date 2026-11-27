// Debugger lifecycle hub: on-demand attach/detach with 30 s idle timeout, hold_debugger,
// Emulation.setFocusEmulationEnabled, child OOPIF sessionId forwarding, MV3 service-worker restart
// recovery (serial-queued storage + Target.getTargetInfo ownedByUs probe), and foreign extension
// frame eviction with up to 2 retries (never during a handoff).
// Patterns adapted from anomalyco/browse (MIT License).

export const DEFAULT_DEBUGGER_IDLE_MS = 30_000;
export const MAX_HOLD_MS = 600_000;
export const MAX_FOREIGN_FRAME_RETRIES = 2;
export const ATTACHED_STORAGE_KEY = "bc_attached_tabs";
export const POST_ATTACH_SETUP_TIMEOUT_MS = 1_500;

const DIALOG_SAFE_METHODS = new Set([
  "Page.handleJavaScriptDialog",
  "Target.getTargetInfo",
]);

const DIALOG_ABORTABLE_PREFIXES = [
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Input.dispatchDragEvent",
];

function isDialogAbortable(method) {
  return DIALOG_ABORTABLE_PREFIXES.includes(method);
}

function formatDialogError(tabId, dialog) {
  const type = dialog?.type || "dialog";
  const msg = dialog?.message ? ` ("${String(dialog.message).slice(0, 200)}")` : "";
  return `DIALOG_OPEN: a JavaScript ${type} dialog is open${msg} on tab ${tabId}\nremedy: run dialog accept|dismiss`;
}

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
  enablePageOnAttach = false,
  postAttachTimeoutMs = POST_ATTACH_SETUP_TIMEOUT_MS,
  isTabAllowed = () => true,
  isTabInHandoff = () => false,
  evictForeignFrames = async () => ({ removed: 0 }),
  onEvent = () => {},
  onDetach = () => {},
  onBadgeChange = () => {},
} = {}) {
  const attachedTabs = new Map(); // tabId -> { timer, holdUntil, isolatedContextId, url, ... }
  const inFlightAttach = new Map(); // tabId -> Promise<entry>
  const inFlightDetach = new Map(); // tabId -> Promise<void>
  const lastDetachReason = new Map(); // tabId -> string
  const openDialogs = new Map(); // tabId -> { type, message, url }
  const dialogWaiters = new Map(); // tabId -> Set<(dialog) => void>
  const contextWaiters = new Map(); // tabId -> Set<(ctx) => void>
  const enqueuePersist = createSerialQueue();

  function makeEntry(url = "") {
    return {
      timer: null,
      holdUntil: 0,
      isolatedContextId: undefined,
      url,
      focusEmulationEnabled: false,
      pageEnabled: false,
      runtimeEnabled: false,
      postAttachTimedOut: false,
      mainFrameId: undefined,
      extensionContexts: new Map(), // contextId -> { id, origin, frameId, type, isDefault }
    };
  }

  function subscribeDialogOpening(tabId, fn) {
    let set = dialogWaiters.get(tabId);
    if (!set) {
      set = new Set();
      dialogWaiters.set(tabId, set);
    }
    set.add(fn);
    return () => {
      const cur = dialogWaiters.get(tabId);
      if (!cur) return;
      cur.delete(fn);
      if (cur.size === 0) dialogWaiters.delete(tabId);
    };
  }

  function notifyDialogOpening(tabId, info) {
    const set = dialogWaiters.get(tabId);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(info);
      } catch {
        /* ignore */
      }
    }
  }

  function subscribeContextCreated(tabId, fn) {
    let set = contextWaiters.get(tabId);
    if (!set) {
      set = new Set();
      contextWaiters.set(tabId, set);
    }
    set.add(fn);
    return () => {
      const cur = contextWaiters.get(tabId);
      if (!cur) return;
      cur.delete(fn);
      if (cur.size === 0) contextWaiters.delete(tabId);
    };
  }

  function notifyContextCreated(tabId, ctx) {
    const set = contextWaiters.get(tabId);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(ctx);
      } catch {
        /* ignore */
      }
    }
  }

  function clearTabRuntimeState(tabId) {
    openDialogs.delete(tabId);
    dialogWaiters.delete(tabId);
    contextWaiters.delete(tabId);
  }

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
      if (openDialogs.has(tabId)) {
        touchTimer(tabId);
        return;
      }
      detachTab(tabId).catch(() => {});
    }, ms);
  }

  async function runPostAttachSetup(tabId, entry) {
    if (!entry || attachedTabs.get(tabId) !== entry) return;
    const tasks = [];
    if (!entry.focusEmulationEnabled) {
      tasks.push(
        chromeApi.debugger
          .sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true })
          .then(() => {
            entry.focusEmulationEnabled = true;
          })
          .catch(() => {}),
      );
    }
    if (enablePageOnAttach && !entry.pageEnabled) {
      tasks.push(
        chromeApi.debugger
          .sendCommand({ tabId }, "Page.enable", {})
          .then(() => {
            entry.pageEnabled = true;
          })
          .catch(() => {}),
      );
    }
    if (tasks.length === 0) return;

    let timedOut = false;
    let timer;
    let unsubscribe;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, postAttachTimeoutMs);
    });
    const dialogOpened = new Promise((resolve) => {
      if (openDialogs.has(tabId)) {
        resolve();
        return;
      }
      unsubscribe = subscribeDialogOpening(tabId, () => resolve());
    });
    await Promise.race([Promise.all(tasks), dialogOpened, timeout]);
    clearTimeout(timer);
    unsubscribe?.();
    if (timedOut) {
      entry.postAttachTimedOut = true;
    } else if (!openDialogs.has(tabId)) {
      entry.postAttachTimedOut = false;
    }
  }

  async function ensureAttached(tabId, opts = {}) {
    if (!isTabAllowed(tabId)) {
      throw new Error(
        `REFUSED: tab ${tabId} is not lent to Browser Control (click the extension icon to lend it or switch to All tabs)`,
      );
    }
    const skipFocusEmulation = opts.skipFocusEmulation === true;
    const existing = attachedTabs.get(tabId);
    if (existing) {
      touchTimer(tabId);
      if (!skipFocusEmulation && !existing.focusEmulationEnabled && !existing.postAttachTimedOut) {
        await runPostAttachSetup(tabId, existing);
      }
      return existing;
    }

    let entry;
    if (inFlightAttach.has(tabId)) {
      entry = await inFlightAttach.get(tabId);
    } else {
      const work = (async () => {
        while (inFlightDetach.has(tabId)) {
          await inFlightDetach.get(tabId).catch(() => {});
        }
        lastDetachReason.delete(tabId);
        await chromeApi.debugger.attach({ tabId }, "1.3");
        const tab = await chromeApi.tabs?.get?.(tabId).catch(() => null);
        const created = makeEntry(tab?.url || "");
        attachedTabs.set(tabId, created);
        touchTimer(tabId);
        await persistAttached();
        onBadgeChange();
        return created;
      })().finally(() => {
        inFlightAttach.delete(tabId);
      });

      inFlightAttach.set(tabId, work);
      entry = await work;
    }

    if (!skipFocusEmulation && !entry.focusEmulationEnabled && !entry.postAttachTimedOut) {
      await runPostAttachSetup(tabId, entry);
    }
    return entry;
  }

  async function detachTab(tabId) {
    if (inFlightDetach.has(tabId)) {
      return inFlightDetach.get(tabId);
    }
    const entry = attachedTabs.get(tabId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    attachedTabs.delete(tabId);
    clearTabRuntimeState(tabId);

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
    const isDialogHandler = method === "Page.handleJavaScriptDialog";
    const skipFocusEmulation = opts.skipFocusEmulation === true || DIALOG_SAFE_METHODS.has(method);

    if (!isDialogHandler && opts.allowWhileDialog !== true && openDialogs.has(tabId)) {
      throw new Error(formatDialogError(tabId, openDialogs.get(tabId)));
    }

    for (let attempt = 0; attempt <= MAX_FOREIGN_FRAME_RETRIES; attempt++) {
      const entry = await ensureAttached(tabId, { skipFocusEmulation });
      if (isDialogHandler && enablePageOnAttach && !sessionId && !entry.pageEnabled) {
        // Chrome's PageHandler needs Page.enable on this session before Page.handleJavaScriptDialog
        // can see a dialog that opened prior to attach. Page.enable flips the browser-side handler
        // immediately and emits Page.javascriptDialogOpening even though its renderer reply blocks
        // while the dialog is open, so never wait on it indefinitely.
        let unsubscribe;
        let timer;
        const pageEnable = chromeApi.debugger
          .sendCommand({ tabId }, "Page.enable", {})
          .then(() => {
            entry.pageEnabled = true;
          })
          .catch(() => {});
        const dialogSeen = new Promise((resolve) => {
          if (openDialogs.has(tabId)) {
            resolve();
            return;
          }
          unsubscribe = subscribeDialogOpening(tabId, () => resolve());
        });
        const cap = new Promise((resolve) => {
          timer = setTimeout(resolve, 150);
        });
        await Promise.race([pageEnable, dialogSeen, cap]);
        clearTimeout(timer);
        unsubscribe?.();
      }
      if (!isDialogHandler && opts.allowWhileDialog !== true && openDialogs.has(tabId)) {
        throw new Error(formatDialogError(tabId, openDialogs.get(tabId)));
      }
      lastDetachReason.delete(tabId);
      try {
        const shouldAbortOnDialog =
          !isDialogHandler &&
          opts.abortOnDialog !== false &&
          (opts.abortOnDialog === true || isDialogAbortable(method));
        let result;
        if (shouldAbortOnDialog) {
          let unsubscribe;
          const dialogPromise = new Promise((_, reject) => {
            unsubscribe = subscribeDialogOpening(tabId, (dialog) => {
              reject(new Error(formatDialogError(tabId, dialog)));
            });
          });
          try {
            result = await Promise.race([
              chromeApi.debugger.sendCommand(target, method, params),
              dialogPromise,
            ]);
          } finally {
            unsubscribe?.();
          }
        } else {
          result = await chromeApi.debugger.sendCommand(target, method, params);
        }

        if (!sessionId && entry && attachedTabs.get(tabId) === entry) {
          if (method === "Runtime.enable") entry.runtimeEnabled = true;
          if (method === "Runtime.disable") {
            entry.runtimeEnabled = false;
            entry.extensionContexts.clear();
          }
          if (method === "Page.enable") entry.pageEnabled = true;
          if (isDialogHandler) {
            openDialogs.delete(tabId);
            entry.postAttachTimedOut = false;
            if (!entry.focusEmulationEnabled || (enablePageOnAttach && !entry.pageEnabled)) {
              runPostAttachSetup(tabId, entry).catch(() => {});
            }
          } else {
            entry.postAttachTimedOut = false;
          }
        }
        touchTimer(tabId);
        return result;
      } catch (err) {
        if (String(err?.message || err).startsWith("DIALOG_OPEN:")) {
          throw err;
        }
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
        const entry = makeEntry(tab.url || item.url || "");
        attachedTabs.set(tabId, entry);
        await runPostAttachSetup(tabId, entry);
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

  function matchExtensionContext(entry, expectedOrigin, targetFrameId) {
    if (!entry) return undefined;
    let fallback;
    for (const ctx of entry.extensionContexts.values()) {
      if (ctx.origin !== expectedOrigin) continue;
      if (targetFrameId) {
        if (ctx.frameId === targetFrameId) return ctx.id;
      } else {
        fallback = ctx.id;
      }
    }
    return targetFrameId ? undefined : fallback;
  }

  /**
   * Locate this extension's content-script execution context on `tabId` by exact
   * `origin === "chrome-extension://" + chrome.runtime.id` (and `auxData.frameId`).
   */
  async function findExtensionContext(tabId, { expectedOrigin, frameId, timeoutMs = 400, forceRefresh = false } = {}) {
    const origin = expectedOrigin || (chromeApi?.runtime?.id ? `chrome-extension://${chromeApi.runtime.id}` : "");
    if (!origin) return undefined;
    const entry = await ensureAttached(tabId);

    let targetFrameId = typeof frameId === "string" && frameId !== "" ? frameId : entry.mainFrameId;
    if (!targetFrameId) {
      const tree = await sendCommand(tabId, "Page.getFrameTree", {}).catch(() => null);
      if (typeof tree?.frameTree?.frame?.id === "string") {
        entry.mainFrameId = tree.frameTree.frame.id;
        targetFrameId = entry.mainFrameId;
      }
    }

    if (forceRefresh && entry.runtimeEnabled) {
      await sendCommand(tabId, "Runtime.disable", {}).catch(() => {});
    }

    if (!entry.runtimeEnabled) {
      await sendCommand(tabId, "Runtime.enable", {});
    }

    const immediate = matchExtensionContext(entry, origin, targetFrameId);
    if (immediate !== undefined) return immediate;

    if (timeoutMs <= 0) return undefined;
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const done = (id) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(id);
      };
      const unsubscribe = subscribeContextCreated(tabId, (ctx) => {
        if (ctx.origin !== origin) return;
        if (targetFrameId && ctx.frameId !== targetFrameId) return;
        done(ctx.id);
      });
      timer = setTimeout(() => {
        done(matchExtensionContext(entry, origin, targetFrameId));
      }, timeoutMs);
      const afterSubscribe = matchExtensionContext(entry, origin, targetFrameId);
      if (afterSubscribe !== undefined) done(afterSubscribe);
    });
  }

  function invalidateExtensionContext(tabId, contextId) {
    const entry = attachedTabs.get(tabId);
    if (!entry) return;
    if (contextId === undefined) {
      entry.extensionContexts.clear();
    } else {
      entry.extensionContexts.delete(contextId);
    }
  }

  function handleDebuggerEvent(source, method, params) {
    if (typeof source?.tabId !== "number") return;
    const entry = attachedTabs.get(source.tabId);
    if (!source.sessionId && entry) {
      if (method === "Runtime.executionContextCreated") {
        const ctx = params?.context;
        if (ctx && typeof ctx.id === "number") {
          const info = {
            id: ctx.id,
            origin: String(ctx.origin || ""),
            frameId: ctx.auxData?.frameId ? String(ctx.auxData.frameId) : "",
            type: String(ctx.auxData?.type || ""),
            isDefault: Boolean(ctx.auxData?.isDefault),
          };
          entry.extensionContexts.set(ctx.id, info);
          notifyContextCreated(source.tabId, info);
        }
      } else if (method === "Runtime.executionContextDestroyed") {
        const ctxId = params?.executionContextId;
        if (typeof ctxId === "number") {
          entry.extensionContexts.delete(ctxId);
          if (entry.isolatedContextId === ctxId) entry.isolatedContextId = undefined;
        }
      } else if (method === "Runtime.executionContextsCleared") {
        entry.extensionContexts.clear();
        entry.isolatedContextId = undefined;
      } else if (method === "Page.frameNavigated") {
        if (!params?.frame?.parentId) {
          entry.isolatedContextId = undefined;
          entry.extensionContexts.clear();
          openDialogs.delete(source.tabId);
          if (typeof params?.frame?.id === "string") {
            entry.mainFrameId = params.frame.id;
          }
          if (typeof params?.frame?.url === "string") {
            entry.url = params.frame.url;
            persistAttached().catch(() => {});
          }
        } else if (typeof params?.frame?.id === "string") {
          for (const [id, ctx] of entry.extensionContexts) {
            if (ctx.frameId === params.frame.id) entry.extensionContexts.delete(id);
          }
        }
      }
    }

    if (method === "Page.javascriptDialogOpening") {
      const info = {
        type: String(params?.type || "dialog"),
        message: String(params?.message || ""),
        url: String(params?.url || ""),
      };
      openDialogs.set(source.tabId, info);
      notifyDialogOpening(source.tabId, info);
    } else if (method === "Page.javascriptDialogClosed") {
      openDialogs.delete(source.tabId);
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
    clearTabRuntimeState(source.tabId);
    persistAttached().catch(() => {});
    onBadgeChange();
    onDetach(source, reason);
  }

  function forgetTab(tabId) {
    lastDetachReason.delete(tabId);
    clearTabRuntimeState(tabId);
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
    findExtensionContext,
    invalidateExtensionContext,
    getOpenDialog: (tabId) => openDialogs.get(tabId) || null,
    subscribeDialogOpening,
    formatDialogError,
    size: () => attachedTabs.size,
  };
}
