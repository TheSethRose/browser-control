// Long-lived server for one capability runtime, so one CDP connection (and one
// Chrome "Allow" prompt) serves many short client calls. It listens on a Unix
// socket; `scripts/browser-control-daemon` is the curl-based client.
//
//   POST /call/<operation>   JSON object body -> InvokeResult JSON (HTTP 400 when ok:false)
//   POST /eval               JavaScript body  -> the value as text
//   POST /nav                URL body         -> navigate result as text (?until=load&snap=1)
//   POST /page/<action>      JSON body        -> page helper result as text
//        actions: snap, click, type, key, value, text, ocr, do, shot, verdict, health
//   GET  /tabs               one page per line, "*" marks the active target
//   GET  /ops                one operation per line with its input names
//   GET  /status             daemon pid + get_browser_status
//   POST /stop               dispose and exit
//
// /eval, /nav and /page/* take ?t=<targetId> or ?m=<text in the tab's url or title>, and
// ?q=1 to leave out the "what changed" lines after an action.
import { openStandaloneCapability, type InvokeResult } from "@agent-software/core";
import { rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runBrowse, type Runner } from "./src/backends/browse";
import { recognizeText, type Recognizer } from "./src/ocr";
import { KEYS, PAGE_HELPERS_SOURCE, PAGE_HELPERS_VERSION, parseLocator, type Locator } from "./src/page-helpers";

type Json = Record<string, unknown>;
type Invoker = (operation: string, input?: Json) => Promise<InvokeResult>;

const NEED_INSTALL = "__BC_NEED_INSTALL__";
/** Input events never return while a JavaScript dialog is open, so don't wait the full CDP timeout. */
const INPUT_TIMEOUT_MS = 10_000;
const DIALOG_HINT = "the page stopped responding; a JavaScript dialog is probably open (references/dialogs.md)";

const failure = (code: string, message: string): InvokeResult =>
  ({ ok: false, error: { code, message } }) as InvokeResult;
const success = (value: string): InvokeResult => ({ ok: true, data: { value } });
const valueOf = (res: InvokeResult): string => (res.ok ? String((res.data as Json)["value"] ?? "") : "");
const messageOf = (res: InvokeResult): string => (res.ok ? "" : res.error.message);
const js = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Strings print bare; everything else prints as JSON. */
function asText(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} of ${text.length} chars; narrow the expression or raise BROWSER_CONTROL_MAX_OUTPUT]`;
}

function browseTabNumber(targetId: unknown): number | undefined {
  if (typeof targetId !== "string" || !targetId.startsWith("browse:")) return undefined;
  const n = Number(targetId.slice("browse:".length));
  return Number.isInteger(n) ? n : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const AX_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "tab", "menuitem",
  "menuitemcheckbox", "menuitemradio", "switch", "slider", "spinbutton", "option", "treeitem", "listbox",
]);
const AX_LIMIT = 250;

type AxNode = {
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
};

/** Controls from Chrome's accessibility tree, which reaches closed shadow roots the DOM walk can't. */
export function formatAxTree(nodes: AxNode[], find?: string): string[] {
  const want = find?.toLowerCase();
  const lines: string[] = [];
  for (const n of nodes) {
    const role = n.role?.value ?? "";
    if (n.ignored || !AX_ROLES.has(role) || n.backendDOMNodeId === undefined) continue;
    const name = String(n.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const flags = (n.properties ?? [])
      .filter((p) => ["disabled", "checked", "expanded", "required"].includes(p.name) && (p.value?.value === true || p.value?.value === "true"))
      .map((p) => p.name);
    const line = `- ${role}${name ? ` "${name.replace(/"/g, "'")}"` : ""} [a${n.backendDOMNodeId}]${flags.length ? ` [${flags.join(",")}]` : ""}`;
    if (want && !line.toLowerCase().includes(want)) continue;
    lines.push(line);
    if (lines.length >= AX_LIMIT) break;
  }
  return lines;
}

/** Resolve `--match <text>` to the one tab whose url or title contains it. */
export async function matchTab(invoke: Invoker, match: string): Promise<{ ok: true; targetId: string } | { ok: false; res: InvokeResult }> {
  const listed = await invoke("list_targets", { types: ["page"] });
  if (!listed.ok) return { ok: false, res: listed };
  const want = match.toLowerCase();
  const tabs = ((listed.data as Json)["targets"] as Array<{ targetId: string; url: string; title: string }>) ?? [];
  const hits = tabs.filter((t) => t.url.toLowerCase().includes(want) || t.title.toLowerCase().includes(want));
  if (hits.length === 1) return { ok: true, targetId: hits[0]!.targetId };
  const list = (hits.length ? hits : tabs).slice(0, 12).map((t) => `  ${t.targetId} ${t.url.slice(0, 100)} | ${t.title.slice(0, 60)}`).join("\n");
  return {
    ok: false,
    res: failure(
      "EXECUTION_FAILED",
      hits.length ? `AMBIGUOUS: --match "${match}" fits ${hits.length} tabs; pass a targetId:\n${list}` : `NO_MATCH: no tab's url or title contains "${match}". Open tabs:\n${list}`,
    ),
  };
}

/** A helper's own refusal arrives wrapped as a JavaScript exception with a stack; keep just the message. */
function helperError(res: InvokeResult): InvokeResult {
  if (res.ok) return res;
  const m = /^JS_EXCEPTION: (?:Error: )?((?:AMBIGUOUS|NO_MATCH|STALE_REF|NOT_ACTIONABLE|REFUSED|INPUT_INVALID): [\s\S]*?)(?:\n\s+at [\s\S]*)?$/.exec(res.error.message);
  return m ? failure(res.error.code, m[1]!) : res;
}

