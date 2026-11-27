import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvokeResult } from "@agent-software/core";
// @ts-expect-error Plain ES module in extension/lib without .d.ts
import { SESSION_TABS_STORAGE_KEY, RESERVATION_TTL_MS, createSessionTabs, validSessionKey } from "../extension/lib/session-tabs.js";
// @ts-expect-error Plain ES module in extension/lib without .d.ts
import { createTabBusy, withDeadline } from "../extension/lib/tab-busy.js";
import {
  EXTENSION_ORIGIN,
  PROTOCOL_VERSION,
  browserSlugFor,
  createExtensionBackend,
  extProofMessage,
  hmacHex,
  type ExtensionBackend,
} from "../src/backends/extension";
import { PAGE_HELPERS_VERSION } from "../src/page-helpers";
import { createPageHelperHandler } from "../src/page-runner";

const WRAPPER = resolve(import.meta.dir, "../.agents/skills/browser-control/scripts/browser-control-daemon");
const BACKGROUND = resolve(import.meta.dir, "../extension/background.js");
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

  test("a newly launched daemon does not inherit the caller's raw session ids", () => {
    const launch = /nohup[^\n]*/.exec(readFileSync(WRAPPER, "utf8"))?.[0] ?? "";
    expect(launch).toContain("--serve");
    for (const name of SESSION_ENV) expect(launch).toContain(`-u ${name}`);
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
  const make = (now?: () => number) =>
    createSessionTabs({
      chrome,
      isAgentTab: (id: number) => agent.has(id),
      isTabInHandoff: (id: number) => handoff.has(id),
      isTabBusy: (id: number) => busy.has(id),
      ...(now ? { now } : {}),
    });
  return { tabMap, store, agent, handoff, busy, windows, chrome, make };
}

const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";

describe("session tab reuse decisions (extension)", () => {
  test("reuses the session's free agent tab; unknown sessions get none", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }]);
    const st = env.make();
    await st.remember(A, 5);
    expect(await st.reserve(A)).toBe(5);
    st.release(5);
    expect(await st.reserve(B)).toBeUndefined();
    expect(await st.reserve("not-a-hash")).toBeUndefined();
  });

  test("a closed, claimed, pinned, handed-off, busy or minimized-window tab is not reused", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }]);
    const st = env.make();
    await st.remember(A, 5);

    env.busy.add(5);
    expect(await st.reserve(A)).toBeUndefined();
    env.busy.delete(5);

    env.handoff.add(5);
    expect(await st.reserve(A)).toBeUndefined();
    env.handoff.delete(5);

    env.tabMap.get(5)!.pinned = true;
    expect(await st.reserve(A)).toBeUndefined();
    env.tabMap.get(5)!.pinned = false;

    env.windows.set(1, { id: 1, type: "normal", state: "minimized" });
    expect(await st.reserve(A)).toBeUndefined();
    env.windows.set(1, { id: 1, type: "normal", state: "normal" });

    expect(await st.reserve(A)).toBe(5);
    st.release(5);
    env.agent.delete(5); // claimed by the user
    expect(await st.reserve(A)).toBeUndefined();
    env.agent.add(5);

    env.tabMap.delete(5); // gone
    expect(await st.reserve(A)).toBeUndefined();
  });

  test("two concurrent calls for one session never reserve the same tab", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }]);
    const st = env.make();
    await st.remember(A, 5);
    const [first, second] = await Promise.all([st.reserve(A), st.reserve(A)]);
    expect(first).toBe(5);
    expect(second).toBeUndefined();
    st.release(5);
    expect(await st.reserve(A)).toBe(5);
  });

  test("a tab the user claims or pins after selection is refused at the update", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }]);
    const st = env.make();
    await st.remember(A, 5);
    expect(await st.reserve(A)).toBe(5);
    expect(await st.confirm(A, 5)).toBe(true);

    env.tabMap.get(5)!.pinned = true;
    expect(await st.confirm(A, 5)).toBe(false);
    env.tabMap.get(5)!.pinned = false;

    env.agent.delete(5); // claimed by the user while the request was in flight
    expect(await st.confirm(A, 5)).toBe(false);
    st.release(5);
    expect(await st.reserve(A)).toBeUndefined();
  });

  test("a reservation a hung call never released expires instead of pinning the tab", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }]);
    let clock = 1_000;
    const st = env.make(() => clock);
    await st.remember(A, 5);
    expect(await st.reserve(A)).toBe(5);
    expect(await st.reserve(A)).toBeUndefined();
    clock += RESERVATION_TTL_MS;
    expect(await st.reserve(A)).toBe(5);
  });

  test("sessions never share a tab: recording it for one drops it from the other", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }, { id: 6, windowId: 1 }]);
    const st = env.make();
    await st.remember(A, 5);
    await st.remember(B, 5); // B targeted A's tab explicitly
    expect(await st.reserve(B)).toBe(5);
    st.release(5);
    expect(await st.reserve(A)).toBeUndefined();
    await st.remember(A, 6);
    expect(st.snapshot()).toEqual({ [B]: 5, [A]: 6 });
  });

  test("only agent tabs are recorded; forget and replace keep the map current", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }]);
    const st = env.make();
    await st.remember(A, 99); // not an agent tab (a lent or user tab)
    expect(st.snapshot()).toEqual({});
    await st.remember(A, 5);
    env.agent.add(7);
    await st.replace(7, 5);
    expect(st.snapshot()).toEqual({ [A]: 7 });
    await st.forget(7);
    expect(st.snapshot()).toEqual({});
  });

  test("a replacement moves the mapping before the purge of the old id can drop it", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }, { id: 7, windowId: 1 }]);
    const st = env.make();
    await st.remember(A, 5);
    // Background order: ownership transfers, replace() is registered, then the purge of tab 5 runs.
    await Promise.all([st.replace(7, 5), st.forget(5)]);
    expect(st.snapshot()).toEqual({ [A]: 7 });
  });

  test("background transfers ownership and the mapping before purging the replaced tab", () => {
    const src = readFileSync(BACKGROUND, "utf8");
    const block =
      /chrome\.tabs\.onReplaced\.addListener\(\(addedTabId, removedTabId\) => \{[\s\S]*?\n\}\);/.exec(src)?.[0] ?? "";
    expect(block).toContain("agentTabs.add(addedTabId)");
    expect(block.indexOf("sessionTabs.replace(addedTabId, removedTabId)")).toBeGreaterThan(-1);
    expect(block.indexOf("sessionTabs.replace(addedTabId, removedTabId)")).toBeLessThan(
      block.indexOf("tabCleanup.handleTabReplaced"),
    );
  });

  test("background bounds every relayed request on its own busy slot", () => {
    const src = readFileSync(BACKGROUND, "utf8");
    expect(src).toContain("withDeadline(handleRequest(msg), requestLimitMs(msg)");
    expect(src).toContain("tabBusy.hold(");
    expect(src).not.toContain("busyTabs");
  });

  test("survives a worker restart through chrome.storage.session", async () => {
    const env = makeEnv([{ id: 5, windowId: 1 }]);
    await env.make().remember(A, 5);
    const restarted = env.make();
    expect(await restarted.reserve(A)).toBe(5);
  });
});

