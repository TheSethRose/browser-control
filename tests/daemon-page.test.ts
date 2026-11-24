import { describe, expect, test } from "bun:test";
import type { InvokeResult } from "@agent-software/core";
import { createPageHelperHandler, formatAxTree, matchTab } from "../daemon";
import { PAGE_HELPERS_SOURCE, PAGE_HELPERS_VERSION, parseLocator } from "../src/page-helpers";
import type { Runner } from "../src/backends/browse";
import { parseBoxes } from "../src/ocr";

type Call = { op: string; input: Record<string, unknown> };

function makeFakeInvoker(options: {
  browseActive?: string;
  hidden?: boolean;
  readback?: string;
  locate?: Record<string, string>;
  wall?: string;
  finalUrl?: string;
} = {}) {
  const calls: Call[] = [];
  let installed = false;
  const ok = (value: unknown): InvokeResult => ({ ok: true, data: { value } });

  const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
    calls.push({ op, input });
    if (op === "get_browser_status") {
      return {
        ok: true,
        data: options.browseActive
          ? {
              connected: false,
              backends: {
                order: ["browse", "cdp"],
                active: "browse",
                browse: { available: true, activeTargetId: options.browseActive },
              },
            }
          : { connected: true },
      };
    }
    if (op === "evaluate") {
      const expr = String(input["expression"] ?? "");
      if (expr.includes(PAGE_HELPERS_SOURCE)) installed = true;
      if (!installed && expr.includes("__BC_NEED_INSTALL__")) return ok("__BC_NEED_INSTALL__");
      const point = `120 240 ${options.hidden ? "hidden" : "visible"}`;
      if (expr.includes("__bc.locate")) {
        const label = /__bc\.locate\("([^"]*)"/.exec(expr)?.[1] ?? "";
        const ref = options.locate?.[label];
        return ref
          ? ok(ref)
          : { ok: false, error: { code: "EXECUTION_FAILED", message: `JS_EXCEPTION: Error: AMBIGUOUS: "${label}" matches 2 controls; use one of these refs:\n- button "${label}" [e1]\n- button "${label}" [e2]\n    at Object.locate (<anonymous>:1:1)` } };
      }
      if (expr.includes("__bc.hit")) return ok("https://a.test/x\nhit: canvas#c");
      if (expr.includes("__bc.diff")) return ok('+ button "Extra" [e9]');
      if (expr.includes("__bc.point")) return ok(expr.includes("__bc.baseline()") ? `https://a.test/x ${point}` : point);
      if (expr.includes("location.href, __bc.wall()")) return ok(`${options.finalUrl ?? "https://a.test/x"}\n${options.wall ?? ""}`);
      if (expr.includes("__bc.baseline")) return ok("https://a.test/x");
      if (expr.includes("__bc.snapshot")) return ok('# Page | /\n- button "Save" [e1]');
      if (expr.includes("__bc.guard")) return ok("ok");
      if (expr.includes("__bc.focusForType")) return ok("focused");
      if (expr.includes("__bc.value")) return ok(options.readback ?? "hello");
      if (expr.includes("__bc.verdict")) return ok('{"result":"confirmed"}');
      if (expr.includes("__bc.health")) return ok('{"h1Count":1}');
      if (expr.includes("__bc.text")) return ok("# Page | /\n\nHello");
      if (expr.includes("__bc.viewport")) return ok('{"x":0,"y":0,"width":1000,"height":500,"dpr":2}');
      if (expr.includes("__bc.surface")) return ok("picture");
      return ok("ok");
    }
    if (op === "execute_cdp") return { ok: true, data: { result: {} } };
    if (op === "capture_screenshot") return { ok: true, data: { path: "/nonexistent/bc-test.png" } };
    if (op === "navigate") return { ok: true, data: { loaded: true, frameId: "F" } };
    if (op === "list_targets") {
      return {
        ok: true,
        data: {
          targets: [
            { targetId: "T1", url: "https://github.com/a/b", title: "Repo" },
            { targetId: "T2", url: "https://github.com/c/d", title: "Other" },
            { targetId: "T3", url: "https://example.com/", title: "Example Domain" },
          ],
        },
      };
    }
    return { ok: true, data: {} };
  };

  return { calls, invoke };
}

