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
  test("findExtensionContext matches only exact chrome-extension://<id> + known frameId + uniqueId, ignoring foreign worlds", async () => {
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
          context: { id: 1, uniqueId: "u-1", origin: "https://app.test", auxData: { isDefault: true, type: "default", frameId: "MAIN-FRAME" } },
        });
        hub.handleDebuggerEvent(target, "Runtime.executionContextCreated", {
          context: { id: 2, uniqueId: "u-2", origin: "chrome-extension://bitwarden-other-id", auxData: { isDefault: false, type: "isolated", frameId: "MAIN-FRAME" } },
        });
        hub.handleDebuggerEvent(target, "Runtime.executionContextCreated", {
          context: { id: 3, uniqueId: "u-3", origin: `chrome-extension://${extId}`, auxData: { isDefault: false, type: "isolated", frameId: "CHILD-FRAME" } },
        });
        hub.handleDebuggerEvent(target, "Runtime.executionContextCreated", {
          context: { id: 4, uniqueId: "u-4", origin: `chrome-extension://${extId}`, auxData: { isDefault: false, type: "isolated", frameId: "MAIN-FRAME" } },
        });
        return {};
      }
      return {};
    };

    const mainCtx = await hub.findExtensionContext(11, { expectedOrigin: `chrome-extension://${extId}` });
    expect(mainCtx).toMatchObject({ id: 4, uniqueId: "u-4", frameId: "MAIN-FRAME" });

    const childCtx = await hub.findExtensionContext(11, {
      expectedOrigin: `chrome-extension://${extId}`,
      frameId: "CHILD-FRAME",
    });
    expect(childCtx).toMatchObject({ id: 3, uniqueId: "u-3", frameId: "CHILD-FRAME" });

    // Renderer swap reuses numeric id 4 with a new uniqueId; destroying the old uniqueId keeps the new context.
    hub.handleDebuggerEvent({ tabId: 11 }, "Runtime.executionContextCreated", {
      context: { id: 4, uniqueId: "u-4-new", origin: `chrome-extension://${extId}`, auxData: { isDefault: false, type: "isolated", frameId: "MAIN-FRAME" } },
    });
    hub.handleDebuggerEvent({ tabId: 11 }, "Runtime.executionContextDestroyed", {
      executionContextId: 4,
      executionContextUniqueId: "u-4",
    });
    const afterSwap = await hub.findExtensionContext(11, {
      expectedOrigin: `chrome-extension://${extId}`,
      timeoutMs: 10,
    });
    expect(afterSwap).toMatchObject({ id: 4, uniqueId: "u-4-new" });

    // Destroying the active uniqueId clears it.
    hub.handleDebuggerEvent({ tabId: 11 }, "Runtime.executionContextDestroyed", {
      executionContextId: 4,
      executionContextUniqueId: "u-4-new",
    });
    const afterDestroy = await hub.findExtensionContext(11, {
      expectedOrigin: `chrome-extension://${extId}`,
      timeoutMs: 10,
    });
    expect(afterDestroy).toBeUndefined();

    // Main-frame navigation clears cached contexts and accepts the new context uniqueId.
    hub.handleDebuggerEvent({ tabId: 11 }, "Page.frameNavigated", {
      frame: { id: "MAIN-FRAME", url: "https://app.test/next" },
    });
    hub.handleDebuggerEvent({ tabId: 11 }, "Runtime.executionContextCreated", {
      context: { id: 9, uniqueId: "u-9", origin: `chrome-extension://${extId}`, auxData: { isDefault: false, type: "isolated", frameId: "MAIN-FRAME" } },
    });
    const afterNav = await hub.findExtensionContext(11, {
      expectedOrigin: `chrome-extension://${extId}`,
      timeoutMs: 10,
    });
    expect(afterNav).toMatchObject({ id: 9, uniqueId: "u-9" });

    await hub.detachAll();
  });

  test("S1: findExtensionContext refuses to match when target frameId cannot be determined", async () => {
    const extId = "gdoaemlogkgnnojmjcgjfaphohadilcf";
    const fake = makeFakeChrome({
      extensionId: extId,
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 12, windowId: 1, url: "https://app.test", active: true, groupId: -1 }],
    });

    const hub = createDebuggerHub({ chrome: fake.chrome, idleMs: 60_000 });
    fake.debuggerHandlers.sendCommand = async (target, method) => {
      if (method === "Page.getFrameTree") {
        throw new Error("Frame tree unavailable");
      }
      if (method === "Runtime.enable") {
        hub.handleDebuggerEvent(target, "Runtime.executionContextCreated", {
          context: { id: 4, uniqueId: "u-4", origin: `chrome-extension://${extId}`, auxData: { isDefault: false, type: "isolated", frameId: "SOME-FRAME" } },
        });
      }
      return {};
    };

    const ctx = await hub.findExtensionContext(12, { expectedOrigin: `chrome-extension://${extId}`, timeoutMs: 20 });
    expect(ctx).toBeUndefined();
    await hub.detachAll();
  });

  test("S10: findExtensionContext propagates DIALOG_OPEN from the frame lookup", async () => {
    const extId = "gdoaemlogkgnnojmjcgjfaphohadilcf";
    const fake = makeFakeChrome({
      extensionId: extId,
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 13, windowId: 1, url: "https://app.test", active: true, groupId: -1 }],
    });
    const hub = createDebuggerHub({ chrome: fake.chrome, idleMs: 60_000 });
    const seen: string[] = [];
    fake.debuggerHandlers.sendCommand = async (_target, method) => {
      seen.push(method);
      if (method === "Page.getFrameTree") throw new Error("DIALOG_OPEN: a JavaScript confirm dialog is open on tab 13");
      return {};
    };
    await expect(
      hub.findExtensionContext(13, { expectedOrigin: `chrome-extension://${extId}`, forceRefresh: true, timeoutMs: 20 }),
    ).rejects.toThrow(/^DIALOG_OPEN:/);
    expect(seen).not.toContain("Runtime.enable");
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

  test("S4: first handleJavaScriptDialog response does not erase a second dialog opened before the response arrived", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 25, windowId: 1, url: "https://dialog.test", active: true, groupId: -1 }],
    });

    const hub = createDebuggerHub({
      chrome: fake.chrome,
      idleMs: 60_000,
      enablePageOnAttach: true,
    });

    await hub.ensureAttached(25);
    hub.handleDebuggerEvent({ tabId: 25 }, "Page.javascriptDialogOpening", {
      type: "confirm",
      message: "first",
      url: "https://dialog.test",
    });

    fake.debuggerHandlers.sendCommand = async (_target, method) => {
      if (method === "Page.handleJavaScriptDialog") {
        // Chrome closes dialog 1 and opens chained dialog 2 before returning the response.
        hub.handleDebuggerEvent({ tabId: 25 }, "Page.javascriptDialogClosed", { result: true });
        hub.handleDebuggerEvent({ tabId: 25 }, "Page.javascriptDialogOpening", {
          type: "alert",
          message: "second",
          url: "https://dialog.test",
        });
        return {};
      }
      return {};
    };

    await hub.sendCommand(25, "Page.handleJavaScriptDialog", { accept: true });
    expect(hub.getOpenDialog(25)?.message).toBe("second");

    await expect(hub.sendCommand(25, "Runtime.evaluate", { expression: "1" })).rejects.toThrow(/DIALOG_OPEN:.*second/);
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

  test("cross-window: restoreAfterHandoff activates previous tab and refocuses its window while the handoff window is focused", async () => {
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
    const callsBeforeRestore = fake.calls.length;

    const restored = await wg.restoreAfterHandoff(20, prev);
    expect(restored).toEqual({ restoredTabId: 10, restoredWindowId: 1 });
    expect(fake.tabMap.get(10)?.active).toBe(true);
    // S5: the handoff window held focus, so restore hands focus back to the user's window.
    const restoreWindowCalls = fake.calls.slice(callsBeforeRestore).filter((c) => c.api === "windows.update");
    expect(restoreWindowCalls.length).toBe(1);
    expect(fake.winMap.get(1)?.focused).toBe(true);
  });

  test("S5: switching to another app during cross-window handoff does not restore or pull Chrome to foreground", async () => {
    const fake = makeFakeChrome({
      windows: [
        { id: 1, type: "normal", state: "normal", focused: true },
        { id: 2, type: "normal", state: "normal", focused: false },
      ],
      tabs: [
        { id: 10, windowId: 1, url: "https://user-work.test", active: true, groupId: -1 },
        { id: 20, windowId: 2, url: "https://agent.test", active: true, groupId: -1 },
      ],
      lastFocusedWindowId: 2,
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

    // User switches to another OS app: no Chrome window is focused, though getLastFocused still reports window 2.
    fake.winMap.get(1)!.focused = false;
    fake.winMap.get(2)!.focused = false;
    const callsBeforeRestore = fake.calls.length;

    const restored = await wg.restoreAfterHandoff(20, prev);
    expect(restored).toBeNull();
    const restoreCalls = fake.calls.slice(callsBeforeRestore);
    expect(restoreCalls.filter((c) => c.api === "windows.update")).toEqual([]);
    expect(restoreCalls.filter((c) => c.api === "tabs.update")).toEqual([]);
    expect(fake.winMap.get(1)?.focused).toBe(false);
    expect(fake.winMap.get(2)?.focused).toBe(false);
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

  test("S5: starting on the already-focused handoff tab does not capture an unrelated window", async () => {
    const fake = makeFakeChrome({
      windows: [
        { id: 1, type: "normal", state: "normal", focused: true },
        { id: 2, type: "normal", state: "normal", focused: false },
      ],
      tabs: [
        { id: 10, windowId: 1, url: "https://agent.test", active: true, groupId: -1 },
        { id: 20, windowId: 2, url: "https://unrelated.test", active: true, groupId: -1 },
      ],
    });

    const wg = createWindowGroups({
      chrome: fake.chrome,
      getSettings: () => ({ tabGroupMode: "shared", autoCollapse: true }),
      isAgentTab: (id: number) => id === 10,
    });

    const prev = await wg.captureActiveTabForRestore(10);
    expect(prev).toBeNull();
  });

  test("S5: restoreAfterHandoff does not override a tab or window switch made by the user during handoff", async () => {
    // 1. User switches to another tab in the same window during handoff.
    const sameWin = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [
        { id: 1, windowId: 1, url: "https://docs.user.test", active: true, groupId: -1 },
        { id: 2, windowId: 1, url: "https://agent.test", active: false, groupId: -1 },
        { id: 3, windowId: 1, url: "https://mail.user.test", active: false, groupId: -1 },
      ],
    });
    const inHandoff = new Set<number>();
    const wg1 = createWindowGroups({
      chrome: sameWin.chrome,
      getSettings: () => ({ tabGroupMode: "shared", autoCollapse: true }),
      isAgentTab: (id: number) => id === 2,
      isTabInHandoff: (id: number) => inHandoff.has(id),
    });
    const groupId = await wg1.addTabToAgentGroup(2);
    const prev1 = await wg1.captureActiveTabForRestore(2);
    expect(prev1).toEqual({ tabId: 1, windowId: 1 });
    inHandoff.add(2);
    await wg1.expandGroupForTab(2);

    // User switches to tab 3 while handoff is open.
    await sameWin.chrome.tabs.update(3, { active: true });
    inHandoff.delete(2);
    const res1 = await wg1.restoreAfterHandoff(2, prev1);
    expect(res1).toBeNull();
    expect(sameWin.tabMap.get(3)?.active).toBe(true);
    expect(sameWin.tabMap.get(1)?.active).toBe(false);
    expect(sameWin.groupMap.get(groupId!)?.collapsed).toBe(true);

    // 2. User switches to another window during handoff.
    const multiWin = makeFakeChrome({
      windows: [
        { id: 1, type: "normal", state: "normal", focused: true },
        { id: 2, type: "normal", state: "normal", focused: false },
        { id: 3, type: "normal", state: "normal", focused: false },
      ],
      tabs: [
        { id: 10, windowId: 1, url: "https://user-orig.test", active: true, groupId: -1 },
        { id: 20, windowId: 2, url: "https://agent.test", active: true, groupId: -1 },
        { id: 30, windowId: 3, url: "https://user-next.test", active: true, groupId: -1 },
      ],
    });
    const wg2 = createWindowGroups({
      chrome: multiWin.chrome,
      getSettings: () => ({ tabGroupMode: "shared", autoCollapse: true }),
      isAgentTab: (id: number) => id === 20,
    });
    const prev2 = await wg2.captureActiveTabForRestore(20);
    expect(prev2).toEqual({ tabId: 10, windowId: 1 });
    await wg2.expandGroupForTab(20);
    expect(multiWin.winMap.get(2)?.focused).toBe(true);

    // User switches focus to window 3 during handoff.
    await multiWin.chrome.windows.update(3, { focused: true });
    const res2 = await wg2.restoreAfterHandoff(20, prev2);
    expect(res2).toBeNull();
    expect(multiWin.winMap.get(3)?.focused).toBe(true);
    expect(multiWin.winMap.get(1)?.focused).toBe(false);
  });
});

