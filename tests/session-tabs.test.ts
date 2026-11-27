import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvokeResult } from "@agent-software/core";
// @ts-expect-error Plain ES module in extension/lib without .d.ts
import { SESSION_TABS_STORAGE_KEY, createSessionTabs, validSessionKey } from "../extension/lib/session-tabs.js";
import { createPageHelperHandler } from "../src/page-runner";

const WRAPPER = resolve(import.meta.dir, "../.agents/skills/browser-control/scripts/browser-control-daemon");
const SESSION_ENV = ["BROWSER_CONTROL_SESSION", "CLAUDE_CODE_SESSION_ID", "T3CODE_THREAD_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID"];

/** Run the wrapper's own session_key function with only the given session variables set. */
function wrapperKey(vars: Record<string, string>): string {
  const src = readFileSync(WRAPPER, "utf8");
  const fn = /^session_key\(\) \{[\s\S]*?^\}$/m.exec(src)?.[0];
  if (!fn) throw new Error("session_key not found in wrapper");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SESSION_ENV.includes(k)) env[k] = v;
  const out = Bun.spawnSync(["bash", "-c", `${fn}\nsession_key`], { env: { ...env, ...vars } });
  return out.stdout.toString().trim();
}

const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

describe("session key (CLI wrapper)", () => {
  test("no session variable means no key", () => {
    expect(wrapperKey({})).toBe("");
  });

  test("hashes the id to a 16-hex prefix and never prints it raw", () => {
    const key = wrapperKey({ CLAUDE_CODE_SESSION_ID: "raw-claude-id" });
    expect(key).toBe(sha16("raw-claude-id"));
    expect(key).not.toContain("raw");
    expect(validSessionKey(key)).toBe(key);
  });

  test("precedence: BROWSER_CONTROL_SESSION, Claude, T3, Codex thread, Codex session", () => {
    const all = {
      BROWSER_CONTROL_SESSION: "o",
      CLAUDE_CODE_SESSION_ID: "c",
      T3CODE_THREAD_ID: "t",
      CODEX_THREAD_ID: "x",
      CODEX_SESSION_ID: "s",
    };
    expect(wrapperKey(all)).toBe(sha16("o"));
    const { BROWSER_CONTROL_SESSION: _o, ...noOverride } = all;
    expect(wrapperKey(noOverride)).toBe(sha16("c"));
    expect(wrapperKey({ T3CODE_THREAD_ID: "t", CODEX_THREAD_ID: "x" })).toBe(sha16("t"));
    expect(wrapperKey({ CODEX_THREAD_ID: "x", CODEX_SESSION_ID: "s" })).toBe(sha16("x"));
    expect(wrapperKey({ CODEX_SESSION_ID: "s" })).toBe(sha16("s"));
  });

  test("the extension accepts only hashed keys", () => {
    expect(validSessionKey("raw-claude-id")).toBeUndefined();
    expect(validSessionKey("ABCDEF0123456789")).toBeUndefined();
    expect(validSessionKey(42)).toBeUndefined();
  });
});

type Tab = { id: number; windowId: number; pinned?: boolean };