const text = (res: InvokeResult) => (res.ok ? String((res.data as { value: unknown }).value) : res.error.message);
const cdpMethods = (calls: Call[]) => calls.filter((c) => c.op === "execute_cdp").map((c) => c.input["method"]);

describe("page helper source", () => {
  test("is plain JavaScript that carries the version the daemon probes for", () => {
    expect(PAGE_HELPERS_SOURCE).toContain(`const VERSION = ${PAGE_HELPERS_VERSION};`);
    expect(() => new Function(PAGE_HELPERS_SOURCE)).not.toThrow();
  });

  test("parseLocator tells refs, iframe refs, accessibility refs and labels apart", () => {
    expect(parseLocator("@e12")).toEqual({ kind: "dom", ref: "e12" });
    expect(parseLocator("f2:e5")).toEqual({ kind: "frame", frame: 2, ref: "e5" });
    expect(parseLocator("a41")).toEqual({ kind: "ax", node: 41 });
    expect(parseLocator("Save changes")).toEqual({ kind: "label", label: "Save changes" });
    expect(() => parseLocator("")).toThrow("INPUT_INVALID");
    expect(() => parseLocator(undefined)).toThrow("INPUT_INVALID");
  });
});

describe("daemon page helpers", () => {
  test("installs __bc lazily once per document and reuses it on subsequent calls", async () => {
    const { calls, invoke } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);

    expect((await handle("snap", { all: false })).ok).toBe(true);
    expect((await handle("verdict", {})).ok).toBe(true);

    const evals = calls.filter((c) => c.op === "evaluate").map((c) => String(c.input["expression"]));
    expect(evals.filter((e) => e.includes(PAGE_HELPERS_SOURCE))).toHaveLength(1);
    expect(evals[evals.length - 1]).not.toContain(PAGE_HELPERS_SOURCE);
  });

  test("snap passes find and within to the page", async () => {
    const { calls, invoke } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);
    await handle("snap", { find: "save", within: "form" });
    const expr = String(calls.filter((c) => c.op === "evaluate").at(-1)!.input["expression"]);
    expect(expr).toContain('__bc.snapshot({"all":false,"find":"save","within":"form"})');
  });

  test("click enables focus emulation on hidden tabs, dispatches in-process and reports what changed", async () => {
    const { calls, invoke } = makeFakeInvoker({ hidden: true });
    const handle = createPageHelperHandler(invoke);

    const res = await handle("click", { ref: "@e1" });
    expect(res.ok).toBe(true);
    expect(text(res)).toBe('click e1 at 120,240: delivered\n+ button "Extra" [e9]');
    expect(cdpMethods(calls)).toEqual([
      "Emulation.setFocusEmulationEnabled",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);
  });

  test("quiet leaves out the baseline and the diff", async () => {
    const { calls, invoke } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);
    const res = await handle("click", { ref: "e1", quiet: true });
    expect(text(res)).toBe("click e1 at 120,240: delivered");
    const evals = calls.filter((c) => c.op === "evaluate").map((c) => String(c.input["expression"]));
    expect(evals.some((e) => !e.includes(PAGE_HELPERS_SOURCE) && (e.includes("__bc.baseline") || e.includes("__bc.diff")))).toBe(false);
  });

  test("a label resolves to a ref, and an ambiguous one fails without dispatching input", async () => {
    const { calls, invoke } = makeFakeInvoker({ locate: { Next: "e7" } });
    const handle = createPageHelperHandler(invoke);

    expect(text(await handle("click", { ref: "Next", quiet: true }))).toBe("click e7 at 120,240: delivered");

    const before = cdpMethods(calls).length;
    const bad = await handle("click", { ref: "Save" });
    expect(bad.ok).toBe(false);
    expect(text(bad)).toStartWith('AMBIGUOUS: "Save" matches 2 controls');
    expect(text(bad)).not.toContain("at Object.locate");
    expect(cdpMethods(calls).length).toBe(before);
  });

  test("type supports Input.insertText, --keys, and readback", async () => {
    const { calls, invoke } = makeFakeInvoker({ readback: "ab" });
    const handle = createPageHelperHandler(invoke);

    const res = await handle("type", { ref: "e2", text: "ab", keys: true, quiet: true });
    expect(text(res)).toContain("delivered (read back matches)");
    const keyEvents = calls.filter((c) => c.op === "execute_cdp" && c.input["method"] === "Input.dispatchKeyEvent");
    expect(keyEvents).toHaveLength(4);
  });

  test("do runs steps in one call, stops at the first failure and says what was not run", async () => {
    const { invoke } = makeFakeInvoker({ readback: "x", locate: { Email: "e3" } });
    const handle = createPageHelperHandler(invoke);

    const good = await handle("do", { steps: [{ type: ["Email", "x"] }, { key: "Tab" }] });
    expect(good.ok).toBe(true);
    expect(text(good)).toBe('1. type e3: delivered (read back matches)\n2. key Tab: sent\n+ button "Extra" [e9]');

    const bad = await handle("do", { steps: [{ type: ["Email", "x"] }, { click: "Save" }, { key: "Tab" }] });
    expect(bad.ok).toBe(false);
    expect(text(bad)).toContain("2. click \"Save\": FAILED AMBIGUOUS");
    expect(text(bad)).toContain("# STOPPED: step 2 failed. 1 step(s) not run.");

    const unread = await handle("do", { steps: [{ type: ["Email", "typed"] }, { key: "Tab" }] });
    expect(unread.ok).toBe(false);
    expect(text(unread)).toContain("# STOPPED: step 1 was not read back as typed");

    expect((await handle("do", { steps: [{ hover: "x" }] })).ok).toBe(false);
    expect((await handle("do", { steps: "nope" })).ok).toBe(false);
  });

  test("do stops when the page turns into a wall", async () => {
    const { invoke } = makeFakeInvoker({ wall: "cloudflare-access", locate: { Go: "e1" } });
    const handle = createPageHelperHandler(invoke);
    const res = await handle("do", { steps: [{ click: "Go" }, { key: "Tab" }] });
    expect(res.ok).toBe(false);
    expect(text(res)).toContain("# STOPPED: the page is a cloudflare-access wall after step 1");
  });

  test("fill turns a label-to-text map into type steps", async () => {
    const { invoke } = makeFakeInvoker({ readback: "v", locate: { Email: "e3", Name: "e4" } });
    const handle = createPageHelperHandler(invoke);
    const res = await handle("do", { fill: { Email: "v", Name: "v" }, quiet: true });
    expect(text(res)).toBe("1. type e3: delivered (read back matches)\n2. type e4: delivered (read back matches)");
  });

  test("nav waits for the document by default and flags redirects and walls", async () => {
    const { calls, invoke } = makeFakeInvoker({ finalUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/login", wall: "cloudflare-access" });
    const handle = createPageHelperHandler(invoke);
    const res = await handle("nav", { url: "https://app.test/" });
    expect(calls.find((c) => c.op === "navigate")!.input["until"]).toBe("domcontentloaded");
    expect(text(res)).toContain("# REDIRECTED: app.test -> team.cloudflareaccess.com");
    expect(text(res)).toContain("# WALL: cloudflare-access");

    await handle("nav", { url: "https://app.test/", until: "load" });
    expect(calls.filter((c) => c.op === "navigate").at(-1)!.input["until"]).toBe("load");

    const snapped = await handle("nav", { url: "https://a.test/x", snap: true });
    expect(text(snapped)).toContain('- button "Save" [e1]');
  });

  test("routes snap, click, type, and key to browse CLI on browse:<n> tabs", async () => {
    const { invoke } = makeFakeInvoker({ browseActive: "browse:7" });
    const browseCalls: string[][] = [];
    const fakeBrowse: Runner = async (args) => {
      browseCalls.push(args);
      return { code: 0, stdout: `ok:${args[0]}`, stderr: "" };
    };
    const handle = createPageHelperHandler(invoke, fakeBrowse);

    expect((await handle("snap", { all: false })).ok).toBe(true);
    expect((await handle("snap", { all: true, find: "save" }, "browse:9")).ok).toBe(true);
    expect((await handle("click", { ref: "e12", quiet: true })).ok).toBe(true);
    expect((await handle("type", { ref: "e5", text: "hi", quiet: true })).ok).toBe(true);
    expect(text(await handle("key", { key: "Enter" }))).toBe("ok:press\nok:snapshot");

    expect(browseCalls).toEqual([
      ["snapshot", "--json", JSON.stringify({ tab: 7, interactive: true })],
      ["snapshot", "--json", JSON.stringify({ tab: 9, find: "save" })],
      ["click", "--json", JSON.stringify({ tab: 7, ref: "e12" })],
      ["fill", "--json", JSON.stringify({ tab: 7, ref: "e5", value: "hi" })],
      ["press", "--json", JSON.stringify({ tab: 7, key: "Enter" })],
      ["snapshot", "--json", JSON.stringify({ tab: 7, interactive: true, delta: true })],
    ]);

    expect((await handle("value", { ref: "e5" })).ok).toBe(false);
  });
});

