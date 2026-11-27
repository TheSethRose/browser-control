/**
 * Page helper runner shared by the daemon HTTP handler and unit tests.
 * Runs `__bc` in an isolated world (falling back cleanly on mocks/browse tabs),
 * dispatches mouse/key/drag input in-process with delivery checks, reports DOM diffs,
 * and exposes structured readers (`form`, `query`, `read-urls`, `text --scroll`),
 * DevTools inspection (`styles`, `issues`, `perf`), site notes, saved GET flows, and `script`.
 */
import type { InvokeResult } from "@agent-software/core";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { runBrowse, type Runner } from "./backends/browse";
import {
  backendOrder,
  extensionOnlyMessage,
  isBackendUnavailable,
  isExtensionOnlyOrder,
} from "./backends/router";
import { extensionFrameTarget, extensionTabOf, getRegisteredExtensionBcCall, type BcCallFn } from "./backends/extension";
import {
  SHORT_PAGE_CHARS,
  buildChallengeProbeExpression,
  classifyChallenge,
  fastVendorSelectors,
  formatChallengeOutput,
  isDenialTitle,
  isSuspiciousSnapshot,
  isSuspiciousTitle,
  isSuspiciousUrl,
  matchProbeSelectorsFromRows,
  parseBcQueryRows,
  parseBcTextForProbe,
  probeSelectors,
  type ChallengeDetection,
  type ChallengeProbe,
} from "./challenges";
import { inspectIssues, inspectPerf, inspectStyles } from "./devtools";
import {
  buildFlow,
  fillFlowUrl,
  listFlows,
  loadFlowFile,
  removeFlowFile,
  saveFlowFile,
  shapeFlowResult,
  type RecordedGet,
} from "./flows";
import { drawMarksOnImage, type MarkBox } from "./marks";
import {
  DEFAULT_VIEWPORT,
  isNaturalEnabled,
  pickClickPoint,
  planClickTiming,
  planPointerPath,
  planWheelScroll,
  type Box2D,
  type Point2D,
  type Viewport,
} from "./natural";
import { appendNote, approveNote, getNote, listNotes, noteHeaderForUrl, removeNote, setNote } from "./notes";
import { recognizeText, type Recognizer } from "./ocr";
import {
  HONEYPOT_NAME,
  KEYS,
  PAGE_HELPERS_SOURCE,
  PAGE_HELPERS_VERSION,
  PAYMENT_FIELD,
  normalizeHelperCall,
  parseLocator,
  renderElementStep,
  renderSteps,
  type ElementStep,
  type HelperCall,
  type Locator,
} from "./page-helpers";
import { createPictureTracker, imageWidth, resizeImage } from "./picture";
import { classifyFieldKind, planTyping, type CharKeySpec, type FieldKind } from "./typing";
import { didYouMean, withRemedy, wrapUntrusted } from "./safety";
import { createScriptRunner, writeOutputFile } from "./script";

type Json = Record<string, unknown>;
export type Invoker = (operation: string, input?: Json) => Promise<InvokeResult>;

const NEED_INSTALL = "__BC_NEED_INSTALL__";
/** Input events never return while a JavaScript dialog is open, so don't wait the full CDP timeout. */
const INPUT_TIMEOUT_MS = 10_000;
const MAX_VIEWPORT_DIM = 10_000_000;
const DIALOG_HINT = "the page stopped responding; a JavaScript dialog is probably open (references/dom-and-input.md)";

const PAGE_ACTIONS = [
  "snap", "text", "form", "query", "read-urls", "ocr", "shot", "click", "hover", "type", "select",
  "upload", "drag", "wait", "key", "fill", "do", "value", "nav", "verdict", "health",
  "styles", "issues", "perf", "dialog", "emulate", "handoff", "notes", "flow", "script",
] as const;

const DEFAULT_HANDOFF_TIMEOUT_MS = 10 * 60 * 1000;
const CHALLENGE_WAIT_MAX_MS = 8_000;
const CHALLENGE_POLL_MS = 500;
const CHALLENGE_PROBE_RESERVE_MS = 250;
const CHALLENGE_PROBE_SEP = "\n__BC_CHALLENGE_SEP__\n";
const CHALLENGE_PROBE_EXPR = buildChallengeProbeExpression(false);
const FAST_VENDOR_CSS = fastVendorSelectors.join(",");
/** One cheap querySelector-style check for known challenge markers (`# N row(s)` header). */
const VENDOR_MARKER_STEP = {
  kind: "bc",
  method: "query",
  args: [{ selector: FAST_VENDOR_CSS, fields: { id: "@id" }, limit: 1, all: true }],
  fallback: "",
} as const;
const PROBE_SELECTORS_CSS = probeSelectors.join(",");
const EXTENSION_REQUEST_SYMBOL = Symbol.for("browser-control.extension-request");
type ExtensionRequestFn = (op: string, params?: Json, timeoutMs?: number) => Promise<unknown>;

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

function stripHash(url: string): string {
  const idx = url.indexOf("#");
  return idx >= 0 ? url.slice(0, idx) : url;
}

type ProbeReadResult =
  | { kind: "skip"; url?: string }
  | { kind: "probe"; probe: ChallengeProbe }
  | { kind: "error" };

