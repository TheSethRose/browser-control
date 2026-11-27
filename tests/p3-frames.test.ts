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

type BcInput = { targetId?: string; steps: readonly Step[] };

/** Minimal handler with caller-supplied helper, CDP and extension stubs; records where helpers ran. */
function stubHandler(opts: {
  bc: (method: string | undefined, input: BcInput) => { value: string };
  cdp?: (method: string, targetId?: string, params?: Record<string, unknown>) => unknown;
  targets?: unknown[];
  listFrames?: () => unknown[];
}) {
  const ran: Array<{ method?: string; targetId?: string; args?: readonly unknown[] }> = [];
  const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
    if (op === "list_targets") return { ok: true, data: { targets: opts.targets ?? [] } };
    if (op === "evaluate") {
      const expr = String(input["expression"]);
      const calls = [...expr.matchAll(/__bc\.(\w+)\(([^)]*)\)/g)];
      const last = calls.at(-1);
      const args = last?.[2] ? (JSON.parse(`[${last[2]}]`) as unknown[]) : [];
      const step = { kind: "bc", method: last?.[1], args };
      const targetId = input["targetId"] as string | undefined;
      ran.push({ method: step.method, targetId, args });
      try {
        return { ok: true, data: opts.bc(step.method, { targetId, steps: calls.map(() => step) }) };
      } catch (error) {
        return { ok: false, error: { code: "EXECUTION_FAILED", message: `JS_EXCEPTION: ${String(error)}` } } as InvokeResult;
      }
    }
    if (op === "execute_cdp") {
      const params = (input["params"] ?? {}) as Record<string, unknown>;
      return { ok: true, data: { result: opts.cdp?.(String(input["method"]), input["targetId"] as string | undefined, params) ?? {} } };
    }
    return { ok: true, data: { result: {} } };
  };
  const bcCall = async (input: BcInput) => {
    const last = input.steps.at(-1)!;
    ran.push({ method: last.method, targetId: input.targetId, args: last.args });
    return opts.bc(last.method, input);
  };
  const extensionRequest = async (op: string) => {
    if (op === "list_frames") return { frames: opts.listFrames?.() ?? [] };
    throw new Error(`unexpected op ${op}`);
  };
  return { handle: createPageHelperHandler(invoke, undefined, undefined, { bcCall, extensionRequest }), ran };
}

const pointOrMiss = (method: string | undefined, input: BcInput, hits: Record<string, string>) => {
  if (method === "point") return { value: input.steps.length > 1 ? "http://x/ 1 2" : "1 2" };
  if (method === "frameOffset") return { value: "0 0" };
  if (method === "locate" || method === "locateFile") {
    const hit = input.targetId ? hits[input.targetId] : undefined;
    if (hit && input.steps.at(-1)?.args?.[0] === "Cross input") return { value: hit };
    throw new Error(`NO_MATCH: no control named "x". Run snap to see the controls.`);
  }
  return { value: "" };
};