/** Pixel width of a PNG or JPEG file, or undefined when it can't be read. */
export async function imageWidth(path: string): Promise<number | undefined> {
  try {
    const v = new DataView(await Bun.file(path).arrayBuffer());
    if (v.getUint32(0) === 0x89504e47) return v.getUint32(16);
    for (let i = 2; i + 9 < v.byteLength; ) {
      const marker = v.getUint16(i);
      if (marker >= 0xffc0 && marker <= 0xffc3) return v.getUint16(i + 7);
      i += 2 + v.getUint16(i + 2);
    }
  } catch {
    // unreadable: the caller keeps the first capture
  }
  return undefined;
}

type Point = { x: number; y: number; hidden: boolean; before?: string };
type Step = { action: string; input: Json; label: string };

/**
 * Page helper runner shared by the daemon HTTP handler and unit tests.
 * Injects `__bc` lazily once per document, dispatches mouse/key input in-process, reports what
 * each action changed, and routes `snap`/`click`/`type`/`key` to the `browse` CLI on `browse:<n>` tabs.
 */
export function createPageHelperHandler(invoke: Invoker, browseRunner: Runner = runBrowse, recognize: Recognizer = recognizeText) {
  /** Cross-origin iframe targets from the last snap of each tab: f1 is index 0. */
  const frameTargets = new Map<string, string[]>();
  /** Text last recognized on each picture page, to report what an action changed. */
  const seenText = new Map<string, Map<string, string>>();

  /** Recognize the visible text of a tab from a screenshot: one "x,y "text"" line each, in click coordinates. */
  async function readPicture(targetId?: string): Promise<{ ok: true; lines: Map<string, string> } | { ok: false; res: InvokeResult }> {
    const box = await evalHelper("__bc.viewport()", targetId);
    if (!box.ok) return { ok: false, res: box };
    const v = JSON.parse(valueOf(box)) as { x: number; y: number; width: number; height: number };
    const path = join(tmpdir(), `bc-ocr-${randomUUID()}.png`);
    const shot = await invoke("capture_screenshot", {
      format: "png",
      path,
      clip: { x: v.x, y: v.y, width: v.width, height: v.height, scale: 1 },
      ...(targetId ? { targetId } : {}),
    });
    if (!shot.ok) return { ok: false, res: shot };
    try {
      const boxes = await recognize(String((shot.data as Json)["path"] ?? path));
      boxes.sort((a, b) => (Math.abs(a.y - b.y) < 0.008 ? a.x - b.x : a.y - b.y));
      const lines = new Map<string, string>();
      for (const b of boxes) {
        const at = `${Math.round((b.x + b.width / 2) * v.width)},${Math.round((b.y + b.height / 2) * v.height)}`;
        lines.set(`${b.text}@${Math.round(b.y * 50)}`, `${at} "${b.text.replace(/"/g, "'")}"`);
      }
      return { ok: true, lines };
    } catch (error) {
      return { ok: false, res: failure("EXECUTION_FAILED", (error as Error).message) };
    } finally {
      // The picture holds whatever was on screen; keep only the text that was asked for.
      await unlink(String((shot.data as Json)["path"] ?? path)).catch(() => {});
    }
  }

  /** On a picture page the DOM never changes, so compare recognized text before and after instead. */
  async function pictureChanges(targetId?: string): Promise<string> {
    const before = seenText.get(targetId ?? "");
    if (!before) return "# picture page: run ocr to read the result";
    await sleep(700);
    const now = await readPicture(targetId);
    if (!now.ok) return `# could not read the picture: ${messageOf(now.res).slice(0, 160)}`;
    seenText.set(targetId ?? "", now.lines);
    const out: string[] = [];
    for (const [key, line] of now.lines) if (!before.has(key)) out.push(`+ ${line}`);
    for (const [key, line] of before) if (!now.lines.has(key)) out.push(`- ${line.replace(/^\S+ /, "")}`);
    if (out.length === 0) return "# no visible text change yet (the remote page may still be drawing; run ocr again)";
    return out.length > 40 ? [...out.slice(0, 40), `# … ${out.length - 40} more changes; run ocr`].join("\n") : out.join("\n");
  }

  const isPicture = async (targetId?: string) => valueOf(await evalHelper("__bc.surface()", targetId)) === "picture";

  async function resolveBrowseTab(targetId?: string): Promise<number | undefined> {
    if (targetId !== undefined) return browseTabNumber(targetId);
    const status = await invoke("get_browser_status");
    if (!status.ok) return undefined;
    const backends = (status.data as Json)["backends"] as Json | undefined;
    if (backends?.["active"] !== "browse") return undefined;
    const browseState = backends["browse"] as Json | undefined;
    return browseTabNumber(browseState?.["activeTargetId"]);
  }

  async function callBrowse(tool: string, args: Json, timeoutMs = 60_000): Promise<InvokeResult> {
    const res = await browseRunner([tool, "--json", JSON.stringify(args)], timeoutMs);
    const out = res.stdout || res.stderr;
    if (res.code === 127) {
      return failure("EXECUTION_FAILED", "BACKEND_UNAVAILABLE: the browse CLI is not installed");
    }
    if (res.code !== 0) {
      return failure("EXECUTION_FAILED", out || `browse ${tool} failed (exit ${res.code})`);
    }
    return success(out);
  }

  async function evalHelper(callExpr: string, targetId?: string, timeoutMs?: number): Promise<InvokeResult> {
    const extra = { ...(targetId ? { targetId } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
    const probe = `globalThis.__bc && globalThis.__bc.v === ${PAGE_HELPERS_VERSION} ? (${callExpr}) : "${NEED_INSTALL}"`;
    const first = await invoke("evaluate", { expression: probe, ...extra });
    if (!first.ok) return helperError(first);
    if ((first.data as Json)["value"] !== NEED_INSTALL) return first;
    return helperError(await invoke("evaluate", { expression: `${PAGE_HELPERS_SOURCE}\n${callExpr}`, ...extra }));
  }

  async function cdp(method: string, params: Json, targetId?: string, timeoutMs?: number): Promise<InvokeResult> {
    return invoke("execute_cdp", { method, params, ...(targetId ? { targetId } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  }

  async function clickCoords(x: number, y: number, targetId?: string): Promise<InvokeResult> {
    const m1 = await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, targetId, INPUT_TIMEOUT_MS);
    if (!m1.ok) return m1;
    const m2 = await cdp(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
      targetId,
      INPUT_TIMEOUT_MS,
    );
    if (!m2.ok) return m2;
    return cdp(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 },
      targetId,
      INPUT_TIMEOUT_MS,
    );
  }

  /** Turn a label into a ref; everything else passes through. */
  async function locate(raw: unknown, kind: "click" | "type" | "read", targetId?: string): Promise<{ ok: true; loc: Exclude<Locator, { kind: "label" }> } | { ok: false; res: InvokeResult }> {
    let loc: Locator;
    try {
      loc = parseLocator(raw);
    } catch (error) {
      return { ok: false, res: failure("INPUT_VALIDATION_FAILED", (error as Error).message) };
    }
    if (loc.kind !== "label") return { ok: true, loc };
    const found = await evalHelper(`__bc.locate(${js(loc.label)}, ${js(kind)})`, targetId);
    if (!found.ok) return { ok: false, res: found };
    return { ok: true, loc: { kind: "dom", ref: valueOf(found) } };
  }

  const nameOf = (loc: Exclude<Locator, { kind: "label" }>) =>
    loc.kind === "dom" ? loc.ref : loc.kind === "frame" ? `f${loc.frame}:${loc.ref}` : `a${loc.node}`;

  function frameTarget(frame: number, targetId?: string): string | undefined {
    return frameTargets.get(targetId ?? "")?.[frame - 1];
  }

  /** Where to click, in the top page's viewport coordinates. `baseline` also records the controls for the later diff. */
  async function pointOf(loc: Exclude<Locator, { kind: "label" }>, targetId: string | undefined, baseline: boolean): Promise<{ ok: true; pt: Point } | { ok: false; res: InvokeResult }> {
    const bad = (res: InvokeResult) => ({ ok: false as const, res });
    if (loc.kind === "ax") {
      const before = baseline ? await evalHelper("__bc.baseline()", targetId) : undefined;
      await cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId: loc.node }, targetId);
      const quads = await cdp("DOM.getContentQuads", { backendNodeId: loc.node }, targetId);
      if (!quads.ok) return bad(quads);
      const q = ((((quads.data as Json)["result"] as Json | undefined)?.["quads"] as number[][] | undefined) ?? [])[0];
      if (!q || q.length < 8) return bad(failure("EXECUTION_FAILED", `NOT_ACTIONABLE: a${loc.node} has no visible box. Run snap --ax again.`));
      return {
        ok: true,
        pt: { x: Math.round((q[0]! + q[2]! + q[4]! + q[6]!) / 4), y: Math.round((q[1]! + q[3]! + q[5]! + q[7]!) / 4), hidden: false, before: before?.ok ? valueOf(before) : undefined },
      };
    }
    const where = loc.kind === "frame" ? frameTarget(loc.frame, targetId) : targetId;
    if (loc.kind === "frame" && !where) {
      return bad(failure("EXECUTION_FAILED", `STALE_REF: iframe f${loc.frame} is not known for this tab. Run snap again.`));
    }
    const before = baseline && loc.kind === "frame" ? await evalHelper("__bc.baseline()", targetId) : undefined;
    const expr = baseline && loc.kind === "dom"
      ? `[__bc.baseline(), await __bc.point(${js(loc.ref)})].join(" ")`
      : `await __bc.point(${js(loc.ref)})`;
    const res = await evalHelper(expr, where);
    if (!res.ok) return bad(res);
    const parts = valueOf(res).split(" ");
    const href = baseline && loc.kind === "dom" ? parts.shift() : before?.ok ? valueOf(before) : undefined;
    let x = Number(parts[0]);
    let y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return bad(failure("EXECUTION_FAILED", `unexpected point output: ${valueOf(res)}`));
    }
    if (loc.kind === "frame") {
      const off = await evalHelper(`__bc.frameOffset(${loc.frame})`, targetId);
      if (!off.ok) return bad(off);
      const [ox, oy] = valueOf(off).split(" ").map(Number);
      x = Math.round(x + (ox ?? 0));
      y = Math.round(y + (oy ?? 0));
    }
    return { ok: true, pt: { x, y, hidden: parts[2] === "hidden", before: href } };
  }

  async function clickAt(pt: Point, targetId?: string): Promise<InvokeResult> {
    if (pt.hidden) {
      const foc = await cdp("Emulation.setFocusEmulationEnabled", { enabled: true }, targetId);
      if (!foc.ok) return foc;
    }
    return clickCoords(pt.x, pt.y, targetId);
  }

  async function pressKey(name: string, targetId?: string): Promise<InvokeResult> {
    const spec = KEYS[name];
    if (!spec) {
      return failure("INPUT_VALIDATION_FAILED", `INPUT_INVALID: key must be ${Object.keys(KEYS).join(", ")}`);
    }
    const base: Json = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode };
    const down = spec.text !== undefined
      ? await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: spec.text }, targetId, INPUT_TIMEOUT_MS)
      : await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, targetId, INPUT_TIMEOUT_MS);
    if (!down.ok) return down;
    return cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base }, targetId, INPUT_TIMEOUT_MS);
  }

  /** The document was replaced mid-call: give the new one a moment to parse. */
  async function waitParsed(targetId?: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const ready = await invoke("evaluate", { expression: "document.readyState", ...(targetId ? { targetId } : {}), timeoutMs: 2_000 });
      if (ready.ok && valueOf(ready) !== "loading") return;
      await sleep(125);
    }
  }

  /** What changed since the baseline, once the page has settled. Survives a navigation. */
  async function changes(before: string | undefined, targetId?: string): Promise<string> {
    const expr = `(await __bc.settle(), __bc.diff(${js({ from: before ?? "" })}))`;
    let res = await evalHelper(expr, targetId, 8_000);
    if (!res.ok && messageOf(res).startsWith("CDP_TIMEOUT")) return `# ${DIALOG_HINT}`;
    if (!res.ok) {
      await waitParsed(targetId);
      res = await evalHelper(expr, targetId, 8_000);
    }
    return res.ok ? valueOf(res) : `# could not read what changed: ${messageOf(res).slice(0, 160)}`;
  }

  const withChanges = async (line: string, before: string | undefined, quiet: boolean, targetId?: string): Promise<InvokeResult> =>
    success(quiet ? line : `${line}\n${await changes(before, targetId)}`);

  const inputFailed = (res: InvokeResult, what: string): InvokeResult =>
    messageOf(res).startsWith("CDP_TIMEOUT") ? success(`${what}: delivered_unverified (${DIALOG_HINT})`) : res;

  async function snapFrames(opts: Json, targetId?: string): Promise<string[]> {
    const listed = await evalHelper("__bc.frames()", targetId);
    if (!listed.ok) return [];
    let frames: Array<{ i: number; src: string; title: string }>;
    try {
      frames = JSON.parse(valueOf(listed));
    } catch {
      return [];
    }
    if (frames.length === 0) return [];
    const targets = await invoke("list_targets", { types: ["iframe"] });
    const pool = targets.ok ? [...(((targets.data as Json)["targets"] as Array<{ targetId: string; url: string }>) ?? [])] : [];
    const path = (u: string) => {
      try {
        const p = new URL(u);
        return p.origin + p.pathname;
      } catch {
        return u;
      }
    };
    const origin = (u: string) => {
      try {
        return new URL(u).origin;
      } catch {
        return u;
      }
    };
    const take = (test: (t: { url: string }) => boolean) => {
      const at = pool.findIndex(test);
      return at === -1 ? undefined : pool.splice(at, 1)[0];
    };
    const ids: string[] = [];
    const out: string[] = [];
    for (const f of frames.slice(0, 8)) {
      const t = take((x) => x.url === f.src) ?? take((x) => path(x.url) === path(f.src)) ?? take((x) => origin(x.url) === origin(f.src));
      const label = `f${f.i}${f.title ? ` "${f.title}"` : ""} ${hostOf(f.src)}`;
      if (!t) {
        ids[f.i - 1] = "";
        out.push(`# iframe ${label}: not reachable; click by coordinates (click --xy) or see references/frames.md`);
        continue;
      }
      ids[f.i - 1] = t.targetId;
      const inner = await evalHelper(`__bc.snapshot(${js({ all: opts["all"] === true, find: opts["find"] })})`, t.targetId, 5_000);
      const lines = inner.ok ? valueOf(inner).split("\n").filter((l) => l.startsWith("- ")) : [];
      out.push(`# iframe ${label}: ${lines.length} control(s)`);
      out.push(...lines.map((l) => l.replace(/\[e(\d+)\]/, `[f${f.i}:e$1]`)));
    }
    frameTargets.set(targetId ?? "", ids);
    return out;
  }

  async function snapAx(find: unknown, targetId?: string): Promise<InvokeResult> {
    const tree = await cdp("Accessibility.getFullAXTree", {}, targetId, 20_000);
    if (!tree.ok) return tree;
    const nodes = ((((tree.data as Json)["result"] as Json | undefined)?.["nodes"]) as AxNode[] | undefined) ?? [];
    const lines = formatAxTree(nodes, typeof find === "string" ? find : undefined);
    return success([`# accessibility tree: ${lines.length} control(s). Refs like a41 work with click and type; values are never shown.`, ...lines].join("\n"));
  }

  function parseSteps(input: Json): Step[] | string {
    const raw = input["steps"] ?? input["fill"];
    const steps: Step[] = [];
    if (input["fill"] !== undefined) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "fill takes a JSON object of label or ref to text";
      for (const [ref, text] of Object.entries(raw as Json)) {
        if (typeof text !== "string") return `fill: the value for "${ref}" must be a string`;
        steps.push({ action: "type", input: { ref, text }, label: `type ${js(ref)}` });
      }
      return steps;
    }
    if (!Array.isArray(raw)) return 'do takes a JSON array of steps, e.g. [{"type":["Email","a@b.co"]},{"key":"Tab"},{"click":"Next"}]';
    for (const [i, entry] of raw.entries()) {
      const keys = typeof entry === "object" && entry !== null ? Object.keys(entry as Json) : [];
      const verb = keys[0];
      const arg = verb ? (entry as Json)[verb] : undefined;
      if (keys.length !== 1 || !verb) return `step ${i + 1}: each step is one verb, e.g. {"click":"Save"}`;
      if (verb === "click" && typeof arg === "string") steps.push({ action: "click", input: { ref: arg }, label: `click ${js(arg)}` });
      else if (verb === "key" && typeof arg === "string") steps.push({ action: "key", input: { key: arg }, label: `key ${arg}` });
      else if (verb === "type" && Array.isArray(arg) && typeof arg[0] === "string" && typeof arg[1] === "string") {
        steps.push({ action: "type", input: { ref: arg[0], text: arg[1], keys: arg[2] === "keys" || arg[2] === true }, label: `type ${js(arg[0])}` });
      } else return `step ${i + 1}: use {"click":"<ref|label>"}, {"type":["<ref|label>","<text>"]} or {"key":"<name>"}`;
    }
    return steps;
  }

  async function act(action: string, input: Json, targetId: string | undefined, quiet: boolean, browseTab: number | undefined): Promise<InvokeResult> {
    switch (action) {
      case "click": {
        if (Array.isArray(input["xy"])) {
          const [x, y] = (input["xy"] as unknown[]).map(Number);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: --xy takes x,y in CSS pixels");
          if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: --xy needs a DevTools tab");
          const hit = await evalHelper(`[__bc.baseline(), __bc.hit(${x}, ${y})].join("\\n")`, targetId);
          if (!hit.ok) return hit;
          const [before, what] = valueOf(hit).split("\n");
          const clicked = await clickCoords(x!, y!, targetId);
          if (!clicked.ok) return inputFailed(clicked, `click ${x},${y}`);
          if (!quiet && /^hit: canvas/.test(what ?? "")) return success(`click ${x},${y}: delivered. ${what}\n${await pictureChanges(targetId)}`);
          return withChanges(`click ${x},${y}: delivered. ${what}`, before, quiet, targetId);
        }
        if (browseTab !== undefined) {
          const res = await callBrowse("click", { tab: browseTab, ref: input["ref"] });
          return res.ok && !quiet ? browseDelta(res, browseTab) : res;
        }
        const found = await locate(input["ref"], "click", targetId);
        if (!found.ok) return found.res;
        const at = await pointOf(found.loc, targetId, !quiet);
        if (!at.ok) return at.res;
        const clicked = await clickAt(at.pt, targetId);
        if (!clicked.ok) return inputFailed(clicked, `click ${nameOf(found.loc)}`);
        return withChanges(`click ${nameOf(found.loc)} at ${at.pt.x},${at.pt.y}: delivered`, at.pt.before, quiet, targetId);
      }

      case "type": {
        if (typeof input["text"] !== "string") {
          return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: text is required");
        }
        const text = input["text"];
        const keys = input["keys"] === true;
        if (browseTab !== undefined) {
          const res = await callBrowse("fill", { tab: browseTab, ref: input["ref"], value: text });
          return res.ok && !quiet ? browseDelta(res, browseTab) : res;
        }
        if (input["focused"] === true) {
          const g = await evalHelper("__bc.guardFocused()", targetId);
          if (!g.ok) return g;
          const picture = !quiet && (await isPicture(targetId));
          const before = quiet || picture ? undefined : await evalHelper("__bc.baseline()", targetId);
          const ins = await cdp("Input.insertText", { text }, targetId, INPUT_TIMEOUT_MS);
          if (!ins.ok) return inputFailed(ins, "type --focused");
          const line = "type --focused: sent to whatever has focus (not read back)";
          if (picture) return success(`${line}\n${await pictureChanges(targetId)}`);
          return withChanges(line, before?.ok ? valueOf(before) : undefined, quiet, targetId);
        }
        const found = await locate(input["ref"], "type", targetId);
        if (!found.ok) return found.res;
        const loc = found.loc;
        const name = nameOf(loc);
        // Field checks run where the field lives: its own target for a cross-origin iframe.
        const fieldTarget = loc.kind === "frame" ? frameTarget(loc.frame, targetId) : targetId;
        if (loc.kind !== "ax") {
          const g = await evalHelper(`__bc.guard(${js(loc.ref)})`, fieldTarget);
          if (!g.ok) return g;
        }
        const at = await pointOf(loc, targetId, !quiet);
        if (!at.ok) return at.res;
        const clicked = await clickAt(at.pt, targetId);
        if (!clicked.ok) return inputFailed(clicked, `type ${name}`);
        if (loc.kind !== "ax") {
          const st = await evalHelper(`__bc.focusForType(${js(loc.ref)})`, fieldTarget);
          if (!st.ok) return st;
          if (valueOf(st) !== "focused") {
            return failure("EXECUTION_FAILED", `type ${name}: not_delivered (the click did not focus it; try snap again)`);
          }
        }
        if (text === "") {
          const bs = await pressKey("Backspace", targetId);
          if (!bs.ok) return bs;
        } else if (keys) {
          for (const ch of text) {
            const kd = await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }, targetId, INPUT_TIMEOUT_MS);
            if (!kd.ok) return kd;
            const ku = await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, targetId, INPUT_TIMEOUT_MS);
            if (!ku.ok) return ku;
          }
        } else {
          const ins = await cdp("Input.insertText", { text }, targetId, INPUT_TIMEOUT_MS);
          if (!ins.ok) return ins;
        }
        if (loc.kind === "ax") {
          return withChanges(`type ${name}: delivered_unverified (accessibility ref, not read back)`, at.pt.before, quiet, targetId);
        }
        const readback = await evalHelper(`__bc.value(${js(loc.ref)})`, fieldTarget);
        const got = readback.ok ? valueOf(readback) : "__unknown__";
        const msg = got === "__secure__"
          ? `type ${name}: delivered_unverified (secure field, not read back)`
          : got === text
            ? `type ${name}: delivered (read back matches)`
            : `type ${name}: delivered_unverified (read back "${got.slice(0, 80)}"). Do not retype blindly; snap first.`;
        return withChanges(msg, at.pt.before, quiet, targetId);
      }

      case "key": {
        const keyName = typeof input["key"] === "string" ? input["key"] : "";
        if (!KEYS[keyName]) {
          return failure("INPUT_VALIDATION_FAILED", `INPUT_INVALID: key must be ${Object.keys(KEYS).join(", ")}`);
        }
        if (browseTab !== undefined) {
          const res = await callBrowse("press", { tab: browseTab, key: keyName });
          return res.ok && !quiet ? browseDelta(res, browseTab) : res;
        }
        const picture = !quiet && (await isPicture(targetId));
        const before = quiet || picture ? undefined : await evalHelper("__bc.baseline()", targetId);
        const res = await pressKey(keyName, targetId);
        if (!res.ok) return inputFailed(res, `key ${keyName}`);
        if (picture) return success(`key ${keyName}: sent\n${await pictureChanges(targetId)}`);
        return withChanges(`key ${keyName}: sent`, before?.ok ? valueOf(before) : undefined, quiet, targetId);
      }

      default:
        return failure("OPERATION_NOT_FOUND", `unknown page helper: ${action}`);
    }
  }

  async function browseDelta(res: InvokeResult, tab: number): Promise<InvokeResult> {
    const delta = await callBrowse("snapshot", { tab, interactive: true, delta: true });
    return delta.ok ? success(`${valueOf(res)}\n${valueOf(delta)}`) : res;
  }

  return async function handlePage(action: string, input: Json, targetId?: string): Promise<InvokeResult> {
    const browseTab = await resolveBrowseTab(targetId);
    const quiet = input["quiet"] === true;

    switch (action) {
      case "snap": {
        const all = input["all"] === true;
        const find = typeof input["find"] === "string" && input["find"] !== "" ? input["find"] : undefined;
        const within = typeof input["within"] === "string" && input["within"] !== "" ? input["within"] : undefined;
        if (browseTab !== undefined) {
          return callBrowse("snapshot", {
            tab: browseTab,
            ...(all ? {} : { interactive: true }),
            ...(find ? { find } : {}),
            ...(within ? { within } : {}),
          });
        }
        if (input["ax"] === true) return snapAx(find, targetId);
        const opts: Json = { all, ...(find ? { find } : {}), ...(within ? { within } : {}) };
        const res = await evalHelper(`__bc.snapshot(${js(opts)})`, targetId);
        if (!res.ok) return res;
        let out = valueOf(res);
        if (!within && out.includes("cross-origin iframe(s)")) {
          const frames = await snapFrames(opts, targetId);
          if (frames.length) out += `\n${frames.join("\n")}`;
        }
        if (!find && !within && !out.includes("\n- ") && !out.includes("# WALL:")) {
          const ax = await snapAx(undefined, targetId);
          if (ax.ok && valueOf(ax).includes("\n- ")) out += `\n# No controls found in the DOM.\n${valueOf(ax)}`;
        }
        return success(out);
      }

      case "click":
      case "type":
      case "key":
        return act(action, input, targetId, quiet, browseTab);

      case "do": {
        const steps = parseSteps(input);
        if (typeof steps === "string") return failure("INPUT_VALIDATION_FAILED", `INPUT_INVALID: ${steps}`);
        if (steps.length === 0) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: no steps given");
        const start = browseTab === undefined ? await evalHelper("__bc.baseline()", targetId) : undefined;
        if (start && !start.ok) return start;
        const startUrl = start ? valueOf(start) : "";
        const out: string[] = [];
        let stopped: string | undefined;
        for (const [i, step] of steps.entries()) {
          const res = await act(step.action, { ...step.input, quiet: true }, targetId, true, browseTab);
          if (!res.ok) {
            out.push(`${i + 1}. ${step.label}: FAILED ${messageOf(res)}`);
            stopped = `step ${i + 1} failed`;
            break;
          }
          out.push(`${i + 1}. ${valueOf(res)}`);
          if (step.action === "type" && !valueOf(res).includes(": delivered (") && !valueOf(res).includes("secure field")) {
            stopped = `step ${i + 1} was not read back as typed`;
            break;
          }
          if (browseTab !== undefined || i === steps.length - 1) continue;
          // Let the page react before the next step, and stop if it left the site or hit a wall.
          const state = await evalHelper('(await __bc.settle(), [location.href, __bc.wall() || ""].join("\\n"))', targetId, 8_000);
          let url = "";
          let wall = "";
          if (state.ok) [url = "", wall = ""] = valueOf(state).split("\n");
          else {
            await waitParsed(targetId);
            const again = await evalHelper('[location.href, __bc.wall() || ""].join("\\n")', targetId, 8_000);
            if (again.ok) [url = "", wall = ""] = valueOf(again).split("\n");
          }
          if (wall) stopped = `the page is a ${wall} wall after step ${i + 1}`;
          else if (url && hostOf(url) !== hostOf(startUrl)) stopped = `step ${i + 1} left ${hostOf(startUrl)} for ${hostOf(url)}`;
          if (stopped) break;
        }
        if (stopped) out.push(`# STOPPED: ${stopped}. ${steps.length - out.length} step(s) not run.`);
        if (!quiet) {
          if (browseTab !== undefined) {
            const delta = await callBrowse("snapshot", { tab: browseTab, interactive: true, delta: true });
            if (delta.ok) out.push(valueOf(delta));
          } else {
            out.push(await changes(startUrl, targetId));
          }
        }
        return stopped ? failure("EXECUTION_FAILED", out.join("\n")) : success(out.join("\n"));
      }

      case "value": {
        if (browseTab !== undefined) {
          return failure(
            "INPUT_VALIDATION_FAILED",
            "INPUT_INVALID: value <ref> reads DevTools refs; on browse:<n> tabs use snap or eval",
          );
        }
        const found = await locate(input["ref"], "read", targetId);
        if (!found.ok) return found.res;
        if (found.loc.kind === "ax") {
          return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: value needs a DOM ref (e12 or f2:e5), not an accessibility ref");
        }
        const where = found.loc.kind === "frame" ? frameTarget(found.loc.frame, targetId) : targetId;
        if (found.loc.kind === "frame" && !where) {
          return failure("EXECUTION_FAILED", `STALE_REF: iframe f${found.loc.frame} is not known for this tab. Run snap again.`);
        }
        return evalHelper(`__bc.value(${js(found.loc.ref)})`, where);
      }

      case "text": {
        const opts: Json = {};
        if (typeof input["within"] === "string" && input["within"] !== "") opts["within"] = input["within"];
        if (input["all"] === true) opts["all"] = true;
        if (Number(input["max"]) > 0) opts["max"] = Number(input["max"]);
        return evalHelper(`__bc.text(${js(opts)})`, targetId);
      }

      case "ocr": {
        if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: ocr needs a DevTools tab");
        const read = await readPicture(targetId);
        if (!read.ok) return read.res;
        seenText.set(targetId ?? "", read.lines);
        const find = typeof input["find"] === "string" ? input["find"].toLowerCase() : "";
        const lines = [...read.lines.values()].filter((l) => !find || l.toLowerCase().includes(find));
        return success([
          `# ${lines.length} piece(s) of text${find ? ` matching "${find}"` : ""} read from a picture of the tab. Each line is x,y "text"; click one with: click --xy x,y`,
          ...lines,
        ].join("\n"));
      }

      case "shot": {
        const png = input["png"] === true;
        const base: Json = {
          format: png ? "png" : "jpeg",
          ...(png ? {} : { quality: Number(input["quality"]) > 0 ? Number(input["quality"]) : 60 }),
          ...(typeof input["path"] === "string" && input["path"] !== "" ? { path: input["path"] } : {}),
          ...(targetId ? { targetId } : {}),
        };
        if (browseTab !== undefined) {
          const shot = await invoke("capture_screenshot", base);
          return shot.ok ? success(String((shot.data as Json)["path"])) : shot;
        }
        if (input["full"] === true) {
          const shot = await invoke("capture_screenshot", { ...base, fullPage: true });
          return shot.ok ? success(`${String((shot.data as Json)["path"])}\n# Full page, device pixels: coordinates do not match click --xy.`) : shot;
        }
        let box: InvokeResult;
        if (input["ref"] !== undefined && input["ref"] !== "") {
          const found = await locate(input["ref"], "read", targetId);
          if (!found.ok) return found.res;
          if (found.loc.kind !== "dom") return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: shot --ref needs a page ref like e12");
          box = await evalHelper(`__bc.rect(${js(found.loc.ref)})`, targetId);
        } else {
          box = await evalHelper("__bc.viewport()", targetId);
        }
        if (!box.ok) return box;
        const r = JSON.parse(valueOf(box)) as { x: number; y: number; width: number; height: number; dpr: number };
        const marks = input["marks"] === true ? await evalHelper("__bc.marks(true)", targetId) : undefined;
        if (marks && !marks.ok) return marks;
        // One image pixel per CSS pixel, so picture coordinates are click coordinates. A real
        // high-density screen needs scale 1/dpr; an emulated one is already at CSS scale, so
        // measure the result and retake it when the first guess came out small.
        const width = Math.max(1, r.width);
        const capture = (scale: number) =>
          invoke("capture_screenshot", { ...base, clip: { x: r.x, y: r.y, width, height: Math.max(1, r.height), scale } });
        let shot = await capture(1 / (r.dpr || 1));
        if (shot.ok && r.dpr > 1) {
          const got = await imageWidth(String((shot.data as Json)["path"]));
          if (got !== undefined && got < width * 0.75) shot = await capture(1);
        }
        if (marks) await evalHelper("__bc.marks(false)", targetId);
        if (!shot.ok) return shot;
        const lines = [String((shot.data as Json)["path"])];
        if (input["ref"] === undefined || input["ref"] === "") lines.push("# CSS-pixel scale: a point in the picture is the same x,y for click --xy.");
        if (marks) lines.push("# The number on each control is its ref: 12 is e12.", valueOf(marks));
        return success(lines.join("\n"));
      }

      case "nav": {
        const url = typeof input["url"] === "string" ? input["url"] : "";
        const until = input["until"] === "load" ? "load" : "domcontentloaded";
        const nav = await invoke("navigate", { url, until, ...(targetId ? { targetId } : {}) });
        if (!nav.ok) return nav;
        const data = nav.data as Json;
        // An untargeted nav on the browse backend opens a new tab; follow it.
        const tab = typeof data["targetId"] === "string" ? (data["targetId"] as string) : targetId;
        const onBrowse = browseTabNumber(tab) !== undefined || (tab === undefined && browseTab !== undefined);
        const lines = [JSON.stringify(data)];
        if (!onBrowse) {
          const state = await evalHelper('(await __bc.settle(), [location.href, __bc.wall() || ""].join("\\n"))', tab, 8_000);
          if (state.ok) {
            const [final = "", wall = ""] = valueOf(state).split("\n");
            if (final && final !== url) lines.push(`# url: ${final}`);
            if (final && hostOf(final) && hostOf(url) && hostOf(final) !== hostOf(url)) lines.push(`# REDIRECTED: ${hostOf(url)} -> ${hostOf(final)}`);
            if (wall && input["snap"] !== true) lines.push(`# WALL: ${wall}. Stop and hand this tab to the user; do not solve or bypass it.`);
          }
        }
        if (input["snap"] === true) {
          const snap = await handlePage("snap", {}, tab);
          lines.push(snap.ok ? valueOf(snap) : `# snap failed: ${messageOf(snap).slice(0, 200)}`);
        }
        return success(lines.join("\n"));
      }

      case "verdict":
        return evalHelper("__bc.verdict()", targetId);

      case "health":
        return evalHelper("__bc.health()", targetId);

      default:
        return failure("OPERATION_NOT_FOUND", `unknown page helper: ${action}`);
    }
  };
}

