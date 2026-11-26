import { describe, expect, test } from "bun:test";
import type { InvokeResult } from "@agent-software/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAGE_HELPERS_VERSION,
  normalizeHelperCall,
  renderElementStep,
  renderSteps,
  type ElementStep,
  type HelperCall,
} from "../src/page-helpers";
import { createPageHelperHandler } from "../src/page-runner";

/**
 * Golden strings captured verbatim from pre-refactor `src/page-runner.ts`, `src/picture.ts`,
 * and `src/devtools.ts` before converting helper calls to structured steps.
 * Every converted call site has an explicit case below proving byte-identical CDP rendering.
 */
const GOLDEN_CALL_SITES: ReadonlyArray<{ name: string; call: HelperCall; golden: string }> = [
  // --- src/page-runner.ts ---
  {
    name: "locate: verifyRef",
    call: { kind: "bc", method: "verifyRef", args: ["e12"] },
    golden: '__bc.verifyRef("e12")',
  },
  {
    name: "locate: healRef",
    call: { kind: "bc", method: "healRef", args: ["e12"] },
    golden: '__bc.healRef("e12")',
  },
  {
    name: "locate: locate by label and kind",
    call: { kind: "bc", method: "locate", args: ["Save changes", "click"] },
    golden: '__bc.locate("Save changes", "click")',
  },
  {
    name: "pointOf (ax): baseline",
    call: { kind: "bc", method: "baseline" },
    golden: "__bc.baseline()",
  },
  {
    name: "pointOf (frame): baseline",
    call: { kind: "bc", method: "baseline" },
    golden: "__bc.baseline()",
  },
  {
    name: "pointOf (dom + baseline): baseline + point joined by space",
    call: { steps: [{ kind: "bc", method: "baseline" }, { kind: "bc", method: "point", args: ["e5"] }], join: " " },
    golden: '[__bc.baseline(), await __bc.point("e5")].join(" ")',
  },
  {
    name: "pointOf (no baseline): point",
    call: { kind: "bc", method: "point", args: ["e5"] },
    golden: 'await __bc.point("e5")',
  },
  {
    name: "pointOf (frame): frameOffset",
    call: { kind: "bc", method: "frameOffset", args: [2] },
    golden: "__bc.frameOffset(2)",
  },
  {
    name: "readProbe: readInputProbe",
    call: { kind: "bc", method: "readInputProbe" },
    golden: "__bc.readInputProbe()",
  },
  {
    name: "waitParsed: document.readyState",
    call: { kind: "readyState" },
    golden: "document.readyState",
  },
  {
    name: "changes: settle then diff (with before URL)",
    call: { steps: [{ kind: "bc", method: "settle" }, { kind: "bc", method: "diff", args: [{ from: "https://a.test/x" }] }] },
    golden: '(await __bc.settle(), __bc.diff({"from":"https://a.test/x"}))',
  },
  {
    name: "changes: settle then diff (empty before)",
    call: { steps: [{ kind: "bc", method: "settle" }, { kind: "bc", method: "diff", args: [{ from: "" }] }] },
    golden: '(await __bc.settle(), __bc.diff({"from":""}))',
  },
  {
    name: "snapFrames: frames",
    call: { kind: "bc", method: "frames" },
    golden: "__bc.frames()",
  },
  {
    name: "snapFrames: inner snapshot (find omitted / undefined)",
    call: { kind: "bc", method: "snapshot", args: [{ all: false, find: undefined }] },
    golden: '__bc.snapshot({"all":false})',
  },
  {
    name: "snapFrames: inner snapshot (all + find)",
    call: { kind: "bc", method: "snapshot", args: [{ all: true, find: "submit" }] },
    golden: '__bc.snapshot({"all":true,"find":"submit"})',
  },
  {
    name: "runWait: checkWait",
    call: { kind: "bc", method: "checkWait", args: [{ text: "Saved", selector: ".toast", url: "/done" }] },
    golden: '__bc.checkWait({"text":"Saved","selector":".toast","url":"/done"})',
  },
  {
    name: "runDrag: baseline",
    call: { kind: "bc", method: "baseline" },
    golden: "__bc.baseline()",
  },
  {
    name: "runDrag: dragInfo",
    call: { kind: "bc", method: "dragInfo", args: ["e2", "e5", "after"] },
    golden: '__bc.dragInfo("e2", "e5", "after")',
  },
  {
    name: "runDrag: listPosition",
    call: {
      kind: "bc",
      method: "listPosition",
      args: [{ parentRef: "e1", tag: "LI", text: "Card A", index: 1, total: 3 }],
    },
    golden: '__bc.listPosition({"parentRef":"e1","tag":"LI","text":"Card A","index":1,"total":3})',
  },
  {
    name: "click --xy: baseline + hit joined by newline",
    call: { steps: [{ kind: "bc", method: "baseline" }, { kind: "bc", method: "hit", args: [200, 110] }], join: "\n" },
    golden: '[__bc.baseline(), __bc.hit(200, 110)].join("\\n")',
  },
  {
    name: "click: armInputProbe",
    call: { kind: "bc", method: "armInputProbe" },
    golden: "__bc.armInputProbe()",
  },
  {
    name: "type --focused: guardFocused",
    call: { kind: "bc", method: "guardFocused" },
    golden: "__bc.guardFocused()",
  },
  {
    name: "type --focused: baseline",
    call: { kind: "bc", method: "baseline" },
    golden: "__bc.baseline()",
  },
  {
    name: "type: guard",
    call: { kind: "bc", method: "guard", args: ["e3"] },
    golden: '__bc.guard("e3")',
  },
  {
    name: "type: setTypedValue",
    call: { kind: "bc", method: "setTypedValue", args: ["e4", "2026-11-26"] },
    golden: '__bc.setTypedValue("e4", "2026-11-26")',
  },
  {
    name: "type (typed input): baseline",
    call: { kind: "bc", method: "baseline" },
    golden: "__bc.baseline()",
  },
  {
    name: "type: cellInfo",
    call: { kind: "bc", method: "cellInfo", args: ["e7"] },
    golden: '__bc.cellInfo("e7")',
  },
  {
    name: "type (grid cell): baseline",
    call: { kind: "bc", method: "baseline" },
    golden: "__bc.baseline()",
  },
  {
    name: "type (grid cell): cellEditor (after dblclick)",
    call: { kind: "bc", method: "cellEditor" },
    golden: "__bc.cellEditor()",
  },
  {
    name: "type (grid cell): cellEditor (after Enter)",
    call: { kind: "bc", method: "cellEditor" },
    golden: "__bc.cellEditor()",
  },
  {
    name: "type (grid cell): focusForType editorRef",
    call: { kind: "bc", method: "focusForType", args: ["e9"] },
    golden: '__bc.focusForType("e9")',
  },
  {
    name: "type (grid cell): cellRead",
    call: { kind: "bc", method: "cellRead", args: ["e7", "old value"] },
    golden: '__bc.cellRead("e7", "old value")',
  },
  {
    name: "type: focusForType loc.ref",
    call: { kind: "bc", method: "focusForType", args: ["e3"] },
    golden: '__bc.focusForType("e3")',
  },
  {
    name: "type: value readback",
    call: { kind: "bc", method: "value", args: ["e3"] },
    golden: '__bc.value("e3")',
  },
  {
    name: "select: baseline",
    call: { kind: "bc", method: "baseline" },
    golden: "__bc.baseline()",
  },
  {
    name: "select: native select",
    call: { kind: "bc", method: "select", args: ["e8", "United States"] },
    golden: '__bc.select("e8", "United States")',
  },
  {
    name: "select (ARIA combobox): settle(300, 80)",
    call: { kind: "bc", method: "settle", args: [300, 80] },
    golden: "await __bc.settle(300, 80)",
  },
  {
    name: "select (ARIA combobox): locateOption",
    call: { kind: "bc", method: "locateOption", args: ["Admin"] },
    golden: '__bc.locateOption("Admin")',
  },
  {
    name: "upload: baseline",
    call: { kind: "bc", method: "baseline" },
    golden: "__bc.baseline()",
  },
  {
    name: "upload: locateFile",
    call: { kind: "bc", method: "locateFile", args: ["Resume"] },
    golden: '__bc.locateFile("Resume")',
  },
  {
    name: "key: baseline",
    call: { kind: "bc", method: "baseline" },
    golden: "__bc.baseline()",
  },
  {
    name: "captureRecordedGets: location.origin",
    call: { kind: "origin" },
    golden: "location.origin",
  },
  {
    name: "handleNotes: location.host",
    call: { kind: "host" },
    golden: "location.host",
  },
  {
    name: "snap: snapshot",
    call: { kind: "bc", method: "snapshot", args: [{ all: false, find: "save", within: "form" }] },
    golden: '__bc.snapshot({"all":false,"find":"save","within":"form"})',
  },
  {
    name: "form: form",
    call: { kind: "bc", method: "form", args: [{ within: "#signup" }] },
    golden: '__bc.form({"within":"#signup"})',
  },
  {
    name: "query: query",
    call: { kind: "bc", method: "query", args: [{ selector: "a.item", fields: ["text", "href"], limit: 10, all: true }] },
    golden: '__bc.query({"selector":"a.item","fields":["text","href"],"limit":10,"all":true})',
  },
  {
    name: "read-urls: readUrls",
    call: { kind: "bc", method: "readUrls", args: [{ urls: ["https://a.test/1"], concurrency: 2, timeoutMs: 5000, maxChars: 2000 }] },
    golden: 'await __bc.readUrls({"urls":["https://a.test/1"],"concurrency":2,"timeoutMs":5000,"maxChars":2000})',
  },
  {
    name: "do: baseline",
    call: { kind: "bc", method: "baseline" },
    golden: "__bc.baseline()",
  },
  {
    name: "do (browse tab): location.href",
    call: { kind: "href" },
    golden: "location.href",
  },
  {
    name: "do: settle + [location.href, __bc.wall() || \"\"].join(\"\\n\")",
    call: {
      steps: [
        { kind: "bc", method: "settle", discard: true },
        { kind: "href" },
        { kind: "bc", method: "wall", fallback: "" },
      ],
      join: "\n",
    },
    golden: '(await __bc.settle(), [location.href, __bc.wall() || ""].join("\\n"))',
  },
  {
    name: "do (retry after waitParsed): [location.href, __bc.wall() || \"\"].join(\"\\n\")",
    call: {
      steps: [{ kind: "href" }, { kind: "bc", method: "wall", fallback: "" }],
      join: "\n",
    },
    golden: '[location.href, __bc.wall() || ""].join("\\n")',
  },
  {
    name: "value: value",
    call: { kind: "bc", method: "value", args: ["e12"] },
    golden: '__bc.value("e12")',
  },
  {
    name: "text --scroll: scrollRead",
    call: { kind: "bc", method: "scrollRead", args: [{ within: "#grid", match: "Order", limit: 50, timeoutMs: 10000 }] },
    golden: 'await __bc.scrollRead({"within":"#grid","match":"Order","limit":50,"timeoutMs":10000})',
  },
  {
    name: "text: text",
    call: { kind: "bc", method: "text", args: [{ within: "main", all: true, max: 5000 }] },
    golden: '__bc.text({"within":"main","all":true,"max":5000})',
  },
  {
    name: "shot --ref: rect",
    call: { kind: "bc", method: "rect", args: ["e12"] },
    golden: '__bc.rect("e12")',
  },
  {
    name: "shot: viewport",
    call: { kind: "bc", method: "viewport" },
    golden: "__bc.viewport()",
  },
  {
    name: "shot --marks: markBoxes",
    call: { kind: "bc", method: "markBoxes" },
    golden: "__bc.markBoxes()",
  },
  {
    name: "shot --marks: marks(true) (primary)",
    call: { kind: "bc", method: "marks", args: [true] },
    golden: "__bc.marks(true)",
  },
  {
    name: "shot --marks: marks(false) (clearDomMarks)",
    call: { kind: "bc", method: "marks", args: [false] },
    golden: "__bc.marks(false)",
  },
  {
    name: "shot --marks: marks(true) (fallback)",
    call: { kind: "bc", method: "marks", args: [true] },
    golden: "__bc.marks(true)",
  },
  {
    name: "shot --marks: marks(false) (fallback finally)",
    call: { kind: "bc", method: "marks", args: [false] },
    golden: "__bc.marks(false)",
  },
  {
    name: "nav: settle + [location.href, __bc.wall() || \"\"].join(\"\\n\")",
    call: {
      steps: [
        { kind: "bc", method: "settle", discard: true },
        { kind: "href" },
        { kind: "bc", method: "wall", fallback: "" },
      ],
      join: "\n",
    },
    golden: '(await __bc.settle(), [location.href, __bc.wall() || ""].join("\\n"))',
  },
  {
    name: "verdict: verdict",
    call: { kind: "bc", method: "verdict" },
    golden: "__bc.verdict()",
  },
  {
    name: "health: health",
    call: { kind: "bc", method: "health" },
    golden: "__bc.health()",
  },

  // --- src/picture.ts ---
  {
    name: "picture.isPicture: surface",
    call: { kind: "bc", method: "surface" },
    golden: "__bc.surface()",
  },
  {
    name: "picture.canvasHash: canvasHash",
    call: { kind: "bc", method: "canvasHash" },
    golden: "__bc.canvasHash()",
  },
  {
    name: "picture.readPicture: viewport",
    call: { kind: "bc", method: "viewport" },
    golden: "__bc.viewport()",
  },
];