describe("extension backend targetRequest exposes resolve_bc_node", () => {
  test("resolve_bc_node is permitted via TARGET_REQUEST_OPS and routes through extension relay", async () => {
    const savedBackends = process.env["BROWSER_CONTROL_BACKENDS"];
    process.env["BROWSER_CONTROL_BACKENDS"] = "extension";
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
      if (savedBackends === undefined) delete process.env["BROWSER_CONTROL_BACKENDS"];
      else process.env["BROWSER_CONTROL_BACKENDS"] = savedBackends;
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

  test("S2: unanswered dialog detaches once the fixed dialog deferral deadline expires", async () => {
    const fake = makeFakeChrome({
      windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
      tabs: [{ id: 32, windowId: 1, url: "https://dialog.test", active: true, groupId: -1 }],
    });

    const hub = createDebuggerHub({
      chrome: fake.chrome,
      idleMs: 25,
      dialogDeferMs: 80,
      enablePageOnAttach: true,
    });

    await hub.ensureAttached(32);
    hub.handleDebuggerEvent({ tabId: 32 }, "Page.javascriptDialogOpening", {
      type: "alert",
      message: "unanswered",
      url: "https://dialog.test",
    });

    // Still attached after first idle tick (25ms), before dialogDeferMs (80ms).
    await new Promise((r) => setTimeout(r, 45));
    expect(hub.attachedTabs.has(32)).toBe(true);

    // Detached after dialogDeferMs expires even though dialog was never answered.
    await new Promise((r) => setTimeout(r, 80));
    expect(hub.attachedTabs.has(32)).toBe(false);
  });
});

function makeBackgroundChrome(opts: {
  extensionId?: string;
  tabs?: FakeTab[];
  executeScript?: (details: unknown) => Promise<unknown>;
  sendCommand?: (
    target: { tabId: number; sessionId?: string },
    method: string,
    params: unknown,
    emitDebuggerEvent: (source: { tabId: number }, method: string, params: unknown) => void,
  ) => Promise<Record<string, unknown>>;
}) {
  const fake = makeFakeChrome({
    extensionId: opts.extensionId ?? "gdoaemlogkgnnojmjcgjfaphohadilcf",
    windows: [{ id: 1, type: "normal", state: "normal", focused: true }],
    tabs: opts.tabs ?? [{ id: 7, windowId: 1, url: "https://app.test", active: true, groupId: -1 }],
  });
  const noopListener = { addListener: () => {}, removeListener: () => {} };
  const debuggerEventListeners: Array<(source: { tabId: number }, method: string, params: unknown) => void> = [];
  const messageListeners: Array<
    (msg: Record<string, unknown>, sender: unknown, sendResponse: (res: unknown) => void) => unknown
  > = [];
  const emitDebuggerEvent = (source: { tabId: number }, method: string, params: unknown) => {
    for (const fn of debuggerEventListeners) fn(source, method, params);
  };
  const sendRuntimeMessage = (msg: Record<string, unknown>) =>
    new Promise((resolve) => {
      for (const fn of messageListeners) fn(msg, {}, resolve);
    });

  const cdpCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const executeScriptCalls: unknown[] = [];

  fake.debuggerHandlers.sendCommand = async (target, method, params) => {
    cdpCalls.push({ method, params: (params ?? {}) as Record<string, unknown> });
    if (opts.sendCommand) {
      return opts.sendCommand(target, method, params, emitDebuggerEvent);
    }
    return {};
  };

  const fullChrome = {
    ...fake.chrome,
    action: { setIcon: async () => {}, setTitle: async () => {} },
    alarms: { create: () => {}, onAlarm: noopListener },
    notifications: { create: async () => {}, clear: async () => {}, onClicked: noopListener, onButtonClicked: noopListener },
    scripting: {
      executeScript: async (details: unknown) => {
        executeScriptCalls.push(details);
        if (opts.executeScript) return opts.executeScript(details);
        return [{ result: true }];
      },
    },
    runtime: {
      ...fake.chrome.runtime,
      getURL: (p: string) => `chrome-extension://${fake.chrome.runtime.id}/${p}`,
      getManifest: () => ({ version: "2.0.0" }),
      onMessage: { addListener: (fn: (typeof messageListeners)[number]) => messageListeners.push(fn) },
      onStartup: noopListener,
      onInstalled: noopListener,
    },
    debugger: {
      ...fake.chrome.debugger,
      onEvent: { addListener: (fn: (typeof debuggerEventListeners)[number]) => debuggerEventListeners.push(fn) },
      onDetach: noopListener,
    },
    tabs: {
      ...fake.chrome.tabs,
      onActivated: noopListener,
      onUpdated: noopListener,
      onRemoved: noopListener,
      onReplaced: noopListener,
      sendMessage: async () => ({ ok: true }),
    },
    webNavigation: { onCreatedNavigationTarget: noopListener },
    storage: { ...fake.chrome.storage, onChanged: noopListener },
  };

  return { fullChrome, calls: fake.calls, cdpCalls, executeScriptCalls, emitDebuggerEvent, sendRuntimeMessage };
}

async function withBackgroundModule<T>(
  tag: string,
  fullChrome: unknown,
  fn: (bg: {
    resolveBcNode: (tabId: number, refOrSelector: string, opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    runBcSilent: (tabId: number, steps: unknown[], opts?: Record<string, unknown>) => Promise<unknown>;
  }) => Promise<T>,
): Promise<T> {
  const prevChrome = (globalThis as Record<string, unknown>)["chrome"];
  (globalThis as Record<string, unknown>)["chrome"] = fullChrome;
  try {
    const bg = (await import(`../extension/background.js?${tag}`)) as {
      resolveBcNode: (tabId: number, refOrSelector: string, opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
      runBcSilent: (tabId: number, steps: unknown[], opts?: Record<string, unknown>) => Promise<unknown>;
    };
    return await fn(bg);
  } finally {
    if (prevChrome === undefined) {
      delete (globalThis as Record<string, unknown>)["chrome"];
    } else {
      (globalThis as Record<string, unknown>)["chrome"] = prevChrome;
    }
  }
}

describe("background.js resolveBcNode & runBcSilent review fixes (S1, S3, S6, S7)", () => {
  test("S1 & S7: resolveBcNode evaluates with uniqueContextId (not contextId), primes DOM.getDocument, and skips redundant DOM.requestNode", async () => {
    const extId = "gdoaemlogkgnnojmjcgjfaphohadilcf";
    const env = makeBackgroundChrome({
      extensionId: extId,
      sendCommand: async (target, method, _params, emit) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "MAIN-FRAME" } } };
        if (method === "Runtime.enable") {
          emit(target, "Runtime.executionContextCreated", {
            context: {
              id: 4,
              uniqueId: "unique-ext-ctx-4",
              origin: `chrome-extension://${extId}`,
              auxData: { isDefault: false, type: "isolated", frameId: "MAIN-FRAME" },
            },
          });
          return {};
        }
        if (method === "Runtime.evaluate") {
          return { result: { objectId: "obj-el-42", subtype: "node" } };
        }
        return {};
      },
    });

    await withBackgroundModule("s1-s7", env.fullChrome, async (bg) => {
      const resolved = await bg.resolveBcNode(7, "e4", { mode: "ref" });
      expect(resolved).toEqual({ objectId: "obj-el-42" });

      const evalCall = env.cdpCalls.find((c) => c.method === "Runtime.evaluate");
      expect(evalCall?.params["uniqueContextId"]).toBe("unique-ext-ctx-4");
      expect(evalCall?.params["contextId"]).toBeUndefined();
      expect(env.cdpCalls.some((c) => c.method === "DOM.getDocument")).toBe(true);
      expect(env.cdpCalls.some((c) => c.method === "DOM.requestNode")).toBe(false);
    });
  });

  test("S3: revoking tab grant during context lookup prevents direct script injection and DOM stamping", async () => {
    let revokeNow: (() => Promise<void>) | undefined;
    let revokeOnSecondLookup = false;
    let frameTreeCalls = 0;

    // 1. Revoked during first lookup -> blocks initial ISOLATED world executeScript.
    const env1 = makeBackgroundChrome({
      sendCommand: async (_target, method) => {
        if (method === "Page.getFrameTree") {
          await revokeNow?.();
          return { frameTree: { frame: { id: "MAIN-FRAME" } } };
        }
        return {};
      },
    });
    await withBackgroundModule("s3-first", env1.fullChrome, async (bg) => {
      await env1.sendRuntimeMessage({ type: "setMode", mode: "lent" });
      await env1.sendRuntimeMessage({ type: "toggleLend", tabId: 7 });
      revokeNow = async () => {
        await env1.sendRuntimeMessage({ type: "toggleLend", tabId: 7 });
      };
      await expect(bg.resolveBcNode(7, "#box", { mode: "selector" })).rejects.toThrow(/REFUSED/);
      expect(env1.executeScriptCalls.length).toBe(0);
    });

    // 2. Revoked after initial world-ensure injection -> blocks fallback DOM stamp executeScript.
    const env2 = makeBackgroundChrome({
      executeScript: async () => {
        revokeOnSecondLookup = true;
        return [{ result: true }];
      },
      sendCommand: async (_target, method) => {
        if (method === "Page.getFrameTree") {
          frameTreeCalls++;
          if (revokeOnSecondLookup && frameTreeCalls >= 2) {
            await revokeNow?.();
          }
          return {}; // No frame id so context lookup returns undefined and reaches fallback
        }
        return {};
      },
    });
    await withBackgroundModule("s3-fallback", env2.fullChrome, async (bg) => {
      await env2.sendRuntimeMessage({ type: "setMode", mode: "lent" });
      await env2.sendRuntimeMessage({ type: "toggleLend", tabId: 7 });
      revokeNow = async () => {
        await env2.sendRuntimeMessage({ type: "toggleLend", tabId: 7 });
      };
      await expect(bg.resolveBcNode(7, "#box", { mode: "selector" })).rejects.toThrow(/REFUSED/);
      // Only the initial world-ensure executeScript ran before revocation; the DOM stamp never ran.
      expect(env2.executeScriptCalls.length).toBe(1);
    });
  });

  test("S1: resolveBcNode treats Chrome's 'uniqueContextId not found' as stale and retries with refreshed context", async () => {
    const extId = "gdoaemlogkgnnojmjcgjfaphohadilcf";
    let runtimeEnableCount = 0;
    const evalUniqueIds: unknown[] = [];
    const env = makeBackgroundChrome({
      extensionId: extId,
      sendCommand: async (target, method, params, emit) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "MAIN-FRAME" } } };
        if (method === "Runtime.enable") {
          runtimeEnableCount++;
          const uniqueId = runtimeEnableCount === 1 ? "stale-unique-1" : "fresh-unique-2";
          emit(target, "Runtime.executionContextCreated", {
            context: {
              id: 4,
              uniqueId,
              origin: `chrome-extension://${extId}`,
              auxData: { isDefault: false, type: "isolated", frameId: "MAIN-FRAME" },
            },
          });
          return {};
        }
        if (method === "Runtime.evaluate") {
          const p = (params ?? {}) as Record<string, unknown>;
          evalUniqueIds.push(p["uniqueContextId"]);
          if (p["uniqueContextId"] === "stale-unique-1") {
            throw new Error("uniqueContextId not found");
          }
          return { result: { objectId: "obj-refreshed-42", subtype: "node" } };
        }
        return {};
      },
    });

    await withBackgroundModule("s1-unique-ctx-not-found", env.fullChrome, async (bg) => {
      const resolved = await bg.resolveBcNode(7, "e4", { mode: "ref" });
      expect(resolved).toEqual({ objectId: "obj-refreshed-42" });
      expect(evalUniqueIds).toEqual(["stale-unique-1", "fresh-unique-2"]);
      expect(env.cdpCalls.some((c) => c.method === "Runtime.disable")).toBe(true);
    });
  });

  test("S3: revoking grant after fallback stamp skips cleanup injection, and expired markers are rejected and pruned", async () => {
    let revokeNow: (() => Promise<void>) | undefined;
    const stampedMarkers: string[] = [];

    // 1. Revoke right after fallback stamps data-bc-resolve -> cleanup executeScript must not run.
    const envRevoke = makeBackgroundChrome({
      executeScript: async (details) => {
        const d = details as { args?: unknown[] };
        if (Array.isArray(d.args) && typeof d.args[1] === "string" && d.args[1].startsWith("bc-")) {
          stampedMarkers.push(d.args[1]);
          return [{ result: { ok: true } }];
        }
        return [{ result: true }];
      },
      sendCommand: async (_target, method) => {
        if (method === "Page.getFrameTree") return {}; // Force fallback path
        if (method === "DOM.getDocument") {
          await revokeNow?.();
          return { root: { nodeId: 1 } };
        }
        return {};
      },
    });

    await withBackgroundModule("s3-post-stamp-revoke", envRevoke.fullChrome, async (bg) => {
      await envRevoke.sendRuntimeMessage({ type: "setMode", mode: "lent" });
      await envRevoke.sendRuntimeMessage({ type: "toggleLend", tabId: 7 });
      revokeNow = async () => {
        await envRevoke.sendRuntimeMessage({ type: "toggleLend", tabId: 7 });
      };
      await expect(bg.resolveBcNode(7, "#box", { mode: "selector" })).rejects.toThrow(/REFUSED/);
      // Call 1: world-ensure; Call 2: fallback stamp. Cleanup (Call 3) must be skipped after revocation.
      expect(envRevoke.executeScriptCalls.length).toBe(2);
      expect(stampedMarkers.length).toBe(1);
      expect(stampedMarkers[0]).toMatch(/^bc-\d+-/);
    });

    // 2. Expired marker is ignored by resolver (throws NO_MATCH) and stale DOM attributes are pruned on next stamp.
    const removedAttrs: string[] = [];
    const envExpire = makeBackgroundChrome({
      executeScript: async (details) => {
        const d = details as { func?: (...args: unknown[]) => unknown; args?: unknown[] };
        if (Array.isArray(d.args) && typeof d.args[1] === "string" && d.args[1].startsWith("bc-") && typeof d.func === "function") {
          // Run the real stamp function against a minimal fake document containing an expired marker.
          const staleNode = {
            attrs: new Map<string, string>([["data-bc-resolve", "bc-1-expired"]]),
            isConnected: true,
            getAttribute(k: string) {
              return this.attrs.get(k) ?? null;
            },
            setAttribute(k: string, v: string) {
              this.attrs.set(k, v);
            },
            removeAttribute(k: string) {
              removedAttrs.push(`${k}=${this.attrs.get(k)}`);
              this.attrs.delete(k);
            },
          };
          const prevDoc = (globalThis as Record<string, unknown>)["document"];
          (globalThis as Record<string, unknown>)["document"] = {
            querySelectorAll: () => [staleNode],
            querySelector: (sel: string) => (sel === "#box" ? staleNode : null),
          };
          try {
            const out = d.func(...d.args);
            return [{ result: out }];
          } finally {
            if (prevDoc === undefined) delete (globalThis as Record<string, unknown>)["document"];
            else (globalThis as Record<string, unknown>)["document"] = prevDoc;
          }
        }
        return [{ result: true }];
      },
      sendCommand: async (_target, method) => {
        if (method === "Page.getFrameTree") return {};
        if (method === "DOM.getDocument") {
          await new Promise((r) => setTimeout(r, 35));
          return { root: { nodeId: 1 } };
        }
        if (method === "DOM.querySelector") return { nodeId: 99 };
        return {};
      },
    });

    await withBackgroundModule("s3-marker-expiry", envExpire.fullChrome, async (bg) => {
      await expect(bg.resolveBcNode(7, "#box", { mode: "selector", markerTtlMs: 15 })).rejects.toThrow(
        /NO_MATCH:.*expired/,
      );
      expect(removedAttrs).toContain("data-bc-resolve=bc-1-expired");
    });
  });

  test("S6: in-flight dialog whose message contains 'cannot access' reports DIALOG_OPEN, not RESTRICTED_PAGE", async () => {
    const env = makeBackgroundChrome({
      executeScript: () => new Promise(() => {}),
      sendCommand: async (target, method, _params, emit) => {
        if (method === "Page.enable") {
          setTimeout(() => {
            emit(target, "Page.javascriptDialogOpening", {
              type: "alert",
              message: "You cannot access this record",
              url: "https://app.test",
            });
          }, 5);
          return new Promise(() => {});
        }
        if (method === "Runtime.evaluate") return new Promise(() => {});
        return {};
      },
    });

    await withBackgroundModule("s6-cannot-access-dialog", env.fullChrome, async (bg) => {
      let msg = "";
      try {
        await bg.runBcSilent(7, [{ kind: "href" }], {
          timeoutMs: 10_000,
          dialogProbeDelayMs: 25,
          livenessProbeTimeoutMs: 25,
        });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/^DIALOG_OPEN:/);
      expect(msg).toContain("You cannot access this record");
      expect(msg).not.toContain("RESTRICTED_PAGE");
    });
  });

  test("S8: blocked select cancelled on DIALOG_OPEN is never dispatched after dialog closes", async () => {
    let releaseProbe: ((v: unknown) => void) | undefined;
    let actionDispatched = false;
    let helpersInjected = false;

    const env = makeBackgroundChrome({
      executeScript: (details) => {
        const d = details as { files?: string[]; args?: unknown[] };
        if (Array.isArray(d.files) && d.files.length > 0) {
          helpersInjected = true;
          return Promise.resolve([{ result: true }]);
        }
        if (Array.isArray(d.args) && Array.isArray(d.args[0])) {
          actionDispatched = true;
          return Promise.resolve([{ result: { ok: true, values: ["selected"] } }]);
        }
        if (Array.isArray(d.args) && typeof d.args[0] === "number") {
          // First probe (__bc version check) blocks behind the open dialog until dialog closes.
          return new Promise((resolve) => {
            releaseProbe = resolve;
          });
        }
        // Liveness probe (() => 1) also blocks while the modal dialog is open.
        return new Promise(() => {});
      },
      sendCommand: async (target, method, _params, emit) => {
        if (method === "Page.enable") {
          setTimeout(() => {
            emit(target, "Page.javascriptDialogOpening", {
              type: "confirm",
              message: "Confirm action",
              url: "https://app.test",
            });
          }, 5);
          return new Promise(() => {});
        }
        if (method === "Runtime.evaluate") return new Promise(() => {});
        return {};
      },
    });

    await withBackgroundModule("s8-cancel-select", env.fullChrome, async (bg) => {
      await expect(
        bg.runBcSilent(7, [{ kind: "bc", method: "select", args: ["Color", "green"] }], {
          timeoutMs: 10_000,
          dialogProbeDelayMs: 25,
          livenessProbeTimeoutMs: 25,
        }),
      ).rejects.toThrow(/DIALOG_OPEN:.*Confirm action/);

      // Simulate dialog closing and Chrome unblocking the queued probe executeScript.
      env.emitDebuggerEvent({ tabId: 7 }, "Page.javascriptDialogClosed", { result: true });
      releaseProbe?.([{ result: true }]);
      await new Promise((r) => setTimeout(r, 40));

      expect(helpersInjected).toBe(false);
      expect(actionDispatched).toBe(false);
    });
  });

  test("S6 & S9: runBcSilent probes silently before attaching debugger — healthy slow reads stay silent, stalled dialogs attach and fail fast", async () => {
    // 1. Pre-existing dialog on unattached tab -> liveness probe also stalls -> attaches, triggers Page.enable, fails fast with DIALOG_OPEN.
    const envDialog = makeBackgroundChrome({
      executeScript: () => new Promise(() => {}),
      sendCommand: async (target, method, _params, emit) => {
        if (method === "Page.enable") {
          setTimeout(() => {
            emit(target, "Page.javascriptDialogOpening", {
              type: "confirm",
              message: "pre-existing",
              url: "https://app.test",
            });
          }, 5);
          return new Promise(() => {});
        }
        if (method === "Runtime.evaluate") return new Promise(() => {});
        return {};
      },
    });

    await withBackgroundModule("s6-s9-dialog", envDialog.fullChrome, async (bg) => {
      const t0 = Date.now();
      await expect(
        bg.runBcSilent(7, [{ kind: "href" }], {
          timeoutMs: 10_000,
          dialogProbeDelayMs: 30,
          livenessProbeTimeoutMs: 30,
        }),
      ).rejects.toThrow(/DIALOG_OPEN:.*pre-existing/);
      expect(Date.now() - t0).toBeLessThan(500);
      expect(envDialog.calls.some((c) => c.api === "debugger.attach")).toBe(true);
    });

    // 2. Slow healthy read (> dialogProbeDelayMs) -> liveness probe answers -> stays silent (never attaches debugger) and finishes cleanly.
    const envSlow = makeBackgroundChrome({
      executeScript: async (details) => {
        const d = details as { args?: unknown[] };
        if (Array.isArray(d.args) && typeof d.args[0] === "number") {
          return [{ result: true }]; // __bc version check
        }
        if (Array.isArray(d.args) && Array.isArray(d.args[0])) {
          // Slow async read (longer than dialogProbeDelayMs + livenessProbeTimeoutMs).
          await new Promise((r) => setTimeout(r, 120));
          return [{ result: { ok: true, values: ["https://app.test/slow"] } }];
        }
        // Silent liveness probe (() => 1) answers immediately on a responsive renderer.
        return [{ result: 1 }];
      },
    });

    await withBackgroundModule("s6-s9-slow", envSlow.fullChrome, async (bg) => {
      const values = await bg.runBcSilent(7, [{ kind: "href" }], {
        timeoutMs: 5_000,
        dialogProbeDelayMs: 25,
        livenessProbeTimeoutMs: 30,
      });
      expect(values).toEqual(["https://app.test/slow"]);
      expect(envSlow.calls.some((c) => c.api === "debugger.attach")).toBe(false);
      expect(envSlow.cdpCalls.length).toBe(0);
    });
  });
});
