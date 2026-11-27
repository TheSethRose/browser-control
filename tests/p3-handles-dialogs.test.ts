import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvokeResult } from "@agent-software/core";
// @ts-expect-error Plain ES module in extension/lib without .d.ts
import { createDebuggerHub } from "../extension/lib/debugger-hub.js";
// @ts-expect-error Plain ES module in extension/lib without .d.ts
import { createWindowGroups } from "../extension/lib/window-groups.js";
import { createPageHelperHandler } from "../src/page-runner";

type FakeTab = {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
  pinned?: boolean;
  status?: string;
  index?: number;
  groupId: number;
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
  let nextGroupId = 10;
  const winMap = new Map<number, FakeWindow>(windows.map((w) => [w.id, { ...w }]));
  const tabMap = new Map<number, FakeTab>(tabs.map((t) => [t.id, { ...t }]));
  const groupMap = new Map<number, FakeGroup>(groups.map((g) => [g.id, { ...g }]));
  const sessionStore = new Map<string, unknown>();
  const localStore = new Map<string, unknown>();
  const calls: Array<{ api: string; args: unknown[] }> = [];

  const record = (api: string, ...args: unknown[]) => {
    calls.push({ api, args });
  };

  const makeStorage = (store: Map<string, unknown>) => ({
    async get(keys?: string[]) {
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
      for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
    },
    async remove(keys: string[]) {
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
      session: makeStorage(sessionStore),
      local: makeStorage(localStore),
    },
    windows: {
      async getLastFocused(_opts?: unknown) {
        const id = lastFocusedWindowId ?? [...winMap.values()].find((w) => w.focused)?.id;
        if (id === undefined || !winMap.has(id)) throw new Error("No window");
        return { ...winMap.get(id)! };
      },
      async getAll() {
        return [...winMap.values()].map((w) => ({ ...w }));
      },
      async get(windowId: number) {
        const w = winMap.get(windowId);
        if (!w) throw new Error(`No window ${windowId}`);
        return { ...w };
      },
      async update(windowId: number, patch: Partial<FakeWindow>) {
        record("windows.update", windowId, patch);
        const w = winMap.get(windowId);
        if (!w) throw new Error(`No window ${windowId}`);
        if (patch.focused === true) {
          for (const other of winMap.values()) other.focused = false;
        }
        Object.assign(w, patch);
        return { ...w };
      },
    },
    tabs: {
      async get(tabId: number) {
        const t = tabMap.get(tabId);
        if (!t) throw new Error(`No tab ${tabId}`);
        return { ...t };
      },
      async query(q: { windowId?: number; groupId?: number; active?: boolean } = {}) {
        return [...tabMap.values()]
          .filter((t) => (q.windowId === undefined ? true : t.windowId === q.windowId))
          .filter((t) => (q.groupId === undefined ? true : t.groupId === q.groupId))
          .filter((t) => (q.active === undefined ? true : t.active === q.active))
          .map((t) => ({ ...t }));
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
        return { ...t };
      },
      async group(opts: { groupId?: number; createProperties?: { windowId: number }; tabIds: number[] }) {
        record("tabs.group", opts);
        let groupId = opts.groupId;
        if (groupId === undefined) {
          groupId = nextGroupId++;
          const windowId = opts.createProperties?.windowId ?? tabMap.get(opts.tabIds[0]!)?.windowId ?? 1;
          groupMap.set(groupId, { id: groupId, windowId, title: "", color: "blue", collapsed: false });
        }
        for (const tid of opts.tabIds) {
          const t = tabMap.get(tid);
          if (t) t.groupId = groupId;
        }
        return groupId;
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
        return groupMap.get(groupId);
      },
    },
    debugger: {
      attach: (...args: [any, any]) => debuggerHandlers.attach(...args),
      detach: (...args: [any]) => debuggerHandlers.detach(...args),
      sendCommand: (...args: [any, any, any]) => debuggerHandlers.sendCommand(...args),
    },
  };

  return { chrome, calls, winMap, tabMap, groupMap, debuggerHandlers };
}

describe("element handles: exact extension context matching and invalidation", () => {
  test("findExtensionContext matches only exact chrome-extension://<id> + frameId, ignoring foreign isolated worlds", async () => {
    const extId = "gdoaemlogkgnnojmjcgjfaphohadilcf";
    const fake = makeFakeChrome({
      extensionId: extId,
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 11, windowId: 1, url: "https://app.test", active: true, groupId: -1 }],
    });

    const hub = createDebuggerHub({ chrome: fake.chrome, idleMs: 60_000 });

    fake.debuggerHandlers.sendCommand = async (target, method) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "MAIN-FRAME" } } };
      }
      if (method === "Runtime.enable") {
        // Simulate Chrome emitting multiple isolated worlds (Bitwarden, AdGuard, child frame, ours).
        hub.handleDebuggerEvent(target, "Runtime.executionContextCreated", {
          context: { id: 1, origin: "https://app.test", auxData: { isDefault: true, type: "default", frameId: "MAIN-FRAME" } },
        });
        hub.handleDebuggerEvent(target, "Runtime.executionContextCreated", {
          context: { id: 2, origin: "chrome-extension://bitwarden-other-id", auxData: { isDefault: false, type: "isolated", frameId: "MAIN-FRAME" } },
        });
        hub.handleDebuggerEvent(target, "Runtime.executionContextCreated", {
          context: { id: 3, origin: `chrome-extension://${extId}`, auxData: { isDefault: false, type: "isolated", frameId: "CHILD-FRAME" } },
        });
        hub.handleDebuggerEvent(target, "Runtime.executionContextCreated", {
          context: { id: 4, origin: `chrome-extension://${extId}`, auxData: { isDefault: false, type: "isolated", frameId: "MAIN-FRAME" } },
        });
        return {};
      }
      return {};
    };

    const mainCtx = await hub.findExtensionContext(11, { expectedOrigin: `chrome-extension://${extId}` });
    expect(mainCtx).toBe(4);

    const childCtx = await hub.findExtensionContext(11, {
      expectedOrigin: `chrome-extension://${extId}`,
      frameId: "CHILD-FRAME",
    });
    expect(childCtx).toBe(3);

    // Context destroyed removes that context so a fresh lookup resolves the new one.
    hub.handleDebuggerEvent({ tabId: 11 }, "Runtime.executionContextDestroyed", { executionContextId: 4 });
    const afterDestroy = await hub.findExtensionContext(11, {
      expectedOrigin: `chrome-extension://${extId}`,
      timeoutMs: 10,
    });
    expect(afterDestroy).toBeUndefined();

    // Main-frame navigation clears cached contexts and accepts the new context id.
    hub.handleDebuggerEvent({ tabId: 11 }, "Page.frameNavigated", {
      frame: { id: "MAIN-FRAME", url: "https://app.test/next" },
    });
    hub.handleDebuggerEvent({ tabId: 11 }, "Runtime.executionContextCreated", {
      context: { id: 9, origin: `chrome-extension://${extId}`, auxData: { isDefault: false, type: "isolated", frameId: "MAIN-FRAME" } },
    });
    const afterNav = await hub.findExtensionContext(11, {
      expectedOrigin: `chrome-extension://${extId}`,
      timeoutMs: 10,
    });
    expect(afterNav).toBe(9);

    await hub.detachAll();
  });

  test("page-runner upload and styles route element resolution through resolve_bc_node on extension tabs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bc-p3-upload-"));
    const sampleFile = join(dir, "resume.txt");
    writeFileSync(sampleFile, "hello");

    try {
      const extRequests: Array<{ op: string; params: Record<string, unknown> }> = [];
      const cdpCalls: Array<{ method: string; params: Record<string, unknown> }> = [];

      const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
        if (op === "execute_cdp") {
          const method = String(input["method"]);
          const params = (input["params"] ?? {}) as Record<string, unknown>;
          cdpCalls.push({ method, params });
          if (method === "DOM.requestNode") {
            expect(params["objectId"]).toBe("obj-box-1");
            return { ok: true, data: { result: { nodeId: 77 } } };
          }
          if (method === "CSS.getMatchedStylesForNode") {
            return {
              ok: true,
              data: {
                result: {
                  matchedCSSRules: [
                    {
                      rule: {
                        origin: "regular",
                        selectorList: { text: "#box" },
                        style: { cssProperties: [{ name: "color", value: "rgb(10, 20, 30)" }] },
                      },
                    },
                  ],
                },
              },
            };
          }
          if (method === "CSS.getComputedStyleForNode") {
            return { ok: true, data: { result: { computedStyle: [{ name: "color", value: "rgb(10, 20, 30)" }] } } };
          }
          return { ok: true, data: { result: {} } };
        }
        return { ok: true, data: {} };
      };

      const bcCall = async (input: { steps: readonly { kind: string; method?: string }[] }) => {
        const last = input.steps.at(-1);
        if (last?.method === "locateFile") return { value: "e12" };
        if (last?.method === "baseline") return { value: "http://127.0.0.1/" };
        if (last?.method === "diff") return { value: "+ file resume.txt" };
        return { value: "ok" };
      };

      const extensionRequest = async (op: string, params: Record<string, unknown> = {}) => {
        extRequests.push({ op, params });
        if (op === "resolve_bc_node" && params["ref"] === "e12") {
          return { objectId: "obj-file-12", nodeId: 44 };
        }
        if (op === "resolve_bc_node" && params["ref"] === "#box") {
          return { objectId: "obj-box-1", nodeId: 77 };
        }
        throw new Error(`unexpected op ${op}`);
      };

      const handle = createPageHelperHandler(invoke, undefined, undefined, { bcCall, extensionRequest });

      const upRes = await handle("upload", { ref: "Resume", path: sampleFile }, "extension:5");
      expect(upRes.ok).toBe(true);
      expect(extRequests[0]).toEqual({
        op: "resolve_bc_node",
        params: { targetId: "extension:5", ref: "e12", mode: "ref" },
      });
      expect(cdpCalls.some((c) => c.method === "Runtime.evaluate")).toBe(false);
      expect(cdpCalls.find((c) => c.method === "DOM.setFileInputFiles")?.params).toEqual({
        objectId: "obj-file-12",
        files: [sampleFile],
      });

      const styleRes = await handle("styles", { ref: "#box", properties: ["color"] }, "extension:5");
      expect(styleRes.ok).toBe(true);
      expect(styleRes.ok ? String((styleRes.data as { value: string }).value) : "").toContain("rgb(10, 20, 30)");
      expect(extRequests[1]).toEqual({
        op: "resolve_bc_node",
        params: { targetId: "extension:5", ref: "#box", mode: "selector" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("JS dialogs on extension tabs", () => {
  test("Page.handleJavaScriptDialog succeeds immediately when a dialog opened before attach (without waiting on hung Emulation.setFocusEmulationEnabled)", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 21, windowId: 1, url: "https://dialog.test", active: true, groupId: -1 }],
    });

    const sent: string[] = [];
    fake.debuggerHandlers.sendCommand = async (_target, method, params) => {
      sent.push(method);
      if (method === "Emulation.setFocusEmulationEnabled" || method === "Page.enable") {
        // Simulate Chromium blocking renderer-handled commands while a JS dialog is open.
        return new Promise(() => {});
      }
      if (method === "Page.handleJavaScriptDialog") {
        return { handled: true, params };
      }
      return {};
    };

    const hub = createDebuggerHub({
      chrome: fake.chrome,
      idleMs: 60_000,
      enablePageOnAttach: true,
      postAttachTimeoutMs: 50,
    });

    const started = Date.now();
    const res = await hub.sendCommand(21, "Page.handleJavaScriptDialog", { accept: true });
    expect(Date.now() - started).toBeLessThan(300);
    expect(res).toEqual({ handled: true, params: { accept: true } });
    // Page.enable is fired non-blockingly before Page.handleJavaScriptDialog; focus emulation is skipped until after.
    expect(sent.slice(0, 2)).toEqual(["Page.enable", "Page.handleJavaScriptDialog"]);

    await hub.detachAll();
  });

  test("Page.handleJavaScriptDialog receives pre-existing dialog once Page.enable emits javascriptDialogOpening", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 24, windowId: 1, url: "https://dialog.test", active: true, groupId: -1 }],
    });

    const hub = createDebuggerHub({
      chrome: fake.chrome,
      idleMs: 60_000,
      enablePageOnAttach: true,
      postAttachTimeoutMs: 5_000,
    });

    let pageEnableSeen = false;
    fake.debuggerHandlers.sendCommand = async (target, method, params) => {
      if (method === "Page.enable") {
        pageEnableSeen = true;
        // Browser-side PageHandler emits Page.javascriptDialogOpening immediately while renderer reply hangs.
        setTimeout(() => {
          hub.handleDebuggerEvent(target, "Page.javascriptDialogOpening", {
            type: "confirm",
            message: "pre-attach",
            url: "https://dialog.test",
          });
        }, 5);
        return new Promise(() => {});
      }
      if (method === "Emulation.setFocusEmulationEnabled") {
        return new Promise(() => {});
      }
      if (method === "Page.handleJavaScriptDialog") {
        if (!pageEnableSeen) throw new Error("No dialog is showing");
        return { accepted: (params as { accept?: boolean })?.accept };
      }
      return {};
    };

    const t0 = Date.now();
    const res = await hub.sendCommand(24, "Page.handleJavaScriptDialog", { accept: true });
    expect(Date.now() - t0).toBeLessThan(200);
    expect(res).toEqual({ accepted: true });

    await hub.detachAll();
  });

  test("Page.handleJavaScriptDialog does not deadlock behind an in-flight attach blocked on focus emulation", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 22, windowId: 1, url: "https://dialog.test", active: true, groupId: -1 }],
    });

    let dialogOpen = true;
    fake.debuggerHandlers.sendCommand = async (_target, method) => {
      if (method === "Page.handleJavaScriptDialog") {
        dialogOpen = false;
        return {};
      }
      if (dialogOpen) {
        return new Promise(() => {});
      }
      return { result: { value: 1 } };
    };

    const hub = createDebuggerHub({
      chrome: fake.chrome,
      idleMs: 60_000,
      enablePageOnAttach: true,
      postAttachTimeoutMs: 5_000,
    });

    // Start an attach that hangs on Emulation.setFocusEmulationEnabled (dialog already open).
    const blockedAttach = hub.ensureAttached(22);
    await new Promise((r) => setTimeout(r, 20));

    // Page.handleJavaScriptDialog arrives while the earlier ensureAttached is waiting on post-attach setup.
    const started = Date.now();
    await hub.sendCommand(22, "Page.handleJavaScriptDialog", { accept: false });
    expect(Date.now() - started).toBeLessThan(200);
    expect(dialogOpen).toBe(false);

    // Clean up without waiting 5s.
    await hub.detachAll();
    void blockedAttach;
  });

  test("open dialog fails in-flight and subsequent Runtime.evaluate fast with DIALOG_OPEN + remedy", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 23, windowId: 1, url: "https://dialog.test", active: true, groupId: -1 }],
    });

    const hub = createDebuggerHub({
      chrome: fake.chrome,
      idleMs: 60_000,
      enablePageOnAttach: true,
      postAttachTimeoutMs: 50,
    });

    let dialogOpen = false;
    fake.debuggerHandlers.sendCommand = async (_target, method) => {
      if (method === "Runtime.evaluate") {
        // Trigger a dialog mid-eval.
        setTimeout(() => {
          dialogOpen = true;
          hub.handleDebuggerEvent({ tabId: 23 }, "Page.javascriptDialogOpening", {
            type: "confirm",
            message: "sure?",
            url: "https://dialog.test",
          });
        }, 10);
        return new Promise(() => {});
      }
      if (method === "Page.handleJavaScriptDialog") {
        dialogOpen = false;
        hub.handleDebuggerEvent({ tabId: 23 }, "Page.javascriptDialogClosed", { result: true });
        return {};
      }
      return {};
    };

    // 1. In-flight Runtime.evaluate fails immediately when Page.javascriptDialogOpening fires.
    const t0 = Date.now();
    let err1 = "";
    try {
      await hub.sendCommand(23, "Runtime.evaluate", { expression: "confirm('sure?')" });
    } catch (e) {
      err1 = (e as Error).message;
    }
    expect(Date.now() - t0).toBeLessThan(300);
    expect(err1).toContain("DIALOG_OPEN:");
    expect(err1).toContain('confirm dialog is open ("sure?")');
    expect(err1).toContain("remedy: run dialog accept|dismiss");

    // 2. Subsequent Runtime.evaluate while dialog is open fails immediately without calling sendCommand.
    const t1 = Date.now();
    let err2 = "";
    try {
      await hub.sendCommand(23, "Runtime.evaluate", { expression: "1" });
    } catch (e) {
      err2 = (e as Error).message;
    }
    expect(Date.now() - t1).toBeLessThan(50);
    expect(err2).toContain("DIALOG_OPEN:");
    expect(err2).toContain("remedy: run dialog accept|dismiss");

    // 3. Accepting the dialog clears openDialogs so normal commands work again.
    await hub.sendCommand(23, "Page.handleJavaScriptDialog", { accept: true });
    expect(dialogOpen).toBe(false);
    expect(hub.getOpenDialog(23)).toBeNull();

    fake.debuggerHandlers.sendCommand = async () => ({ result: { value: 42 } });
    const okRes = await hub.sendCommand(23, "Runtime.evaluate", { expression: "42" });
    expect(okRes).toEqual({ result: { value: 42 } });

    await hub.detachAll();
  });
});