type ChallengeCheckResult =
  | { status: "clear"; waited: boolean; url?: string }
  | {
      status: "interactive" | "block" | "non-interactive-timeout";
      detection: ChallengeDetection;
      url: string;
      waited: boolean;
    };

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
  const m = /^JS_EXCEPTION: (?:Error: )?((?:AMBIGUOUS|NO_MATCH|STALE_REF|REF_DRIFTED|NOT_ACTIONABLE|REFUSED|INPUT_INVALID|INPUT_NOT_DELIVERED|FLOW_DRIFTED): [\s\S]*?)(?:\n\s+at [\s\S]*)?$/.exec(
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

type Point = { x: number; y: number; hidden: boolean; before?: string; box?: Box2D; viewport?: Viewport };
type ScrollerDetail = {
  kind: "element" | "document";
  box: Box2D;
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  clientHeight: number;
  point?: Point2D | null;
};
type PointDetail = {
  x: number;
  y: number;
  hidden: boolean;
  inView: boolean;
  box: Box2D;
  rect: Box2D;
  viewport: Viewport;
  stickyTop: number;
  stickyBottom: number;
  scroller?: ScrollerDetail;
};
type Step = { action: string; input: Json; label: string };

export function createPageHelperHandler(
  invoke: Invoker,
  browseRunner: Runner = runBrowse,
  recognize: Recognizer = recognizeText,
  options: {
    notesDir?: string;
    flowsDir?: string;
    sessionId?: string;
    sleep?: (ms: number) => Promise<void>;
    rng?: () => number;
    now?: () => number;
    naturalDefault?: boolean;
    bcCall?: BcCallFn;
    extensionRequest?: ExtensionRequestFn;
    challengeWaitMaxMs?: number;
  } = {},
) {
  const daemonSessionId = options.sessionId ?? randomUUID().slice(0, 12);
  const pause = options.sleep ?? sleep;
  const rng = options.rng ?? Math.random;
  /** Natural typing speed for this daemon session, drawn once (0.85-1.15) on the first use. */
  let typingSpeed: number | undefined;
  const typingSpeedFactor = (): number => (typingSpeed ??= 0.85 + rng() * 0.3);
  const now = options.now ?? (() => Date.now());
  const isNatural = (input: Json): boolean => isNaturalEnabled(input, { defaultEnabled: options.naturalDefault });
  /** Per-tab pointer state keyed by resolved top-level target id (without frame suffix). */
  const motionByTab = new Map<string, { pointer?: Point2D; viewport?: Viewport }>();
  let implicitCdpTarget: string | undefined;
  const tabKeyOf = (targetId?: string): string => (targetId ?? implicitCdpTarget ?? "").replace(/@(?:frame:)?\d+$/, "");
  const motionOf = (targetId?: string): { pointer?: Point2D; viewport?: Viewport } => {
    const key = tabKeyOf(targetId);
    let st = motionByTab.get(key);
    if (!st) {
      st = {};
      motionByTab.set(key, st);
    }
    return st;
  };
  const resetMotion = (targetId?: string): void => {
    motionByTab.delete(tabKeyOf(targetId));
  };
  /** Cross-origin iframe targets from the last snap of each tab: f1 is index 0. */
  const frameTargets = new Map<string, string[]>();
  /** Last isolated-world executionContextId seen per target, used by upload/styles. */
  const contextIds = new Map<string, number>();
  /** Last parsed snapshot entries per browse tab, used for trap/payment guard checks. */
  const browseCache = new Map<number, Map<string, BrowseEntry>>();
  /** Non-secret typed values remembered per tab for `flow save` parameterization. */
  const recentTyped = new Map<string, Record<string, string>>();
  /** Active human handoff id per extension tab id (at most one active handoff per tab). */
  const activeHandoffs = new Map<number, string>();

  async function runBcCall(call: ReturnType<typeof normalizeHelperCall>, targetId: string, timeoutMs?: number): Promise<InvokeResult> {
    const order = backendOrder();
    const fn = options.bcCall ?? (order.includes("extension") ? getRegisteredExtensionBcCall() : undefined);
    if (!fn) {
      const msg = isExtensionOnlyOrder(order)
        ? extensionOnlyMessage("the extension backend isn't active")
        : "BACKEND_UNAVAILABLE: extension backend is not active";
      return failure("EXECUTION_FAILED", msg);
    }
    try {
      const data = await fn({
        targetId,
        steps: call.steps,
        join: call.join,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      return { ok: true, data };
    } catch (error) {
      if (isBackendUnavailable(error) && isExtensionOnlyOrder(order)) {
        return failure("EXECUTION_FAILED", extensionOnlyMessage(error));
      }
      return helperError(failure("EXECUTION_FAILED", (error as Error).message));
    }
  }

  async function evalHelper(call: HelperCall, targetId?: string, timeoutMs?: number): Promise<InvokeResult> {
    const normalized = normalizeHelperCall(call);
    if (extensionTabOf(targetId) !== undefined) {
      return runBcCall(normalized, targetId!, timeoutMs);
    }
    const callExpr = renderSteps(normalized);
    const extra = { isolated: true, ...(targetId ? { targetId } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
    const probe = `globalThis.__bc && globalThis.__bc.v === ${PAGE_HELPERS_VERSION} ? (${callExpr}) : "${NEED_INSTALL}"`;
    const first = await invoke("evaluate", { expression: probe, ...extra });
    if (!first.ok) return helperError(first);
    const firstCtx = (first.data as Json)["contextId"];
    if (typeof firstCtx === "number") contextIds.set(targetId ?? "", firstCtx);
    if ((first.data as Json)["value"] !== NEED_INSTALL) return first;
    const second = await invoke("evaluate", { expression: `${PAGE_HELPERS_SOURCE}\n${callExpr}`, ...extra });
    if (second.ok) {
      const secondCtx = (second.data as Json)["contextId"];
      if (typeof secondCtx === "number") contextIds.set(targetId ?? "", secondCtx);
    }
    return helperError(second);
  }

  /** A plain page property read: no __bc probe, and it never updates the helper context cache. */
  function readProperty(
    kind: "readyState" | "origin" | "host" | "href",
    targetId?: string,
    opts: { isolated?: boolean; timeoutMs?: number } = {},
  ): Promise<InvokeResult> {
    if (extensionTabOf(targetId) !== undefined) {
      return runBcCall({ steps: [{ kind }] }, targetId!, opts.timeoutMs);
    }
    return invoke("evaluate", {
      expression: renderSteps(normalizeHelperCall({ kind })),
      ...(opts.isolated ? { isolated: true } : {}),
      ...(targetId ? { targetId } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  const picture = createPictureTracker(invoke, evalHelper, recognize);

  type ResolvedTarget = {
    browseTab?: number;
    extensionTarget?: string;
    cdpTarget?: string;
    extensionOnly?: boolean;
    extensionAvailable?: boolean;
    activeBackend?: string | null;
  };

  async function resolveTargetBackend(targetId?: string): Promise<ResolvedTarget> {
    if (targetId !== undefined) {
      return {
        browseTab: browseTabNumber(targetId),
        extensionTarget: extensionTabOf(targetId) !== undefined ? targetId : undefined,
      };
    }
    const status = await invoke("get_browser_status");
    if (!status.ok) return {};
    const data = status.data as Json;
    const backends = data["backends"] as Json | undefined;
    const activeBackend = typeof backends?.["active"] === "string" ? (backends["active"] as string) : null;
    const order = Array.isArray(backends?.["order"]) ? (backends["order"] as string[]) : undefined;
    const extensionOnly = order ? isExtensionOnlyOrder(order) : false;
    const extState = backends?.["extension"] as Json | undefined;
    const extensionAvailable = typeof extState?.["available"] === "boolean" ? extState["available"] : undefined;
    if (activeBackend === "browse") {
      const browseState = backends?.["browse"] as Json | undefined;
      return { browseTab: browseTabNumber(browseState?.["activeTargetId"]), extensionOnly, extensionAvailable, activeBackend };
    }
    if (activeBackend === "extension") {
      const activeId = extState?.["activeTargetId"];
      return {
        extensionTarget: extensionTabOf(activeId) !== undefined ? (activeId as string) : undefined,
        extensionOnly,
        extensionAvailable,
        activeBackend,
      };
    }
    const cdpAllowed =
      backends === undefined || activeBackend === "cdp" || (activeBackend === null && (!order || order.includes("cdp")));
    const cdpTarget = cdpAllowed && typeof data["activeTargetId"] === "string" ? (data["activeTargetId"] as string) : undefined;
    return { cdpTarget, extensionOnly, extensionAvailable, activeBackend };
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
    // Resolve the pointer-state slot before awaiting, so a concurrent request that switches the
    // implicit target cannot make this event land under another tab.
    const st = method === "Input.dispatchMouseEvent" ? motionOf(targetId) : undefined;
    const res = await invoke("execute_cdp", { method, params, ...(targetId ? { targetId } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
    if (st) {
      if (!res.ok) delete st.pointer;
      else if (params["type"] === "mouseMoved" && typeof params["x"] === "number" && typeof params["y"] === "number") st.pointer = { x: params["x"], y: params["y"] };
    }
    return res;
  }

  /** Resolve a structured element target into a CDP RemoteObjectId in the same world where `__bc` lives. */
  async function resolveObject(
    target: ElementStep,
    targetId?: string,
  ): Promise<{ ok: true; objectId: string } | { ok: false; res: InvokeResult }> {
    const expr = renderElementStep(target);
    if (extensionTabOf(targetId) !== undefined) {
      const order = backendOrder();
      const extRequest =
        options.extensionRequest ??
        ((globalThis as Record<symbol, unknown>)[EXTENSION_REQUEST_SYMBOL] as ExtensionRequestFn | undefined);
      if (!extRequest) {
        const msg = isExtensionOnlyOrder(order)
          ? extensionOnlyMessage("the extension backend isn't active")
          : "BACKEND_UNAVAILABLE: extension backend is not active";
        return {
          ok: false,
          res: failure("EXECUTION_FAILED", msg),
        };
      }
      const reqParams: Json =
        target.kind === "bc"
          ? { targetId, ref: target.args[0], mode: "ref" }
          : { targetId, ref: target.selector, mode: "selector" };
      try {
        const resolved = (await extRequest("resolve_bc_node", reqParams)) as { objectId?: unknown } | undefined;
        const objectId = typeof resolved?.objectId === "string" && resolved.objectId !== "" ? resolved.objectId : undefined;
        if (!objectId) {
          return {
            ok: false,
            res: failure("EXECUTION_FAILED", `NO_MATCH: could not resolve element (${expr})`),
          };
        }
        return { ok: true, objectId };
      } catch (err) {
        if (isBackendUnavailable(err) && isExtensionOnlyOrder(order)) {
          return { ok: false, res: failure("EXECUTION_FAILED", extensionOnlyMessage(err)) };
        }
        return { ok: false, res: helperError(failure("EXECUTION_FAILED", (err as Error).message)) };
      }
    }
    const ctxId = contextIds.get(targetId ?? "");
    const evalObj = await cdp(
      "Runtime.evaluate",
      { expression: expr, returnByValue: false, ...(ctxId !== undefined ? { contextId: ctxId } : {}) },
      targetId,
    );
    if (!evalObj.ok) return { ok: false, res: evalObj };
    const objectId = ((((evalObj.data as Json)["result"] as Json | undefined)?.["result"] as Json | undefined)?.["objectId"]) as
      | string
      | undefined;
    if (!objectId) {
      return { ok: false, res: failure("EXECUTION_FAILED", `NOT_ACTIONABLE: could not resolve element (${expr})`) };
    }
    return { ok: true, objectId };
  }

  /** Cumulative debt pacer: absorbs timer slack and IPC latency across steps without distorting mock-clock tests. */
  function createPacer() {
    let debtMs = 0;
    let lastEnd = now();
    return async (delayMs: number): Promise<void> => {
      debtMs += Math.max(0, now() - lastEnd);
      if (delayMs > 0) {
        const rem = Math.max(0, delayMs - debtMs);
        debtMs = Math.max(0, debtMs - delayMs);
        if (rem > 0) {
          const t0 = now();
          await pause(rem);
          const slept = Math.max(0, now() - t0);
          if (slept > rem) debtMs += slept - rem;
        }
      }
      lastEnd = now();
    };
  }

  async function movePointer(
    to: Point2D,
    targetId: string | undefined,
    opts: {
      viewport?: Viewport;
      targetSize?: number;
      maxSteps?: number;
      overshootProb?: number;
      button?: string;
      buttons?: number;
    } = {},
  ): Promise<InvokeResult> {
    const state = motionOf(targetId);
    const viewport = opts.viewport ?? state.viewport ?? DEFAULT_VIEWPORT;
    if (opts.viewport) state.viewport = opts.viewport;
    const plan = planPointerPath({
      from: state.pointer,
      to,
      viewport,
      targetSize: opts.targetSize,
      maxSteps: opts.maxSteps,
      overshootProb: opts.overshootProb,
      rng,
    });
    const pace = createPacer();
    for (const step of plan.steps) {
      await pace(step.delayMs);
      const res = await cdp(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x: step.x,
          y: step.y,
          ...(opts.button !== undefined ? { button: opts.button } : {}),
          ...(opts.buttons !== undefined ? { buttons: opts.buttons } : {}),
        },
        targetId,
        INPUT_TIMEOUT_MS,
      );
      if (!res.ok) return res;
    }
    return success("ok");
  }

  const notActionable = (ref: string, why = "covered after hover") => failure("EXECUTION_FAILED", `NOT_ACTIONABLE: ${ref} ${why}`);

  /** `res` is a helper error (stale ref, bad output) that must fail the click; `blocked` means another element is on top. */
  async function verifyHit(ref: string, pt: Point2D, where: string | undefined) {
    const hc = await evalHelper({ kind: "bc", method: "hitCheck", args: [ref, pt.x, pt.y] }, where, 2_000);
    if (!hc.ok) return { ok: false as const, res: hc };
    try {
      const p = JSON.parse(valueOf(hc)) as { ok?: boolean; reason?: string };
      if (p.ok === true) return { ok: true as const };
      if (p.ok === false) return { ok: false as const, blocked: p.reason };
    } catch { /* fall through */ }
    return { ok: false as const, res: notActionable(ref, "invalid hitCheck output") };
  }

  async function clickCoords(
    x: number,
    y: number,
    targetId?: string,
    clickCount = 1,
    opts: { natural?: boolean; box?: Box2D; viewport?: Viewport; domRef?: string } = {},
  ): Promise<InvokeResult> {
    let at: Point2D = { x, y };
    let timing: ReturnType<typeof planClickTiming> | undefined;
    if (!opts.natural) {
      const m1 = await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, targetId, INPUT_TIMEOUT_MS);
      if (!m1.ok) return m1;
    } else {
      const moveOpts = { viewport: opts.viewport, targetSize: opts.box ? Math.min(opts.box.width, opts.box.height) : undefined };
      const moved = await movePointer(at, targetId, moveOpts);
      if (!moved.ok) return moved;
      timing = planClickTiming(clickCount, rng);
      await pause(timing.dwellMs);
      if (opts.domRef) {
        // Hover can open menus over the target: never press without a passing hit check.
        let chk = await verifyHit(opts.domRef, at, targetId);
        if (!chk.ok && !chk.res && opts.box) {
          const { left, top, width, height } = opts.box;
          const alt = await pickVerifiedPoint(opts.domRef, opts.box, { x: Math.round(left + width / 2), y: Math.round(top + height / 2) }, targetId);
          if (!alt.ok) return alt.res;
          const rep = await movePointer(alt.pt, targetId, { ...moveOpts, overshootProb: 0 });
          if (!rep.ok) return rep;
          at = alt.pt;
          chk = await verifyHit(opts.domRef, at, targetId);
        }
        if (!chk.ok) return chk.res ?? notActionable(opts.domRef, chk.blocked);
      }
    }
    for (let c = 1; c <= clickCount; c++) {
      const m2 = await cdp(
        "Input.dispatchMouseEvent",
        { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: c },
        targetId,
        INPUT_TIMEOUT_MS,
      );
      if (!m2.ok) return m2;
      if (timing) await pause(timing.holdsMs[c - 1]!);
      const m3 = await cdp(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: c },
        targetId,
        INPUT_TIMEOUT_MS,
      );
      if (!m3.ok) return m3;
      if (timing && c < clickCount) await pause(timing.gapsMs[c - 1]!);
    }
    return success("ok");
  }

  /** Turn a label into a ref; everything else passes through. */
  async function locate(
    raw: unknown,
    kind: "click" | "type" | "select" | "read",
    targetId?: string,
    healInBatch = false,
  ): Promise<{ ok: true; loc: Exclude<Locator, { kind: "label" }>; healedFrom?: string } | { ok: false; res: InvokeResult }> {
    let loc: Locator;
    try {
      loc = parseLocator(raw);
    } catch (error) {
      return { ok: false, res: failure("INPUT_VALIDATION_FAILED", (error as Error).message) };
    }
    if (loc.kind !== "label") {
      if (loc.kind === "dom") {
        const ver = await evalHelper({ kind: "bc", method: "verifyRef", args: [loc.ref] }, targetId);
        if (!ver.ok) {
          if (healInBatch && messageOf(ver).startsWith("STALE_REF")) {
            const healed = await evalHelper({ kind: "bc", method: "healRef", args: [loc.ref] }, targetId);
            if (healed.ok && /^e\d+$/.test(valueOf(healed))) {
              return { ok: true, loc: { kind: "dom", ref: valueOf(healed) }, healedFrom: loc.ref };
            }
          }
          return { ok: false, res: ver };
        }
      }
      return { ok: true, loc };
    }
    const found = await evalHelper({ kind: "bc", method: "locate", args: [loc.label, kind] }, targetId);
    if (!found.ok) {
      if (messageOf(found).includes("NO_MATCH:")) {
        const hit = await locateInFrames("locate", [loc.label, kind], targetId);
        if (hit) return { ok: true, loc: { kind: "frame", frame: hit.frame, ref: hit.ref, target: hit.target } };
      }
      return { ok: false, res: found };
    }
    return { ok: true, loc: { kind: "dom", ref: valueOf(found) } };
  }

  const nameOf = (loc: Exclude<Locator, { kind: "label" }>) =>
    loc.kind === "dom" ? loc.ref : loc.kind === "frame" ? `f${loc.frame}:${loc.ref}` : `a${loc.node}`;

  function frameTarget(frame: number, targetId?: string): string | undefined {
    return frameTargets.get(targetId ?? "")?.[frame - 1];
  }

  function parsePointDetail(raw: string): PointDetail | undefined {
    if (!raw.startsWith("{")) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<PointDetail>;
      if (typeof parsed.x === "number" && typeof parsed.y === "number" && parsed.box && parsed.viewport) {
        return {
          x: parsed.x,
          y: parsed.y,
          hidden: parsed.hidden === true,
          inView: parsed.inView !== false,
          box: parsed.box,
          rect: parsed.rect ?? parsed.box,
          viewport: parsed.viewport,
          stickyTop: typeof parsed.stickyTop === "number" ? parsed.stickyTop : 0,
          stickyBottom: typeof parsed.stickyBottom === "number" ? parsed.stickyBottom : 0,
          scroller: parsed.scroller,
        };
      }
    } catch { /* fall back to legacy format */ }
    return undefined;
  }

  async function pickVerifiedPoint(ref: string, box: Box2D | undefined, center: Point2D, where: string | undefined) {
    const canSample = Boolean(box && box.width >= 2 && box.height >= 2);
    let blocked: string | undefined;
    for (let i = canSample ? 0 : 3; i < 4; i++) {
      const pt = i < 3 ? pickClickPoint(box!, rng) : center;
      const chk = await verifyHit(ref, pt, where);
      if (chk.ok) return { ok: true as const, pt };
      if (chk.res) return { ok: false as const, res: chk.res };
      blocked = chk.blocked;
    }
    return { ok: false as const, res: notActionable(ref, blocked) };
  }

  async function wheelScrollIntoView(
    ref: string,
    initial: PointDetail,
    targetId: string | undefined,
  ): Promise<{ ok: true; detail: PointDetail } | { ok: false; res: InvokeResult }> {
    let cur = initial;
    if (cur.hidden) {
      const foc = await cdp("Emulation.setFocusEmulationEnabled", { enabled: true }, targetId);
      if (!foc.ok) return { ok: false, res: foc };
    }
    const vw = cur.viewport.width || DEFAULT_VIEWPORT.width;
    const vh = cur.viewport.height || DEFAULT_VIEWPORT.height;
    motionOf(targetId).viewport = { width: vw, height: vh };

    const scroller = cur.scroller;
    const goalY = scroller?.kind === "element"
      ? scroller.box.top + scroller.box.height * (0.32 + rng() * 0.22)
      : vh * (0.32 + rng() * 0.22);
    const neededDeltaY = Math.round(cur.rect.top + cur.rect.height / 2 - goalY);

    if (Math.abs(neededDeltaY) >= 4) {
      const ptr = motionOf(targetId).pointer;
      let anchor: Point2D;
      let inScrollArea = false;
      if (scroller?.kind === "element") {
        const cl = Math.max(0, scroller.box.left);
        const ct = Math.max(0, scroller.box.top);
        const cr = Math.min(vw, scroller.box.left + scroller.box.width);
        const cb = Math.min(vh, scroller.box.top + scroller.box.height);
        if (ptr && cr - cl >= 4 && cb - ct >= 4 && ptr.x >= cl && ptr.x < cr && ptr.y >= ct && ptr.y < cb) {
          anchor = ptr;
          inScrollArea = true;
        } else {
          anchor = cr - cl >= 4 && cb - ct >= 4
            ? pickClickPoint({ left: cl, top: ct, width: cr - cl, height: cb - ct }, rng)
            : { x: Math.round(vw * 0.5), y: Math.round(vh * 0.5) };
        }
      } else {
        // Reuse the resting pointer only when the page confirms it is over the document, not a nested scroller.
        const ptrIn = ptr !== undefined && ptr.x >= 0 && ptr.x < vw && ptr.y >= 0 && ptr.y < vh;
        let docPt = scroller?.point;
        if (ptrIn || !docPt) {
          const sp = await evalHelper({ kind: "bc", method: "pageScrollPoint", ...(ptrIn ? { args: [ptr.x, ptr.y] } : {}) }, targetId, 2_000);
          try { docPt = (sp.ok ? (JSON.parse(valueOf(sp)) as Point2D | null) : null) ?? docPt; } catch { /* keep docPt */ }
        }
        const ok = docPt != null && typeof docPt.x === "number" && typeof docPt.y === "number";
        inScrollArea = ok && ptrIn && docPt!.x === ptr.x && docPt!.y === ptr.y;
        anchor = ok ? docPt! : { x: Math.round(vw * (0.35 + rng() * 0.3)), y: Math.round(vh * (0.35 + rng() * 0.3)) };
      }

      if (!inScrollArea) {
        const moved = await movePointer(anchor, targetId, { viewport: { width: vw, height: vh }, overshootProb: 0 });
        if (!moved.ok) return { ok: false, res: moved };
      }

      const plan = planWheelScroll(neededDeltaY, rng);
      const pace = createPacer();
      for (let fi = 0; fi < plan.flicks.length; fi++) {
        const flick = plan.flicks[fi]!;
        const prevTop = cur.rect.top;
        for (const ev of flick.events) {
          await pace(ev.delayMs);
          const wres = await cdp(
            "Input.dispatchMouseEvent",
            { type: "mouseWheel", x: anchor.x, y: anchor.y, deltaX: 0, deltaY: ev.deltaY },
            targetId,
            INPUT_TIMEOUT_MS,
          );
          if (!wres.ok) return { ok: false, res: wres };
        }
        const probe = await evalHelper(
          { kind: "bc", method: "point", args: [ref, { noScroll: true, detail: true }] },
          targetId,
        );
        if (!probe.ok) break;
        const next = parsePointDetail(valueOf(probe));
        if (!next) break;
        cur = next;
        if (next.inView) return { ok: true, detail: next };
        if (Math.abs(next.rect.top - prevTop) < 2) break;
        if (fi < plan.flicks.length - 1 && flick.pauseAfterMs > 0) {
          await pace(flick.pauseAfterMs);
        }
      }
    }

    // Fallback to instant scrollIntoView when wheel scrolling stagnates or target is still off-screen.
    const settled = await evalHelper(
      { kind: "bc", method: "point", args: [ref, { detail: true }] },
      targetId,
    );
    if (!settled.ok) return { ok: false, res: settled };
    const detail = parsePointDetail(valueOf(settled));
    if (!detail) {
      return { ok: false, res: failure("EXECUTION_FAILED", `unexpected point output: ${valueOf(settled)}`) };
    }
    return { ok: true, detail };
  }

  /** Where to click, in the top page's viewport coordinates. `baseline` also records the controls for the later diff. */
  async function pointOf(
    loc: Exclude<Locator, { kind: "label" }>,
    targetId: string | undefined,
    baseline: boolean,
    natural = false,
  ): Promise<{ ok: true; pt: Point } | { ok: false; res: InvokeResult }> {
    const bad = (res: InvokeResult) => ({ ok: false as const, res });
    if (loc.kind === "ax") {
      const before = baseline ? await evalHelper({ kind: "bc", method: "baseline" }, targetId) : undefined;
      await cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId: loc.node }, targetId);
      const quads = await cdp("DOM.getContentQuads", { backendNodeId: loc.node }, targetId);
      if (!quads.ok) return bad(quads);
      const q = ((((quads.data as Json)["result"] as Json | undefined)?.["quads"] as number[][] | undefined) ?? [])[0];
      if (!q || q.length < 8) {
        return bad(failure("EXECUTION_FAILED", `NOT_ACTIONABLE: a${loc.node} has no visible box. Run snap --ax again.`));
      }
      const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
      const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
      const box: Box2D = {
        left: Math.min(...xs),
        top: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
      const picked = natural && box.width >= 2 && box.height >= 2
        ? pickClickPoint(box, rng)
        : { x: Math.round((q[0]! + q[2]! + q[4]! + q[6]!) / 4), y: Math.round((q[1]! + q[3]! + q[5]! + q[7]!) / 4) };
      return {
        ok: true,
        pt: {
          x: picked.x,
          y: picked.y,
          hidden: false,
          before: before?.ok ? valueOf(before) : undefined,
          ...(natural ? { box } : {}),
        },
      };
    }
    const where = loc.kind === "frame" ? (loc.target ?? frameTarget(loc.frame, targetId)) : targetId;
    if (loc.kind === "frame" && !where) {
      return bad(failure("EXECUTION_FAILED", `STALE_REF: iframe f${loc.frame} is not known for this tab. Run snap again.`));
    }
    const before = baseline && loc.kind === "frame" ? await evalHelper({ kind: "bc", method: "baseline" }, targetId) : undefined;
    if (!natural || loc.kind === "frame") {
      const call: HelperCall = baseline && loc.kind === "dom"
        ? { steps: [{ kind: "bc", method: "baseline" }, { kind: "bc", method: "point", args: [loc.ref] }], join: " " }
        : { kind: "bc", method: "point", args: [loc.ref] };
      const res = await evalHelper(call, where);
      if (!res.ok) return bad(res);
      const parts = valueOf(res).split(" ");
      const href = baseline && loc.kind === "dom" ? parts.shift() : before?.ok ? valueOf(before) : undefined;
      let x = Number(parts[0]);
      let y = Number(parts[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return bad(failure("EXECUTION_FAILED", `unexpected point output: ${valueOf(res)}`));
      }
      if (loc.kind === "frame") {
        // Offset the iframe element that hosts the frame the point came from, not whatever sits in slot f<n> now.
        const slot = (await crossFrames(targetId)).find((f) => f.target === where)?.i;
        if (slot === undefined) {
          return bad(failure("EXECUTION_FAILED", `STALE_REF: iframe f${loc.frame} is gone. Run snap again.`));
        }
        const off = await evalHelper({ kind: "bc", method: "frameOffset", args: [slot] }, targetId);
        if (!off.ok) return bad(off);
        const [ox, oy] = valueOf(off).split(" ").map(Number);
        x = Math.round(x + (ox ?? 0));
        y = Math.round(y + (oy ?? 0));
      }
      return { ok: true, pt: { x, y, hidden: parts[2] === "hidden", before: href } };
    }

    // Natural mode (main-frame DOM ref): inspect visibility without scrolling so off-screen targets wheel-scroll.
    const pointOpts = { noScroll: true, detail: true };
    const call: HelperCall = baseline
      ? { steps: [{ kind: "bc", method: "baseline" }, { kind: "bc", method: "point", args: [loc.ref, pointOpts] }], join: "\n" }
      : { kind: "bc", method: "point", args: [loc.ref, pointOpts] };
    const res = await evalHelper(call, targetId);
    if (!res.ok) return bad(res);
    const raw = valueOf(res);
    let href: string | undefined;
    let ptRaw = raw;
    if (baseline) {
      const nl = raw.indexOf("\n");
      if (nl >= 0) {
        href = raw.slice(0, nl);
        ptRaw = raw.slice(nl + 1);
      } else {
        const sp = raw.indexOf(" ");
        if (sp >= 0) {
          href = raw.slice(0, sp);
          ptRaw = raw.slice(sp + 1);
        }
      }
    }
    let detail = parsePointDetail(ptRaw);
    if (!detail) {
      // Fallback for mocks returning legacy "x y visible" format.
      const parts = ptRaw.split(" ");
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return bad(failure("EXECUTION_FAILED", `unexpected point output: ${raw}`));
      }
      return { ok: true, pt: { x, y, hidden: parts[2] === "hidden", before: href } };
    }

    if (!detail.inView) {
      const scrolled = await wheelScrollIntoView(loc.ref, detail, targetId);
      if (!scrolled.ok) return bad(scrolled.res);
      detail = scrolled.detail;
    }

    motionOf(targetId).viewport = detail.viewport;
    const sampled = await pickVerifiedPoint(loc.ref, detail.box, { x: detail.x, y: detail.y }, targetId);
    if (!sampled.ok) return bad(sampled.res);
    return {
      ok: true,
      pt: {
        x: sampled.pt.x,
        y: sampled.pt.y,
        hidden: detail.hidden,
        before: href,
        box: detail.box,
        viewport: detail.viewport,
      },
    };
  }

  async function clickAt(
    pt: Point,
    targetId?: string,
    clickCount = 1,
    natural = false,
    domRef?: string,
  ): Promise<InvokeResult> {
    if (pt.hidden) {
      const foc = await cdp("Emulation.setFocusEmulationEnabled", { enabled: true }, targetId);
      if (!foc.ok) return foc;
    }
    return clickCoords(pt.x, pt.y, targetId, clickCount, {
      natural,
      box: pt.box,
      viewport: pt.viewport,
      domRef,
    });
  }

  /** Arm isolated-world event probe and read back trusted event counts after input. */
  async function readProbe(targetId?: string): Promise<Record<string, number> | undefined> {
    const res = await evalHelper({ kind: "bc", method: "readInputProbe" }, targetId, 2_000);
    if (!res.ok) return undefined;
    try {
      const parsed = JSON.parse(valueOf(res)) as Record<string, number>;
      return typeof parsed === "object" && parsed !== null && "mousedown" in parsed ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async function pressKey(name: string, targetId?: string, holdMs = 0): Promise<InvokeResult> {
    const spec = KEYS[name];
    if (!spec) {
      return failure("INPUT_VALIDATION_FAILED", `INPUT_INVALID: key must be ${Object.keys(KEYS).join(", ")}`);
    }
    const base: Json = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode };
    const down = spec.text !== undefined
      ? await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: spec.text }, targetId, INPUT_TIMEOUT_MS)
      : await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, targetId, INPUT_TIMEOUT_MS);
    if (!down.ok) return down;
    if (holdMs > 0) await pause(holdMs);
    return cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base }, targetId, INPUT_TIMEOUT_MS);
  }

  async function dispatchText(
    text: string,
    mode: "human" | "fast" | "keys",
    targetId?: string,
    opts: { focused?: boolean; fieldKind?: FieldKind } = {},
  ): Promise<InvokeResult> {
    if (text === "") {
      return pressKey("Backspace", targetId);
    }
    if (mode === "fast") {
      if (!opts.focused && text.length >= 2 && !/[\r\n\t]$/.test(text)) {
        // Insert all but the last character fast, then send the final character as real key events to wake autocompletes/frameworks.
        const ins = await cdp("Input.insertText", { text: text.slice(0, -1) }, targetId, INPUT_TIMEOUT_MS);
        if (!ins.ok) return ins;
        const last = text.slice(-1);
        const kd = await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: last, text: last }, targetId, INPUT_TIMEOUT_MS);
        if (!kd.ok) return kd;
        return cdp("Input.dispatchKeyEvent", { type: "keyUp", key: last }, targetId, INPUT_TIMEOUT_MS);
      }
      return cdp("Input.insertText", { text }, targetId, INPUT_TIMEOUT_MS);
    }
    if (mode === "keys") {
      for (const ch of text) {
        const kd = await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }, targetId, INPUT_TIMEOUT_MS);
        if (!kd.ok) return kd;
        const ku = await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, targetId, INPUT_TIMEOUT_MS);
        if (!ku.ok) return ku;
      }
      return success("ok");
    }
    // Default: natural typing — human cadence, rollover, real Shift, and self-corrected typos.
    const plan = planTyping(text, {
      rng,
      speedFactor: typingSpeedFactor(),
      fieldKind: opts.fieldKind ?? "none",
    });
    // A key is recorded as down before its keyDown goes out, so one that reached the page but
    // timed out is still released. Events run against elapsed time, so round trips don't add up.
    const held = heldFor(targetId);
    await releaseKeys(targetId);
    const start = now();
    let plannedAt = 0;
    try {
      for (const step of plan.events) {
        plannedAt += step.delayMs;
        const wait = start + plannedAt - now();
        if (wait > 0) await pause(wait);
        // Emoji and other unmapped characters go as key text: keyDown with text, then keyUp.
        const spec: CharKeySpec =
          step.kind === "insert" ? { key: step.text, code: "", windowsVirtualKeyCode: 0, text: step.text } : step.spec;
        if (step.kind !== "keyUp") {
          held.set(spec.key, spec);
          const down = await sendKey(spec.text !== undefined ? "keyDown" : "rawKeyDown", spec, targetId);
          if (!down.ok) return down;
        }
        if (step.kind !== "keyDown") {
          const up = await sendKey("keyUp", spec, targetId);
          if (!up.ok) return up;
          held.delete(spec.key);
        }
      }
      return success("ok");
    } finally {
      await releaseKeys(targetId);
    }
  }

  function sendKey(type: string, spec: CharKeySpec, targetId?: string, timeoutMs = INPUT_TIMEOUT_MS): Promise<InvokeResult> {
    const { key, code, windowsVirtualKeyCode, modifiers, text } = spec;
    const extra = { ...(modifiers ? { modifiers } : {}), ...(type === "keyDown" && text !== undefined ? { text } : {}) };
    return cdp("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode, ...extra }, targetId, timeoutMs);
  }

  /** Keys whose keyUp has not landed, per tab. Retried at the next dispatch and after a dialog closes. */
  const heldKeys = new Map<string, Map<string, CharKeySpec>>();
  function heldFor(targetId?: string): Map<string, CharKeySpec> {
    let held = heldKeys.get(targetId ?? "");
    if (!held) heldKeys.set(targetId ?? "", (held = new Map()));
    return held;
  }

  async function releaseKeys(targetId?: string): Promise<void> {
    const held = heldFor(targetId);
    for (const [key, spec] of [...held].reverse()) {
      // A dialog blocks input: stop and keep the rest for the retry instead of waiting on each.
      if (!(await sendKey("keyUp", spec, targetId, 1_000).catch(() => undefined))?.ok) return;
      held.delete(key);
    }
  }

  /** Typo policy from the focused field's live type and flags (attach-free read); any doubt means none. */
  async function fieldKindOf(text: string, targetId?: string): Promise<FieldKind> {
    const probe = await evalHelper({ kind: "bc", method: "typingField" }, targetId, 2_000);
    let f: { type?: unknown; flags?: unknown; hint?: unknown } = {};
    try {
      f = (probe.ok && JSON.parse(valueOf(probe))) || {};
    } catch {}
    if (typeof f.type !== "string" || !Array.isArray(f.flags)) return "none";
    if (/^(number|password)$/.test(f.type) || f.flags.some((x) => /^(secure|trap|payment|cc)$/.test(String(x)))) return "none";
    if (/^(email|tel|url|date|time|datetime-local|month|week)$/.test(f.type)) return "structured";
    return classifyFieldKind(text, String(f.hint ?? ""));
  }

  async function waitParsed(targetId?: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const ready = await readProperty("readyState", targetId, { timeoutMs: 2_000 });
      if (ready.ok && valueOf(ready) !== "loading") return;
      await sleep(125);
    }
  }

  async function changes(before: string | undefined, targetId?: string): Promise<string> {
    const call: HelperCall = {
      steps: [{ kind: "bc", method: "settle" }, { kind: "bc", method: "diff", args: [{ from: before ?? "" }] }],
    };
    let res = await evalHelper(call, targetId, 8_000);
    if (!res.ok && messageOf(res).startsWith("CDP_TIMEOUT")) return `# ${DIALOG_HINT}`;
    if (!res.ok) {
      await waitParsed(targetId);
      res = await evalHelper(call, targetId, 8_000);
    }
    return res.ok ? valueOf(res) : `# could not read what changed: ${messageOf(res).slice(0, 160)}`;
  }

  const withChanges = async (line: string, before: string | undefined, quiet: boolean, targetId?: string): Promise<InvokeResult> =>
    success(quiet ? line : `${line}\n${await changes(before, targetId)}`);

  const inputFailed = (res: InvokeResult, what: string): InvokeResult =>
    messageOf(res).startsWith("CDP_TIMEOUT") ? success(`${what}: delivered_unverified (${DIALOG_HINT})`) : res;

  /** Targets that can run helpers inside a child frame: OOPIF targets on CDP, frame ids on extension tabs. */
  async function frameTargetPool(targetId?: string): Promise<Array<{ targetId: string; url: string }>> {
    if (extensionTabOf(targetId) !== undefined) {
      const extRequest =
        options.extensionRequest ??
        ((globalThis as Record<symbol, unknown>)[EXTENSION_REQUEST_SYMBOL] as ExtensionRequestFn | undefined);
      if (!extRequest) return [];
      try {
        const res = (await extRequest("list_frames", { targetId })) as
          | { frames?: Array<{ frameId: number; url: string }> }
          | undefined;
        return (res?.frames ?? [])
          .filter((fr) => typeof fr.frameId === "number" && fr.frameId !== 0)
          .map((fr) => ({ targetId: extensionFrameTarget(targetId!, fr.frameId), url: fr.url }));
      } catch {
        return [];
      }
    }
    const targets = await invoke("list_targets", { types: ["iframe"] });
    if (!targets.ok) return [];
    const all = ((targets.data as Json)["targets"] as Array<{ targetId: string; url: string; parentFrameId?: string }>) ?? [];
    // list_targets covers every tab: keep only iframes whose parent chain reaches this tab's frame tree.
    const tree = await cdp("Page.getFrameTree", {}, targetId);
    if (!tree.ok) return [];
    const mine = new Set<string>();
    const walk = (node: Json | undefined) => {
      const id = (node?.["frame"] as Json | undefined)?.["id"];
      if (typeof id === "string") mine.add(id);
      for (const child of (node?.["childFrames"] as Json[] | undefined) ?? []) walk(child);
    };
    walk(((tree.data as Json)["result"] as Json | undefined)?.["frameTree"] as Json | undefined);
    const pool: Array<{ targetId: string; url: string }> = [];
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of all) {
        if (mine.has(t.targetId) || !t.parentFrameId || !mine.has(t.parentFrameId)) continue;
        mine.add(t.targetId);
        pool.push({ targetId: t.targetId, url: t.url });
        grew = true;
      }
    }
    return pool;
  }

  /** The top page's cross-origin iframes (first 8), each matched to a helper target when one is reachable. */
  async function crossFrames(
    targetId?: string,
  ): Promise<Array<{ i: number; src: string; title: string; target?: string }>> {
    const listed = await evalHelper({ kind: "bc", method: "frames" }, targetId);
    if (!listed.ok) return [];
    let frames: Array<{ i: number; src: string; title: string }>;
    try {
      frames = JSON.parse(valueOf(listed));
    } catch {
      return [];
    }
    if (frames.length === 0) return [];
    const first8 = frames.slice(0, 8);
    const pool = await frameTargetPool(targetId);
    if (pool.length === 0) return first8;
    // Pair each <iframe> with the frame it really hosts: post a random tag into every iframe, then ask
    // each frame which tag it got. URLs can't do this (a frame may have navigated to a sibling's src),
    // so an iframe whose frame doesn't report its tag stays unbound instead of guessed.
    const readTags = async (mine?: string[]) =>
      new Map(
        (
          await Promise.all(
            pool.map(async (t) => {
              const r = await evalHelper({ kind: "bc", method: "frameTag", ...(mine ? { args: [mine] } : {}) }, t.targetId, 2_000);
              return [r.ok ? valueOf(r) : "", t.targetId] as const;
            }),
          )
        ).filter(([tag]) => tag !== ""),
      );
    await readTags(); // loads the helper (and its message listener) in every candidate frame
    const tags = first8.map(() => randomUUID().replaceAll("-", ""));
    const sent = await evalHelper({ kind: "bc", method: "tagFrames", args: [tags, first8.map((f) => f.src)] }, targetId);
    if (!sent.ok) return first8;
    let owners = await readTags(tags);
    if (tags.some((t) => !owners.has(t))) {
      await new Promise((r) => setTimeout(r, 50));
      owners = await readTags(tags);
    }
    return first8.map((f, k) => {
      const target = owners.get(tags[k]!);
      return { ...f, ...(target ? { target } : {}) };
    });
  }

  /**
   * Number frames by identity: a frame target keeps its `f<n>` for the life of the tab and numbers
   * are never reused, so a saved `f<n>:e<m>` ref can't silently move to another frame after a reorder.
   */
  function frameNumbers(frames: Array<{ target?: string }>, targetId?: string): Map<string, number> {
    const ids = frameTargets.get(targetId ?? "") ?? [];
    const nums = new Map<string, number>();
    for (const f of frames) {
      if (!f.target) continue;
      let at = ids.indexOf(f.target);
      if (at === -1) at = ids.push(f.target) - 1;
      nums.set(f.target, at + 1);
    }
    frameTargets.set(targetId ?? "", ids);
    return nums;
  }

  /** Run a label lookup helper inside each reachable cross-origin iframe; first hit wins. */
  async function locateInFrames(
    method: "locate" | "locateFile",
    args: string[],
    targetId?: string,
  ): Promise<{ frame: number; ref: string; target: string } | undefined> {
    const frames = await crossFrames(targetId);
    if (frames.length === 0) return undefined;
    const nums = frameNumbers(frames, targetId);
    for (const f of frames) {
      if (!f.target) continue;
      const hit = await evalHelper({ kind: "bc", method, args }, f.target, 5_000);
      if (hit.ok && /^e\d+$/.test(valueOf(hit))) return { frame: nums.get(f.target)!, ref: valueOf(hit), target: f.target };
    }
    return undefined;
  }

  async function snapFrames(opts: Json, targetId?: string): Promise<string[]> {
    const frames = await crossFrames(targetId);
    if (frames.length === 0) return [];
    const out: string[] = [];
    const nums = frameNumbers(frames, targetId);
    for (const f of frames) {
      const n = f.target ? nums.get(f.target)! : undefined;
      const label = `${n === undefined ? `#${f.i}` : `f${n}`}${f.title ? ` "${f.title}"` : ""} ${hostOf(f.src)}`;
      if (!f.target) {
        out.push(`# iframe ${label}: not reachable; click by coordinates (click --xy) or see references/dom-and-input.md`);
        continue;
      }
      const inner = await evalHelper(
        { kind: "bc", method: "snapshot", args: [{ all: opts["all"] === true, find: opts["find"], ...(opts["full"] === true ? { full: true } : {}) }] },
        f.target,
        5_000,
      );
      const text = inner.ok ? valueOf(inner) : "";
      const lines = text.split("\n").filter((l) => /^[-+~] /.test(l));
      const diff = /^# snap diff .*$/m.exec(text)?.[0];
      out.push(`# iframe ${label}: ${lines.length} control(s)${diff ? ` changed; ${diff.slice(2)}` : ""}`);
      out.push(...lines.map((l) => l.replace(/\[e(\d+)\]/, `[f${n}:e$1]`)));
    }
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
      const fast = input["fast"] === true;
      for (const [ref, text] of Object.entries(raw as Json)) {
        if (typeof text !== "string") return `fill: the value for "${ref}" must be a string`;
        steps.push({ action: "type", input: { ref, text, ...(fast ? { fast: true } : {}) }, label: `type ${js(ref)}` });
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
        steps.push({
          action: "type",
          input: {
            ref: arg[0],
            text: arg[1],
            fast: arg[2] === "fast",
            keys: arg[2] === "keys" || arg[2] === true,
          },
          label: `type ${js(arg[0])}`,
        });
      } else if (verb === "select" && Array.isArray(arg) && typeof arg[0] === "string" && typeof arg[1] === "string") {
        steps.push({ action: "select", input: { ref: arg[0], option: arg[1] }, label: `select ${js(arg[0])}` });
      } else if (verb === "upload" && Array.isArray(arg) && typeof arg[0] === "string" && typeof arg[1] === "string") {
        steps.push({ action: "upload", input: { ref: arg[0], path: arg[1] }, label: `upload ${js(arg[0])}` });
      } else if (verb === "drag" && Array.isArray(arg) && typeof arg[0] === "string" && typeof arg[1] === "string") {
        steps.push({ action: "drag", input: { from: arg[0], to: arg[1], ...(typeof arg[2] === "string" ? { side: arg[2] } : {}) }, label: `drag ${js(arg[0])} -> ${js(arg[1])}` });
      } else if (verb === "wait" && typeof arg === "string") {
        steps.push({ action: "wait", input: { text: arg }, label: `wait ${js(arg)}` });
      } else if (verb === "wait" && typeof arg === "object" && arg !== null && !Array.isArray(arg)) {
        steps.push({ action: "wait", input: arg as Json, label: "wait" });
      } else {
        return `step ${i + 1}: use {"click":"<ref|label>"}, {"type":["<ref|label>","<text>"]}, {"select":["<ref|label>","<option>"]}, {"upload":["<ref|label>","<abs-path>"]}, {"drag":["<from>","<to>"]}, {"wait":"<text>"}, or {"key":"<name>"}`;
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
      const check = await evalHelper({ kind: "bc", method: "checkWait", args: [opts] }, targetId, 5_000);
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

  /** Perform HTML5 drag-and-drop (via Input.setInterceptDrags) or plain mouse drag. */
  async function runDrag(input: Json, targetId: string | undefined, quiet: boolean, healInBatch: boolean): Promise<InvokeResult> {
    const fromLoc = await locate(input["from"], "click", targetId, healInBatch);
    if (!fromLoc.ok) return fromLoc.res;
    const toLoc = await locate(input["to"], "click", targetId, healInBatch);
    if (!toLoc.ok) return toLoc.res;
    if (fromLoc.loc.kind !== "dom" || toLoc.loc.kind !== "dom") {
      return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: drag requires DOM refs or labels on the main page");
    }
    const before = quiet ? undefined : await evalHelper({ kind: "bc", method: "baseline" }, targetId);
    const side = input["side"] === "before" || input["side"] === "after" ? input["side"] : "";
    const infoRes = await evalHelper(
      { kind: "bc", method: "dragInfo", args: [fromLoc.loc.ref, toLoc.loc.ref, side] },
      targetId,
    );
    if (!infoRes.ok) return infoRes;
    const info = JSON.parse(valueOf(infoRes)) as {
      sx: number; sy: number; dx: number; dy: number; draggable: boolean; listMeta: Json | null;
    };

    let html5Dropped = false;
    let dragIntercepted: { data?: Json } | undefined;
    let mouseDown = false;
    if (info.draggable) {
      await cdp("Input.setInterceptDrags", { enabled: true }, targetId, 4_000);
    }
    try {
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.sx, y: info.sy }, targetId, INPUT_TIMEOUT_MS);
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: info.sx, y: info.sy, button: "left", buttons: 1, clickCount: 1 }, targetId, INPUT_TIMEOUT_MS);
      mouseDown = true;
      const mx = Math.round((info.sx + info.dx) / 2);
      const my = Math.round((info.sy + info.dy) / 2);
      if (info.draggable) {
        const waitDrag = invoke("wait_for_event", { method: "Input.dragIntercepted", timeoutMs: 1200, ...(targetId ? { targetId } : {}) });
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: mx, y: my, button: "left", buttons: 1 }, targetId, INPUT_TIMEOUT_MS);
        const ev = await waitDrag;
        if (ev.ok && (ev.data as Json)["found"] === true) {
          dragIntercepted = (((ev.data as Json)["event"] as Json)?.["params"] as { data?: Json }) ?? {};
          const dragData = dragIntercepted.data ?? { items: [], dragOperationsMask: 1 };
          await cdp("Input.dispatchDragEvent", { type: "dragEnter", x: info.dx, y: info.dy, data: dragData }, targetId, INPUT_TIMEOUT_MS);
          await cdp("Input.dispatchDragEvent", { type: "dragOver", x: info.dx, y: info.dy, data: dragData }, targetId, INPUT_TIMEOUT_MS);
          const dropRes = await cdp("Input.dispatchDragEvent", { type: "drop", x: info.dx, y: info.dy, data: dragData }, targetId, INPUT_TIMEOUT_MS);
          html5Dropped = dropRes.ok;
        } else {
          await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.dx, y: info.dy, button: "left", buttons: 1 }, targetId, INPUT_TIMEOUT_MS);
        }
      } else {
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: mx, y: my, button: "left", buttons: 1 }, targetId, INPUT_TIMEOUT_MS);
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.dx, y: info.dy, button: "left", buttons: 1 }, targetId, INPUT_TIMEOUT_MS);
      }
    } finally {
      if (info.draggable && dragIntercepted && !html5Dropped) {
        await cdp("Input.dispatchDragEvent", { type: "dragCancel", x: info.dx, y: info.dy, data: dragIntercepted.data ?? { items: [], dragOperationsMask: 1 } }, targetId, 2_000).catch(() => {});
      }
      if (mouseDown) {
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: info.dx, y: info.dy, button: "left", buttons: 0, clickCount: 1 }, targetId, 2_000).catch(() => {});
      }
      if (info.draggable) {
        await cdp("Input.setInterceptDrags", { enabled: false }, targetId, 2_000).catch(() => {});
      }
    }

    const posRes = info.listMeta
      ? await evalHelper({ kind: "bc", method: "listPosition", args: [info.listMeta] }, targetId)
      : undefined;
    const posNote = posRes?.ok && valueOf(posRes) ? ` (${valueOf(posRes)})` : "";
    const mode = info.draggable ? (html5Dropped ? "HTML5 drag and drop" : "mouse drag fallback") : "mouse drag";
    return withChanges(
      `drag ${fromLoc.loc.ref} -> ${toLoc.loc.ref}: delivered (${mode})${posNote}`,
      before?.ok ? valueOf(before) : undefined,
      quiet,
      targetId,
    );
  }

  async function act(
    action: string,
    input: Json,
    targetId: string | undefined,
    quiet: boolean,
    browseTab: number | undefined,
    healInBatch = false,
  ): Promise<InvokeResult> {
    switch (action) {
      case "click": {
        const natural = isNatural(input);
        if (Array.isArray(input["xy"])) {
          const [x, y] = (input["xy"] as unknown[]).map(Number);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: --xy takes x,y in CSS pixels");
          }
          if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: --xy needs a DevTools tab");
          const hit = await evalHelper(
            { steps: [{ kind: "bc", method: "baseline" }, { kind: "bc", method: "hit", args: [x!, y!] }], join: "\n" },
            targetId,
          );
          if (!hit.ok) return hit;
          const [before, what] = valueOf(hit).split("\n");
          const isCanvas = !quiet && /^hit: canvas/.test(what ?? "");
          const beforeHash = isCanvas ? await picture.canvasHash(targetId) : "";
          const clicked = await clickCoords(x!, y!, targetId, 1, { natural });
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
        const found = await locate(input["ref"], "click", targetId, healInBatch);
        if (!found.ok) return found.res;
        const useNatural = natural && found.loc.kind !== "frame";
        const at = await pointOf(found.loc, targetId, !quiet, useNatural);
        if (!at.ok) return at.res;
        if (found.loc.kind === "dom") await evalHelper({ kind: "bc", method: "armInputProbe" }, targetId, 2_000).catch(() => {});
        const clicked = await clickAt(at.pt, targetId, 1, useNatural, found.loc.kind === "dom" ? found.loc.ref : undefined);
        if (!clicked.ok) return inputFailed(clicked, `click ${nameOf(found.loc)}`);
        const probe = found.loc.kind === "dom" ? await readProbe(targetId) : undefined;
        const healPrefix = found.healedFrom ? `↻ ${found.healedFrom}->${nameOf(found.loc)} ` : "";
        const delivery = probe && probe["mousedown"] === 0 && probe["mouseup"] === 0
          ? "delivered_unverified (no mouse events reached page)"
          : "delivered";
        return withChanges(`${healPrefix}click ${nameOf(found.loc)} at ${at.pt.x},${at.pt.y}: ${delivery}`, at.pt.before, quiet, targetId);
      }

      case "type": {
        if (typeof input["text"] !== "string") {
          return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: text is required");
        }
        const text = input["text"];
        const mode: "human" | "fast" | "keys" =
          input["fast"] === true ? "fast" : input["keys"] === true ? "keys" : "human";
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
          const g = await evalHelper({ kind: "bc", method: "guardFocused" }, targetId);
          if (!g.ok) return g;
          const isPic = !quiet && (await picture.isPicture(targetId));
          const beforeHash = isPic ? await picture.canvasHash(targetId) : "";
          const before = quiet || isPic ? undefined : await evalHelper({ kind: "bc", method: "baseline" }, targetId);
          const sent = await dispatchText(text, mode, targetId, { focused: true, fieldKind: "none" });
          if (!sent.ok) return inputFailed(sent, "type --focused");
          const line = "type --focused: sent to whatever has focus (not read back)";
          if (isPic) return success(`${line}\n${await picture.pictureChanges(targetId, beforeHash)}`);
          return withChanges(line, before?.ok ? valueOf(before) : undefined, quiet, targetId);
        }
        const found = await locate(input["ref"], "type", targetId, healInBatch);
        if (!found.ok) return found.res;
        const loc = found.loc;
        let name = nameOf(loc);
        const healPrefix = found.healedFrom ? `↻ ${found.healedFrom}->${name} ` : "";
        const fieldTarget = loc.kind === "frame" ? (loc.target ?? frameTarget(loc.frame, targetId)) : targetId;

        if (loc.kind !== "ax") {
          const g = await evalHelper({ kind: "bc", method: "guard", args: [loc.ref] }, fieldTarget);
          if (!g.ok) return g;

          // Native date/time/month/week/color/range inputs set .value cleanly without segmented key quirks.
          const typedCheck = await evalHelper({ kind: "bc", method: "setTypedValue", args: [loc.ref, text] }, fieldTarget);
          if (!typedCheck.ok) return typedCheck;
          if (valueOf(typedCheck).startsWith('{"typed":true')) {
            const parsed = JSON.parse(valueOf(typedCheck)) as { type: string; value: string; matched: boolean };
            const before = quiet ? undefined : await evalHelper({ kind: "bc", method: "baseline" }, targetId);
            const note = parsed.matched ? "read back matches" : `normalized to "${parsed.value}"`;
            return withChanges(`${healPrefix}type ${name} (${parsed.type}): delivered (${note})`, before?.ok ? valueOf(before) : undefined, quiet, targetId);
          }

          // Spreadsheet / ARIA grid cell editing: double-click or Enter, fill editor, Enter to commit.
          const cellCheck = await evalHelper({ kind: "bc", method: "cellInfo", args: [loc.ref] }, fieldTarget);
          if (cellCheck.ok && valueOf(cellCheck).startsWith('{"cell":true')) {
            const cInfo = JSON.parse(valueOf(cellCheck)) as { before: string; editorRef: string | null };
            const before = quiet ? undefined : await evalHelper({ kind: "bc", method: "baseline" }, targetId);
            let editorRef = cInfo.editorRef;
            if (!editorRef) {
              const pt = await pointOf(loc, targetId, false);
              if (!pt.ok) return pt.res;
              await clickAt(pt.pt, targetId, 2);
              await sleep(150);
              const ed = await evalHelper({ kind: "bc", method: "cellEditor" }, fieldTarget);
              editorRef = ed.ok && /^e\d+$/.test(valueOf(ed)) ? valueOf(ed) : null;
              if (!editorRef) {
                await pressKey("Enter", targetId);
                await sleep(150);
                const ed2 = await evalHelper({ kind: "bc", method: "cellEditor" }, fieldTarget);
                editorRef = ed2.ok && /^e\d+$/.test(valueOf(ed2)) ? valueOf(ed2) : null;
              }
            }
            if (editorRef) {
              await evalHelper({ kind: "bc", method: "focusForType", args: [editorRef] }, fieldTarget);
            }
            const cellKind = mode === "human" ? await fieldKindOf(text, fieldTarget) : undefined;
            const sent = await dispatchText(text, mode, targetId, { fieldKind: cellKind });
            if (!sent.ok) return inputFailed(sent, `type ${name}`);
            await pressKey("Enter", targetId);
            await sleep(150);
            const afterRes = await evalHelper({ kind: "bc", method: "cellRead", args: [loc.ref, cInfo.before] }, fieldTarget);
            if (afterRes.ok) {
              const after = JSON.parse(valueOf(afterRes)) as { after: string; before: string; error: string };
              if (after.error) {
                await pressKey("Escape", targetId).catch(() => {});
                return failure("EXECUTION_FAILED", `REJECTED: grid cell ${name} rejected "${text}": ${after.error}`);
              }
              return withChanges(
                `${healPrefix}~ gridcell ${name}: "${after.after}" (was "${after.before}")`,
                before?.ok ? valueOf(before) : undefined,
                quiet,
                targetId,
              );
            }
          }
        }

        const at = await pointOf(loc, targetId, !quiet);
        if (!at.ok) return at.res;
        const clicked = await clickAt(at.pt, targetId);
        if (!clicked.ok) return inputFailed(clicked, `type ${name}`);
        let activeRef = loc.kind === "ax" ? "" : loc.ref;
        let retargetNote = "";
        if (loc.kind !== "ax") {
          const st = await evalHelper({ kind: "bc", method: "focusForType", args: [loc.ref] }, fieldTarget);
          if (!st.ok) return st;
          const stVal = valueOf(st);
          if (stVal.startsWith("retargeted:")) {
            activeRef = stVal.slice("retargeted:".length);
            name = loc.kind === "frame" ? `f${loc.frame}:${activeRef}` : activeRef;
            retargetNote = ` (retargeted -> ${name})`;
          } else if (stVal !== "focused") {
            return failure("EXECUTION_FAILED", `type ${name}: not_delivered (the click did not focus it; try snap again)`);
          }
        }
        const typeKind = mode === "human" ? await fieldKindOf(text, fieldTarget) : undefined;
        const sent = await dispatchText(text, mode, targetId, { fieldKind: typeKind });
        if (!sent.ok) return inputFailed(sent, `type ${name}`);
        if (loc.kind === "ax") {
          return withChanges(`${healPrefix}type ${name}: delivered_unverified (accessibility ref, not read back)`, at.pt.before, quiet, targetId);
        }
        const readback = await evalHelper({ kind: "bc", method: "value", args: [activeRef] }, fieldTarget);
        const got = readback.ok ? valueOf(readback) : "__unknown__";
        if (got !== "__secure__" && typeof input["ref"] === "string" && text.length >= 2) {
          const key = input["ref"].replace(/^@/, "").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase().slice(0, 20) || "q";
          const bag = recentTyped.get(targetId ?? "") ?? {};
          bag[key] = text;
          recentTyped.set(targetId ?? "", bag);
        }
        const msg = got === "__secure__"
          ? `${healPrefix}type ${name}${retargetNote}: delivered_unverified (secure field, not read back)`
          : got === text
            ? `${healPrefix}type ${name}${retargetNote}: delivered (read back matches)`
            : `${healPrefix}type ${name}${retargetNote}: delivered_unverified (read back "${got.slice(0, 80)}"). Do not retype blindly; snap first.`;
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
        const found = await locate(input["ref"], "select", targetId, healInBatch);
        if (!found.ok) return found.res;
        const loc = found.loc;
        if (loc.kind === "ax") {
          return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: select needs a DOM ref or label, not an accessibility ref");
        }
        const fieldTarget = loc.kind === "frame" ? (loc.target ?? frameTarget(loc.frame, targetId)) : targetId;
        if (loc.kind === "frame" && !fieldTarget) {
          return failure("EXECUTION_FAILED", `STALE_REF: iframe f${loc.frame} is not known for this tab. Run snap again.`);
        }
        const before = quiet ? undefined : await evalHelper({ kind: "bc", method: "baseline" }, targetId);
        const native = await evalHelper({ kind: "bc", method: "select", args: [loc.ref, option] }, fieldTarget);
        if (!native.ok) return native;
        if (valueOf(native) !== "__not_native__") {
          return withChanges(
            `select ${nameOf(loc)} -> "${valueOf(native)}": delivered`,
            before?.ok ? valueOf(before) : undefined,
            quiet,
            targetId,
          );
        }
        const natural = isNatural(input) && loc.kind !== "frame";
        const at = await pointOf(loc, targetId, false, natural);
        if (!at.ok) return at.res;
        const opened = await clickAt(at.pt, targetId, 1, natural, loc.kind === "dom" ? loc.ref : undefined);
        if (!opened.ok) return inputFailed(opened, `select ${nameOf(loc)}`);
        await evalHelper({ kind: "bc", method: "settle", args: [300, 80] }, fieldTarget, 4_000);
        const optRef = await evalHelper({ kind: "bc", method: "locateOption", args: [option] }, fieldTarget);
        if (!optRef.ok) return optRef;
        const optLoc: Exclude<Locator, { kind: "label" }> =
          loc.kind === "frame"
            ? { kind: "frame", frame: loc.frame, ref: valueOf(optRef), ...(loc.target ? { target: loc.target } : {}) }
            : { kind: "dom", ref: valueOf(optRef) };
        const optAt = await pointOf(optLoc, targetId, false, natural);
        if (!optAt.ok) return optAt.res;
        const picked = await clickAt(optAt.pt, targetId, 1, natural, optLoc.kind === "dom" ? optLoc.ref : undefined);
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
        let fileFrame = frame ? Number(frame[1]) : undefined;
        let fieldTarget = frame ? frameTarget(Number(frame[1]), targetId) : targetId;
        if (frame && !fieldTarget) {
          return failure("EXECUTION_FAILED", `STALE_REF: iframe f${frame[1]} is not known for this tab. Run snap again.`);
        }
        const before = quiet ? undefined : await evalHelper({ kind: "bc", method: "baseline" }, targetId);
        const located = await evalHelper(
          { kind: "bc", method: "locateFile", args: [frame ? frame[2]! : refInput] },
          fieldTarget,
        );
        let fileRef: string;
        if (located.ok) {
          fileRef = valueOf(located);
        } else {
          const hit = !frame && messageOf(located).includes("NO_MATCH:")
            ? await locateInFrames("locateFile", [refInput], targetId)
            : undefined;
          if (!hit) return located;
          fileRef = hit.ref;
          fileFrame = hit.frame;
          fieldTarget = hit.target;
        }
        const objRes = await resolveObject({ kind: "bc", method: "el", args: [fileRef] }, fieldTarget);
        if (!objRes.ok) return objRes.res;
        try {
          const set = await cdp("DOM.setFileInputFiles", { objectId: objRes.objectId, files: [filePath] }, fieldTarget);
          if (!set.ok) return set;
        } finally {
          await cdp("Runtime.releaseObject", { objectId: objRes.objectId }, fieldTarget).catch(() => {});
        }
        const label = fileFrame !== undefined ? `f${fileFrame}:${fileRef}` : fileRef;
        return withChanges(`upload ${label} <- ${filePath}: delivered`, before?.ok ? valueOf(before) : undefined, quiet, targetId);
      }

      case "drag": {
        if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: drag needs a DevTools tab");
        return runDrag(input, targetId, quiet, healInBatch);
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
        const before = quiet || isPic ? undefined : await evalHelper({ kind: "bc", method: "baseline" }, targetId);
        const res = await pressKey(keyName, targetId);
        if (!res.ok) return inputFailed(res, `key ${keyName}`);
        if (isPic) return success(`key ${keyName}: sent\n${await picture.pictureChanges(targetId, beforeHash)}`);
        return withChanges(`key ${keyName}: sent`, before?.ok ? valueOf(before) : undefined, quiet, targetId);
      }

      default:
        return failure("OPERATION_NOT_FOUND", `unknown page helper: ${action}`);
    }
  }

  /** Capture recent first-party 2xx GET JSON responses from buffered CDP Network events. */
  async function captureRecordedGets(targetId?: string): Promise<RecordedGet[]> {
    const hrefRes = await readProperty("origin", targetId, { isolated: true });
    const pageOrigin = hrefRes.ok ? valueOf(hrefRes) : "";
    const evRes = await invoke("read_events", { method: "Network.responseReceived", limit: 200, clear: false, ...(targetId ? { targetId } : {}) });
    if (!evRes.ok) return [];
    const events = ((evRes.data as Json)["events"] as Array<{ params?: Json }>) ?? [];
    const out: RecordedGet[] = [];
    for (const ev of events.slice(-30).reverse()) {
      const p = ev.params ?? {};
      const resp = (p["response"] as Json | undefined) ?? {};
      const status = Number(resp["status"] ?? 0);
      const url = String(resp["url"] ?? "");
      const mime = String(resp["mimeType"] ?? "").toLowerCase();
      const requestId = String(p["requestId"] ?? "");
      if (status < 200 || status >= 300 || !mime.includes("json") || !requestId) continue;
      let u: URL;
      try { u = new URL(url); } catch { continue; }
      if (pageOrigin && u.origin !== pageOrigin) continue;
      const bodyRes = await cdp("Network.getResponseBody", { requestId }, targetId, 3_000);
      if (!bodyRes.ok) continue;
      const rawBody = String((((bodyRes.data as Json)["result"] as Json | undefined)?.["body"]) ?? "");
      if (!rawBody || rawBody.length > 2_000_000) continue;
      try {
        out.push({ id: requestId, url, origin: u.origin, status, body: JSON.parse(rawBody), at: Date.now() });
      } catch { /* non-JSON */ }
      if (out.length >= 8) break;
    }
    return out;
  }

  async function handleNotes(input: Json, targetId?: string): Promise<InvokeResult> {
    const sub = String(input["sub"] ?? "get").toLowerCase();
    let site = typeof input["site"] === "string" && input["site"].trim() !== "" ? input["site"].trim() : "";
    if (sub === "list") return success(await listNotes(options.notesDir));
    if (!site) {
      const urlRes = await readProperty("host", targetId, { isolated: true });
      if (!urlRes.ok || !valueOf(urlRes)) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: pass a site host or select a tab");
      site = valueOf(urlRes);
    }
    try {
      if (sub === "get") {
        const found = await getNote(site, options.notesDir);
        if (!found) return success(`# no notes for ${site}`);
        return success(`# notes for ${site} (${found.trusted ? "trusted" : "quarantined"}):\n${found.text.trimEnd()}`);
      }
      if (sub === "set") return success(await setNote(site, String(input["text"] ?? ""), options.notesDir));
      if (sub === "append") return success(await appendNote(site, String(input["text"] ?? ""), options.notesDir));
      if (sub === "rm" || sub === "delete") return success(await removeNote(site, options.notesDir));
      if (sub === "approve") return success(await approveNote(site, options.notesDir));
      return failure("INPUT_VALIDATION_FAILED", `INPUT_INVALID: notes subcommand must be get, set, append, rm, approve, or list`);
    } catch (err) {
      return failure("EXECUTION_FAILED", (err as Error).message);
    }
  }

  async function handleFlow(input: Json, targetId?: string): Promise<InvokeResult> {
    const sub = String(input["sub"] ?? "list").toLowerCase();
    const site = typeof input["site"] === "string" && input["site"].trim() !== "" ? input["site"].trim() : undefined;
    try {
      if (sub === "list") return success(await listFlows(site, options.flowsDir));
      if (sub === "record") {
        const en = await cdp("Network.enable", {}, targetId);
        return en.ok ? success("flow recording enabled (Network.enable active on this tab; run actions then: flow save <name>)") : en;
      }
      const name = typeof input["name"] === "string" ? input["name"].trim() : "";
      if (!name) return failure("INPUT_VALIDATION_FAILED", `INPUT_INVALID: flow ${sub} requires a flow name`);
      if (sub === "show") {
        const flow = await loadFlowFile(name, site, options.flowsDir);
        return success(JSON.stringify(flow, null, 2));
      }
      if (sub === "rm" || sub === "delete") {
        return success(await removeFlowFile(name, site, options.flowsDir));
      }
      if (sub === "save") {
        const recorded = await captureRecordedGets(targetId);
        if (recorded.length === 0) {
          return failure("EXECUTION_FAILED", "NO_MATCH: no recent first-party 2xx GET JSON responses captured; run `flow record` before the search/lookup");
        }
        const chosen = recorded.sort((a, b) => JSON.stringify(b.body).length - JSON.stringify(a.body).length)[0]!;
        const givenParams = (input["params"] && typeof input["params"] === "object" ? input["params"] : {}) as Record<string, string>;
        const mergedParams = { ...(recentTyped.get(targetId ?? "") ?? {}), ...givenParams };
        const flow = buildFlow(name, chosen, mergedParams);
        const savedPath = await saveFlowFile(flow, options.flowsDir);
        return success(`saved flow ${flow.name} (${flow.site}) -> ${flow.urlTemplate}\nparams: ${flow.params.map((p) => p.name).join(", ") || "(none)"}\nfile: ${savedPath}`);
      }
      if (sub === "run") {
        const flow = await loadFlowFile(name, site, options.flowsDir);
        const givenParams = (input["params"] && typeof input["params"] === "object" ? input["params"] : {}) as Record<string, string>;
        const url = fillFlowUrl(flow, givenParams);
        const fetchExpr = `(async () => {
          const r = await fetch(${js(url)}, { method: "GET", credentials: "include", cache: "no-store", redirect: "manual" });
          if (r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400)) return JSON.stringify({ error: "REDIRECTED: flow redirected (possible sign-in wall)" });
          if (r.status === 401 || r.status === 403) return JSON.stringify({ error: "AUTH_EXPIRED: HTTP " + r.status });
          if (r.status === 429) return JSON.stringify({ error: "RATE_LIMITED: HTTP 429" });
          if (!r.ok) return JSON.stringify({ error: "HTTP_ERROR: HTTP " + r.status });
          const text = await r.text();
          if (text.length > 8_000_000) return JSON.stringify({ error: "ANSWER_TOO_LARGE: response exceeded 8 MB" });
          return JSON.stringify({ ok: true, body: JSON.parse(text) });
        })()`;
        const fetched = await invoke("evaluate", { expression: fetchExpr, isolated: true, ...(targetId ? { targetId } : {}), timeoutMs: 30_000 });
        if (!fetched.ok) return fetched;
        const parsed = JSON.parse(valueOf(fetched)) as { ok?: boolean; error?: string; body?: unknown };
        if (parsed.error) return failure("EXECUTION_FAILED", parsed.error);
        const shaped = shapeFlowResult(flow, parsed.body, {
          fields: Array.isArray(input["fields"]) ? (input["fields"] as unknown[]).map(String) : undefined,
          where: input["where"] && typeof input["where"] === "object" ? (input["where"] as Record<string, string>) : undefined,
          limit: Number(input["limit"]) > 0 ? Number(input["limit"]) : undefined,
        });
        if (shaped.drifted) {
          flow.verified = false;
          await saveFlowFile(flow, options.flowsDir).catch(() => {});
          return failure("EXECUTION_FAILED", shaped.text);
        }
        return success(shaped.text);
      }
      return failure("INPUT_VALIDATION_FAILED", `INPUT_INVALID: flow subcommand must be record, save, run, list, show, or rm`);
    } catch (err) {
      return failure("EXECUTION_FAILED", (err as Error).message);
    }
  }

  let runScript: ReturnType<typeof createScriptRunner>;

  /** Move the pointer onto a ref/label or `--xy` point without pressing a button. */
  async function runHover(
    input: Json,
    targetId: string | undefined,
    quiet: boolean,
    browseTab: number | undefined,
  ): Promise<InvokeResult> {
    if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: hover needs a DevTools tab");
    if (Array.isArray(input["xy"])) {
      const [x, y] = (input["xy"] as unknown[]).map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: --xy takes x,y in CSS pixels");
      }
      const hit = await evalHelper(
        { steps: [{ kind: "bc", method: "baseline" }, { kind: "bc", method: "hit", args: [x!, y!] }], join: "\n" },
        targetId,
      );
      if (!hit.ok) return hit;
      const [before, what] = valueOf(hit).split("\n");
      const moved = await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: x!, y: y! }, targetId, INPUT_TIMEOUT_MS);
      if (!moved.ok) return inputFailed(moved, `hover ${x},${y}`);
      return withChanges(`hover ${x},${y}: delivered. ${what ?? ""}`.trimEnd(), before, quiet, targetId);
    }
    const found = await locate(input["ref"], "click", targetId);
    if (!found.ok) return found.res;
    const at = await pointOf(found.loc, targetId, !quiet);
    if (!at.ok) return at.res;
    if (at.pt.hidden) {
      const foc = await cdp("Emulation.setFocusEmulationEnabled", { enabled: true }, targetId);
      if (!foc.ok) return foc;
    }
    const moved = await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.pt.x, y: at.pt.y }, targetId, INPUT_TIMEOUT_MS);
    if (!moved.ok) return inputFailed(moved, `hover ${nameOf(found.loc)}`);
    return withChanges(`hover ${nameOf(found.loc)} at ${at.pt.x},${at.pt.y}: delivered`, at.pt.before, quiet, targetId);
  }

  /** Accept or dismiss an open JavaScript alert/confirm/prompt/beforeunload dialog. */
  async function runDialog(input: Json, targetId: string | undefined, browseTab: number | undefined): Promise<InvokeResult> {
    const sub = String(input["sub"] ?? "").toLowerCase();
    if (sub !== "accept" && sub !== "dismiss") {
      return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: dialog subcommand must be accept or dismiss");
    }
    if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: dialog needs a DevTools tab");
    const text = input["text"];
    if (text !== undefined && typeof text !== "string") {
      return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: dialog prompt text must be a string");
    }
    const accept = sub === "accept";
    const params: Json = { accept };
    if (accept && typeof text === "string" && text !== "") params["promptText"] = text;
    // Page is enabled on attach (session.ts ensureSession); a second Page.enable would block behind an open dialog.
    const res = await cdp("Page.handleJavaScriptDialog", params, targetId, INPUT_TIMEOUT_MS);
    if (!res.ok) {
      if (/no dialog|not showing|not open/i.test(messageOf(res))) {
        return failure(
          "EXECUTION_FAILED",
          "NO_MATCH: no JavaScript dialog is open\nremedy: open the alert, confirm, or prompt first, then run dialog again",
        );
      }
      return res;
    }
    await releaseKeys(targetId);
    if (accept) return success(typeof params["promptText"] === "string" ? `dialog accept: accepted with prompt text ${js(params["promptText"])}` : "dialog accept: accepted");
    return success("dialog dismiss: dismissed");
  }

  const mediaByTarget = new Map<string, Map<string, string>>();
  const emulateQueue = new Map<string, Promise<unknown>>();

  /** Pin emulate to the active route's tab id and run one emulate per tab at a time, so the media cache stays right. */
  async function runEmulate(
    input: Json,
    targetId: string | undefined,
    browseTab: number | undefined,
    cdpTarget: string | undefined,
  ): Promise<InvokeResult> {
    if (browseTab !== undefined) return runEmulateNow(input, targetId, browseTab);
    const pinned = targetId ?? cdpTarget;
    const key = pinned ?? "";
    const run = (emulateQueue.get(key) ?? Promise.resolve()).then(() => runEmulateNow(input, pinned, browseTab));
    const tail = run.catch(() => undefined);
    emulateQueue.set(key, tail);
    try {
      return await run;
    } finally {
      if (emulateQueue.get(key) === tail) emulateQueue.delete(key);
    }
  }

  /** Device, media, network, and user-agent emulation. Reset uses Chrome's double-clear race fix. */
  async function runEmulateNow(input: Json, targetId: string | undefined, browseTab: number | undefined): Promise<InvokeResult> {
    if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: emulate needs a DevTools tab");
    const keys = ["viewport", "mobile", "colorScheme", "reducedMotion", "offline", "ua", "reset"] as const;

    let width = 0;
    let height = 0;
    let scale: number | undefined;
    const viewport = input["viewport"];
    if (viewport !== undefined) {
      const match = typeof viewport === "string" ? /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(viewport) : null;
      if (!match) {
        return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: viewport must be WxH or WxH@scale, e.g. 390x844 or 390x844@3");
      }
      width = Number(match[1]);
      height = Number(match[2]);
      scale = match[3] !== undefined ? Number(match[3]) : undefined;
      if (width <= 0 || height <= 0 || (scale !== undefined && !(scale > 0))) {
        return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: viewport width, height, and scale must be greater than zero");
      }
      // Chrome's Emulation.setDeviceMetricsOverride limit.
      if (width > MAX_VIEWPORT_DIM || height > MAX_VIEWPORT_DIM || (scale !== undefined && !Number.isFinite(scale))) {
        return failure("INPUT_VALIDATION_FAILED", `INPUT_INVALID: viewport width and height must be at most ${MAX_VIEWPORT_DIM}`);
      }
    }
    const mobile = input["mobile"];
    if (mobile !== undefined && typeof mobile !== "boolean") {
      return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: mobile takes true or false");
    }
    const colorScheme = input["colorScheme"];
    if (colorScheme !== undefined && colorScheme !== "dark" && colorScheme !== "light") {
      return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: colorScheme must be dark or light");
    }
    const reducedMotion = input["reducedMotion"];
    if (reducedMotion !== undefined && typeof reducedMotion !== "boolean") {
      return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: reducedMotion takes true or false");
    }
    const offline = input["offline"];
    if (offline !== undefined && typeof offline !== "boolean") {
      return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: offline takes true or false");
    }
    const ua = input["ua"];
    if (ua !== undefined && typeof ua !== "string") {
      return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: ua takes a user-agent string");
    }
    const reset = input["reset"];
    if (reset !== undefined && typeof reset !== "boolean") {
      return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: reset takes true or false");
    }
    const wantReset = reset === true;
    const optionsGiven = keys.filter((key) => key !== "reset" && input[key] !== undefined).length;
    if (optionsGiven === 0 && !wantReset) {
      return failure(
        "INPUT_VALIDATION_FAILED",
        "INPUT_INVALID: emulate needs at least one option: viewport, mobile, colorScheme, reducedMotion, offline, ua, or reset",
      );
    }

    const applied: string[] = [];
    if (wantReset) {
      const first = await cdp("Emulation.clearDeviceMetricsOverride", {}, targetId);
      if (!first.ok) return first;
      await pause(100);
      const second = await cdp("Emulation.clearDeviceMetricsOverride", {}, targetId);
      if (!second.ok) return second;
      const touchOff = await cdp("Emulation.setTouchEmulationEnabled", { enabled: false }, targetId);
      if (!touchOff.ok) return touchOff;
      const media = await cdp("Emulation.setEmulatedMedia", { features: [] }, targetId);
      if (!media.ok) return media;
      mediaByTarget.delete(targetId ?? "");
      const online = await cdp("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      }, targetId);
      if (!online.ok) return online;
      const uaOff = await cdp("Emulation.setUserAgentOverride", { userAgent: "" }, targetId);
      if (!uaOff.ok) return uaOff;
      applied.push("reset");
    }
    if (viewport !== undefined) {
      const metrics: Json = { width, height, deviceScaleFactor: scale ?? 0, mobile: mobile === true };
      const set = await cdp("Emulation.setDeviceMetricsOverride", metrics, targetId);
      if (!set.ok) return set;
      applied.push(`viewport ${width}x${height}${scale !== undefined ? `@${scale}` : ""}`);
    }
    if (mobile === true) {
      const touch = await cdp("Emulation.setTouchEmulationEnabled", { enabled: true }, targetId);
      if (!touch.ok) return touch;
      applied.push("mobile");
    }
    if (colorScheme !== undefined || reducedMotion !== undefined) {
      // setEmulatedMedia replaces every feature, so merge with what this tab already has.
      const key = targetId ?? "";
      const kept = new Map(mediaByTarget.get(key) ?? []);
      if (colorScheme !== undefined) kept.set("prefers-color-scheme", colorScheme);
      if (reducedMotion !== undefined) kept.set("prefers-reduced-motion", reducedMotion === true ? "reduce" : "no-preference");
      const features: Json[] = [...kept].map(([name, value]) => ({ name, value }));
      const media = await cdp("Emulation.setEmulatedMedia", { features }, targetId);
      if (!media.ok) return media;
      mediaByTarget.set(key, kept);
      if (colorScheme !== undefined) applied.push(`color-scheme ${colorScheme}`);
      if (reducedMotion !== undefined) applied.push(`reduced-motion ${reducedMotion === true ? "reduce" : "no-preference"}`);
    }
    if (offline !== undefined) {
      const net = await cdp("Network.emulateNetworkConditions", {
        offline,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      }, targetId);
      if (!net.ok) return net;
      applied.push(offline ? "offline" : "online");
    }
    if (ua !== undefined) {
      const override = await cdp("Emulation.setUserAgentOverride", { userAgent: ua }, targetId);
      if (!override.ok) return override;
      applied.push("ua");
    }
    return success(`emulate: ${applied.join(", ")}`);
  }

  async function maybeSaveOut(res: InvokeResult, input: Json): Promise<InvokeResult> {
    const outPath = typeof input["out"] === "string" && input["out"].trim() !== "" ? input["out"].trim() : "";
    if (!outPath || !res.ok) return res;
    try {
      const digest = await writeOutputFile(outPath, valueOf(res));
      const preview = valueOf(res).split("\n").slice(0, 12).join("\n");
      const challenge = (res.data as Json | undefined)?.["challenge"];
      const value = `${digest}\n${preview}`;
      return challenge !== undefined ? { ok: true, data: { value, challenge } } : success(value);
    } catch (err) {
      return failure("EXECUTION_FAILED", `ARTIFACT_WRITE_FAILED: ${(err as Error).message}`);
    }
  }

  async function runHandoff(
    input: Json,
    targetId: string | undefined,
    resolved: ResolvedTarget,
  ): Promise<InvokeResult> {
    const extTarget = extensionTabOf(targetId) !== undefined ? targetId : resolved.extensionTarget;
    const extTabId = extensionTabOf(extTarget);
    const extOnly = resolved.extensionOnly ?? isExtensionOnlyOrder();
    if (!extTarget || extTabId === undefined) {
      if (targetId === undefined && extOnly && resolved.activeBackend !== "cdp") {
        const cause = resolved.extensionAvailable === false ? "extension is not connected" : "no extension tab is selected";
        return failure("EXECUTION_FAILED", extensionOnlyMessage(cause));
      }
      return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: handoff requires an extension tab");
    }

    const message =
      typeof input["message"] === "string" && input["message"].trim() !== ""
        ? input["message"].trim()
        : "Complete this step in the browser, then click Continue.";
    const timeoutMs =
      typeof input["timeoutMs"] === "number" && Number.isFinite(input["timeoutMs"]) && input["timeoutMs"] > 0
        ? input["timeoutMs"]
        : typeof input["timeout"] === "number" && Number.isFinite(input["timeout"]) && input["timeout"] > 0
          ? Math.round(input["timeout"] * 1000)
          : DEFAULT_HANDOFF_TIMEOUT_MS;

    const extRequest =
      options.extensionRequest ??
      ((globalThis as Record<symbol, unknown>)[EXTENSION_REQUEST_SYMBOL] as ExtensionRequestFn | undefined);

    const callExtensionHandoff = async (op: "handoff_start" | "handoff_clear", params: Json): Promise<InvokeResult> => {
      if (!extRequest) {
        const msg = extOnly
          ? extensionOnlyMessage("handoff requires the browser-control extension relay")
          : "BACKEND_UNAVAILABLE: handoff requires the browser-control extension relay";
        return failure("EXECUTION_FAILED", msg);
      }
      try {
        const result = await extRequest(op, { targetId: extTarget, ...params });
        return { ok: true, data: { result } };
      } catch (err) {
        if (isBackendUnavailable(err) && extOnly) {
          return failure("EXECUTION_FAILED", extensionOnlyMessage(err));
        }
        return failure("EXECUTION_FAILED", (err as Error).message);
      }
    };

    if (activeHandoffs.has(extTabId)) {
      return failure(
        "EXECUTION_FAILED",
        `HANDOFF_IN_PROGRESS: tab ${extTarget} already has an active handoff`,
      );
    }

    const handoffId = randomUUID();
    activeHandoffs.set(extTabId, handoffId);

    try {
      // Drop any stale handoff completion events for this tab before showing the overlay.
      await invoke("read_events", { method: "bc.handoffDone", targetId: extTarget, clear: true }).catch(() => {});

      const started = await callExtensionHandoff("handoff_start", { message, handoffId });
      if (!started.ok) return started;

      const deadline = Date.now() + timeoutMs;
      while (true) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const waited = await invoke("wait_for_event", {
          method: "bc.handoffDone",
          targetId: extTarget,
          match: { handoffId },
          timeoutMs: remainingMs,
          consumeBuffer: true,
        });
        if (!waited.ok) {
          await callExtensionHandoff("handoff_clear", { handoffId }).catch(() => {});
          return waited;
        }

        const data = waited.data as Json | undefined;
        if (data?.["found"] === true) {
          const eventParams = (data["event"] as Json | undefined)?.["params"] as Json | undefined;
          if (eventParams?.["handoffId"] === handoffId) {
            return success("handoff: done");
          }
          if (Date.now() >= deadline) break;
          continue;
        }
        break;
      }

      await callExtensionHandoff("handoff_clear", { handoffId }).catch(() => {});
      const secs = Math.max(1, Math.round(timeoutMs / 1000));
      return failure("EXECUTION_FAILED", `HANDOFF_TIMEOUT: handoff timed out after ${secs}s`);
    } finally {
      if (activeHandoffs.get(extTabId) === handoffId) {
        activeHandoffs.delete(extTabId);
      }
    }
  }

  const challengeBackendOf = (tid: string | undefined): "extension" | "cdp" =>
    extensionTabOf(tid) !== undefined ? "extension" : "cdp";

  function challengeDataOf(
    detection: ChallengeDetection,
    status: "interactive" | "non-interactive-timeout",
    targetUrl: string,
    backend: "extension" | "cdp",
  ) {
    return {
      kind: detection.kind,
      vendor: detection.vendor,
      status,
      url: targetUrl,
      message: formatChallengeOutput(detection, targetUrl, { backend, untrustedBoundary: true }),
    };
  }

  async function raceDeadline<T>(promise: Promise<T>, deadline: number | undefined, onTimeout: T): Promise<T> {
    if (deadline === undefined) return promise;
    const rem = deadline - Date.now();
    if (rem <= 0) return onTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.catch(() => onTimeout),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(onTimeout), rem);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function readChallengeProbeCdp(
    targetId: string | undefined,
    timeoutMs = 4_000,
    deadline?: number,
  ): Promise<ProbeReadResult> {
    const budget = deadline !== undefined ? Math.min(timeoutMs, deadline - Date.now()) : timeoutMs;
    if (budget <= 0) return { kind: "error" };
    const res = await raceDeadline(
      invoke("evaluate", {
        expression: CHALLENGE_PROBE_EXPR,
        isolated: true,
        ...(targetId ? { targetId } : {}),
        timeoutMs: Math.max(1, Math.floor(budget)),
      }),
      deadline,
      failure("EXECUTION_FAILED", "CHALLENGE_PROBE_TIMEOUT"),
    );
    if (!res.ok) return { kind: "error" };
    const raw = valueOf(res);
    if (!raw || !raw.startsWith("{")) return { kind: "skip" };
    try {
      const parsed = JSON.parse(raw) as { skip?: boolean; url?: string; probe?: ChallengeProbe };
      if (parsed.skip) return { kind: "skip", url: typeof parsed.url === "string" ? parsed.url : undefined };
      if (parsed.probe && typeof parsed.probe === "object") return { kind: "probe", probe: parsed.probe };
      return { kind: "skip" };
    } catch {
      return { kind: "skip" };
    }
  }

  /**
   * Read a lightweight bot-challenge probe for the current page.
   * - On extension tabs: stays on the silent `evalHelper` (`bc_call`) tier so normal pages never attach `chrome.debugger`.
   * - During a non-interactive interstitial wait, if a throttled/collapsed background extension tab stops answering
   *   `bc_call`, falls back to `evaluate` (which enables focus emulation so the interstitial's timers can finish).
   * - On CDP tabs: runs a single self-contained `evaluate` expression that exits early on normal long pages.
   */
  async function readChallengeProbe(
    targetId: string | undefined,
    opts: { wallHint?: string; reprobe?: boolean; deadline?: number } = {},
  ): Promise<ProbeReadResult> {
    const remaining = (cap: number): number =>
      opts.deadline !== undefined ? Math.min(cap, opts.deadline - Date.now()) : cap;

    if (extensionTabOf(targetId) !== undefined) {
      const baseTimeout = opts.reprobe ? 1_500 : 4_000;
      const quickBudget = remaining(baseTimeout);
      if (quickBudget <= 0) return { kind: "error" };
      const quick = await raceDeadline(
        evalHelper(
          {
            steps: [
              { kind: "href" },
              { kind: "title" },
              { kind: "bc", method: "text", args: [{ all: true, max: 3000 }] },
              { kind: "bc", method: "query", args: [{ selector: FAST_VENDOR_CSS, fields: { id: "@id" }, limit: 1, all: true }] },
            ],
            join: CHALLENGE_PROBE_SEP,
          },
          targetId,
          Math.max(1, Math.floor(quickBudget)),
        ),
        opts.deadline,
        failure("EXECUTION_FAILED", "CHALLENGE_PROBE_TIMEOUT"),
      );
      if (!quick.ok) {
        return opts.reprobe ? readChallengeProbeCdp(targetId, baseTimeout, opts.deadline) : { kind: "error" };
      }
      const rawQuick = valueOf(quick);
      if (!rawQuick.includes(CHALLENGE_PROBE_SEP)) return { kind: "skip" };
      const [url = "", title = "", rawText = "", rawVendor = ""] = rawQuick.split(CHALLENGE_PROBE_SEP);
      const { text, textLength } = parseBcTextForProbe(rawText);
      const hasVendor = parseBcQueryRows(rawVendor).length > 0;
      const suspicious =
        opts.wallHint === "captcha" ||
        opts.wallHint === "rate-limit" ||
        textLength < SHORT_PAGE_CHARS ||
        hasVendor ||
        isSuspiciousTitle(title) ||
        isSuspiciousUrl(url);
      if (!suspicious) return { kind: "skip", url };

      const markersBudget = remaining(baseTimeout);
      if (markersBudget <= 0) return { kind: "error" };
      const markers = await raceDeadline(
        evalHelper(
          {
            steps: [
              { kind: "bc", method: "query", args: [{ selector: "iframe[src]", fields: { src: "@src" }, limit: 20, all: true }] },
              { kind: "bc", method: "query", args: [{ selector: "script[src]", fields: { src: "@src" }, limit: 50, all: true }] },
              {
                kind: "bc",
                method: "query",
                args: [{ selector: PROBE_SELECTORS_CSS, fields: { id: "@id", cls: "@class", src: "@src", title: "@title" }, limit: 20, all: true }],
              },
              {
                kind: "bc",
                method: "query",
                args: [{ selector: PROBE_SELECTORS_CSS, fields: { id: "@id", cls: "@class", src: "@src", title: "@title" }, limit: 20, all: false }],
              },
              { kind: "bc", method: "query", args: [{ selector: "awswaf-captcha", fields: { id: "@id" }, limit: 1, all: true }] },
            ],
            join: CHALLENGE_PROBE_SEP,
          },
          targetId,
          Math.max(1, Math.floor(markersBudget)),
        ),
        opts.deadline,
        failure("EXECUTION_FAILED", "CHALLENGE_PROBE_TIMEOUT"),
      );
      const [rawFrames = "", rawScripts = "", rawSel = "", rawVis = "", rawAws = ""] = markers.ok
        ? valueOf(markers).split(CHALLENGE_PROBE_SEP)
        : [];
      const frameUrls = parseBcQueryRows(rawFrames).map((r) => r["src"]).filter((s): s is string => Boolean(s));
      const scriptSrcs = parseBcQueryRows(rawScripts).map((r) => r["src"]).filter((s): s is string => Boolean(s));
      const hasAws = parseBcQueryRows(rawAws).length > 0;
      const selectors = matchProbeSelectorsFromRows(parseBcQueryRows(rawSel), hasAws);
      const visibleSelectors = matchProbeSelectorsFromRows(parseBcQueryRows(rawVis), false);
      const probe: ChallengeProbe = {
        url,
        title: title.trim(),
        text,
        textLength,
        frameUrls,
        scriptSrcs,
        selectors,
        visibleSelectors,
      };
      // Check HTTP navigation status before accepting a non-block match on a denial-titled page
      // (e.g. a long "403 Access Denied" page with a CAPTCHA) or a short AWS WAF SDK page.
      const preliminary = classifyChallenge(probe);
      const needsStatus =
        preliminary?.kind !== "block" &&
        (isDenialTitle(title) || (textLength < SHORT_PAGE_CHARS && scriptSrcs.some((s) => /\.awswaf\.com\//.test(s))));
      if (needsStatus) {
        const statusBudget = remaining(2_000);
        if (statusBudget > 0) {
          const statusRes = await raceDeadline(
            invoke("evaluate", {
              expression: '(() => { const n = performance.getEntriesByType && performance.getEntriesByType("navigation")[0]; return n && typeof n.responseStatus === "number" ? n.responseStatus : 0; })()',
              isolated: true,
              ...(targetId ? { targetId } : {}),
              timeoutMs: Math.max(1, Math.floor(statusBudget)),
            }),
            opts.deadline,
            failure("EXECUTION_FAILED", "CHALLENGE_PROBE_TIMEOUT"),
          );
          const statusNum = statusRes.ok ? Number((statusRes.data as Json)["value"]) : 0;
          if (Number.isInteger(statusNum) && statusNum > 0) {
            return { kind: "probe", probe: { ...probe, status: statusNum } };
          }
        }
      }
      return { kind: "probe", probe };
    }

    return readChallengeProbeCdp(targetId, opts.reprobe ? 1_500 : 4_000, opts.deadline);
  }

  /**
   * Run the challenge classifier; auto-wait boundedly (~8 s) on `non-interactive` interstitials,
   * and immediately report `interactive` or `block` without retrying.
   */
  async function checkChallenge(
    targetId: string | undefined,
    opts: { wallHint?: string; knownUrl?: string } = {},
  ): Promise<ChallengeCheckResult> {
    const first = await readChallengeProbe(targetId, { wallHint: opts.wallHint });
    if (first.kind !== "probe") {
      return { status: "clear", waited: false, url: first.kind === "skip" ? first.url : opts.knownUrl };
    }
    let lastProbe = first.probe;
    let detection = classifyChallenge(lastProbe);
    if (!detection) return { status: "clear", waited: false, url: lastProbe.url };
    if (detection.kind === "block") {
      return { status: "block", detection, url: lastProbe.url || opts.knownUrl || "", waited: false };
    }
    if (detection.kind === "interactive") {
      return { status: "interactive", detection, url: lastProbe.url || opts.knownUrl || "", waited: false };
    }

    const waitMaxMs = options.challengeWaitMaxMs ?? CHALLENGE_WAIT_MAX_MS;
    const started = Date.now();
    const deadline = started + waitMaxMs;
    let waitedMs = 0;
    const remainingBudget = () => Math.max(0, Math.min(deadline - Date.now(), waitMaxMs - waitedMs));
    while (remainingBudget() > 0) {
      // Keep part of the budget for one last probe so a page that clears near the deadline is seen.
      const rem = remainingBudget();
      const reserve = Math.min(CHALLENGE_PROBE_RESERVE_MS, Math.floor(rem / 2));
      const last = rem - reserve <= CHALLENGE_POLL_MS;
      const step = Math.min(CHALLENGE_POLL_MS, rem - reserve);
      if (step <= 0) break;
      await pause(step);
      waitedMs += step;
      if (deadline - Date.now() <= 0) break;
      const next = await readChallengeProbe(targetId, { reprobe: true, deadline });
      if (next.kind === "error") continue;
      if (next.kind === "skip") {
        return { status: "clear", waited: true, url: next.url || opts.knownUrl };
      }
      lastProbe = next.probe;
      const nextDetection = classifyChallenge(lastProbe);
      if (!nextDetection) {
        return { status: "clear", waited: true, url: lastProbe.url };
      }
      detection = nextDetection;
      if (detection.kind === "block") {
        return { status: "block", detection, url: lastProbe.url || opts.knownUrl || "", waited: true };
      }
      if (detection.kind === "interactive") {
        return { status: "interactive", detection, url: lastProbe.url || opts.knownUrl || "", waited: true };
      }
      if (last) break;
    }

    return {
      status: "non-interactive-timeout",
      detection,
      url: lastProbe.url || opts.knownUrl || "",
      waited: true,
    };
  }

  async function handlePage(action: string, input: Json, rawTargetId?: string): Promise<InvokeResult> {
    const resolved = await resolveTargetBackend(rawTargetId);
    const { browseTab, extensionTarget, cdpTarget } = resolved;
    if (rawTargetId === undefined) implicitCdpTarget = cdpTarget;
    const targetId = rawTargetId ?? extensionTarget;
    const quiet = input["quiet"] === true;

    switch (action) {
      case "snap": {
        const all = input["all"] === true;
        const full = input["full"] === true;
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
          return maybeSaveOut(res, input);
        }
        if (input["ax"] === true) return maybeSaveOut(await snapAx(find, targetId), input);
        const opts: Json = {
          all,
          ...(full ? { full: true } : {}),
          ...(find ? { find } : {}),
          ...(within ? { within } : {}),
        };
        const res = await evalHelper({ kind: "bc", method: "snapshot", args: [opts] }, targetId);
        if (!res.ok) return res;
        let out = valueOf(res);
        let challengePrefix = "";
        let challengeMeta: ReturnType<typeof challengeDataOf> | undefined;
        if (!find && !within && input["_skipChallengeCheck"] !== true && isSuspiciousSnapshot(out)) {
          const wallHint = out.includes("# WALL: captcha") ? "captcha" : out.includes("# WALL: rate-limit") ? "rate-limit" : undefined;
          const snapUrl = /^# .* \| (https?:\/\/[^\s]+)/.exec(out)?.[1];
          const challengeBackend = challengeBackendOf(targetId);
          const challenge = await checkChallenge(targetId, { wallHint, knownUrl: snapUrl });
          if (challenge.status === "block") {
            return failure(
              "EXECUTION_FAILED",
              formatChallengeOutput(challenge.detection, challenge.url || snapUrl || "", {
                backend: challengeBackend,
                untrustedBoundary: true,
              }),
            );
          }
          if (challenge.status === "interactive" || challenge.status === "non-interactive-timeout") {
            const targetUrl = challenge.url || snapUrl || "";
            challengePrefix = formatChallengeOutput(challenge.detection, targetUrl, {
              backend: challengeBackend,
              untrustedBoundary: true,
            });
            challengeMeta = challengeDataOf(challenge.detection, challenge.status, targetUrl, challengeBackend);
          } else if (challenge.waited) {
            const refreshed = await evalHelper({ kind: "bc", method: "snapshot", args: [opts] }, targetId);
            if (refreshed.ok) out = valueOf(refreshed);
          }
        }
        // Attach per-site agent notes if present for the page's origin.
        const urlMatch = /^# .* \| (https?:\/\/[^\s]+)/.exec(out);
        if (urlMatch?.[1]) {
          const header = await noteHeaderForUrl(urlMatch[1], daemonSessionId, options.notesDir);
          if (header) out = `${header}\n${out}`;
        }
        if (!within && out.includes("cross-origin iframe(s)")) {
          const frames = await snapFrames(opts, targetId);
          if (frames.length) out += `\n${frames.join("\n")}`;
        }
        if (!challengePrefix && !find && !within && !out.includes("\n- ") && !out.includes("# WALL:") && !out.includes("# snap diff")) {
          const ax = await snapAx(undefined, targetId);
          if (ax.ok && valueOf(ax).includes("\n- ")) out += `\n# No controls found in the DOM.\n${valueOf(ax)}`;
        }
        if (challengePrefix) out = `${challengePrefix}\n${out}`;
        return maybeSaveOut(challengeMeta ? { ok: true, data: { value: out, challenge: challengeMeta } } : success(out), input);
      }

      case "form": {
        if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: form needs a DevTools tab");
        const opts: Json = typeof input["within"] === "string" && input["within"] !== "" ? { within: input["within"] } : {};
        return maybeSaveOut(await evalHelper({ kind: "bc", method: "form", args: [opts] }, targetId), input);
      }

      case "query": {
        if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: query needs a DevTools tab");
        const opts: Json = {
          selector: input["selector"],
          ...(input["fields"] ? { fields: input["fields"] } : {}),
          ...(Number(input["limit"]) > 0 ? { limit: Number(input["limit"]) } : {}),
          ...(input["all"] === true ? { all: true } : {}),
        };
        return maybeSaveOut(await evalHelper({ kind: "bc", method: "query", args: [opts] }, targetId), input);
      }

      case "read-urls": {
        if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: read-urls needs a DevTools tab");
        const opts: Json = {
          urls: input["urls"],
          ...(Number(input["concurrency"]) > 0 ? { concurrency: Number(input["concurrency"]) } : {}),
          ...(Number(input["timeoutMs"]) > 0 ? { timeoutMs: Number(input["timeoutMs"]) } : {}),
          ...(Number(input["maxChars"]) > 0 ? { maxChars: Number(input["maxChars"]) } : {}),
        };
        return maybeSaveOut(await evalHelper({ kind: "bc", method: "readUrls", args: [opts] }, targetId, 75_000), input);
      }

      case "click":
      case "type":
      case "select":
      case "upload":
      case "drag":
      case "wait":
      case "key":
        return act(action, input, targetId, quiet, browseTab);

      case "hover":
        return runHover(input, targetId, quiet, browseTab);

      case "dialog":
        return runDialog(input, targetId, browseTab);

      case "emulate":
        return runEmulate(input, targetId, browseTab, cdpTarget);

      case "handoff":
        return runHandoff(input, targetId, resolved);

      case "do": {
        const steps = parseSteps(input);
        if (typeof steps === "string") return failure("INPUT_VALIDATION_FAILED", `INPUT_INVALID: ${steps}`);
        if (steps.length === 0) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: no steps given");
        const start = browseTab === undefined
          ? await evalHelper({ kind: "bc", method: "baseline" }, targetId)
          : await readProperty("href", targetId);
        if (browseTab === undefined && start && !start.ok) return start;
        const startUrl = start?.ok ? valueOf(start) : "";
        let prevUrl = startUrl;
        const out: string[] = [];
        let stopped: string | undefined;
        let challengeReport: string | undefined;
        const challengeBackend = challengeBackendOf(targetId);
        for (const [i, step] of steps.entries()) {
          const res = await act(step.action, { ...step.input, quiet: true }, targetId, true, browseTab, true);
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
            !valueOf(res).includes("secure field") &&
            !valueOf(res).startsWith("~ gridcell")
          ) {
            stopped = `step ${i + 1} was not read back as typed`;
            break;
          }
          const isLastStep = i === steps.length - 1;
          if (isLastStep && browseTab !== undefined) continue;
          const state = await evalHelper(
            {
              steps: [
                { kind: "bc", method: "settle", discard: true },
                { kind: "href" },
                { kind: "bc", method: "wall", fallback: "" },
                VENDOR_MARKER_STEP,
              ],
              join: "\n",
            },
            targetId,
            8_000,
          );
          let url = "";
          let wall = "";
          let rest: string[] = [];
          if (state.ok) [url = "", wall = "", ...rest] = valueOf(state).split("\n");
          else {
            await waitParsed(targetId);
            const again = await evalHelper(
              { steps: [{ kind: "href" }, { kind: "bc", method: "wall", fallback: "" }, VENDOR_MARKER_STEP], join: "\n" },
              targetId,
              8_000,
            );
            if (again.ok) [url = "", wall = "", ...rest] = valueOf(again).split("\n");
          }
          const markerRows = rest.join("\n");
          const navigated = Boolean(url && prevUrl && stripHash(url) !== stripHash(prevUrl));
          if (navigated) resetMotion(targetId);
          const challengeWall = wall === "captcha" || wall === "rate-limit" || /^# [1-9]\d* row/.test(markerRows);
          if (browseTab === undefined && (navigated || challengeWall)) {
            const challenge = await checkChallenge(targetId, { wallHint: wall, knownUrl: url });
            if (challenge.status === "block") {
              challengeReport = formatChallengeOutput(challenge.detection, challenge.url || url, {
                backend: challengeBackend,
                untrustedBoundary: true,
              });
              stopped = `blocked by ${challenge.detection.vendor} after step ${i + 1}`;
              break;
            }
            if (challenge.status === "interactive" || challenge.status === "non-interactive-timeout") {
              challengeReport = formatChallengeOutput(challenge.detection, challenge.url || url, {
                backend: challengeBackend,
                untrustedBoundary: true,
              });
              stopped = `${challenge.detection.vendor} challenge after step ${i + 1}`;
              break;
            }
            if (challenge.waited) {
              const afterWait = await evalHelper(
                { steps: [{ kind: "href" }, { kind: "bc", method: "wall", fallback: "" }], join: "\n" },
                targetId,
                4_000,
              );
              if (afterWait.ok) [url = "", wall = ""] = valueOf(afterWait).split("\n");
              else if (challenge.url) url = challenge.url;
            }
          }
          if (url) prevUrl = url;
          if (!isLastStep) {
            if (wall) stopped = `the page is a ${wall} wall after step ${i + 1}`;
            else if (url && startUrl && hostOf(url) !== hostOf(startUrl)) {
              stopped = `step ${i + 1} left ${hostOf(startUrl)} for ${hostOf(url)}`;
            }
            if (stopped) break;
          }
        }
        if (stopped) out.push(`# STOPPED: ${stopped}. ${steps.length - out.length} step(s) not run.`);
        if (!quiet) {
          if (browseTab !== undefined) {
            const delta = await callBrowse("snapshot", { tab: browseTab, interactive: true, delta: true });
            if (delta.ok) {
              cacheBrowseSnapshot(browseTab, valueOf(delta));
              out.push(valueOf(delta));
            }
          } else if (!challengeReport) {
            out.push(await changes(startUrl, targetId));
          }
        }
        if (challengeReport) out.unshift(challengeReport);
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
        const where = found.loc.kind === "frame" ? (found.loc.target ?? frameTarget(found.loc.frame, targetId)) : targetId;
        if (found.loc.kind === "frame" && !where) {
          return failure("EXECUTION_FAILED", `STALE_REF: iframe f${found.loc.frame} is not known for this tab. Run snap again.`);
        }
        return evalHelper({ kind: "bc", method: "value", args: [found.loc.ref] }, where);
      }

      case "text": {
        if (input["scroll"] === true) {
          if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: text --scroll needs a DevTools tab");
          const opts: Json = {
            ...(typeof input["within"] === "string" && input["within"] !== "" ? { within: input["within"] } : {}),
            ...(typeof input["filter"] === "string" && input["filter"] !== "" ? { match: input["filter"] } : {}),
            ...(Number(input["limit"]) > 0 ? { limit: Number(input["limit"]) } : {}),
            ...(Number(input["timeoutMs"]) > 0 ? { timeoutMs: Number(input["timeoutMs"]) } : {}),
          };
          return maybeSaveOut(await evalHelper({ kind: "bc", method: "scrollRead", args: [opts] }, targetId, 65_000), input);
        }
        const opts: Json = {};
        if (typeof input["within"] === "string" && input["within"] !== "") opts["within"] = input["within"];
        if (input["all"] === true) opts["all"] = true;
        if (Number(input["max"]) > 0) opts["max"] = Number(input["max"]);
        return maybeSaveOut(await evalHelper({ kind: "bc", method: "text", args: [opts] }, targetId), input);
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
        const hasRef = input["ref"] !== undefined && input["ref"] !== "";
        let box: InvokeResult;
        if (hasRef) {
          const found = await locate(input["ref"], "read", targetId);
          if (!found.ok) return found.res;
          if (found.loc.kind !== "dom") return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: shot --ref needs a page ref like e12");
          box = await evalHelper({ kind: "bc", method: "rect", args: [found.loc.ref] }, targetId);
        } else {
          box = await evalHelper({ kind: "bc", method: "viewport" }, targetId);
        }
        if (!box.ok) return box;
        const r = JSON.parse(valueOf(box)) as { x: number; y: number; width: number; height: number; dpr: number };
        const wantMarks = input["marks"] === true;
        let nativeBoxes: { boxes: MarkBox[]; legend: string } | undefined;
        let domMarksLegend: string | undefined;
        if (wantMarks && !hasRef) {
          const mb = await evalHelper({ kind: "bc", method: "markBoxes" }, targetId);
          if (mb.ok) {
            try {
              const parsed = JSON.parse(valueOf(mb)) as { boxes: MarkBox[]; legend: string };
              if (Array.isArray(parsed.boxes)) nativeBoxes = parsed;
            } catch { /* fallback to DOM marks */ }
          }
        }
        let domMarksActive = false;
        if (wantMarks && !nativeBoxes) {
          const dm = await evalHelper({ kind: "bc", method: "marks", args: [true] }, targetId);
          if (!dm.ok) return dm;
          domMarksLegend = valueOf(dm);
          domMarksActive = true;
        }

        const width = Math.max(1, Math.round(r.width));
        const height = Math.max(1, Math.round(r.height));
        const captureClipped = (scale: number) =>
          invoke("capture_screenshot", { ...base, clip: { x: r.x, y: r.y, width, height, scale } });
        let shot: InvokeResult;
        const clearDomMarks = async () => {
          if (domMarksActive) {
            domMarksActive = false;
            await evalHelper({ kind: "bc", method: "marks", args: [false] }, targetId);
          }
        };
        try {
          if (hasRef) {
            shot = await captureClipped(1 / (r.dpr || 1));
            if (shot.ok && r.dpr > 1) {
              const got = await imageWidth(String((shot.data as Json)["path"]));
              if (got !== undefined && got < width * 0.75) shot = await captureClipped(1);
            }
          } else {
            shot = await invoke("capture_screenshot", base);
            if (shot.ok) {
              const outPath = String((shot.data as Json)["path"]);
              const got = await imageWidth(outPath);
              if (got !== undefined && got > width * 1.1) {
                if (process.platform === "darwin") await clearDomMarks();
                const resized = await resizeImage(outPath, width, height);
                if (!resized && r.dpr > 1) shot = await captureClipped(1 / r.dpr);
              }
            }
          }
        } finally {
          await clearDomMarks();
        }
        if (!shot.ok) return shot;
        const outPath = String((shot.data as Json)["path"]);
        let marksLegend = domMarksLegend;
        if (nativeBoxes) {
          const drawn = await drawMarksOnImage(outPath, nativeBoxes.boxes);
          if (drawn) {
            marksLegend = nativeBoxes.legend;
          } else {
            // Non-macOS or swiftc absent: fall back to temporary DOM badges so --marks still works.
            const dm = await evalHelper({ kind: "bc", method: "marks", args: [true] }, targetId);
            if (dm.ok) {
              try {
                await invoke("capture_screenshot", { ...base, path: outPath });
                const got = await imageWidth(outPath);
                if (got !== undefined && got > width * 1.1) await resizeImage(outPath, width, height);
                marksLegend = valueOf(dm);
              } finally {
                await evalHelper({ kind: "bc", method: "marks", args: [false] }, targetId).catch(() => {});
              }
            }
          }
        }
        const lines = [outPath];
        if (!hasRef) {
          lines.push("# CSS-pixel scale: a point in the picture is the same x,y for click --xy.");
        }
        if (marksLegend !== undefined) lines.push("# The number on each control is its ref: 12 is e12.", marksLegend);
        return success(lines.join("\n"));
      }

      case "nav": {
        const url = typeof input["url"] === "string" ? input["url"] : "";
        const until = input["until"] === "load" ? "load" : "domcontentloaded";
        const nav = await invoke("navigate", {
          url,
          until,
          ...(targetId ? { targetId } : {}),
          ...(input["newWindow"] === true ? { newWindow: true } : {}),
          ...(input["keepOpen"] === true ? { keepOpen: true } : {}),
        });
        if (!nav.ok) return nav;
        const data = nav.data as Json;
        const tab = typeof data["targetId"] === "string" ? (data["targetId"] as string) : targetId;
        resetMotion(tab);
        // Only the tab id this nav returned may be cleaned up, never the caller's targetId.
        const newTab =
          data["created"] === true && typeof data["targetId"] === "string" && extensionTabOf(data["targetId"]) !== undefined
            ? (data["targetId"] as string)
            : undefined;
        const onBrowse = browseTabNumber(tab) !== undefined || (tab === undefined && browseTab !== undefined);
        const lines = [JSON.stringify(data)];
        if (!onBrowse) {
          const state = await evalHelper(
            {
              steps: [
                { kind: "bc", method: "settle", discard: true },
                { kind: "href" },
                { kind: "bc", method: "wall", fallback: "" },
              ],
              join: "\n",
            },
            tab,
            8_000,
          );
          let final = "";
          let wall = "";
          if (state.ok) {
            [final = "", wall = ""] = valueOf(state).split("\n");
          } else if (messageOf(state).startsWith("EXTENSION_ONLY:") || messageOf(state).includes("RESTRICTED_PAGE:")) {
            if (newTab !== undefined && messageOf(state).includes("RESTRICTED_PAGE:")) {
              const closed = await invoke("close_target", { targetId: newTab }).catch((e: unknown) =>
                failure("EXECUTION_FAILED", e instanceof Error ? e.message : String(e)),
              );
              const note = !closed.ok
                ? `may still be open (closing it could not be confirmed): ${messageOf(closed)}`
                : (closed.data as Json | undefined)?.["closed"] === false
                  ? "may still be open (closing it could not be confirmed)"
                  : undefined;
              if (note !== undefined) {
                return failure(
                  state.ok ? "EXECUTION_FAILED" : state.error.code,
                  `${messageOf(state)}\nThe tab this nav opened (${newTab}) ${note}.`,
                );
              }
            }
            return state;
          }
          const challengeBackend = challengeBackendOf(tab);
          const challenge = await checkChallenge(tab, { wallHint: wall, knownUrl: final || url });
          if (challenge.status === "block") {
            return failure(
              "EXECUTION_FAILED",
              formatChallengeOutput(challenge.detection, challenge.url || final || url, {
                backend: challengeBackend,
                untrustedBoundary: true,
              }),
            );
          }
          if (challenge.status === "interactive" || challenge.status === "non-interactive-timeout") {
            const targetUrl = challenge.url || final || url;
            // The final URL and redirect host come from the page, so keep them inside the boundary.
            const navDetails: string[] = [];
            if (final && final !== url) navDetails.push(`# url: ${final}`);
            if (final && hostOf(final) && hostOf(url) && hostOf(final) !== hostOf(url)) {
              navDetails.push(`# REDIRECTED: ${hostOf(url)} -> ${hostOf(final)}`);
            }
            if (navDetails.length) lines.push(wrapUntrusted(navDetails.join("\n")));
            return {
              ok: true,
              data: {
                value: `${formatChallengeOutput(challenge.detection, targetUrl, { backend: challengeBackend, untrustedBoundary: true })}\n${lines.join("\n")}`,
                challenge: challengeDataOf(challenge.detection, challenge.status, targetUrl, challengeBackend),
              },
            };
          }
          if (challenge.waited) {
            const afterWait = await evalHelper(
              {
                steps: [
                  { kind: "bc", method: "settle", discard: true },
                  { kind: "href" },
                  { kind: "bc", method: "wall", fallback: "" },
                ],
                join: "\n",
              },
              tab,
              8_000,
            );
            if (afterWait.ok) {
              [final = "", wall = ""] = valueOf(afterWait).split("\n");
            } else if (challenge.url) {
              final = challenge.url;
              wall = "";
            }
          }
          if (final && final !== url) lines.push(`# url: ${final}`);
          if (final && hostOf(final) && hostOf(url) && hostOf(final) !== hostOf(url)) {
            lines.push(`# REDIRECTED: ${hostOf(url)} -> ${hostOf(final)}`);
          }
          if (wall && input["snap"] !== true) {
            lines.push(`# WALL: ${wall}. Stop and hand this tab to the user; do not solve or bypass it.`);
          }
        }
        if (input["snap"] === true) {
          const snap = await handlePage("snap", { _skipChallengeCheck: !onBrowse }, tab);
          lines.push(snap.ok ? valueOf(snap) : `# snap failed: ${messageOf(snap).slice(0, 200)}`);
        }
        return success(lines.join("\n"));
      }

      case "styles":
        if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: styles needs a DevTools tab");
        return inspectStyles(invoke, resolveObject, input, targetId);

      case "issues":
        if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: issues needs a DevTools tab");
        return inspectIssues(invoke, input, targetId);

      case "perf":
        if (browseTab !== undefined) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: perf needs a DevTools tab");
        return inspectPerf(invoke, input, targetId);

      case "notes":
        return handleNotes(input, targetId);

      case "flow":
        return handleFlow(input, targetId);

      case "script":
        return runScript(input, targetId);

      case "verdict":
        return evalHelper({ kind: "bc", method: "verdict" }, targetId);

      case "health":
        return evalHelper({ kind: "bc", method: "health" }, targetId);

      default: {
        const hint = didYouMean(action, PAGE_ACTIONS);
        return failure(
          "OPERATION_NOT_FOUND",
          `unknown page helper: ${action}${hint ? `. Did you mean "${hint}"?` : ""}`,
        );
      }
    }
  }

  runScript = createScriptRunner(handlePage, (expression, tid) =>
    invoke("evaluate", { expression, ...(tid ? { targetId: tid } : {}) }),
  );

  return async function handlePageWithRemedies(action: string, input: Json, targetId?: string): Promise<InvokeResult> {
    const res = await handlePage(action, input, targetId);
    if (!res.ok) return failure(res.error.code, withRemedy(res.error.message));
    return res;
  };
}