function makeEnv(tabs: Tab[], stored?: Record<string, number>) {
  const tabMap = new Map(tabs.map((t) => [t.id, { ...t }]));
  const store = new Map<string, unknown>(stored ? [[SESSION_TABS_STORAGE_KEY, stored]] : []);
  const agent = new Set(tabs.map((t) => t.id));
  const handoff = new Set<number>();
  const busy = new Set<number>();
  const windows = new Map([[1, { id: 1, type: "normal", state: "normal" }]]);
  const chrome = {
    tabs: {
      async get(id: number) {
        const t = tabMap.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return t;
      },
    },
    windows: {
      async get(id: number) {
        const w = windows.get(id);
        if (!w) throw new Error("no window");
        return w;
      },
    },
    storage: {
      session: {
        async get(keys: string[]) {
          return Object.fromEntries(keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
        },
        async set(obj: Record<string, unknown>) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
      },
    },
  };
  const make = () =>
    createSessionTabs({
      chrome,
      isAgentTab: (id: number) => agent.has(id),
      isTabInHandoff: (id: number) => handoff.has(id),
      isTabBusy: (id: number) => busy.has(id),
    });
  return { tabMap, store, agent, handoff, busy, windows, make };
}

const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";

describe("session tab reuse decisions (extension)", () => {
  test("reuses the session's free agent tab; unknown sessions get none", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }]);
    const st = env.make();
    await st.remember(A, 5);
    expect(await st.reusableTab(A)).toBe(5);
    expect(await st.reusableTab(B)).toBeUndefined();
    expect(await st.reusableTab("not-a-hash")).toBeUndefined();
  });

  test("a closed, claimed, pinned, handed-off, busy or minimized-window tab is not reused", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }]);
    const st = env.make();
    await st.remember(A, 5);

    env.busy.add(5);
    expect(await st.reusableTab(A)).toBeUndefined();
    env.busy.delete(5);

    env.handoff.add(5);
    expect(await st.reusableTab(A)).toBeUndefined();
    env.handoff.delete(5);

    env.tabMap.get(5)!.pinned = true;
    expect(await st.reusableTab(A)).toBeUndefined();
    env.tabMap.get(5)!.pinned = false;

    env.windows.set(1, { id: 1, type: "normal", state: "minimized" });
    expect(await st.reusableTab(A)).toBeUndefined();
    env.windows.set(1, { id: 1, type: "normal", state: "normal" });

    expect(await st.reusableTab(A)).toBe(5);
    env.agent.delete(5); // claimed by the user
    expect(await st.reusableTab(A)).toBeUndefined();
    env.agent.add(5);

    env.tabMap.delete(5); // gone
    expect(await st.reusableTab(A)).toBeUndefined();
  });

  test("sessions never share a tab: recording it for one drops it from the other", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }, { id: 6, windowId: 1 }]);
    const st = env.make();
    await st.remember(A, 5);
    await st.remember(B, 5); // B targeted A's tab explicitly
    expect(await st.reusableTab(B)).toBe(5);
    expect(await st.reusableTab(A)).toBeUndefined();
    await st.remember(A, 6);
    expect(st.snapshot()).toEqual({ [B]: 5, [A]: 6 });
  });

  test("only agent tabs are recorded; forget and replace keep the map current", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }]);
    const st = env.make();
    await st.remember(A, 99); // not an agent tab (a lent or user tab)
    expect(st.snapshot()).toEqual({});
    await st.remember(A, 5);
    await st.replace(7, 5);
    expect(st.snapshot()).toEqual({ [A]: 7 });
    await st.forget(7);
    expect(st.snapshot()).toEqual({});
  });

  test("survives a worker restart through chrome.storage.session", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }]);
    await env.make().remember(A, 5);
    const restarted = env.make();
    expect(await restarted.reusableTab(A)).toBe(5);
  });
});

describe("nav session params (page runner)", () => {
  function harness(navData: Record<string, unknown>) {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const invoke = async (op: string, input: Record<string, unknown>): Promise<InvokeResult> => {
      calls.push({ op, input });
      if (op === "navigate") return { ok: true, data: { loaded: true, backend: "extension", ...navData } } as InvokeResult;
      return { ok: true, data: { value: "" } } as InvokeResult;
    };
    return { calls, handle: createPageHelperHandler(invoke as never) };
  }
  const navInput = (calls: Array<{ op: string; input: Record<string, unknown> }>) =>
    calls.find((c) => c.op === "navigate")!.input;

  test("a tab-less nav sends the session key and says when the tab was reused", async () => {
    const h = harness({ targetId: "extension:7", reused: true });
    const res = await h.handle("nav", { url: "https://a.test/", sessionKey: A });
    const input = navInput(h.calls);
    expect(input["sessionKey"]).toBe(A);
    expect(input["targetId"]).toBeUndefined();
    expect(res.ok && String((res.data as Record<string, unknown>)["value"])).toContain(
      "# reused this session's tab extension:7",
    );
  });

  test("--new-tab is sent for a tab-less nav; an explicit tab wins over it", async () => {
    const h = harness({ targetId: "extension:8", created: true });
    await h.handle("nav", { url: "https://a.test/", sessionKey: A, newTab: true });
    expect(navInput(h.calls)["newTab"]).toBe(true);

    const e = harness({ targetId: "extension:3" });
    const res = await e.handle("nav", { url: "https://a.test/", sessionKey: A, newTab: true }, "extension:3");
    const input = navInput(e.calls);
    expect(input["targetId"]).toBe("extension:3");
    expect(input["newTab"]).toBeUndefined();
    expect(input["sessionKey"]).toBe(A);
    expect(res.ok && String((res.data as Record<string, unknown>)["value"])).not.toContain("reused");
  });

  test("a raw (unhashed) session id is never forwarded", async () => {
    const h = harness({ targetId: "extension:9", created: true });
    await h.handle("nav", { url: "https://a.test/", sessionKey: "raw-claude-id" });
    expect(navInput(h.calls)["sessionKey"]).toBeUndefined();
  });
});
