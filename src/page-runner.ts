/**
 * Page helper runner shared by the daemon HTTP handler and unit tests.
 * Injects `__bc` lazily once per document, dispatches mouse/key input in-process, reports what
 * each action changed, and routes `browse:<n>` tabs cleanly with label and guard parity.
 */
import type { InvokeResult } from "@agent-software/core";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { runBrowse, type Runner } from "./backends/browse";
import { recognizeText, type Recognizer } from "./ocr";
import {
  HONEYPOT_NAME,
  KEYS,
  PAGE_HELPERS_SOURCE,
  PAGE_HELPERS_VERSION,
  PAYMENT_FIELD,
  parseLocator,
  type Locator,
} from "./page-helpers";
import { createPictureTracker, imageWidth } from "./picture";

type Json = Record<string, unknown>;
export type Invoker = (operation: string, input?: Json) => Promise<InvokeResult>;

const NEED_INSTALL = "__BC_NEED_INSTALL__";
/** Input events never return while a JavaScript dialog is open, so don't wait the full CDP timeout. */
const INPUT_TIMEOUT_MS = 10_000;
const DIALOG_HINT = "the page stopped responding; a JavaScript dialog is probably open (references/dom-and-input.md)";

const failure = (code: string, message: string): InvokeResult =>
  ({ ok: false, error: { code, message } }) as InvokeResult;
const success = (value: string): InvokeResult => ({ ok: true, data: { value } });
const valueOf = (res: InvokeResult): string => (res.ok ? String((res.data as Json)["value"] ?? "") : "");
const messageOf = (res: InvokeResult): string => (res.ok ? "" : res.error.message);
const js = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export type AxNode = {
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
export async function matchTab(
  invoke: Invoker,
  match: string,
): Promise<{ ok: true; targetId: string } | { ok: false; res: InvokeResult }> {
  const listed = await invoke("list_targets", { types: ["page"] });
  if (!listed.ok) return { ok: false, res: listed };
  const want = match.toLowerCase();
  const tabs = ((listed.data as Json)["targets"] as Array<{ targetId: string; url: string; title: string }>) ?? [];
  const hits = tabs.filter((t) => t.url.toLowerCase().includes(want) || t.title.toLowerCase().includes(want));
  if (hits.length === 1) return { ok: true, targetId: hits[0]!.targetId };
  const list = (hits.length ? hits : tabs)
    .slice(0, 12)
    .map((t) => `  ${t.targetId} ${t.url.slice(0, 100)} | ${t.title.slice(0, 60)}`)
    .join("\n");
  return {
    ok: false,
    res: failure(
      "EXECUTION_FAILED",
      hits.length
        ? `AMBIGUOUS: --match "${match}" fits ${hits.length} tabs; pass a targetId:\n${list}`
        : `NO_MATCH: no tab's url or title contains "${match}". Open tabs:\n${list}`,
    ),
  };
}

/** A helper's own refusal arrives wrapped as a JavaScript exception with a stack; keep just the message. */
function helperError(res: InvokeResult): InvokeResult {
  if (res.ok) return res;
  const m = /^JS_EXCEPTION: (?:Error: )?((?:AMBIGUOUS|NO_MATCH|STALE_REF|NOT_ACTIONABLE|REFUSED|INPUT_INVALID): [\s\S]*?)(?:\n\s+at [\s\S]*)?$/.exec(
    res.error.message,
  );
  return m ? failure(res.error.code, m[1]!) : res;
}

export type BrowseEntry = { ref: string; role: string; name: string; disabled: boolean; line: string };

/** Parse `browse snapshot` output lines (supports `[e12]`, `[ref=e12]`, or `@e12`). */
export function parseBrowseSnapshot(text: string): BrowseEntry[] {
  const entries: BrowseEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const refMatch = /(?:\[(?:ref=)?|@)(e\d+)\]?/.exec(line);
    if (!refMatch) continue;
    const roleMatch = /^-\s+([a-zA-Z0-9_-]+)/.exec(line);
    const nameMatch = /"([^"]*)"/.exec(line);
    entries.push({
      ref: refMatch[1]!,
      role: (roleMatch?.[1] ?? "").toLowerCase(),
      name: nameMatch?.[1] ?? "",
      disabled: /\[disabled\]|\bdisabled\b/i.test(line),
      line,
    });
  }
  return entries;
}

