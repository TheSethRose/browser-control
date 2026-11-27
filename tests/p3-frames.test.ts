import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvokeResult } from "@agent-software/core";
// @ts-expect-error Plain ES module in extension/lib without .d.ts
import { createDebuggerHub } from "../extension/lib/debugger-hub.js";
import { extensionFrameOf, extensionFrameTarget, extensionTabOf, parseExtensionTargetId } from "../src/backends/extension";
import { createPageHelperHandler } from "../src/page-runner";

const TOP = "extension:5";
const FRAME = "extension:5@7";
const CROSS_SRC = "http://localhost:49261/frame";

type Step = { kind: string; method?: string; args?: readonly unknown[] };

/** Extension-tab stubs: the top page has no "Cross …" controls; cross-origin frame 7 has them. */
function harness() {
  const cdpCalls: Array<{ method: string; params: Record<string, unknown>; targetId?: string }> = [];
  const extRequests: Array<{ op: string; params: Record<string, unknown> }> = [];
  const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
    if (op === "execute_cdp") {
      cdpCalls.push({
        method: String(input["method"]),
        params: (input["params"] ?? {}) as Record<string, unknown>,
        targetId: input["targetId"] as string | undefined,
      });
    }
    return { ok: true, data: { result: {} } };
  };
  const bcCall = async (input: { targetId?: string; steps: readonly Step[] }) => {
    const last = input.steps.at(-1)!;
    const inFrame = input.targetId === FRAME;
    switch (last.method) {
      case "frames":
        return { value: inFrame ? "[]" : JSON.stringify([{ i: 1, src: CROSS_SRC, title: "" }]) };
      case "locate":
        if (inFrame && last.args?.[0] === "Cross input") return { value: "e1" };
        throw new Error(`NO_MATCH: no control named "${String(last.args?.[0])}". Run snap to see the controls.`);
      case "locateFile":
        if (inFrame && last.args?.[0] === "Cross file") return { value: "e2" };
        throw new Error(`NO_MATCH: no file input matching "${String(last.args?.[0])}". Available:\n- file "Resume" [e8]`);
      case "point":
        return { value: input.steps.length > 1 ? "http://x/ 10 20" : "10 20" };
      case "frameOffset":
        return { value: "100 200" };
      default:
        return { value: "" };
    }
  };
  const extensionRequest = async (op: string, params: Record<string, unknown> = {}) => {
    extRequests.push({ op, params });
    if (op === "list_frames") {
      return {
        frames: [
          { frameId: 0, parentFrameId: -1, url: "http://127.0.0.1:49260/" },
          { frameId: 3, parentFrameId: 0, url: "about:srcdoc" },
          { frameId: 7, parentFrameId: 0, url: CROSS_SRC },
        ],
      };
    }
    if (op === "resolve_bc_node") return { objectId: "obj-frame-file" };
    throw new Error(`unexpected op ${op}`);
  };
  const handle = createPageHelperHandler(invoke, undefined, undefined, { bcCall, extensionRequest });
  return { handle, cdpCalls, extRequests };
}

describe("extension frame targets", () => {
  test("parse and build extension:<tab>@<frameId> targets", () => {
    expect(parseExtensionTargetId("extension:5@7")).toEqual({ tabId: 5, frameId: 7 });
    expect(parseExtensionTargetId("extension:chrome-b3:5@7")).toEqual({ slug: "chrome-b3", tabId: 5, frameId: 7 });
    expect(parseExtensionTargetId("extension:5@x")).toBeUndefined();
    expect(extensionTabOf(FRAME)).toBe(5);
    expect(extensionFrameOf(FRAME)).toBe(7);
    expect(extensionFrameOf(TOP)).toBeUndefined();
    expect(extensionFrameTarget(TOP, 7)).toBe(FRAME);
    expect(extensionFrameTarget("extension:5@3", 7)).toBe(FRAME);
  });

  test("a label missing from the top page resolves inside a cross-origin iframe", async () => {
    const { handle, cdpCalls, extRequests } = harness();
    const res = await handle("hover", { ref: "Cross input" }, TOP);
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).toContain("hover f1:e1");
    expect(extRequests.some((r) => r.op === "list_frames" && r.params["targetId"] === TOP)).toBe(true);
    const move = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent");
    expect(move?.params).toMatchObject({ type: "mouseMoved", x: 110, y: 220 });
    expect(move?.targetId).toBe(TOP);
  });

  test("upload by label reaches a file input inside a cross-origin iframe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bc-p3-frames-"));
    const file = join(dir, "resume.txt");
    writeFileSync(file, "hello");
    try {
      const { handle, cdpCalls, extRequests } = harness();
      const res = await handle("upload", { ref: "Cross file", path: file }, TOP);
      expect(res.ok).toBe(true);
      expect(JSON.stringify(res)).toContain("upload f1:e2");
      expect(extRequests.find((r) => r.op === "resolve_bc_node")?.params).toEqual({ targetId: FRAME, ref: "e2", mode: "ref" });
      const set = cdpCalls.find((c) => c.method === "DOM.setFileInputFiles");
      expect(set?.targetId).toBe(FRAME);
      expect(set?.params).toEqual({ objectId: "obj-frame-file", files: [file] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a label that matches nowhere still fails with NO_MATCH", async () => {
    const { handle } = harness();
    const res = await handle("hover", { ref: "Nothing here" }, TOP);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain("NO_MATCH");
  });
});

describe("debugger hub OOPIF sessions", () => {
  test("frameSession turns on flattened auto-attach once and matches the child target by URL", async () => {
    const sent: Array<{ target: unknown; method: string; params: unknown }> = [];
    const mem = new Map<string, unknown>();
    const storage = {
      async get(keys?: string[]) {
        return Object.fromEntries([...mem].filter(([k]) => !keys || keys.includes(k)));
      },
      async set(obj: Record<string, unknown>) {
        for (const [k, v] of Object.entries(obj)) mem.set(k, v);
      },
      async remove(keys: string[]) {
        for (const k of keys) mem.delete(k);
      },
    };
    let hub: ReturnType<typeof createDebuggerHub>;
    const chrome = {
      runtime: { id: "ext" },
      storage: { session: storage, local: storage },
      tabs: { get: async (id: number) => ({ id, url: "http://127.0.0.1:49260/" }) },
      debugger: {
        attach: async () => {},
        detach: async () => {},
        sendCommand: async (target: { tabId: number }, method: string, params?: unknown) => {
          sent.push({ target, method, params });
          if (method === "Target.setAutoAttach") {
            queueMicrotask(() =>
              hub.handleDebuggerEvent({ tabId: target.tabId }, "Target.attachedToTarget", {
                sessionId: "S-CROSS",
                targetInfo: { targetId: "T1", type: "iframe", url: CROSS_SRC },
              }),
            );
          }
          return {};
        },
      },
    };
    hub = createDebuggerHub({ chrome, idleMs: 60_000 });
    expect(await hub.frameSession(5, CROSS_SRC)).toBe("S-CROSS");
    expect(await hub.frameSession(5, CROSS_SRC)).toBe("S-CROSS");
    expect(sent.filter((s) => s.method === "Target.setAutoAttach")).toHaveLength(1);
    expect(sent.find((s) => s.method === "Target.setAutoAttach")?.params).toEqual({
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    expect(await hub.frameSession(5, "http://elsewhere.test/", 100)).toBeUndefined();
  });
});
