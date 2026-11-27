import { afterEach, describe, expect, test } from "bun:test";
import type { InvokeResult } from "@agent-software/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildHash, createPageHelperHandler, formatAxTree, matchTab } from "../daemon";
import { PAGE_HELPERS_SOURCE, PAGE_HELPERS_VERSION, parseLocator } from "../src/page-helpers";
import { parseBrowseSnapshot } from "../src/page-runner";
import { createSeededRng } from "../src/natural";
import type { Runner } from "../src/backends/browse";
import { parseBoxes } from "../src/ocr";

type Call = { op: string; input: Record<string, unknown> };

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeFakeInvoker(options: {
  browseActive?: string;
  hidden?: boolean;
  readback?: string;
  locate?: Record<string, string>;
  wall?: string;
  finalUrl?: string;
  selectResult?: string;
  locateOption?: string;
  locateFile?: string;
  waitSequence?: Array<{ matched: boolean; url?: string; wall?: string }>;
  canvasHashes?: string[];
  field?: string;
  onCdp?: (method: string, params: Record<string, unknown>) => InvokeResult | undefined;
} = {}) {
  const calls: Call[] = [];
  let installed = false;
  let waitIdx = 0;
  let hashIdx = 0;
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
      if (expr === "location.href") return ok(options.finalUrl ?? "https://a.test/x");
      // The page is normal: the bot-challenge probe answers its complete `{skip,url}` readback.
      if (expr.includes("responseStatus") && expr.includes("visibleSelectors")) {
        return ok(JSON.stringify({ skip: true, url: options.finalUrl ?? "https://a.test/x" }));
      }
      if (expr.includes(PAGE_HELPERS_SOURCE)) installed = true;
      if (!installed && expr.includes("__BC_NEED_INSTALL__")) return ok("__BC_NEED_INSTALL__");
      const point = `120 240 ${options.hidden ? "hidden" : "visible"}`;
      if (expr.includes("__bc.locateOption")) {
        return ok(options.locateOption ?? "e99");
      }
      if (expr.includes("__bc.locateFile")) {
        return ok(options.locateFile ?? "e55");
      }
      if (expr.includes("__bc.locate")) {
        const label = /__bc\.locate\("([^"]*)"/.exec(expr)?.[1] ?? "";
        const ref = options.locate?.[label];
        return ref
          ? ok(ref)
          : {
              ok: false,
              error: {
                code: "EXECUTION_FAILED",
                message: `JS_EXCEPTION: Error: AMBIGUOUS: "${label}" matches 2 controls; use one of these refs:\n- button "${label}" [e1]\n- button "${label}" [e2]\n    at Object.locate (<anonymous>:1:1)`,
              },
            };
      }
      if (expr.includes("__bc.select")) {
        return ok(options.selectResult ?? "United States");
      }
      if (expr.includes("__bc.checkWait")) {
        const seq = options.waitSequence ?? [{ matched: true }];
        const item = seq[Math.min(waitIdx++, seq.length - 1)]!;
        return ok(JSON.stringify({ matched: item.matched, url: item.url ?? "https://a.test/x", wall: item.wall ?? "" }));
      }
      if (expr.includes("__bc.canvasHash")) {
        const seq = options.canvasHashes ?? ["h1", "h2"];
        return ok(seq[Math.min(hashIdx++, seq.length - 1)]!);
      }
      if (expr.includes("__bc.typingField")) return ok(options.field ?? "");
      if (expr.includes("__bc.hitCheck")) return ok('{"ok":true}');
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
    if (op === "execute_cdp") {
      const hooked = options.onCdp?.(String(input["method"]), (input["params"] ?? {}) as Record<string, unknown>);
      if (hooked) return hooked;
      if (input["method"] === "Runtime.evaluate") {
        return { ok: true, data: { result: { result: { objectId: "obj-file-1" } } } };
      }
      return { ok: true, data: { result: {} } };
    }
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
  test("is plain JavaScript and derives VERSION from one place", () => {
    expect(PAGE_HELPERS_VERSION).toBeGreaterThanOrEqual(6);
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

  test("parseBrowseSnapshot extracts refs, roles, names, and disabled state", () => {
    const parsed = parseBrowseSnapshot(
      '- button "Next" [e12]\n- textbox "Email" [ref=e4]\n- textbox "Card Number" @e9 [disabled]\n',
    );
    expect(parsed.map((e) => ({ ref: e.ref, role: e.role, name: e.name, disabled: e.disabled }))).toEqual([
      { ref: "e12", role: "button", name: "Next", disabled: false },
      { ref: "e4", role: "textbox", name: "Email", disabled: false },
      { ref: "e9", role: "textbox", name: "Card Number", disabled: true },
    ]);
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

  test("type defaults to human keystrokes with pauses and supports --fast and --keys", async () => {
    const pauses: number[] = [];
    const { calls, invoke } = makeFakeInvoker({ readback: "hello" });
    const handle = createPageHelperHandler(invoke, undefined, undefined, {
      sleep: async (ms) => {
        pauses.push(ms);
      },
      rng: () => 0.5, // deterministic, no typo triggered at 0.5 >= 0.045
    });

    const human = await handle("type", { ref: "e2", text: "hello", quiet: true, _natural: true });
    expect(text(human)).toContain("delivered (read back matches)");
    const humanKeys = calls.filter((c) => c.op === "execute_cdp" && c.input["method"] === "Input.dispatchKeyEvent");
    expect(humanKeys).toHaveLength(10); // 5 chars * (keyDown + keyUp)
    expect((humanKeys[0]!.input["params"] as Record<string, unknown>)["code"]).toBe("KeyH");
    expect(pauses.length).toBeGreaterThanOrEqual(9); // hold + inter-key pauses

    const fastMock = makeFakeInvoker({ readback: "hello" });
    const fastHandle = createPageHelperHandler(fastMock.invoke);
    const fastRes = await fastHandle("type", { ref: "e2", text: "hello", fast: true, quiet: true });
    expect(text(fastRes)).toContain("delivered (read back matches)");
    expect(cdpMethods(fastMock.calls).slice(-3)).toEqual([
      "Input.insertText",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ]);

    const keysMock = makeFakeInvoker({ readback: "ab" });
    const keysHandle = createPageHelperHandler(keysMock.invoke, undefined, undefined, { sleep: async () => {}, rng: () => 0.5 });
    const keysRes = await keysHandle("type", { ref: "e2", text: "ab", keys: true, quiet: true, _natural: true });
    expect(text(keysRes)).toContain("delivered (read back matches)");
    const keyEvents = keysMock.calls.filter((c) => c.op === "execute_cdp" && c.input["method"] === "Input.dispatchKeyEvent");
    expect(keyEvents).toHaveLength(4);
  });

  test("natural typing: live field policy, key text for emoji, no key left down, steady clock", async () => {
    const keys = (calls: Call[]) =>
      calls.filter((c) => c.input["method"] === "Input.dispatchKeyEvent").map((c) => c.input["params"] as Record<string, unknown>);
    const quick = { sleep: async () => {} };
    // Fixed rng below: a random typo or key rollover would change which keys are sent or held.
    const live = (type: string, flags = "") => `{"type":"${type}","flags":[${flags}]}`;
    for (const [field, typos] of [["", false], [live("number"), false], [live("text", '"payment"'), false], [live("text"), true]] as const) {
      const m = makeFakeInvoker({ field });
      await createPageHelperHandler(m.invoke, undefined, undefined, { ...quick, rng: () => 0 })("type", { _natural: true, ref: "e2", text: "123e45 and more", quiet: true });
      expect(keys(m.calls).some((k) => k["key"] === "Backspace")).toBe(typos);
    }

    const emoji = makeFakeInvoker({ field: live("text") });
    await createPageHelperHandler(emoji.invoke, undefined, undefined, { ...quick, rng: () => 0.5 })("type", { _natural: true, ref: "e2", text: "go 🚀", quiet: true });
    expect(cdpMethods(emoji.calls)).not.toContain("Input.insertText");
    expect(keys(emoji.calls).filter((k) => k["key"] === "🚀").map((k) => [k["type"], k["text"]])).toEqual([["keyDown", "🚀"], ["keyUp", undefined]]);

    // A keyUp a dialog refused may have landed: it reads as unverified, is never re-sent, and is not held.
    const refused = { ok: false as const, error: { code: "EXECUTION_FAILED" as const, message: "DIALOG_OPEN: alert" } };
    let ups = 0;
    const blocked = makeFakeInvoker({ onCdp: (m, p) => (m === "Input.dispatchKeyEvent" && p["type"] === "keyUp" && ups++ === 0 ? refused : undefined) });
    const blockedHandle = createPageHelperHandler(blocked.invoke, undefined, undefined, { ...quick, rng: () => 0.5 });
    expect(text(await blockedHandle("type", { _natural: true, ref: "e2", text: "hi", quiet: true }))).toContain("release: delivery unverified (a dialog opened)");
    const sent = keys(blocked.calls);
    expect(text(await blockedHandle("dialog", { sub: "accept" }))).not.toContain("# HELD");
    expect([sent.filter((k) => k["type"] === "keyUp" && k["key"] === "h").length, keys(blocked.calls).length]).toEqual([1, sent.length]);

    // Events run against elapsed time, so 8 ms per CDP round trip doesn't slow the typing,
    // and after one 500 ms stall the later gaps keep their planned length.
    const line = "She packed her bag before dawn, then walked to the station. Nobody spoke on the train.";
    const dispatchTimes = async (latency: number, stallAt = -1) => {
      let clock = 0;
      const at: number[] = [];
      const m = makeFakeInvoker({
        field: live("text"),
        onCdp: (method) => {
          if (method === "Input.dispatchKeyEvent") at.push((clock += at.length === stallAt ? 500 : latency));
          return undefined;
        },
      });
      const opts = { rng: createSeededRng(7), now: () => clock, sleep: async (ms: number) => void (clock += ms) };
      await createPageHelperHandler(m.invoke, undefined, undefined, opts)("type", { _natural: true, ref: "e2", text: line, quiet: true });
      return at;
    };
    const steps = (at: number[]) => at.slice(1).map((t, i) => t - at[i]!);
    expect(steps(await dispatchTimes(0, 20)).slice(21)).toEqual(steps(await dispatchTimes(0)).slice(21));
    const wpmOf = (at: number[]) => (line.length / 5) / ((at.at(-1)! - at[0]!) / 60000);
    const [ideal, slow] = [wpmOf(await dispatchTimes(0)), wpmOf(await dispatchTimes(8))];
    expect(Math.abs(slow - ideal) / ideal).toBeLessThan(0.01);
    // One line is a single sample of the 75-95 wpm band at speed 0.85-1.15, so allow 5% noise.
    expect(slow).toBeGreaterThanOrEqual(75 * 0.85 * 0.95);
    expect(slow).toBeLessThanOrEqual(95 * 1.15 * 1.05);
  });

  test("natural typing: a keyUp timeout still reports the Shift it left down", async () => {
    const timeout = { ok: false as const, error: { code: "EXECUTION_FAILED" as const, message: "CDP_TIMEOUT: no reply" } };
    let timedOut = false;
    const lost = makeFakeInvoker({
      field: '{"type":"text","flags":[]}',
      onCdp: (m, p) => (m === "Input.dispatchKeyEvent" && p["type"] === "keyUp" && p["key"] === "H" && !timedOut ? (timedOut = true, timeout) : undefined),
    });
    const handle = createPageHelperHandler(lost.invoke, undefined, undefined, { sleep: async () => {} });
    const out = text(await handle("type", { _natural: true, ref: "e2", text: "Hi", quiet: true }));
    expect(timedOut).toBe(true);
    expect(out).toContain("delivered_unverified");
    expect(out).toContain("# HELD: key Shift still down");
  });

  test("natural typing: an oversleeping pause shifts the schedule instead of eating the next hold", async () => {
    let clock = 0;
    const holds: number[] = [];
    const downAt = new Map<string, number>();
    const m = makeFakeInvoker({
      field: '{"type":"text","flags":[]}',
      onCdp: (method, params) => {
        if (method !== "Input.dispatchKeyEvent") return undefined;
        const key = String(params["key"]);
        if (params["type"] !== "keyUp") downAt.set(key, clock);
        else if (downAt.has(key)) {
          holds.push(clock - downAt.get(key)!);
          downAt.delete(key);
        }
        return undefined;
      },
    });
    const opts = { rng: createSeededRng(7), now: () => clock, sleep: async (ms: number) => void (clock += ms + 80) };
    await createPageHelperHandler(m.invoke, undefined, undefined, opts)("type", { _natural: true, ref: "e2", text: "hold still", quiet: true });
    expect(holds.length).toBeGreaterThan(5);
    expect(Math.min(...holds)).toBeGreaterThanOrEqual(40);
  });

  test("select handles native <select> and custom ARIA comboboxes", async () => {
    const { calls, invoke } = makeFakeInvoker({ locate: { Country: "e8" }, selectResult: "United States" });
    const handle = createPageHelperHandler(invoke);

    const native = await handle("select", { ref: "Country", option: "US", quiet: true });
    expect(native.ok).toBe(true);
    expect(text(native)).toBe('select e8 -> "United States": delivered');
    expect(cdpMethods(calls)).toEqual([]);

    const custom = makeFakeInvoker({ locate: { Role: "e10" }, selectResult: "__not_native__", locateOption: "e22" });
    const customHandle = createPageHelperHandler(custom.invoke);
    const res = await customHandle("select", { ref: "Role", option: "Admin", quiet: true });
    expect(res.ok).toBe(true);
    expect(text(res)).toBe('select e10 -> "Admin": delivered');
    // Two clicks: open combobox + click option
    expect(cdpMethods(custom.calls).filter((m) => m === "Input.dispatchMouseEvent")).toHaveLength(6);
  });

  test("upload validates file existence and dispatches DOM.setFileInputFiles via objectId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-up-"));
    tempDirs.push(dir);
    const filePath = join(dir, "doc.txt");
    await writeFile(filePath, "hello");

    const { calls, invoke } = makeFakeInvoker({ locateFile: "e55" });
    const handle = createPageHelperHandler(invoke);

    expect((await handle("upload", { ref: "Resume", path: "relative.txt" })).ok).toBe(false);
    expect((await handle("upload", { ref: "Resume", path: join(dir, "missing.txt") })).ok).toBe(false);

    const okRes = await handle("upload", { ref: "Resume", path: filePath, quiet: true });
    expect(okRes.ok).toBe(true);
    expect(text(okRes)).toBe(`upload e55 <- ${filePath}: delivered`);
    expect(cdpMethods(calls)).toEqual(["Runtime.evaluate", "DOM.setFileInputFiles", "Runtime.releaseObject"]);
  });

  test("wait polls until matched or times out with WAIT_TIMEOUT", async () => {
    const okMock = makeFakeInvoker({ waitSequence: [{ matched: false }, { matched: true }] });
    const okHandle = createPageHelperHandler(okMock.invoke);
    const matched = await okHandle("wait", { text: "Saved", timeoutMs: 2000 });
    expect(matched.ok).toBe(true);
    expect(text(matched)).toContain('matched text="Saved"');

    const timeoutMock = makeFakeInvoker({ waitSequence: [{ matched: false, wall: "captcha" }] });
    const timeoutHandle = createPageHelperHandler(timeoutMock.invoke);
    const timedOut = await timeoutHandle("wait", { selector: ".done", timeoutMs: 50 });
    expect(timedOut.ok).toBe(false);
    expect(text(timedOut)).toContain("WAIT_TIMEOUT");
    expect(text(timedOut)).toContain("# WALL: captcha");

    expect((await okHandle("wait", {})).ok).toBe(false);
  });

  test("do supports select, upload, wait, stops at first failure and says what was not run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-do-"));
    tempDirs.push(dir);
    const filePath = join(dir, "cv.pdf");
    await writeFile(filePath, "%PDF-1.4");

    const { invoke } = makeFakeInvoker({ readback: "x", locate: { Email: "e3", Country: "e8" } });
    const handle = createPageHelperHandler(invoke);

    const good = await handle("do", {
      steps: [
        { type: ["Email", "x"] },
        { select: ["Country", "US"] },
        { upload: ["Resume", filePath] },
        { wait: "Saved" },
        { key: "Tab" },
      ],
    });
    expect(good.ok).toBe(true);
    expect(text(good)).toContain("1. type e3: delivered (read back matches)");
    expect(text(good)).toContain('2. select e8 -> "United States": delivered');
    expect(text(good)).toContain(`3. upload e55 <- ${filePath}: delivered`);
    expect(text(good)).toContain('4. waited');
    expect(text(good)).toContain("5. key Tab: sent");

    const bad = await handle("do", { steps: [{ type: ["Email", "x"] }, { click: "Save" }, { key: "Tab" }] });
    expect(bad.ok).toBe(false);
    expect(text(bad)).toContain('2. click "Save": FAILED AMBIGUOUS');
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
    const { calls, invoke } = makeFakeInvoker({
      finalUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/login",
      wall: "cloudflare-access",
    });
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

  test("routes snap, click, type, and key to browse CLI with label lookup, guards, and wall checks", async () => {
    const { invoke } = makeFakeInvoker({ browseActive: "browse:7" });
    const browseCalls: string[][] = [];
    const fakeBrowse: Runner = async (args) => {
      browseCalls.push(args);
      if (args[0] === "snapshot") {
        return {
          code: 0,
          stdout: '- button "Next" [e12]\n- textbox "Email" [e5]\n- textbox "Card Number" [e8]\n- textbox "honeypot" [e9]',
          stderr: "",
        };
      }
      // The browse guard reads the page with the same probe; a normal page answers a complete skip.
      if (args[0] === "eval") {
        return { code: 0, stdout: JSON.stringify({ skip: true, url: "https://a.test/x" }), stderr: "" };
      }
      return { code: 0, stdout: `ok:${args[0]}`, stderr: "" };
    };
    const handle = createPageHelperHandler(invoke, fakeBrowse);

    expect((await handle("snap", { all: false })).ok).toBe(true);
    expect((await handle("snap", { all: true, find: "save" }, "browse:9")).ok).toBe(true);
    expect((await handle("click", { ref: "e12", quiet: true })).ok).toBe(true);
    // Label lookup resolves "Next" -> e12 instead of sending ref:"Next"
    expect((await handle("click", { ref: "Next", quiet: true })).ok).toBe(true);
    expect((await handle("type", { ref: "e5", text: "hi", quiet: true })).ok).toBe(true);
    // Guard blocks payment & trap fields on browse tabs
    expect(text(await handle("type", { ref: "e8", text: "4111", quiet: true }))).toContain("REFUSED");
    expect(text(await handle("type", { ref: "honeypot", text: "bot", quiet: true }))).toContain("REFUSED");
    expect(text(await handle("key", { key: "Enter" }))).toStartWith("ok:press\n- button");

    expect(browseCalls).toEqual([
      ["snapshot", "--json", JSON.stringify({ tab: 7, interactive: true })],
      ["snapshot", "--json", JSON.stringify({ tab: 9, find: "save" })],
      ["click", "--json", JSON.stringify({ tab: 7, ref: "e12" })],
      ["snapshot", "--json", JSON.stringify({ tab: 7, interactive: true })],
      ["click", "--json", JSON.stringify({ tab: 7, ref: "e12" })],
      ["fill", "--json", JSON.stringify({ tab: 7, ref: "e5", value: "hi" })],
      ["snapshot", "--json", JSON.stringify({ tab: 7, interactive: true })],
      ["press", "--json", JSON.stringify({ tab: 7, key: "Enter" })],
      ["snapshot", "--json", JSON.stringify({ tab: 7, interactive: true, delta: true })],
    ]);

    // do stops on a wall on browse tabs too
    const walled = makeFakeInvoker({ browseActive: "browse:7", wall: "captcha" });
    const walledHandle = createPageHelperHandler(walled.invoke, fakeBrowse);
    const stopped = await walledHandle("do", { steps: [{ click: "e12" }, { key: "Tab" }], quiet: true });
    expect(stopped.ok).toBe(false);
    expect(text(stopped)).toContain("# STOPPED: the page is a captcha wall after step 1");
    // The guard read the browse tab itself, not the CDP backend a bare target id would have reached.
    expect(browseCalls.filter((c) => c[0] === "eval")).toHaveLength(1);
    expect(
      walled.calls.some((c) => c.op === "evaluate" && String(c.input["expression"] ?? "").includes("const fastHit")),
    ).toBe(false);

    expect((await handle("value", { ref: "e5" })).ok).toBe(false);
  });
});