const GOLDEN_ELEMENT_SITES: ReadonlyArray<{ name: string; step: ElementStep; golden: string }> = [
  {
    name: "upload: resolveObject(__bc.el(fileRef))",
    step: { kind: "bc", method: "el", args: ["e55"] },
    golden: '__bc.el("e55")',
  },
  {
    name: "devtools.inspectStyles (ref): resolveObject(__bc.el(target))",
    step: { kind: "bc", method: "el", args: ["@e12"] },
    golden: '__bc.el("@e12")',
  },
  {
    name: "devtools.inspectStyles (selector): resolveObject(document.querySelector(target))",
    step: { kind: "querySelector", selector: 'button[data-test="save"]' },
    golden: 'document.querySelector("button[data-test=\\"save\\"]")',
  },
];

describe("renderSteps golden strings for every converted call site", () => {
  for (const { name, call, golden } of GOLDEN_CALL_SITES) {
    test(name, () => {
      expect(renderSteps(call)).toBe(golden);
    });
  }

  for (const { name, step, golden } of GOLDEN_ELEMENT_SITES) {
    test(name, () => {
      expect(renderElementStep(step)).toBe(golden);
    });
  }
});

describe("renderSteps escaping, built-ins, normalization, and validation", () => {
  test("escapes quotes, backslashes, newlines, tabs, and unicode identically to JSON.stringify", () => {
    const tricky = `He said "hi" 'yo' \\path\\to\nline2\t日本語 🚀`;
    expect(renderSteps({ kind: "bc", method: "locate", args: [tricky, "click"] })).toBe(
      `__bc.locate(${JSON.stringify(tricky)}, "click")`,
    );
    expect(renderElementStep({ kind: "querySelector", selector: `[aria-label="Say \\"hi\\" — 日本語"]` })).toBe(
      `document.querySelector(${JSON.stringify('[aria-label="Say \\"hi\\" — 日本語"]')})`,
    );
  });

  test("handles undefined positional args and objects with undefined optional keys", () => {
    expect(renderSteps({ kind: "bc", method: "locate", args: ["Save", undefined] })).toBe(
      '__bc.locate("Save", undefined)',
    );
    expect(renderSteps({ kind: "bc", method: "snapshot", args: [{ all: false, find: undefined, within: "main" }] })).toBe(
      '__bc.snapshot({"all":false,"within":"main"})',
    );
    expect(renderSteps({ kind: "bc", method: "settle", args: [undefined, 80] })).toBe(
      "await __bc.settle(undefined, 80)",
    );
  });

  test("renders all built-in property steps", () => {
    expect(renderSteps({ kind: "href" })).toBe("location.href");
    expect(renderSteps({ kind: "readyState" })).toBe("document.readyState");
    expect(renderSteps({ kind: "origin" })).toBe("location.origin");
    expect(renderSteps({ kind: "host" })).toBe("location.host");
    expect(renderSteps({ kind: "title" })).toBe("document.title");
  });

  test("accepts a single step, a step array, or { steps, join }", () => {
    expect(normalizeHelperCall({ kind: "title" })).toEqual({ steps: [{ kind: "title" }] });
    expect(renderSteps([{ kind: "bc", method: "settle" }, { kind: "bc", method: "diff", args: [{ from: "" }] }])).toBe(
      '(await __bc.settle(), __bc.diff({"from":""}))',
    );
  });

  test("rejects raw JS smuggling in method names and malformed step shapes", () => {
    expect(() => renderSteps({ kind: "bc", method: "locate(); alert(1)//" })).toThrow("INPUT_INVALID");
    expect(() => renderSteps({ kind: "bc", method: "" })).toThrow("INPUT_INVALID");
    expect(() => renderSteps({ kind: "bc", method: "123bad" })).toThrow("INPUT_INVALID");
    expect(() => renderSteps({ steps: [] })).toThrow("INPUT_INVALID");
    expect(() =>
      renderSteps({ steps: [{ kind: "bc", method: "settle", discard: true }], join: "\n" }),
    ).toThrow("INPUT_INVALID");
    expect(() =>
      renderSteps({
        steps: [{ kind: "href" }, { kind: "bc", method: "settle", discard: true }],
        join: "\n",
      }),
    ).toThrow("INPUT_INVALID");
    expect(() => renderSteps({ kind: "bc", method: "locate", args: [() => {}] })).toThrow("INPUT_INVALID");
  });
});

