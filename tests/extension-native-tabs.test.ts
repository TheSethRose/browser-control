import { describe, expect, test } from "bun:test";
import type { InvokeResult } from "@agent-software/core";
// @ts-expect-error Plain ES module in extension/lib without .d.ts
import { ATTACHED_STORAGE_KEY, createDebuggerHub, createSerialQueue, isForeignFrameError } from "../extension/lib/debugger-hub.js";
// @ts-expect-error Plain ES module in extension/lib without .d.ts
import { closeTabSafely, createTabCleanup, protectAgentTab, sweepIdleAgentTabs, unmuteIfOurs } from "../extension/lib/tab-cleanup.js";
// @ts-expect-error Plain ES module in extension/lib without .d.ts
import { createWindowGroups, findTargetWindow, normalizeNavigateUrl, openAgentTab, waitForBlankTabReady } from "../extension/lib/window-groups.js";
import { createPageHelperHandler } from "../src/page-runner";

type FakeTab = {
  id: number;
  windowId: number;
  url: string;
  title?: string;
  active: boolean;
  pinned?: boolean;
  status?: string;
  index?: number;
  groupId: number;
  autoDiscardable?: boolean;
  mutedInfo?: { muted: boolean; reason?: string; extensionId?: string };
};

type FakeWindow = {
  id: number;
  type: string;
  state: string;
  focused: boolean;
};

type FakeGroup = {
  id: number;
  windowId: number;
  title?: string;
  color?: string;
  collapsed?: boolean;
};