export async function serveDaemon(capabilityDir: string, socketPath: string): Promise<void> {
  const capability = await openStandaloneCapability(capabilityDir);
  const maxChars = Number(process.env["BROWSER_CONTROL_MAX_OUTPUT"]) || 50_000;

  const invokeOnce = async (operation: string, input: Json): Promise<InvokeResult> => {
    try {
      return await capability.runtime.invoke(capability.name, operation, input);
    } catch (error) {
      return failure("EXECUTION_FAILED", (error as Error).message);
    }
  };

  // The last successful connect input, minus any port: ports change when the browser
  // restarts, so a reconnect must rediscover the live one.
  // Before any connect it is the default: preferred browser, with time to click Allow.
  let reconnectInput: Json = { timeoutMs: 60_000 };

  /** Invoke; if there is no browser connection (never made, or dropped), connect once and retry. */
  const invoke = async (operation: string, input: Json = {}): Promise<InvokeResult> => {
    if (operation === "disconnect_browser") {
      return failure(
        "EXECUTION_FAILED",
        "DISCONNECT_REFUSED: the daemon keeps browser connections so the user is not asked to click Allow again. Disconnecting fixes nothing. Only if the user asked: browser-control-daemon stop --force",
      );
    }
    const result = await invokeOnce(operation, input);
    if (operation === "connect_browser") {
      if (result.ok) {
        const { port: _port, wsUrl: _wsUrl, ...rest } = input;
        const name = ((result.data as Json)["via"] as Json | undefined)?.["name"];
        reconnectInput = typeof name === "string" && !rest["browser"] && !rest["profileDir"] ? { ...rest, browser: name } : rest;
      }
      return result;
    }
    if (result.ok || !result.error.message.startsWith("NOT_CONNECTED")) return result;
    const reconnected = await invokeOnce("connect_browser", reconnectInput);
    return reconnected.ok ? invokeOnce(operation, input) : reconnected;
  };

  const handlePage = createPageHelperHandler(invoke);

  const json = (result: InvokeResult) =>
    new Response(`${JSON.stringify(result)}\n`, { status: result.ok ? 200 : 400 });

  /** Text reply: `pick(data)` on success, the error JSON on failure. */
  const text = (result: InvokeResult, pick: (data: any) => unknown) =>
    result.ok ? new Response(`${asText(pick(result.data), maxChars)}\n`) : json(result);

  const parseJsonBody = (raw: string): { ok: true; value: Json } | { ok: false; res: Response } => {
    if (raw === "") return { ok: true, value: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, res: json(failure("INPUT_VALIDATION_FAILED", `invalid JSON input: ${(error as Error).message}`)) };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, res: json(failure("INPUT_VALIDATION_FAILED", "input must be a JSON object")) };
    }
    return { ok: true, value: parsed as Json };
  };

  const stop = async () => {
    await capability.runtime.shutdown().catch(() => {});
    rmSync(socketPath, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // idleTimeout 0: operations may legitimately run for minutes. (Cast: bun-types leave
  // idleTimeout off the unix-socket overload, but the runtime honors it.)
  Bun.serve({
    unix: socketPath,
    idleTimeout: 0,
    async fetch(request: Request) {
      const url = new URL(request.url);
      const [route, operation] = url.pathname.slice(1).split("/");
      const started = performance.now();
      const reply = await respond(request, url, route ?? "", operation ?? "");
      // One line per request in daemon.log: where the time goes, never what was sent.
      if (route !== "status") {
        console.log(`${new Date().toISOString()} ${Math.round(performance.now() - started)}ms ${reply.status} /${route}${operation ? `/${operation}` : ""}`);
      }
      return reply;
    },
  } as unknown as Parameters<typeof Bun.serve>[0]);

  async function respond(request: Request, url: URL, route: string, operation: string): Promise<Response> {
      let targetId = url.searchParams.get("t") || undefined;
      const body = (await request.text()).trim();
      const match = url.searchParams.get("m");
      if (match && !targetId) {
        const tab = await matchTab(invoke, match);
        if (!tab.ok) return json(tab.res);
        targetId = tab.targetId;
      }
      const quiet = url.searchParams.get("q") === "1";

      switch (route) {
        case "call": {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return parsed.res;
          return json(await invoke(operation, parsed.value));
        }
        case "eval":
          return text(await invoke("evaluate", { expression: body, targetId }), (data) => data.value);
        case "nav":
          return text(
            await handlePage("nav", { url: body, until: url.searchParams.get("until") ?? "", snap: url.searchParams.get("snap") === "1" }, targetId),
            (data) => data.value,
          );
        case "page": {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return parsed.res;
          return text(await handlePage(operation, { ...parsed.value, ...(quiet ? { quiet: true } : {}) }, targetId), (data) => data.value);
        }
        case "tabs": {
          const [targets, status] = await Promise.all([
            invoke("list_targets", { types: ["page"] }),
            invoke("get_browser_status"),
          ]);
          const state = status.ok ? (status.data as Json) : {};
          const active = state["activeTargetId"];
          const others = (state["alsoConnected"] as string[] | undefined) ?? [];
          // The header says which browser these tabs are in: a missing tab is often in the other one.
          const header = `# ${state["browser"] ?? "browser"}${others.length > 0 ? ` (also connected: ${others.join(", ")}; switch with: start <name>)` : ""}`;
          return text(targets, (data) =>
            [
              header,
              ...(data.targets as Array<{ targetId: string; url: string; title: string }>).map(
                (t) => `${t.targetId === active ? "*" : " "} ${t.targetId} ${t.url.slice(0, 100)} | ${t.title.slice(0, 60)}`,
              ),
            ].join("\n"),
          );
        }
        case "ops":
          return new Response(
            `${capability.runtime
              .listOperations(capability.name)
              .map((o) => {
                const schema = capability.runtime.getOperationInputSchema(capability.name, o.operation);
                const names = Object.keys((schema?.["properties"] as Json | undefined) ?? {});
                return `${o.operation}(${names.join(", ")}) — ${o.description}`;
              })
              .join("\n")}\n`,
          );
        case "status": {
          const status = await invoke("get_browser_status");
          return json(status.ok ? { ok: true, data: { running: true, pid: process.pid, ...(status.data as Json) } } : status);
        }
        case "stop":
          setTimeout(stop, 10);
          return json({ ok: true, data: { running: false } });
        default:
          return json(failure("OPERATION_NOT_FOUND", `unknown daemon route: /${route}`));
      }
  }
}