describe("page-runner emits byte-identical CDP evaluate and Runtime.evaluate expressions", () => {
  test("captured expressions from live runner calls match pre-refactor goldens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-steps-"));
    try {
      const filePath = join(dir, "sample.txt");
      await writeFile(filePath, "hi");

      const evalExprs: string[] = [];
      const evalCalls: Record<string, unknown>[] = [];
      const runtimeEvalExprs: string[] = [];
      const runtimeEvalContexts: unknown[] = [];

      const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
        if (op === "get_browser_status") return { ok: true, data: { connected: true } };
        if (op === "evaluate") {
          const expr = String(input["expression"] ?? "");
          evalExprs.push(expr);
          evalCalls.push(input);
          // Plain property reads report a different context than helper calls; it must never reach upload/styles.
          if (/^(?:location\.(?:host|origin|href)|document\.readyState)$/.test(expr)) {
            return { ok: true, data: { value: expr === "location.host" ? "example.com" : "complete", contextId: 99 } };
          }
          if (expr.includes("__bc.locateFile")) return { ok: true, data: { value: "e55" } };
          if (expr.includes("__bc.locateOption")) return { ok: true, data: { value: "e99" } };
          if (expr.includes("__bc.locate")) return { ok: true, data: { value: "e7" } };
          if (expr.includes("__bc.point")) {
            return { ok: true, data: { value: expr.includes("__bc.baseline()") ? "https://a.test/ 10 20 visible" : "10 20 visible" } };
          }
          if (expr.includes("__bc.hit")) return { ok: true, data: { value: "https://a.test/\nhit: button#ok" } };
          if (expr.includes("__bc.viewport")) return { ok: true, data: { value: '{"x":0,"y":0,"width":800,"height":600,"dpr":1}' } };
          if (expr.includes("__bc.rect")) return { ok: true, data: { value: '{"x":1,"y":2,"width":50,"height":20,"dpr":1}' } };
          if (expr.includes("__bc.markBoxes")) return { ok: true, data: { value: "not-json" } };
          if (expr.includes("__bc.checkWait")) return { ok: true, data: { value: '{"matched":true,"url":"https://a.test/","wall":""}' } };
          if (expr.includes("__bc.dragInfo")) {
            return { ok: true, data: { value: '{"sx":1,"sy":2,"dx":3,"dy":4,"draggable":false,"listMeta":{"i":1}}' } };
          }
          if (expr.includes("__bc.setTypedValue")) return { ok: true, data: { value: "__not_typed__" } };
          if (expr.includes("__bc.cellInfo")) return { ok: true, data: { value: "__not_cell__" } };
          if (expr.includes("__bc.focusForType")) return { ok: true, data: { value: "focused" } };
          if (expr.includes("__bc.value")) return { ok: true, data: { value: "hello" } };
          if (expr.includes("__bc.select")) return { ok: true, data: { value: "__not_native__" } };
          if (expr.includes("location.href, __bc.wall()")) return { ok: true, data: { value: "https://a.test/\n" } };
          if (expr.includes("__bc.surface")) return { ok: true, data: { value: "dom" } };
          if (expr.includes("__bc.snapshot")) return { ok: true, data: { value: '# T | https://a.test/\n- button "Ok" [e1]' } };
          return { ok: true, data: { value: "ok", contextId: 7 } };
        }
        if (op === "execute_cdp") {
          if (input["method"] === "Runtime.evaluate") {
            const params = input["params"] as Record<string, unknown>;
            runtimeEvalExprs.push(String(params["expression"] ?? ""));
            runtimeEvalContexts.push(params["contextId"]);
            return { ok: true, data: { result: { result: { objectId: "obj-1" } } } };
          }
          if (input["method"] === "DOM.requestNode") return { ok: true, data: { result: { nodeId: 10 } } };
          if (input["method"] === "CSS.getMatchedStylesForNode") return { ok: true, data: { result: {} } };
          if (input["method"] === "CSS.getComputedStyleForNode") return { ok: true, data: { result: { computedStyle: [] } } };
          return { ok: true, data: { result: {} } };
        }
        if (op === "navigate") return { ok: true, data: { loaded: true } };
        if (op === "capture_screenshot") return { ok: true, data: { path: join(dir, "shot.jpg") } };
        return { ok: true, data: {} };
      };

      const handle = createPageHelperHandler(invoke, undefined, async () => [], {
        notesDir: dir,
        flowsDir: dir,
        sleep: async () => {},
        rng: () => 0.5,
      });

      const probeOf = (inner: string) =>
        `globalThis.__bc && globalThis.__bc.v === ${PAGE_HELPERS_VERSION} ? (${inner}) : "__BC_NEED_INSTALL__"`;

      await handle("snap", { find: "ok", within: "main" });
      await handle("click", { ref: "Ok" });
      await handle("click", { xy: [15, 25] });
      await handle("type", { ref: "e3", text: "hello", fast: true, quiet: true });
      await handle("select", { ref: "e8", option: "Admin", quiet: true });
      await handle("upload", { ref: "Resume", path: filePath, quiet: true });
      await handle("drag", { from: "e2", to: "e5", side: "before", quiet: true });
      await handle("wait", { text: "Saved" });
      await handle("nav", { url: "https://a.test/" });
      await handle("form", {});
      await handle("query", { selector: "a" });
      await handle("read-urls", { urls: ["https://a.test/1"] });
      await handle("text", { scroll: true, limit: 10 });
      await handle("text", { all: true });
      await handle("shot", { ref: "e1" });
      await handle("shot", { marks: true });
      await handle("verdict", {});
      await handle("health", {});
      await handle("notes", { sub: "get" });
      await handle("styles", { ref: "e12" });
      await handle("styles", { ref: ".card > h2" });

      expect(evalExprs).toContain(probeOf('__bc.snapshot({"all":false,"find":"ok","within":"main"})'));
      expect(evalExprs).toContain(probeOf('__bc.locate("Ok", "click")'));
      expect(evalExprs).toContain(probeOf('[__bc.baseline(), await __bc.point("e7")].join(" ")'));
      expect(evalExprs).toContain(probeOf("__bc.armInputProbe()"));
      expect(evalExprs).toContain(probeOf("__bc.readInputProbe()"));
      expect(evalExprs).toContain(probeOf('(await __bc.settle(), __bc.diff({"from":"https://a.test/"}))'));
      expect(evalExprs).toContain(probeOf('[__bc.baseline(), __bc.hit(15, 25)].join("\\n")'));
      expect(evalExprs).toContain(probeOf('__bc.guard("e3")'));
      expect(evalExprs).toContain(probeOf('__bc.setTypedValue("e3", "hello")'));
      expect(evalExprs).toContain(probeOf('__bc.cellInfo("e3")'));
      expect(evalExprs).toContain(probeOf('__bc.focusForType("e3")'));
      expect(evalExprs).toContain(probeOf('__bc.value("e3")'));
      expect(evalExprs).toContain(probeOf('__bc.select("e8", "Admin")'));
      expect(evalExprs).toContain(probeOf("await __bc.settle(300, 80)"));
      expect(evalExprs).toContain(probeOf('__bc.locateOption("Admin")'));
      expect(evalExprs).toContain(probeOf('__bc.locateFile("Resume")'));
      expect(evalExprs).toContain(probeOf('__bc.dragInfo("e2", "e5", "before")'));
      expect(evalExprs).toContain(probeOf('__bc.listPosition({"i":1})'));
      expect(evalExprs).toContain(probeOf('__bc.checkWait({"text":"Saved"})'));
      expect(evalExprs).toContain(probeOf('(await __bc.settle(), [location.href, __bc.wall() || ""].join("\\n"))'));
      expect(evalExprs).toContain(probeOf("__bc.form({})"));
      expect(evalExprs).toContain(probeOf('__bc.query({"selector":"a"})'));
      expect(evalExprs).toContain(probeOf('await __bc.readUrls({"urls":["https://a.test/1"]})'));
      expect(evalExprs).toContain(probeOf('await __bc.scrollRead({"limit":10})'));
      expect(evalExprs).toContain(probeOf('__bc.text({"all":true})'));
      expect(evalExprs).toContain(probeOf('__bc.rect("e1")'));
      expect(evalExprs).toContain(probeOf("__bc.viewport()"));
      expect(evalExprs).toContain(probeOf("__bc.markBoxes()"));
      expect(evalExprs).toContain(probeOf("__bc.marks(true)"));
      expect(evalExprs).toContain(probeOf("__bc.marks(false)"));
      expect(evalExprs).toContain(probeOf("__bc.verdict()"));
      expect(evalExprs).toContain(probeOf("__bc.health()"));
      // Non-__bc property lookup skips __bc probe/install on CDP
      expect(evalExprs).toContain("location.host");
      // resolveObject expressions for upload and styles
      expect(runtimeEvalExprs).toEqual(['__bc.el("e55")', '__bc.el("e12")', 'document.querySelector(".card > h2")']);
      // Property reads keep their pre-refactor options and never overwrite the helper context used by upload/styles.
      const opts = (expr: string) => evalCalls.filter((c) => c["expression"] === expr).map(({ expression: _e, ...rest }) => rest);
      for (const o of opts("location.host")) expect(o).toEqual({ isolated: true });
      for (const o of opts("location.origin")) expect(o).toEqual({ isolated: true });
      for (const o of opts("document.readyState")) expect(o).toEqual({ timeoutMs: 2_000 });
      for (const o of opts("location.href")) expect(o).toEqual({});
      expect(opts("location.host").length + opts("location.origin").length).toBeGreaterThan(0);
      expect(runtimeEvalContexts.filter((c) => c !== undefined).every((c) => c === 7)).toBe(true);
      expect(runtimeEvalContexts).not.toContain(99);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("page-runner property reads keep their pre-refactor options and context", () => {
  test("readyState, origin, host, and href each run with base options and never replace the helper context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-props-"));
    try {
      const calls: Record<string, unknown>[] = [];
      const runtimeContexts: unknown[] = [];
      let diffCalls = 0;
      const invoke = async (op: string, input: Record<string, unknown> = {}): Promise<InvokeResult> => {
        if (op === "get_browser_status") return { ok: true, data: { connected: true } };
        if (op === "evaluate") {
          const expr = String(input["expression"] ?? "");
          calls.push(input);
          if (/^(?:location\.(?:host|origin|href)|document\.readyState)$/.test(expr)) {
            const value = expr === "document.readyState" ? "complete" : expr === "location.host" ? "a.test" : "https://a.test";
            return { ok: true, data: { value, contextId: 99 } };
          }
          // First settle+diff fails so changes() falls back to waitParsed (the readyState read).
          if (expr.includes("__bc.diff") && diffCalls++ === 0) {
            return { ok: false, error: { code: "EXECUTION_FAILED", message: "JS_EXCEPTION: boom" } };
          }
          if (expr.includes("__bc.locate")) return { ok: true, data: { value: "e7", contextId: 7 } };
          if (expr.includes("__bc.point")) return { ok: true, data: { value: "https://a.test/ 10 20 visible", contextId: 7 } };
          return { ok: true, data: { value: "ok", contextId: 7 } };
        }
        if (op === "execute_cdp") {
          if (input["method"] === "Runtime.evaluate") {
            runtimeContexts.push((input["params"] as Record<string, unknown>)["contextId"]);
            return { ok: true, data: { result: { result: { objectId: "obj-1" } } } };
          }
          if (input["method"] === "DOM.requestNode") return { ok: true, data: { result: { nodeId: 10 } } };
          if (input["method"] === "CSS.getMatchedStylesForNode") return { ok: true, data: { result: {} } };
          if (input["method"] === "CSS.getComputedStyleForNode") return { ok: true, data: { result: { computedStyle: [] } } };
          return { ok: true, data: { result: {} } };
        }
        return { ok: true, data: {} };
      };
      const browse = async () => ({ code: 0, stdout: "{}", stderr: "" });
      const handle = createPageHelperHandler(invoke, browse as never, async () => [], {
        notesDir: dir,
        flowsDir: dir,
        sleep: async () => {},
        rng: () => 0.5,
      });

      await handle("snap", {}); // primes the helper context (7)
      await handle("click", { ref: "Ok" }); // diff fails once -> waitParsed -> document.readyState
      await handle("flow", { sub: "save", name: "x" }); // captureRecordedGets -> location.origin
      await handle("styles", { ref: "e12" }); // right after origin: still helper context 7
      await handle("notes", { sub: "get" }); // location.host
      await handle("styles", { ref: "e12" }); // right after host: still helper context 7
      await handle("do", { steps: [{ key: "Tab" }] }, "browse:7"); // browse-tab start URL -> location.href
      await handle("styles", { ref: "e12" }); // must still use helper context 7, not 99

      const opts = (expr: string) =>
        calls.filter((c) => c["expression"] === expr).map(({ expression: _e, ...rest }) => rest);
      expect(opts("document.readyState")).toContainEqual({ timeoutMs: 2_000 });
      for (const o of opts("document.readyState")) expect(o).toEqual({ timeoutMs: 2_000 });
      expect(opts("location.origin").length).toBeGreaterThan(0);
      for (const o of opts("location.origin")) expect(o).toEqual({ isolated: true });
      expect(opts("location.host").length).toBeGreaterThan(0);
      for (const o of opts("location.host")) expect(o).toEqual({ isolated: true });
      expect(opts("location.href")).toContainEqual({ targetId: "browse:7" });
      for (const o of opts("location.href")) expect(o).toEqual({ targetId: "browse:7" });
      // readyState is followed by a helper retry that legitimately re-caches 7, and href runs on another
      // target, so cache isolation for those two rests on readProperty never touching contextIds.
      expect(runtimeContexts).toEqual([7, 7, 7]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