describe("tab busy slots (extension)", () => {
  test("a hold is released exactly once, overlapping holds count separately, and the count stays at zero", () => {
    const busy = createTabBusy();
    const a = busy.hold(5);
    const b = busy.hold(5);
    expect(busy.count(5)).toBe(2);
    expect(busy.isBusy(5)).toBe(true);
    a();
    expect(busy.count(5)).toBe(1);
    a(); // idempotent: a late finish frees nothing extra
    expect(busy.count(5)).toBe(1);
    b();
    b();
    expect(busy.count(5)).toBe(0);
  });

  test("a command that never settles is bounded and frees its slot", async () => {
    const busy = createTabBusy();
    const release = busy.hold(5);
    await expect(withDeadline(new Promise(() => {}), 20, "navigate")).rejects.toThrow(/navigate did not finish in 20 ms/);
    release();
    expect(busy.count(5)).toBe(0);
  });
});

describe("two connected profiles (daemon)", () => {
  const backends: ExtensionBackend[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    while (sockets.length > 0) sockets.pop()!.close();
    while (backends.length > 0) await backends.pop()!.dispose?.();
  });

  async function connectProfile(port: number, token: string, profileId: string, browser: string, tabId: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: EXTENSION_ORIGIN },
    } as unknown as string[]);
    sockets.push(ws);
    const next = () =>
      new Promise<Record<string, unknown>>((res) => {
        ws.addEventListener("message", (ev) => res(JSON.parse(String(ev.data)) as Record<string, unknown>), {
          once: true,
        });
      });
    await new Promise<void>((res) => ws.addEventListener("open", () => res(), { once: true }));
    const challengeP = next();
    const extNonce = randomBytes(16).toString("hex");
    const hello = { type: "hello", profileId, browser, version: "2.0.0", helpersVersion: PAGE_HELPERS_VERSION, protocolVersion: PROTOCOL_VERSION, features: ["agent_close"], nonce: extNonce };
    ws.send(JSON.stringify(hello));
    const relayNonce = String((await challengeP)["nonce"]);
    const welcomeP = next();
    ws.send(JSON.stringify({ type: "auth.response", proof: hmacHex(token, extProofMessage(port, relayNonce, extNonce)) }));
    await welcomeP;
    const received: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (msg["type"] !== "req" || typeof msg["id"] !== "number") return;
      received.push(msg);
      ws.send(
        JSON.stringify({
          type: "res",
          id: msg["id"],
          ok: true,
          result: { tabId, loaded: true, url: String((msg["params"] as Record<string, unknown>)?.["url"] ?? ""), title: browser },
        }),
      );
    });
    return received;
  }

  test("a session's tab-less nav keeps its own browser when another session switches profiles", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = createExtensionBackend({ portStart: 49900, portEnd: 49903, token, waitConnectMs: 1_000 });
    backends.push(backend);
    await backend.start!();
    const port = backend.getPort()!;
    const slugChrome = browserSlugFor("Chrome", "two-prof-chrome");
    const slugBrave = browserSlugFor("Brave", "two-prof-brave");
    const chromeReqs = await connectProfile(port, token, "two-prof-chrome", "Chrome", 10);
    const braveReqs = await connectProfile(port, token, "two-prof-brave", "Brave", 202);
    for (let i = 0; i < 100 && backend.getConnectedBrowsers().length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(backend.getConnectedBrowsers()).toHaveLength(2);

    const first = (await backend.invoke("navigate", { url: "https://a.test/", sessionKey: A })) as { browser: string };
    expect(first.browser).toBe(slugChrome);
    // Another session moves the daemon-wide active profile to the second browser.
    await backend.invoke("navigate", { url: "https://b.test/", targetId: `extension:${slugBrave}:202` });

    const again = (await backend.invoke("navigate", { url: "https://a2.test/", sessionKey: A })) as { browser: string };
    expect(again.browser).toBe(slugChrome);
    // A session with no history follows the daemon-wide active tab, now back on Browser 1.
    const other = (await backend.invoke("navigate", { url: "https://c.test/", sessionKey: B })) as { browser: string };
    expect(other.browser).toBe(slugChrome);

    const navs = chromeReqs.filter((r) => r["op"] === "navigate");
    const sessionANavs = navs.filter((nav) => (nav["params"] as Record<string, unknown>)["sessionKey"] === A);
    expect(sessionANavs).toHaveLength(2);
    expect(sessionANavs.map((nav) => (nav["params"] as Record<string, unknown>)["tabId"])).toEqual([undefined, undefined]);
    expect(braveReqs.filter((r) => r["op"] === "navigate")).toHaveLength(1);
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