function makeFakeChrome({
  extensionId = "gdoaemlogkgnnojmjcgjfaphohadilcf",
  windows = [] as FakeWindow[],
  tabs = [] as FakeTab[],
  groups = [] as FakeGroup[],
  lastFocusedWindowId = undefined as number | undefined,
} = {}) {
  let nextTabId = 100;
  let nextWindowId = 50;
  let nextGroupId = 10;

  const winMap = new Map<number, FakeWindow>(windows.map((w) => [w.id, { ...w }]));
  const tabMap = new Map<number, FakeTab>(tabs.map((t) => [t.id, { ...t }]));
  const groupMap = new Map<number, FakeGroup>(groups.map((g) => [g.id, { ...g }]));

  const onUpdatedListeners = new Set<(...args: any[]) => void>();
  const onRemovedListeners = new Set<(...args: any[]) => void>();

  const sessionStore = new Map<string, unknown>();
  const localStore = new Map<string, unknown>();
  const calls: Array<{ api: string; args: unknown[] }> = [];

  const record = (api: string, ...args: unknown[]) => {
    calls.push({ api, args });
  };

  const makeStorage = (store: Map<string, unknown>, label: string) => ({
    async get(keys?: string[]) {
      record(`storage.${label}.get`, keys);
      const out: Record<string, unknown> = {};
      if (!keys) {
        for (const [k, v] of store) out[k] = v;
        return out;
      }
      for (const k of keys) {
        if (store.has(k)) out[k] = store.get(k);
      }
      return out;
    },
    async set(obj: Record<string, unknown>) {
      record(`storage.${label}.set`, obj);
      for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
    },
    async remove(keys: string[]) {
      record(`storage.${label}.remove`, keys);
      for (const k of keys) store.delete(k);
    },
  });

  const debuggerHandlers = {
    attach: async (target: { tabId: number }, version: string) => {
      record("debugger.attach", target, version);
    },
    detach: async (target: { tabId: number }) => {
      record("debugger.detach", target);
    },
    sendCommand: async (target: { tabId: number; sessionId?: string }, method: string, params?: unknown) => {
      record("debugger.sendCommand", target, method, params);
      return {};
    },
  };

  const chrome = {
    runtime: { id: extensionId },
    storage: {
      session: makeStorage(sessionStore, "session"),
      local: makeStorage(localStore, "local"),
    },
    windows: {
      async getLastFocused(_opts?: unknown) {
        record("windows.getLastFocused", _opts);
        const id = lastFocusedWindowId ?? [...winMap.values()].find((w) => w.focused)?.id;
        if (id === undefined || !winMap.has(id)) throw new Error("No window");
        return { ...winMap.get(id)! };
      },
      async getAll(opts?: { populate?: boolean }) {
        record("windows.getAll", opts);
        return [...winMap.values()].map((w) => ({
          ...w,
          ...(opts?.populate ? { tabs: [...tabMap.values()].filter((t) => t.windowId === w.id) } : {}),
        }));
      },
      async get(windowId: number) {
        const w = winMap.get(windowId);
        if (!w) throw new Error(`No window ${windowId}`);
        return { ...w };
      },
      async create(opts: { url?: string; focused?: boolean; type?: string }) {
        record("windows.create", opts);
        const id = nextWindowId++;
        const win: FakeWindow = {
          id,
          type: opts.type || "normal",
          state: "normal",
          focused: Boolean(opts.focused),
        };
        winMap.set(id, win);
        const tabId = nextTabId++;
        const tab: FakeTab = {
          id: tabId,
          windowId: id,
          url: opts.url || "about:blank",
          active: true,
          status: "complete",
          index: 0,
          groupId: -1,
        };
        tabMap.set(tabId, tab);
        return { ...win, tabs: [{ ...tab }] };
      },
      async update(windowId: number, patch: Partial<FakeWindow>) {
        record("windows.update", windowId, patch);
        const w = winMap.get(windowId);
        if (!w) throw new Error(`No window ${windowId}`);
        Object.assign(w, patch);
        return { ...w };
      },
    },
    tabs: {
      onUpdated: {
        addListener: (fn: (...args: any[]) => void) => onUpdatedListeners.add(fn),
        removeListener: (fn: (...args: any[]) => void) => onUpdatedListeners.delete(fn),
      },
      onRemoved: {
        addListener: (fn: (...args: any[]) => void) => onRemovedListeners.add(fn),
        removeListener: (fn: (...args: any[]) => void) => onRemovedListeners.delete(fn),
      },
      async get(tabId: number) {
        const t = tabMap.get(tabId);
        if (!t) throw new Error(`No tab ${tabId}`);
        return { ...t, mutedInfo: t.mutedInfo ? { ...t.mutedInfo } : undefined };
      },
      async query(q: { windowId?: number; groupId?: number; active?: boolean } = {}) {
        return [...tabMap.values()]
          .filter((t) => (q.windowId === undefined ? true : t.windowId === q.windowId))
          .filter((t) => (q.groupId === undefined ? true : t.groupId === q.groupId))
          .filter((t) => (q.active === undefined ? true : t.active === q.active))
          .map((t) => ({ ...t }));
      },
      async create(opts: { url?: string; windowId?: number; active?: boolean; status?: string }) {
        record("tabs.create", opts);
        const windowId = opts.windowId ?? [...winMap.keys()][0] ?? 1;
        const winTabs = [...tabMap.values()].filter((t) => t.windowId === windowId);
        if (opts.active) {
          for (const t of winTabs) t.active = false;
        }
        const id = nextTabId++;
        const tab: FakeTab = {
          id,
          windowId,
          url: opts.url || "about:blank",
          active: opts.active !== false,
          status: opts.status || "complete",
          index: winTabs.length,
          groupId: -1,
        };
        tabMap.set(id, tab);
        return { ...tab };
      },
      async update(tabId: number, patch: Record<string, unknown>) {
        record("tabs.update", tabId, patch);
        const t = tabMap.get(tabId);
        if (!t) throw new Error(`No tab ${tabId}`);
        if (patch["active"] === true) {
          for (const other of tabMap.values()) {
            if (other.windowId === t.windowId) other.active = false;
          }
          t.active = true;
        }
        if ("url" in patch) t.url = String(patch["url"]);
        if ("autoDiscardable" in patch) t.autoDiscardable = Boolean(patch["autoDiscardable"]);
        if ("muted" in patch) {
          t.mutedInfo = {
            muted: Boolean(patch["muted"]),
            reason: "extension",
            extensionId,
          };
        }
        return { ...t };
      },
      async move(tabId: number, opts: { windowId?: number; index?: number }) {
        record("tabs.move", tabId, opts);
        const t = tabMap.get(tabId);
        if (!t) throw new Error(`No tab ${tabId}`);
        if (opts.windowId !== undefined) t.windowId = opts.windowId;
        if (opts.index !== undefined && opts.index >= 0) t.index = opts.index;
        return { ...t };
      },
      async group(opts: { groupId?: number; createProperties?: { windowId: number }; tabIds: number[] }) {
        record("tabs.group", opts);
        let groupId = opts.groupId;
        if (groupId === undefined) {
          groupId = nextGroupId++;
          const windowId = opts.createProperties?.windowId ?? tabMap.get(opts.tabIds[0]!)?.windowId ?? 1;
          groupMap.set(groupId, { id: groupId, windowId, title: "", color: "grey", collapsed: false });
        }
        for (const tid of opts.tabIds) {
          const t = tabMap.get(tid);
          if (t) t.groupId = groupId;
        }
        return groupId;
      },
      async ungroup(tabIds: number | number[]) {
        record("tabs.ungroup", tabIds);
        const list = Array.isArray(tabIds) ? tabIds : [tabIds];
        for (const tid of list) {
          const t = tabMap.get(tid);
          if (t) t.groupId = -1;
        }
      },
      async remove(tabId: number) {
        record("tabs.remove", tabId);
        tabMap.delete(tabId);
      },
    },
    tabGroups: {
      async query(q: { windowId?: number } = {}) {
        return [...groupMap.values()]
          .filter((g) => (q.windowId === undefined ? true : g.windowId === q.windowId))
          .map((g) => ({ ...g }));
      },
      async update(groupId: number, patch: Partial<FakeGroup>) {
        record("tabGroups.update", groupId, patch);
        const g = groupMap.get(groupId);
        if (!g) throw new Error(`No group ${groupId}`);
        Object.assign(g, patch);
        return { ...g };
      },
      async move(groupId: number, opts: { index: number }) {
        record("tabGroups.move", groupId, opts);
        for (const t of tabMap.values()) {
          if (t.groupId === groupId) t.index = opts.index;
        }
        return groupMap.get(groupId);
      },
    },
    debugger: {
      attach: (...args: [any, any]) => debuggerHandlers.attach(...args),
      detach: (...args: [any]) => debuggerHandlers.detach(...args),
      sendCommand: (...args: [any, any, any]) => debuggerHandlers.sendCommand(...args),
    },
  };

  return {
    chrome,
    calls,
    winMap,
    tabMap,
    groupMap,
    sessionStore,
    localStore,
    debuggerHandlers,
    emitTabUpdated(tabId: number, changeInfo: Record<string, unknown>) {
      const tab = tabMap.get(tabId);
      if (tab && "status" in changeInfo) tab.status = String(changeInfo["status"]);
      for (const fn of [...onUpdatedListeners]) fn(tabId, changeInfo, tab ? { ...tab } : undefined);
    },
    emitTabRemoved(tabId: number) {
      tabMap.delete(tabId);
      for (const fn of [...onRemovedListeners]) fn(tabId);
    },
  };
}