describe("handoff end refocuses user's previous tab and re-collapses Agents group", () => {
  test("same window: restoreAfterHandoff reactivates user's previous tab and re-collapses Agents group", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: "https://docs.user.test", active: true, groupId: -1 },
        { id: 2, windowId: 1, url: "https://agent.test", active: false, groupId: -1 },
      ],
    });

    const inHandoff = new Set<number>();
    const wg = createWindowGroups({
      chrome: fake.chrome,
      getSettings: () => ({ tabGroupMode: "shared", autoCollapse: true }),
      isAgentTab: (id: number) => id === 2,
      isTabInHandoff: (id: number) => inHandoff.has(id),
    });

    // Put agent tab 2 into the collapsed "Agents · 1" group while user is on tab 1.
    const groupId = await wg.addTabToAgentGroup(2);
    expect(typeof groupId).toBe("number");
    expect(fake.groupMap.get(groupId!)?.collapsed).toBe(true);
    expect(fake.tabMap.get(1)?.active).toBe(true);

    // Handoff starts: capture previous active tab (tab 1), expand group, activate tab 2.
    const prev = await wg.captureActiveTabForRestore(2);
    expect(prev).toEqual({ tabId: 1, windowId: 1 });
    inHandoff.add(2);
    await wg.expandGroupForTab(2);
    expect(fake.groupMap.get(groupId!)?.collapsed).toBe(false);
    expect(fake.tabMap.get(2)?.active).toBe(true);
    expect(fake.tabMap.get(1)?.active).toBe(false);

    // Handoff ends: clear handoff flag, restore user's tab 1 and re-collapse Agents group.
    inHandoff.delete(2);
    const restored = await wg.restoreAfterHandoff(2, prev);
    expect(restored).toEqual({ restoredTabId: 1, restoredWindowId: 1 });
    expect(fake.tabMap.get(1)?.active).toBe(true);
    expect(fake.tabMap.get(2)?.active).toBe(false);
    expect(fake.groupMap.get(groupId!)?.collapsed).toBe(true);
  });

  test("cross-window: restoreAfterHandoff refocuses the user's original window and tab", async () => {
    const fake = makeFakeChrome({
      windows: [
        { id: 1, type: "normal", state: "normal", focused: true },
        { id: 2, type: "normal", state: "normal", focused: false },
      ],
      tabs: [
        { id: 10, windowId: 1, url: "https://user-work.test", active: true, groupId: -1 },
        { id: 20, windowId: 2, url: "https://agent.test", active: true, groupId: -1 },
      ],
    });

    const wg = createWindowGroups({
      chrome: fake.chrome,
      getSettings: () => ({ tabGroupMode: "shared", autoCollapse: true }),
      isAgentTab: (id: number) => id === 20,
    });

    const prev = await wg.captureActiveTabForRestore(20);
    expect(prev).toEqual({ tabId: 10, windowId: 1 });

    await wg.expandGroupForTab(20);
    expect(fake.winMap.get(2)?.focused).toBe(true);

    const restored = await wg.restoreAfterHandoff(20, prev);
    expect(restored).toEqual({ restoredTabId: 10, restoredWindowId: 1 });
    expect(fake.winMap.get(1)?.focused).toBe(true);
    expect(fake.tabMap.get(10)?.active).toBe(true);
  });

  test("closed previous tab during handoff does not throw", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: "https://docs.user.test", active: true, groupId: -1 },
        { id: 2, windowId: 1, url: "https://agent.test", active: false, groupId: -1 },
      ],
    });

    const wg = createWindowGroups({
      chrome: fake.chrome,
      getSettings: () => ({ tabGroupMode: "shared", autoCollapse: true }),
      isAgentTab: (id: number) => id === 2,
    });

    const prev = await wg.captureActiveTabForRestore(2);
    expect(prev).toEqual({ tabId: 1, windowId: 1 });

    // User closes tab 1 before handoff finishes.
    fake.tabMap.delete(1);
    const restored = await wg.restoreAfterHandoff(2, prev);
    expect(restored).toBeNull();
  });
});