describe("p3 frames review fixes", () => {
  test("S1: CDP label fallback only uses iframe targets embedded in the selected tab", async () => {
    const { handle, ran } = stubHandler({
      targets: [
        { targetId: "IF-OTHER", type: "iframe", url: CROSS_SRC, parentFrameId: "TAB-B" },
        { targetId: "IF-MINE", type: "iframe", url: CROSS_SRC, parentFrameId: "SAME-ORIGIN-CHILD" },
      ],
      cdp: (method) =>
        method === "Page.getFrameTree"
          ? { frameTree: { frame: { id: "TAB-A" }, childFrames: [{ frame: { id: "SAME-ORIGIN-CHILD" } }] } }
          : {},
      bc: (method, input) =>
        method === "frames" && input.targetId === "TAB-A"
          ? { value: JSON.stringify([{ i: 1, src: CROSS_SRC, title: "" }]) }
          : method === "frames"
            ? { value: "[]" }
            : pointOrMiss(method, input, { "IF-OTHER": "e1", "IF-MINE": "e1" }),
    });
    const res = await handle("hover", { ref: "Cross input" }, "TAB-A");
    expect(res.ok).toBe(true);
    expect(ran.some((r) => r.targetId === "IF-OTHER")).toBe(false);
    expect(ran.find((r) => r.method === "point")?.targetId).toBe("IF-MINE");
  });

  test("S2: a label lookup after frames reorder never rebinds a saved f1 ref", async () => {
    let order = [{ i: 1, src: CROSS_SRC, title: "" }];
    let frames = [{ frameId: 7, url: CROSS_SRC }];
    const { handle, ran } = stubHandler({
      listFrames: () => frames,
      bc: (method, input) =>
        method === "frames"
          ? { value: input.targetId === TOP ? JSON.stringify(order) : "[]" }
          : pointOrMiss(method, input, { [FRAME]: "e1" }),
    });
    expect((await handle("hover", { ref: "Cross input" }, TOP)).ok).toBe(true);
    order = [{ i: 1, src: "http://ads.test/x", title: "" }, { i: 2, src: CROSS_SRC, title: "" }];
    frames = [{ frameId: 9, url: "http://ads.test/x" }, { frameId: 7, url: CROSS_SRC }];
    const relabeled = await handle("hover", { ref: "Cross input" }, TOP);
    // fN follows frame identity, so frame 7 stays f1 after the reorder.
    expect(JSON.stringify(relabeled)).toContain("f1:e1");
    ran.length = 0;
    expect((await handle("hover", { ref: "f1:e1" }, TOP)).ok).toBe(true);
    expect(ran.find((r) => r.method === "point")?.targetId).toBe(FRAME);
  });

  test("S2: a saved frame ref after a reorder uses its own iframe's page offset", async () => {
    let order = [{ i: 1, src: CROSS_SRC, title: "" }];
    let frames = [{ frameId: 7, url: CROSS_SRC }];
    const moves: Array<Record<string, unknown>> = [];
    const offsets: Record<string, string> = { [CROSS_SRC]: "100 0", "http://ads.test/x": "300 0" };
    const { handle } = stubHandler({
      listFrames: () => frames,
      cdp: (method, _t, params) => {
        if (method === "Input.dispatchMouseEvent" && params?.["type"] === "mouseMoved") moves.push(params);
        return {};
      },
      bc: (method, input) => {
        if (method === "frames") return { value: input.targetId === TOP ? JSON.stringify(order) : "[]" };
        if (method === "frameOffset") return { value: offsets[order[Number(input.steps.at(-1)?.args?.[0]) - 1]!.src]! };
        return pointOrMiss(method, input, { [FRAME]: "e1" });
      },
    });
    expect((await handle("hover", { ref: "Cross input" }, TOP)).ok).toBe(true);
    order = [{ i: 1, src: "http://ads.test/x", title: "" }, { i: 2, src: CROSS_SRC, title: "" }];
    frames = [{ frameId: 9, url: "http://ads.test/x" }, { frameId: 7, url: CROSS_SRC }];
    expect((await handle("hover", { ref: "Cross input" }, TOP)).ok).toBe(true);
    moves.length = 0;
    expect((await handle("hover", { ref: "f1:e1" }, TOP)).ok).toBe(true);
    expect(moves[0]).toMatchObject({ x: 101, y: 2 });
  });

  test("S2: same-URL sibling iframes are never bound to a guessed target", async () => {
    const order = [{ i: 1, src: CROSS_SRC, title: "" }, { i: 2, src: CROSS_SRC, title: "" }];
    const { handle, ran } = stubHandler({
      listFrames: () => [{ frameId: 7, url: CROSS_SRC }, { frameId: 9, url: CROSS_SRC }],
      bc: (method, input) =>
        method === "frames"
          ? { value: input.targetId === TOP ? JSON.stringify(order) : "[]" }
          : pointOrMiss(method, input, { [FRAME]: "e1" }),
    });
    const res = await handle("hover", { ref: "Cross input" }, TOP);
    expect(res.ok).toBe(false);
    expect(ran.some((r) => r.method === "locate" && r.targetId !== TOP)).toBe(false);
  });

  test("S6: a repeat snap after a reorder keeps f1 on the same frame", async () => {
    let order = [{ i: 1, src: CROSS_SRC, title: "" }];
    let frames = [{ frameId: 7, url: CROSS_SRC }];
    const { handle } = stubHandler({
      listFrames: () => frames,
      bc: (method, input) => {
        if (method === "frames") return { value: input.targetId === TOP ? JSON.stringify(order) : "[]" };
        if (method !== "snapshot") return { value: "" };
        if (input.targetId === TOP) return { value: `# page | http://127.0.0.1:49260/\n# ${order.length} cross-origin iframe(s): listed below\n- button "Top" [e1]` };
        return { value: `# frame\n- textbox "In ${input.targetId}" [e1]` };
      },
    });
    const first = JSON.stringify(await handle("snap", {}, TOP));
    expect(first).toContain("[f1:e1]");
    order = [{ i: 1, src: "http://ads.test/x", title: "" }, { i: 2, src: CROSS_SRC, title: "" }];
    frames = [{ frameId: 9, url: "http://ads.test/x" }, { frameId: 7, url: CROSS_SRC }];
    const second = JSON.stringify(await handle("snap", {}, TOP));
    expect(second).toContain(`In ${FRAME}\\" [f1:e1]`);
    expect(second).toContain("[f2:e1]");
    expect(second).not.toContain(`In ${FRAME}\\" [f2:e1]`);
  });

  test("S6: a diff-mode snap keeps child-frame added, updated and removed rows with frame refs", async () => {
    const { handle } = stubHandler({
      listFrames: () => [{ frameId: 7, url: CROSS_SRC }],
      bc: (method, input) => {
        const inFrame = input.targetId === FRAME;
        if (method === "frames") return { value: inFrame ? "[]" : JSON.stringify([{ i: 1, src: CROSS_SRC, title: "" }]) };
        if (method !== "snapshot") return { value: "" };
        if (!inFrame) return { value: `# page | http://127.0.0.1:49260/\n# 1 cross-origin iframe(s): listed below\n- button "Top" [e1]` };
        return {
          value: `# frame\n# snap diff (4 refs unchanged and still valid; pass --full for all)\n+ button "New" [e3]\n~ textbox "Cross input" [e1]\n- button "Go" [e2]`,
        };
      },
    });
    const out = String((await handle("snap", {}, TOP) as { data: { value: string } }).data.value);
    expect(out).toContain("3 control(s) changed; snap diff");
    expect(out).toContain('+ button "New" [f1:e3]');
    expect(out).toContain('~ textbox "Cross input" [f1:e1]');
    expect(out).toContain('- button "Go" [f1:e2]');
  });

  test("S6: snap --full forwards full to child frames so a repeat snap lists their controls", async () => {
    const { handle, ran } = stubHandler({
      listFrames: () => [{ frameId: 7, url: CROSS_SRC }],
      bc: (method, input) => {
        const inFrame = input.targetId === FRAME;
        if (method === "frames") return { value: inFrame ? "[]" : JSON.stringify([{ i: 1, src: CROSS_SRC, title: "" }]) };
        if (method !== "snapshot") return { value: "" };
        const full = (input.steps.at(-1)?.args?.[0] as { full?: boolean } | undefined)?.full === true;
        if (!inFrame) return { value: `# page | http://127.0.0.1:49260/\n# 1 cross-origin iframe(s): listed below\n- button "Top" [e1]` };
        return { value: full ? `# frame\n- textbox "Cross input" [e1]\n- button "Go" [e2]` : "# frame\n# snap diff (2 refs unchanged and still valid; pass --full for all)" };
      },
    });
    await handle("snap", { full: true }, TOP);
    const res = await handle("snap", { full: true }, TOP);
    const out = JSON.stringify(res);
    expect(out).toContain("2 control(s)");
    expect(out).toContain("[f1:e2]");
    expect(ran.filter((r) => r.method === "snapshot" && r.targetId === FRAME).every((r) => (r.args?.[0] as { full?: boolean }).full === true)).toBe(true);
    const diff = JSON.stringify(await handle("snap", {}, TOP));
    expect(diff).toContain("0 control(s) changed; snap diff");
  });
});