describe("window-groups", () => {
  test("placement skips minimized windows and picks a non-minimized normal window", async () => {
    const fake = makeFakeChrome({
      windows: [
        { id: 1, type: "normal", state: "minimized", focused: true },
        { id: 2, type: "popup", state: "normal", focused: false },
        { id: 3, type: "normal", state: "normal", focused: false },
      ],
      lastFocusedWindowId: 1,
    });

    const target = await findTargetWindow(fake.chrome);
    expect(target?.id).toBe(3);

    const tab = await openAgentTab({ url: "https://example.com" }, fake.chrome);
    expect(tab?.windowId).toBe(3);
    expect(tab?.active).toBe(false);
    const createCall = fake.calls.find((c) => c.api === "tabs.create");
    expect(createCall?.args[0]).toEqual({ url: "https://example.com", windowId: 3, active: false });
  });

  test("placement creates an unfocused normal window when all normal windows are minimized", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "minimized", focused: false }],
      lastFocusedWindowId: 1,
    });

    const tab = await openAgentTab({ url: "https://example.com" }, fake.chrome);
    expect(tab?.windowId).not.toBe(1);
    const winCreate = fake.calls.find((c) => c.api === "windows.create");
    expect(winCreate?.args[0]).toEqual({ url: "https://example.com", focused: false, type: "normal" });
  });

  test("about:blank# fragment is stripped before navigate and waits for loading blank tab", async () => {
    expect(normalizeNavigateUrl("about:blank#section")).toBe("about:blank");
    expect(normalizeNavigateUrl("https://example.com/page#hash")).toBe("https://example.com/page#hash");

    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 7, windowId: 1, url: "about:blank", active: false, status: "loading", groupId: -1 }],
    });

    const waiting = waitForBlankTabReady(7, fake.chrome, 2_000);
    setTimeout(() => fake.emitTabUpdated(7, { status: "complete" }), 10);
    const ready = await waiting;
    expect(ready?.status).toBe("complete");
  });

  test("shared Agents group places after pinned tabs, auto-collapses, expands on handoff, and releases claimed tabs", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: "https://pinned.test", active: false, pinned: true, index: 0, groupId: -1 },
        { id: 2, windowId: 1, url: "https://user.test", active: true, pinned: false, index: 1, groupId: -1 },
        { id: 3, windowId: 1, url: "https://agent.test", active: false, pinned: false, index: 2, groupId: -1 },
      ],
    });
    const agentTabs = new Set([3]);
    const handoffTabs = new Set<number>();
    const claimed: number[] = [];

    const wg = createWindowGroups({
      chrome: fake.chrome,
      getSettings: () => ({ tabGroupMode: "shared", autoCollapse: true }),
      isAgentTab: (id: number) => agentTabs.has(id),
      isTabInHandoff: (id: number) => handoffTabs.has(id),
      onUserClaimTab: (id: number) => {
        claimed.push(id);
        agentTabs.delete(id);
      },
    });

    const groupId = await wg.addTabToAgentGroup(3);
    expect(typeof groupId).toBe("number");
    const group = fake.groupMap.get(groupId!);
    expect(group?.title).toBe("Agents · 1");
    expect(group?.collapsed).toBe(true);
    const moveCall = fake.calls.find((c) => c.api === "tabGroups.move");
    expect(moveCall?.args).toEqual([groupId, { index: 1 }]);

    // Expand during handoff.
    handoffTabs.add(3);
    await wg.expandGroupForTab(3);
    expect(fake.groupMap.get(groupId!)?.collapsed).toBe(false);
    expect(fake.tabMap.get(3)?.active).toBe(true);

    // Switching back to user tab collapses the group once handoff ends.
    handoffTabs.delete(3);
    fake.tabMap.get(3)!.active = false;
    fake.tabMap.get(2)!.active = true;
    await wg.handleTabActivated({ tabId: 2, windowId: 1 });
    expect(fake.groupMap.get(groupId!)?.collapsed).toBe(true);

    // User drags tab out of the group -> becomes user tab.
    fake.tabMap.get(3)!.groupId = -1;
    await wg.handleTabUpdated(3, { groupId: -1 }, fake.tabMap.get(3)!);
    expect(claimed).toEqual([3]);
    expect(agentTabs.has(3)).toBe(false);
  });

  test("popup adoption restores user active tab, groups popup, marks agent tab, and emits bc.popupAdopted", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: "https://user.test", active: true, index: 0, groupId: -1 },
        { id: 2, windowId: 1, url: "https://agent.test", active: false, index: 1, groupId: 10 },
        { id: 3, windowId: 1, url: "https://popup.test", active: true, index: 2, groupId: -1 },
      ],
      groups: [{ id: 10, windowId: 1, title: "Agents · 1", color: "blue", collapsed: true }],
    });
    const agentTabs = new Set([2]);
    const adoptedEvents: unknown[] = [];

    const wg = createWindowGroups({
      chrome: fake.chrome,
      getSettings: () => ({ tabGroupMode: "shared", autoCollapse: true }),
      isAgentTab: (id: number) => agentTabs.has(id),
      onAdoptPopup: async ({ tabId }: { tabId: number }) => {
        agentTabs.add(tabId);
        await protectAgentTab(tabId, { mute: false }, fake.chrome);
      },
      onPopupAdoptedEvent: (ev: unknown) => adoptedEvents.push(ev),
    });

    // Seed user tab 1 as active before popup 3 activated.
    await wg.handleTabActivated({ tabId: 1, windowId: 1 });
    await wg.handleTabActivated({ tabId: 3, windowId: 1 });

    const handled = await wg.handleCreatedNavigationTarget({
      sourceTabId: 2,
      tabId: 3,
      url: "https://popup.test",
    });

    expect(handled).toBe(true);
    expect(fake.tabMap.get(1)?.active).toBe(true);
    expect(fake.tabMap.get(3)?.autoDiscardable).toBe(false);
    expect(fake.tabMap.get(3)?.groupId).toBe(10);
    expect(fake.groupMap.get(10)?.title).toBe("Agents · 2");
    expect(agentTabs.has(3)).toBe(true);
    expect(adoptedEvents).toEqual([{ openerTabId: 2, tabId: 3, url: "https://popup.test" }]);
  });
});