describe("tab matching, build hash, and accessibility formatting", () => {
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

  test("buildHash computes a stable 12-char hex digest", () => {
    const h = buildHash(resolve(import.meta.dir, "../cli.ts"));
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(buildHash(undefined)).toBe("unknown");
  });
});

describe("picture pages and daemon script flags", () => {
  test("parseBoxes reads the recognizer's lines and skips junk", () => {
    expect(parseBoxes("0.1 0.2 0.3 0.04 New mail\nnot a line\n0.5 0.5 0.1 0.1 Inbox\n")).toEqual([
      { x: 0.1, y: 0.2, width: 0.3, height: 0.04, text: "New mail" },
      { x: 0.5, y: 0.5, width: 0.1, height: 0.1, text: "Inbox" },
    ]);
  });

  test("ocr captures without clip (avoiding flicker), prints CSS coordinates, and canvas hash speeds up redraw diff", async () => {
    const { calls, invoke } = makeFakeInvoker({ canvasHashes: ["aaa", "bbb"] });
    let screen = [{ x: 0.1, y: 0.2, width: 0.2, height: 0.04, text: "New mail" }];
    const handle = createPageHelperHandler(invoke, undefined, async () => screen);

    const first = await handle("ocr", {});
    expect(text(first)).toContain('200,110 "New mail"');
    expect(calls.find((c) => c.op === "capture_screenshot")?.input["clip"]).toBeUndefined();
    expect(text(await handle("ocr", { find: "nothing" }))).not.toContain("New mail");

    screen = [...screen, { x: 0.5, y: 0.5, width: 0.2, height: 0.04, text: "Compose" }];
    const started = Date.now();
    const clicked = await handle("click", { xy: [200, 110] });
    expect(Date.now() - started).toBeLessThan(500);
    expect(text(clicked)).toBe('click 200,110: delivered. hit: canvas#c\n+ 600,260 "Compose"');
  });

  test("viewport shot omits clip to avoid browser flicker", async () => {
    const { calls, invoke } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke);
    const res = await handle("shot", {});
    expect(res.ok).toBe(true);
    expect(text(res)).toContain("CSS-pixel scale");
    const shotCalls = calls.filter((c) => c.op === "capture_screenshot");
    expect(shotCalls).toHaveLength(1);
    expect(shotCalls[0]!.input["clip"]).toBeUndefined();
  });

  test("type --focused defaults to human keystrokes and supports --fast", async () => {
    const { calls, invoke } = makeFakeInvoker();
    const handle = createPageHelperHandler(invoke, undefined, async () => [], {
      sleep: async () => {},
      rng: () => 0.5,
    });
    const res = await handle("type", { focused: true, text: "hi", quiet: true, _natural: true });
    expect(text(res)).toStartWith("type --focused: sent");
    expect(cdpMethods(calls)).toEqual([
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ]);

    const fastMock = makeFakeInvoker();
    const fastHandle = createPageHelperHandler(fastMock.invoke, undefined, async () => []);
    const fastRes = await fastHandle("type", { focused: true, text: "hi", fast: true, quiet: true });
    expect(text(fastRes)).toStartWith("type --focused: sent");
    expect(cdpMethods(fastMock.calls)).toEqual(["Input.insertText"]);
  });

  test("browser-control-daemon rejects unknown --flags with INPUT_INVALID", async () => {
    const script = resolve(import.meta.dir, "../.agents/skills/browser-control/scripts/browser-control-daemon");
    const proc = Bun.spawn([script, "snap", "--tpye"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(1);
    expect(out).toContain("INPUT_INVALID");
    expect(out).toContain("unknown flag: --tpye");
  });

  test("page-helpers diff fast-path detects JS input.value mutations and passive JS errors without MutationObserver", () => {
    const inputEl: any = {
      nodeType: 1,
      tagName: "INPUT",
      type: "text",
      name: "email",
      id: "email",
      value: "a@b.co",
      checked: false,
      disabled: false,
      readOnly: false,
      required: false,
      tabIndex: 0,
      isConnected: true,
      isContentEditable: false,
      labels: [],
      getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }),
      getAttribute: (a: string) => (a === "aria-label" ? "Email" : null),
      closest: () => null,
      matches: () => true,
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    const listeners: Record<string, Array<(e: any) => void>> = {};
    const doc: any = {
      title: "Form",
      hidden: false,
      body: { innerText: "Form", querySelectorAll: () => [] },
      documentElement: { lang: "en" },
      images: [],
      querySelectorAll: (sel: string) => (sel.includes("input") ? [inputEl] : []),
      querySelector: () => null,
      createTreeWalker: () => ({ nextNode: () => null }),
    };
    inputEl.ownerDocument = doc;
    const prev = {
      __bc: (globalThis as any).__bc,
      document: (globalThis as any).document,
      location: (globalThis as any).location,
      getComputedStyle: (globalThis as any).getComputedStyle,
      innerWidth: (globalThis as any).innerWidth,
      innerHeight: (globalThis as any).innerHeight,
      NodeFilter: (globalThis as any).NodeFilter,
      addEventListener: (globalThis as any).addEventListener,
    };
    try {
      delete (globalThis as any).__bc;
      (globalThis as any).document = doc;
      (globalThis as any).location = { href: "https://app.test/form", origin: "https://app.test", pathname: "/form", hostname: "app.test" };
      (globalThis as any).getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
      (globalThis as any).innerWidth = 1000;
      (globalThis as any).innerHeight = 800;
      (globalThis as any).NodeFilter = { SHOW_ELEMENT: 1 };
      (globalThis as any).addEventListener = (type: string, fn: (e: any) => void) => {
        (listeners[type] ??= []).push(fn);
      };
      new Function(PAGE_HELPERS_SOURCE)();
      const bc = (globalThis as any).__bc;

      expect(bc.snapshot()).toContain('- textbox "Email" [e1] value="a@b.co"');
      bc.baseline();
      // Zero changes -> fast path returns no visible change yet
      expect(bc.diff({ from: "https://app.test/form" })).toBe("# no visible change yet");
      // Programmatic .value change (no MutationObserver fired) MUST still be caught!
      inputEl.value = "new@b.co";
      const changed = bc.diff({ from: "https://app.test/form" });
      expect(changed).toContain('~ textbox "Email" [e1] value="new@b.co"');
      // Passive uncaught JS error surfaces in the next diff receipt
      for (const fn of listeners["error"] ?? []) fn({ message: "Boom validation" });
      const withErr = bc.diff({ from: "https://app.test/form" });
      expect(withErr).toContain("# JS error: Boom validation");
    } finally {
      delete (globalThis as any).__bc;
      const { __bc, ...rest } = prev;
      Object.assign(globalThis, rest);
      if (__bc !== undefined) Object.defineProperty(globalThis, "__bc", { value: __bc, configurable: true });
    }
  });
});