const BROWSE_TYPEABLE = /^(textbox|searchbox|combobox|spinbutton|listbox|input|textarea)$/;

function checkBrowseFieldGuard(labelOrLine: string, ref: string): InvokeResult | null {
  if (/\btrap\b/i.test(labelOrLine) || HONEYPOT_NAME.test(labelOrLine)) {
    return failure("EXECUTION_FAILED", `REFUSED: ${ref} looks like a bot-trap field; leave it empty`);
  }
  if (/\bpayment\b/i.test(labelOrLine) || PAYMENT_FIELD.test(labelOrLine)) {
    return failure("EXECUTION_FAILED", `REFUSED: ${ref} is a payment field; the user enters payment details`);
  }
  return null;
}

type Point = { x: number; y: number; hidden: boolean; before?: string };
type Step = { action: string; input: Json; label: string };

export function createPageHelperHandler(
  invoke: Invoker,
  browseRunner: Runner = runBrowse,
  recognize: Recognizer = recognizeText,
) {
  /** Cross-origin iframe targets from the last snap of each tab: f1 is index 0. */
  const frameTargets = new Map<string, string[]>();
  /** Last parsed snapshot entries per browse tab, used for trap/payment guard checks. */
  const browseCache = new Map<number, Map<string, BrowseEntry>>();

  async function evalHelper(callExpr: string, targetId?: string, timeoutMs?: number): Promise<InvokeResult> {
    const extra = { ...(targetId ? { targetId } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
    const probe = `globalThis.__bc && globalThis.__bc.v === ${PAGE_HELPERS_VERSION} ? (${callExpr}) : "${NEED_INSTALL}"`;
    const first = await invoke("evaluate", { expression: probe, ...extra });
    if (!first.ok) return helperError(first);
    if ((first.data as Json)["value"] !== NEED_INSTALL) return first;
    return helperError(await invoke("evaluate", { expression: `${PAGE_HELPERS_SOURCE}\n${callExpr}`, ...extra }));
  }

  const picture = createPictureTracker(invoke, evalHelper, recognize);

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

  function cacheBrowseSnapshot(tab: number, snapshotText: string): BrowseEntry[] {
    const entries = parseBrowseSnapshot(snapshotText);
    if (entries.length > 0) {
      const map = browseCache.get(tab) ?? new Map<string, BrowseEntry>();
      for (const e of entries) map.set(e.ref, e);
      browseCache.set(tab, map);
    }
    return entries;
  }

  /** Resolve a ref or label on a `browse:<n>` tab to a bare browse ref (`e12`). */
  async function resolveBrowseRef(
    raw: unknown,
    kind: "click" | "type",
    tab: number,
  ): Promise<{ ok: true; ref: string; entry?: BrowseEntry } | { ok: false; res: InvokeResult }> {
    let loc: Locator;
    try {
      loc = parseLocator(raw);
    } catch (error) {
      return { ok: false, res: failure("INPUT_VALIDATION_FAILED", (error as Error).message) };
    }
    if (loc.kind === "dom") {
      return { ok: true, ref: loc.ref, entry: browseCache.get(tab)?.get(loc.ref) };
    }
    if (loc.kind !== "label") {
      return {
        ok: false,
        res: failure("INPUT_VALIDATION_FAILED", `INPUT_INVALID: ${String(raw)} needs a DevTools tab`),
      };
    }
    const snap = await callBrowse("snapshot", { tab, interactive: true });
    if (!snap.ok) return { ok: false, res: snap };
    let entries = cacheBrowseSnapshot(tab, valueOf(snap));
    if (kind === "type") {
      const typeable = entries.filter((e) => BROWSE_TYPEABLE.test(e.role));
      if (typeable.length) entries = typeable;
    }
    const want = loc.label.replace(/\s+/g, " ").trim().toLowerCase();
    let hits = entries.filter((e) => e.name.toLowerCase() === want);
    if (!hits.length) hits = entries.filter((e) => e.name.toLowerCase().includes(want));
    const live = hits.filter((e) => !e.disabled);
    if (live.length) hits = live;
    if (hits.length === 1) return { ok: true, ref: hits[0]!.ref, entry: hits[0]! };
    if (hits.length > 1) {
      return {
        ok: false,
        res: failure(
          "EXECUTION_FAILED",
          `AMBIGUOUS: "${loc.label}" matches ${hits.length} controls; use one of these refs:\n${hits.slice(0, 12).map((h) => h.line).join("\n")}`,
        ),
      };
    }
    return {
      ok: false,
      res: failure("EXECUTION_FAILED", `NO_MATCH: no control named "${loc.label}". Run snap to see the controls.`),
    };
  }

  async function cdp(method: string, params: Json, targetId?: string, timeoutMs?: number): Promise<InvokeResult> {
    return invoke("execute_cdp", {
      method,
      params,
      ...(targetId ? { targetId } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
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
  async function locate(
    raw: unknown,
    kind: "click" | "type" | "select" | "read",
    targetId?: string,
  ): Promise<{ ok: true; loc: Exclude<Locator, { kind: "label" }> } | { ok: false; res: InvokeResult }> {
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
  async function pointOf(
    loc: Exclude<Locator, { kind: "label" }>,
    targetId: string | undefined,
    baseline: boolean,
  ): Promise<{ ok: true; pt: Point } | { ok: false; res: InvokeResult }> {
    const bad = (res: InvokeResult) => ({ ok: false as const, res });
    if (loc.kind === "ax") {
      const before = baseline ? await evalHelper("__bc.baseline()", targetId) : undefined;
      await cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId: loc.node }, targetId);
      const quads = await cdp("DOM.getContentQuads", { backendNodeId: loc.node }, targetId);
      if (!quads.ok) return bad(quads);
      const q = ((((quads.data as Json)["result"] as Json | undefined)?.["quads"] as number[][] | undefined) ?? [])[0];
      if (!q || q.length < 8) {
        return bad(failure("EXECUTION_FAILED", `NOT_ACTIONABLE: a${loc.node} has no visible box. Run snap --ax again.`));
      }
      return {
        ok: true,
        pt: {
          x: Math.round((q[0]! + q[2]! + q[4]! + q[6]!) / 4),
          y: Math.round((q[1]! + q[3]! + q[5]! + q[7]!) / 4),
          hidden: false,
          before: before?.ok ? valueOf(before) : undefined,
        },
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
      const ready = await invoke("evaluate", {
        expression: "document.readyState",
        ...(targetId ? { targetId } : {}),
        timeoutMs: 2_000,
      });
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
        out.push(`# iframe ${label}: not reachable; click by coordinates (click --xy) or see references/dom-and-input.md`);
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
      if (verb === "click" && typeof arg === "string") {
        steps.push({ action: "click", input: { ref: arg }, label: `click ${js(arg)}` });
      } else if (verb === "key" && typeof arg === "string") {
        steps.push({ action: "key", input: { key: arg }, label: `key ${arg}` });
      } else if (verb === "type" && Array.isArray(arg) && typeof arg[0] === "string" && typeof arg[1] === "string") {
        steps.push({ action: "type", input: { ref: arg[0], text: arg[1], keys: arg[2] === "keys" || arg[2] === true }, label: `type ${js(arg[0])}` });
      } else if (verb === "select" && Array.isArray(arg) && typeof arg[0] === "string" && typeof arg[1] === "string") {
        steps.push({ action: "select", input: { ref: arg[0], option: arg[1] }, label: `select ${js(arg[0])}` });
      } else if (verb === "upload" && Array.isArray(arg) && typeof arg[0] === "string" && typeof arg[1] === "string") {
        steps.push({ action: "upload", input: { ref: arg[0], path: arg[1] }, label: `upload ${js(arg[0])}` });
      } else if (verb === "wait" && typeof arg === "string") {
        steps.push({ action: "wait", input: { text: arg }, label: `wait ${js(arg)}` });
      } else if (verb === "wait" && typeof arg === "object" && arg !== null && !Array.isArray(arg)) {
        steps.push({ action: "wait", input: arg as Json, label: "wait" });
      } else {
        return `step ${i + 1}: use {"click":"<ref|label>"}, {"type":["<ref|label>","<text>"]}, {"select":["<ref|label>","<option>"]}, {"upload":["<ref|label>","<abs-path>"]}, {"wait":"<text>"}, or {"key":"<name>"}`;
      }
    }
    return steps;
  }

  async function runWait(input: Json, targetId?: string): Promise<InvokeResult> {
    const text = typeof input["text"] === "string" && input["text"] !== "" ? input["text"] : undefined;
    const selector = typeof input["selector"] === "string" && input["selector"] !== "" ? input["selector"] : undefined;
    const url = typeof input["url"] === "string" && input["url"] !== "" ? input["url"] : undefined;
    if (!text && !selector && !url) {
      return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: wait needs at least one of --text, --selector, or --url");
    }
    const rawTimeout = Number(input["timeoutMs"] ?? input["timeout"]);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(rawTimeout, 60_000) : 10_000;
    const opts: Json = { ...(text ? { text } : {}), ...(selector ? { selector } : {}), ...(url ? { url } : {}) };
    const started = Date.now();
    const deadline = started + timeoutMs;
    let lastWall = "";
    for (;;) {
      const check = await evalHelper(`__bc.checkWait(${js(opts)})`, targetId, 5_000);
      if (!check.ok) {
        if (messageOf(check).startsWith("INPUT_INVALID")) return check;
      } else {
        try {
          const parsed = JSON.parse(valueOf(check)) as { matched: boolean; url: string; wall: string };
          lastWall = parsed.wall;
          if (parsed.matched) {
            const summary = [text && `text="${text}"`, selector && `selector="${selector}"`, url && `url="${url}"`]
              .filter(Boolean)
              .join(", ");
            return success(
              `waited ${Date.now() - started}ms: matched ${summary}${parsed.wall ? `\n# WALL: ${parsed.wall}. Stop and hand this tab to the user; do not solve or bypass it.` : ""}`,
            );
          }
        } catch {
          /* retry until deadline */
        }
      }
      if (Date.now() >= deadline) {
        const summary = [text && `text="${text}"`, selector && `selector="${selector}"`, url && `url="${url}"`]
          .filter(Boolean)
          .join(", ");
        return failure(
          "EXECUTION_FAILED",
          `WAIT_TIMEOUT: timed out after ${timeoutMs}ms waiting for ${summary}${lastWall ? ` (# WALL: ${lastWall})` : ""}`,
        );
      }
      await sleep(150);
    }
  }

  async function browseDelta(res: InvokeResult, tab: number): Promise<InvokeResult> {
    const delta = await callBrowse("snapshot", { tab, interactive: true, delta: true });
    if (delta.ok) {
      cacheBrowseSnapshot(tab, valueOf(delta));
      return success(`${valueOf(res)}\n${valueOf(delta)}`);
    }
    return res;
  }

  async function act(
    action: string,
    input: Json,
    targetId: string | undefined,
    quiet: boolean,
    browseTab: number | undefined,
  ): Promise<InvokeResult> {
    switch (action) {
      case "click": {
        if (Array.isArray(input["xy"])) {
          const [x, y] = (input["xy"] as unknown[]).map(Number);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: --xy takes x,y in CSS pixels");
          }
          if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: --xy needs a DevTools tab");
          const hit = await evalHelper(`[__bc.baseline(), __bc.hit(${x}, ${y})].join("\\n")`, targetId);
          if (!hit.ok) return hit;
          const [before, what] = valueOf(hit).split("\n");
          const isCanvas = !quiet && /^hit: canvas/.test(what ?? "");
          const beforeHash = isCanvas ? await picture.canvasHash(targetId) : "";
          const clicked = await clickCoords(x!, y!, targetId);
          if (!clicked.ok) return inputFailed(clicked, `click ${x},${y}`);
          if (isCanvas) return success(`click ${x},${y}: delivered. ${what}\n${await picture.pictureChanges(targetId, beforeHash)}`);
          return withChanges(`click ${x},${y}: delivered. ${what}`, before, quiet, targetId);
        }
        if (browseTab !== undefined) {
          const resolved = await resolveBrowseRef(input["ref"], "click", browseTab);
          if (!resolved.ok) return resolved.res;
          const res = await callBrowse("click", { tab: browseTab, ref: resolved.ref });
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
          if (input["focused"] === true) {
            return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: type --focused needs a DevTools tab");
          }
          const resolved = await resolveBrowseRef(input["ref"], "type", browseTab);
          if (!resolved.ok) return resolved.res;
          const guardErr = checkBrowseFieldGuard(`${String(input["ref"] ?? "")} ${resolved.entry?.line ?? ""}`, resolved.ref);
          if (guardErr) return guardErr;
          const res = await callBrowse("fill", { tab: browseTab, ref: resolved.ref, value: text });
          return res.ok && !quiet ? browseDelta(res, browseTab) : res;
        }
        if (input["focused"] === true) {
          const g = await evalHelper("__bc.guardFocused()", targetId);
          if (!g.ok) return g;
          const isPic = !quiet && (await picture.isPicture(targetId));
          const beforeHash = isPic ? await picture.canvasHash(targetId) : "";
          const before = quiet || isPic ? undefined : await evalHelper("__bc.baseline()", targetId);
          const ins = await cdp("Input.insertText", { text }, targetId, INPUT_TIMEOUT_MS);
          if (!ins.ok) return inputFailed(ins, "type --focused");
          const line = "type --focused: sent to whatever has focus (not read back)";
          if (isPic) return success(`${line}\n${await picture.pictureChanges(targetId, beforeHash)}`);
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

      case "select": {
        if (typeof input["option"] !== "string" || input["option"] === "") {
          return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: option is required");
        }
        if (browseTab !== undefined) {
          return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: select needs a DevTools tab");
        }
        const option = input["option"];
        const found = await locate(input["ref"], "select", targetId);
        if (!found.ok) return found.res;
        const loc = found.loc;
        if (loc.kind === "ax") {
          return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: select needs a DOM ref or label, not an accessibility ref");
        }
        const fieldTarget = loc.kind === "frame" ? frameTarget(loc.frame, targetId) : targetId;
        if (loc.kind === "frame" && !fieldTarget) {
          return failure("EXECUTION_FAILED", `STALE_REF: iframe f${loc.frame} is not known for this tab. Run snap again.`);
        }
        const before = quiet ? undefined : await evalHelper("__bc.baseline()", targetId);
        const native = await evalHelper(`__bc.select(${js(loc.ref)}, ${js(option)})`, fieldTarget);
        if (!native.ok) return native;
        if (valueOf(native) !== "__not_native__") {
          return withChanges(
            `select ${nameOf(loc)} -> "${valueOf(native)}": delivered`,
            before?.ok ? valueOf(before) : undefined,
            quiet,
            targetId,
          );
        }
        // Custom ARIA combobox/listbox: click trigger, let options mount, click matching option.
        const at = await pointOf(loc, targetId, false);
        if (!at.ok) return at.res;
        const opened = await clickAt(at.pt, targetId);
        if (!opened.ok) return inputFailed(opened, `select ${nameOf(loc)}`);
        await evalHelper("await __bc.settle(300, 80)", fieldTarget, 4_000);
        const optRef = await evalHelper(`__bc.locateOption(${js(option)})`, fieldTarget);
        if (!optRef.ok) return optRef;
        const optLoc: Exclude<Locator, { kind: "label" }> =
          loc.kind === "frame"
            ? { kind: "frame", frame: loc.frame, ref: valueOf(optRef) }
            : { kind: "dom", ref: valueOf(optRef) };
        const optAt = await pointOf(optLoc, targetId, false);
        if (!optAt.ok) return optAt.res;
        const picked = await clickAt(optAt.pt, targetId);
        if (!picked.ok) return inputFailed(picked, `select ${nameOf(loc)} "${option}"`);
        return withChanges(
          `select ${nameOf(loc)} -> "${option}": delivered`,
          before?.ok ? valueOf(before) : undefined,
          quiet,
          targetId,
        );
      }

      case "upload": {
        const filePath = typeof input["path"] === "string" ? input["path"].trim() : "";
        if (!filePath || !isAbsolute(filePath)) {
          return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: upload requires an absolute file path");
        }
        if (!existsSync(filePath)) {
          return failure("INPUT_VALIDATION_FAILED", `INPUT_INVALID: file does not exist: ${filePath}`);
        }
        if (browseTab !== undefined) {
          return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: upload needs a DevTools tab");
        }
        const refInput = typeof input["ref"] === "string" ? input["ref"].trim() : "";
        if (!refInput) {
          return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: a file input ref, label, or CSS selector is required");
        }
        const frame = /^@?f([0-9]+):(e[0-9]+)$/.exec(refInput);
        const fieldTarget = frame ? frameTarget(Number(frame[1]), targetId) : targetId;
        if (frame && !fieldTarget) {
          return failure("EXECUTION_FAILED", `STALE_REF: iframe f${frame[1]} is not known for this tab. Run snap again.`);
        }
        const before = quiet ? undefined : await evalHelper("__bc.baseline()", targetId);
        const located = await evalHelper(`__bc.locateFile(${js(frame ? frame[2]! : refInput)})`, fieldTarget);
        if (!located.ok) return located;
        const fileRef = valueOf(located);
        const evalObj = await cdp(
          "Runtime.evaluate",
          { expression: `__bc.el(${js(fileRef)})`, returnByValue: false },
          fieldTarget,
        );
        if (!evalObj.ok) return evalObj;
        const objectId = ((((evalObj.data as Json)["result"] as Json | undefined)?.["result"] as Json | undefined)?.["objectId"]) as
          | string
          | undefined;
        if (!objectId) {
          return failure("EXECUTION_FAILED", `NOT_ACTIONABLE: could not resolve file input ${fileRef}`);
        }
        try {
          const set = await cdp("DOM.setFileInputFiles", { objectId, files: [filePath] }, fieldTarget);
          if (!set.ok) return set;
        } finally {
          await cdp("Runtime.releaseObject", { objectId }, fieldTarget).catch(() => {});
        }
        const label = frame ? `f${frame[1]}:${fileRef}` : fileRef;
        return withChanges(`upload ${label} <- ${filePath}: delivered`, before?.ok ? valueOf(before) : undefined, quiet, targetId);
      }

      case "wait":
        return runWait(input, targetId);

      case "key": {
        const keyName = typeof input["key"] === "string" ? input["key"] : "";
        if (!KEYS[keyName]) {
          return failure("INPUT_VALIDATION_FAILED", `INPUT_INVALID: key must be ${Object.keys(KEYS).join(", ")}`);
        }
        if (browseTab !== undefined) {
          const res = await callBrowse("press", { tab: browseTab, key: keyName });
          return res.ok && !quiet ? browseDelta(res, browseTab) : res;
        }
        const isPic = !quiet && (await picture.isPicture(targetId));
        const beforeHash = isPic ? await picture.canvasHash(targetId) : "";
        const before = quiet || isPic ? undefined : await evalHelper("__bc.baseline()", targetId);
        const res = await pressKey(keyName, targetId);
        if (!res.ok) return inputFailed(res, `key ${keyName}`);
        if (isPic) return success(`key ${keyName}: sent\n${await picture.pictureChanges(targetId, beforeHash)}`);
        return withChanges(`key ${keyName}: sent`, before?.ok ? valueOf(before) : undefined, quiet, targetId);
      }

      default:
        return failure("OPERATION_NOT_FOUND", `unknown page helper: ${action}`);
    }
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
          const res = await callBrowse("snapshot", {
            tab: browseTab,
            ...(all ? {} : { interactive: true }),
            ...(find ? { find } : {}),
            ...(within ? { within } : {}),
          });
          if (res.ok) cacheBrowseSnapshot(browseTab, valueOf(res));
          return res;
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
      case "select":
      case "upload":
      case "wait":
      case "key":
        return act(action, input, targetId, quiet, browseTab);

      case "do": {
        const steps = parseSteps(input);
        if (typeof steps === "string") return failure("INPUT_VALIDATION_FAILED", `INPUT_INVALID: ${steps}`);
        if (steps.length === 0) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: no steps given");
        const start = browseTab === undefined
          ? await evalHelper("__bc.baseline()", targetId)
          : await invoke("evaluate", { expression: "location.href", ...(targetId ? { targetId } : {}) });
        if (browseTab === undefined && start && !start.ok) return start;
        const startUrl = start?.ok ? valueOf(start) : "";
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
          if (
            browseTab === undefined &&
            step.action === "type" &&
            !valueOf(res).includes(": delivered (") &&
            !valueOf(res).includes("secure field")
          ) {
            stopped = `step ${i + 1} was not read back as typed`;
            break;
          }
          if (i === steps.length - 1) continue;
          // Let the page react before the next step, and stop if it left the site or hit a wall.
          const state = await evalHelper(
            '(await __bc.settle(), [location.href, __bc.wall() || ""].join("\\n"))',
            targetId,
            8_000,
          );
          let url = "";
          let wall = "";
          if (state.ok) [url = "", wall = ""] = valueOf(state).split("\n");
          else {
            await waitParsed(targetId);
            const again = await evalHelper('[location.href, __bc.wall() || ""].join("\\n")', targetId, 8_000);
            if (again.ok) [url = "", wall = ""] = valueOf(again).split("\n");
          }
          if (wall) stopped = `the page is a ${wall} wall after step ${i + 1}`;
          else if (url && startUrl && hostOf(url) !== hostOf(startUrl)) {
            stopped = `step ${i + 1} left ${hostOf(startUrl)} for ${hostOf(url)}`;
          }
          if (stopped) break;
        }
        if (stopped) out.push(`# STOPPED: ${stopped}. ${steps.length - out.length} step(s) not run.`);
        if (!quiet) {
          if (browseTab !== undefined) {
            const delta = await callBrowse("snapshot", { tab: browseTab, interactive: true, delta: true });
            if (delta.ok) {
              cacheBrowseSnapshot(browseTab, valueOf(delta));
              out.push(valueOf(delta));
            }
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
        const read = await picture.readPicture(targetId);
        if (!read.ok) return read.res;
        picture.remember(targetId, read.lines);
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
          return shot.ok
            ? success(`${String((shot.data as Json)["path"])}\n# Full page, device pixels: coordinates do not match click --xy.`)
            : shot;
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
        if (input["ref"] === undefined || input["ref"] === "") {
          lines.push("# CSS-pixel scale: a point in the picture is the same x,y for click --xy.");
        }
        if (marks) lines.push("# The number on each control is its ref: 12 is e12.", valueOf(marks));
        return success(lines.join("\n"));
      }

      case "nav": {
        const url = typeof input["url"] === "string" ? input["url"] : "";
        const until = input["until"] === "load" ? "load" : "domcontentloaded";
        const nav = await invoke("navigate", { url, until, ...(targetId ? { targetId } : {}) });
        if (!nav.ok) return nav;
        const data = nav.data as Json;
        const tab = typeof data["targetId"] === "string" ? (data["targetId"] as string) : targetId;
        const onBrowse = browseTabNumber(tab) !== undefined || (tab === undefined && browseTab !== undefined);
        const lines = [JSON.stringify(data)];
        if (!onBrowse) {
          const state = await evalHelper('(await __bc.settle(), [location.href, __bc.wall() || ""].join("\\n"))', tab, 8_000);
          if (state.ok) {
            const [final = "", wall = ""] = valueOf(state).split("\n");
            if (final && final !== url) lines.push(`# url: ${final}`);
            if (final && hostOf(final) && hostOf(url) && hostOf(final) !== hostOf(url)) {
              lines.push(`# REDIRECTED: ${hostOf(url)} -> ${hostOf(final)}`);
            }
            if (wall && input["snap"] !== true) {
              lines.push(`# WALL: ${wall}. Stop and hand this tab to the user; do not solve or bypass it.`);
            }
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