describe("tab-cleanup", () => {
  test("leaveLastWindowOpen creates a replacement tab and ungroups before removing", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 11, windowId: 1, url: "https://only.test", active: true, groupId: 10 }],
      groups: [{ id: 10, windowId: 1, title: "Agents · 1", color: "blue", collapsed: false }],
    });

    const res = await closeTabSafely(11, {}, fake.chrome);
    expect(res).toEqual({ closed: true, replacement: "tab" });

    const apiOrder = fake.calls.map((c) => c.api);
    const createIdx = apiOrder.indexOf("tabs.create");
    const ungroupIdx = apiOrder.indexOf("tabs.ungroup");
    const removeIdx = apiOrder.indexOf("tabs.remove");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(ungroupIdx).toBeGreaterThan(createIdx);
    expect(removeIdx).toBeGreaterThan(ungroupIdx);
    expect(fake.tabMap.size).toBe(1);
  });

  test("unmuteIfOurs only unmutes tabs muted by this extension", async () => {
    const extId = "gdoaemlogkgnnojmjcgjfaphohadilcf";
    const fake = makeFakeChrome({
      extensionId: extId,
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [
        {
          id: 1,
          windowId: 1,
          url: "https://a.test",
          active: false,
          groupId: -1,
          mutedInfo: { muted: true, reason: "extension", extensionId: extId },
        },
        {
          id: 2,
          windowId: 1,
          url: "https://b.test",
          active: false,
          groupId: -1,
          mutedInfo: { muted: true, reason: "user" },
        },
        {
          id: 3,
          windowId: 1,
          url: "https://c.test",
          active: false,
          groupId: -1,
          mutedInfo: { muted: true, reason: "extension", extensionId: "other-ext-id" },
        },
      ],
    });

    expect(await unmuteIfOurs(1, fake.chrome)).toBe(true);
    expect(fake.tabMap.get(1)?.mutedInfo?.muted).toBe(false);

    expect(await unmuteIfOurs(2, fake.chrome)).toBe(false);
    expect(fake.tabMap.get(2)?.mutedInfo?.muted).toBe(true);

    expect(await unmuteIfOurs(3, fake.chrome)).toBe(false);
    expect(fake.tabMap.get(3)?.mutedInfo?.muted).toBe(true);
  });

  test("idle cleanup closes idle agent tabs, never closes user tabs, respects keepOpen/handoff/Never", async () => {
    const now = 10_000_000;
    const agentTabs = new Set([2, 3, 4, 5]);
    const keepOpenTabs = new Set([4]);
    const lastUsedAt = new Map<number, number>([
      [1, 0], // user tab (not in agentTabs) — must NEVER close
      [2, now - 31 * 60_000], // stale agent tab -> closes
      [3, now - 5 * 60_000], // fresh agent tab -> stays
      [4, now - 60 * 60_000], // keepOpen -> stays
      [5, now - 60 * 60_000], // in handoff -> stays
    ]);
    const closed: number[] = [];

    // "Never" (0) closes nothing.
    const none = await sweepIdleAgentTabs({
      agentTabs,
      keepOpenTabs,
      lastUsedAt,
      idleCleanupMinutes: 0,
      isTabInHandoff: (id: number) => id === 5,
      closeTab: async (id: number) => {
        closed.push(id);
      },
      now,
    });
    expect(none).toEqual([]);

    // 30-minute threshold closes only tab 2.
    const swept = await sweepIdleAgentTabs({
      agentTabs,
      keepOpenTabs,
      lastUsedAt,
      idleCleanupMinutes: 30,
      isTabInHandoff: (id: number) => id === 5,
      closeTab: async (id: number) => {
        closed.push(id);
      },
      now,
    });
    expect(swept).toEqual([2]);
    expect(closed).toEqual([2]);
  });

  test("onReplaced purges removed tab state identically to onRemoved", () => {
    const fake = makeFakeChrome();
    const agentTabs = new Set([20, 21]);
    const lentTabs = new Set([20]);
    const purged: number[] = [];

    const cleanup = createTabCleanup({
      chrome: fake.chrome,
      agentTabs,
      lentTabs,
      onPurgeTab: (id: number) => purged.push(id),
    });

    cleanup.touchTab(20, 100);
    cleanup.markKeepOpen(20, true);
    cleanup.handleTabReplaced(99, 20);

    expect(agentTabs.has(20)).toBe(false);
    expect(lentTabs.has(20)).toBe(false);
    expect(cleanup.lastUsedAt.has(20)).toBe(false);
    expect(cleanup.keepOpenTabs.has(20)).toBe(false);
    expect(purged).toEqual([20]);

    cleanup.handleTabRemoved(21);
    expect(agentTabs.has(21)).toBe(false);
    expect(purged).toEqual([20, 21]);
  });
});