describe("debugger hub frame session review fixes", () => {
  function hubWith(children: Array<{ sessionId: string; url: string }>) {
    const mem = new Map<string, unknown>();
    const storage = {
      async get() {
        return Object.fromEntries(mem);
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
        sendCommand: async (target: { tabId: number }, method: string) => {
          if (method === "Target.setAutoAttach") {
            queueMicrotask(() => {
              for (const c of children) {
                hub.handleDebuggerEvent({ tabId: target.tabId }, "Target.attachedToTarget", {
                  sessionId: c.sessionId,
                  targetInfo: { targetId: `T-${c.sessionId}`, type: "iframe", url: c.url },
                });
              }
            });
          }
          return {};
        },
      },
    };
    hub = createDebuggerHub({ chrome, idleMs: 60_000 });
    return hub;
  }

  test("S4: same-URL sibling OOPIFs are told apart by the probe, not by attach order", async () => {
    const hub = hubWith([
      { sessionId: "S-FIRST", url: CROSS_SRC },
      { sessionId: "S-SECOND", url: CROSS_SRC },
    ]);
    const asked: string[][] = [];
    const choose = async (ids: string[]) => {
      asked.push(ids);
      return "S-SECOND";
    };
    expect(await hub.frameSession(5, CROSS_SRC, 500, choose)).toBe("S-SECOND");
    expect(asked[0]).toEqual(["S-FIRST", "S-SECOND"]);
  });

  test("S4: a same-URL tie the probe cannot settle throws instead of taking the first session", async () => {
    const hub = hubWith([
      { sessionId: "S-FIRST", url: CROSS_SRC },
      { sessionId: "S-SECOND", url: CROSS_SRC },
    ]);
    await expect(hub.frameSession(5, CROSS_SRC, 500, async () => undefined)).rejects.toThrow(/could not identify iframe session/);
    await expect(hub.frameSession(5, CROSS_SRC, 500)).rejects.toThrow(/could not identify iframe session/);
    await expect(
      hub.sessionForFrame(5, 7, async () => ({ url: CROSS_SRC }), async () => { throw new Error("probe failed"); }),
    ).rejects.toThrow(/^EXECUTION_FAILED: could not identify iframe session for frame 7/);
  });

  test("S5: an explicit frameId that no longer exists throws STALE_REF instead of using the top session", async () => {
    const hub = hubWith([{ sessionId: "S-CROSS", url: CROSS_SRC }]);
    await expect(hub.sessionForFrame(5, 7, async () => null)).rejects.toThrow(/^STALE_REF: frame 7 is gone/);
    expect(await hub.sessionForFrame(5, 0, async () => null)).toBeUndefined();
    expect(await hub.sessionForFrame(5, 7, async () => ({ url: CROSS_SRC }))).toBe("S-CROSS");
  });
});