describe("tab matching and accessibility formatting", () => {
  test("matchTab needs exactly one tab", async () => {
    const { invoke } = makeFakeInvoker();
    expect(await matchTab(invoke, "example")).toEqual({ ok: true, targetId: "T3" });
    const many = await matchTab(invoke, "github.com");
    expect(many.ok).toBe(false);
    if (!many.ok) expect(text(many.res)).toStartWith('AMBIGUOUS: --match "github.com" fits 2 tabs');
    const none = await matchTab(invoke, "nowhere");
    if (!none.ok) expect(text(none.res)).toStartWith("NO_MATCH");
  });

  test("formatAxTree lists only named-role controls with a DOM node, and never values", () => {
    const lines = formatAxTree([
      { role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 41, properties: [{ name: "disabled", value: { value: true } }] },
      { role: { value: "textbox" }, name: { value: "Email" }, backendDOMNodeId: 42 },
      { role: { value: "generic" }, name: { value: "x" }, backendDOMNodeId: 43 },
      { role: { value: "button" }, name: { value: "Ignored" }, backendDOMNodeId: 44, ignored: true },
      { role: { value: "link" }, name: { value: "No node" } },
    ]);
    expect(lines).toEqual(['- button "Save" [a41] [disabled]', '- textbox "Email" [a42]']);
    expect(formatAxTree([{ role: { value: "link" }, name: { value: "Docs" }, backendDOMNodeId: 1 }], "save")).toEqual([]);
  });
});