describe("extension backend targetRequest exposes resolve_bc_node", () => {
  test("resolve_bc_node is permitted via TARGET_REQUEST_OPS and routes through extension relay", async () => {
    const { createExtensionBackend, EXTENSION_ORIGIN, PROTOCOL_VERSION, extProofMessage, hmacHex } = await import(
      "../src/backends/extension"
    );
    const { PAGE_HELPERS_VERSION } = await import("../src/page-helpers");
    const token = "a".repeat(64);
    const backend = createExtensionBackend({
      portStart: 49310,
      portEnd: 49315,
      token,
      registerGlobal: true,
      waitConnectMs: 5_000,
    });
    try {
      await backend.start?.();
      const port = backend.getPort()!;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
        headers: { Origin: EXTENSION_ORIGIN },
      } as unknown as string[]);

      const received: Array<{ op: string; params: Record<string, unknown> }> = [];
      const extNonce = "1".repeat(32);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => {
          ws.send(
            JSON.stringify({
              type: "hello",
              profileId: "prof-p3",
              browser: "Chrome",
              version: "2.0.0",
              helpersVersion: PAGE_HELPERS_VERSION,
              protocolVersion: PROTOCOL_VERSION,
              nonce: extNonce,
            }),
          );
        });
        ws.addEventListener("message", (ev) => {
          const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (msg["type"] === "auth.challenge") {
            const proof = hmacHex(token, extProofMessage(port, String(msg["nonce"]), extNonce));
            ws.send(JSON.stringify({ type: "auth.response", proof }));
          } else if (msg["type"] === "welcome") {
            resolve();
          } else if (msg["type"] === "req") {
            received.push({ op: String(msg["op"]), params: (msg["params"] ?? {}) as Record<string, unknown> });
            ws.send(
              JSON.stringify({
                type: "res",
                id: msg["id"],
                ok: true,
                result: { objectId: "obj-shadow-99", nodeId: 99 },
              }),
            );
          }
        });
        ws.addEventListener("error", (e) => reject(e));
      });

      const extReq = (globalThis as Record<symbol, unknown>)[
        Symbol.for("browser-control.extension-request")
      ] as (op: string, params?: Record<string, unknown>) => Promise<unknown>;
      expect(typeof extReq).toBe("function");

      const resolved = await extReq("resolve_bc_node", { targetId: "extension:7", ref: "e4", mode: "ref" });
      expect(resolved).toEqual({ objectId: "obj-shadow-99", nodeId: 99 });
      expect(received).toEqual([{ op: "resolve_bc_node", params: { tabId: 7, ref: "e4", mode: "ref" } }]);

      ws.close();
    } finally {
      await backend.dispose?.();
    }
  });
});

describe("debuggerHub idle detach deferral while dialog is open", () => {
  test("keeps debugger attached across idle timeout while a JS dialog is open, then detaches once closed", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 31, windowId: 1, url: "https://dialog.test", active: true, groupId: -1 }],
    });

    const hub = createDebuggerHub({
      chrome: fake.chrome,
      idleMs: 30,
      enablePageOnAttach: true,
    });

    await hub.ensureAttached(31);
    hub.handleDebuggerEvent({ tabId: 31 }, "Page.javascriptDialogOpening", {
      type: "alert",
      message: "hold",
      url: "https://dialog.test",
    });

    await new Promise((r) => setTimeout(r, 70));
    expect(hub.attachedTabs.has(31)).toBe(true);

    await hub.sendCommand(31, "Page.handleJavaScriptDialog", { accept: true });
    expect(hub.getOpenDialog(31)).toBeNull();

    await new Promise((r) => setTimeout(r, 70));
    expect(hub.attachedTabs.has(31)).toBe(false);
  });
});