describe("debugger-hub", () => {
  test("SW-restore re-attaches only ownedByUs tabs and sends focus emulation", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [
        { id: 10, windowId: 1, url: "https://owned.test", active: false, groupId: -1 },
        { id: 11, windowId: 1, url: "https://devtools-owned.test", active: false, groupId: -1 },
      ],
    });
    fake.sessionStore.set(ATTACHED_STORAGE_KEY, [
      { tabId: 10, url: "https://owned.test" },
      { tabId: 11, url: "https://devtools-owned.test" },
      { tabId: 999, url: "https://closed.test" },
    ]);

    const attached: number[] = [];
    const detached: number[] = [];
    const focusEnabled: number[] = [];

    fake.debuggerHandlers.sendCommand = async (target, method) => {
      if (method === "Target.getTargetInfo") {
        if (target.tabId === 10) return { targetInfo: { targetId: "t10" } };
        throw new Error("Debugger is not attached to the tab with id: 11");
      }
      if (method === "Emulation.setFocusEmulationEnabled") {
        focusEnabled.push(target.tabId);
      }
      return {};
    };
    fake.debuggerHandlers.detach = async (target) => {
      detached.push(target.tabId);
    };
    fake.debuggerHandlers.attach = async (target) => {
      attached.push(target.tabId);
    };

    const hub = createDebuggerHub({ chrome: fake.chrome, idleMs: 60_000 });
    const res = await hub.restoreAttachedTabs();
    expect(res.restored).toEqual([10]);
    expect(res.skipped).toEqual([11, 999]);
    expect(detached).toEqual([10]); // never detaches tab 11 (DevTools / other ext)
    expect(attached).toEqual([10]);
    expect(focusEnabled).toEqual([10]);
    expect(hub.attachedTabs.has(10)).toBe(true);
    expect(hub.attachedTabs.has(11)).toBe(false);

    await hub.detachAll();
    await hub.clearPersisted();
    expect(fake.sessionStore.has(ATTACHED_STORAGE_KEY)).toBe(false);
  });

  test("serial queue preserves storage write ordering", async () => {
    const enqueue = createSerialQueue();
    const order: string[] = [];
    const p1 = enqueue(async () => {
      await new Promise((r) => setTimeout(r, 25));
      order.push("first");
    });
    const p2 = enqueue(async () => {
      order.push("second");
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(["first", "second"]);
  });

  test("foreign-frame eviction retries up to 2 times and NEVER runs during handoff", async () => {
    expect(isForeignFrameError(new Error("Cannot access a chrome-extension://abcdef URL"))).toBe(true);

    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 5, windowId: 1, url: "https://login.test", active: true, groupId: -1 }],
    });

    let inHandoff = false;
    let evictions = 0;
    let attempts = 0;

    fake.debuggerHandlers.sendCommand = async (_target, method) => {
      if (method === "Emulation.setFocusEmulationEnabled") return {};
      attempts++;
      if (attempts <= 2) {
        throw new Error("Cannot access a chrome-extension://1password/frame.html URL");
      }
      return { ok: true };
    };

    const hub = createDebuggerHub({
      chrome: fake.chrome,
      idleMs: 60_000,
      isTabInHandoff: () => inHandoff,
      evictForeignFrames: async () => {
        evictions++;
        return { removed: 1 };
      },
    });

    // Normal agent command: evicts and retries twice, succeeding on attempt 3.
    const result = await hub.sendCommand(5, "DOM.getDocument", {});
    expect(result).toEqual({ ok: true });
    expect(evictions).toBe(2);
    expect(attempts).toBe(3);

    // During handoff: NEVER evicts foreign frames and fails immediately without retries.
    inHandoff = true;
    evictions = 0;
    attempts = 0;
    await expect(hub.sendCommand(5, "DOM.getDocument", {})).rejects.toThrow(/chrome-extension:\/\//);
    expect(evictions).toBe(0);
    expect(attempts).toBe(1);

    // Exhausted retries on Page.navigate fall back to chrome.tabs.update.
    inHandoff = false;
    evictions = 0;
    fake.debuggerHandlers.sendCommand = async (_target, method) => {
      if (method === "Emulation.setFocusEmulationEnabled") return {};
      throw new Error("Cannot access a chrome-extension:// URL");
    };
    const navRes = await hub.sendCommand(5, "Page.navigate", { url: "https://fallback.test" });
    expect(navRes).toEqual({ frameId: "" });
    expect(evictions).toBe(2);
    expect(fake.tabMap.get(5)?.url).toBe("https://fallback.test");

    await hub.detachAll();
  });

  test("forwards OOPIF sessionId on sendCommand, onEvent, and child onDetach without dropping parent tab", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 8, windowId: 1, url: "https://parent.test", active: true, groupId: -1 }],
    });

    const sentTargets: unknown[] = [];
    fake.debuggerHandlers.sendCommand = async (target, method) => {
      if (method !== "Emulation.setFocusEmulationEnabled") sentTargets.push(target);
      return { ok: true };
    };

    const events: unknown[] = [];
    const hub = createDebuggerHub({
      chrome: fake.chrome,
      idleMs: 60_000,
      onEvent: (ev: unknown) => events.push(ev),
    });

    await hub.sendCommand(8, "DOM.getDocument", {}, { sessionId: "child-session-1" });
    expect(sentTargets).toEqual([{ tabId: 8, sessionId: "child-session-1" }]);

    hub.handleDebuggerEvent({ tabId: 8, sessionId: "child-session-1" }, "Runtime.consoleAPICalled", { text: "hi" });
    hub.handleDebuggerDetach({ tabId: 8, sessionId: "child-session-1" }, "target_closed");

    // Top-level tab attachment remains alive after child OOPIF detach.
    expect(hub.attachedTabs.has(8)).toBe(true);
    expect(events).toEqual([
      {
        type: "event",
        tabId: 8,
        sessionId: "child-session-1",
        method: "Runtime.consoleAPICalled",
        params: { text: "hi" },
      },
      {
        type: "event",
        tabId: 8,
        sessionId: "child-session-1",
        method: "Target.detachedFromTarget",
        params: { sessionId: "child-session-1", reason: "target_closed" },
      },
    ]);

    await hub.detachAll();
  });
});