describe("picture pages", () => {
  test("parseBoxes reads the recognizer's lines and skips junk", () => {
    expect(parseBoxes("0.1 0.2 0.3 0.04 New mail\nnot a line\n0.5 0.5 0.1 0.1 Inbox\n")).toEqual([
      { x: 0.1, y: 0.2, width: 0.3, height: 0.04, text: "New mail" },
      { x: 0.5, y: 0.5, width: 0.1, height: 0.1, text: "Inbox" },
    ]);
  });

  test("ocr prints click coordinates in CSS pixels, and a click on the canvas reports new text", async () => {
    const { invoke } = makeFakeInvoker();
    let screen = [{ x: 0.1, y: 0.2, width: 0.2, height: 0.04, text: "New mail" }];
    const handle = createPageHelperHandler(invoke, undefined, async () => screen);

    const first = await handle("ocr", {});
    expect(text(first)).toContain('200,110 "New mail"');
    expect(text(await handle("ocr", { find: "nothing" }))).not.toContain("New mail");

    screen = [...screen, { x: 0.5, y: 0.5, width: 0.2, height: 0.04, text: "Compose" }];
    const clicked = await handle("click", { xy: [200, 110] });
    expect(text(clicked)).toBe('click 200,110: delivered. hit: canvas#c\n+ 600,260 "Compose"');
  });

  test("type --focused sends text without a ref", async () => {
    const { calls, invoke } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke, undefined, async () => []);
    const res = await handle("type", { focused: true, text: "hi", quiet: true });
    expect(text(res)).toStartWith("type --focused: sent");
    expect(cdpMethods(calls)).toEqual(["Input.insertText"]);
  });
});