describe("page-runner handoff command", () => {
  test("handoff calls handoff_start and resolves to 'handoff: done' on bc.handoffDone", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
      calls.push({ op, input });
      if (op === "read_events") return { ok: true, data: { events: [] } };
      if (op === "execute_cdp") return { ok: true, data: { result: { ok: true, tabId: 42 } } };
      if (op === "wait_for_event") {
        expect(input["method"]).toBe("bc.handoffDone");
        expect(input["targetId"]).toBe("extension:42");
        expect(input["timeoutMs"]).toBe(600_000);
        return {
          ok: true,
          data: { found: true, event: { method: "bc.handoffDone", params: { tabId: 42 } }, timedOut: false },
        };
      }
      return { ok: true, data: {} };
    };

    const handle = createPageHelperHandler(invoke);
    const res = await handle("handoff", { message: "Sign in to continue" }, "extension:42");
    expect(res.ok).toBe(true);
    expect(res.ok ? (res.data as { value: string }).value : "").toBe("handoff: done");

    const startCall = calls.find((c) => c.op === "execute_cdp");
    expect(startCall?.input).toEqual({
      method: "bc.handoffStart",
      params: { message: "Sign in to continue" },
      targetId: "extension:42",
    });
  });

  test("handoff clears overlay and returns clean timeout when wait_for_event times out", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
      calls.push({ op, input });
      if (op === "read_events") return { ok: true, data: { events: [] } };
      if (op === "execute_cdp") return { ok: true, data: { result: { ok: true } } };
      if (op === "wait_for_event") {
        return { ok: true, data: { found: false, timedOut: true, waitedMs: 2_000 } };
      }
      return { ok: true, data: {} };
    };

    const handle = createPageHelperHandler(invoke);
    const res = await handle("handoff", { message: "Solve CAPTCHA", timeout: 2 }, "extension:42");
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.error.message).toBe("HANDOFF_TIMEOUT: handoff timed out after 2s");

    const cdpMethods = calls.filter((c) => c.op === "execute_cdp").map((c) => c.input["method"]);
    expect(cdpMethods).toEqual(["bc.handoffStart", "bc.handoffClear"]);
  });
});
