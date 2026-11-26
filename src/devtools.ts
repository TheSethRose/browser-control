/**
 * Lightweight DevTools inspection helpers over standard CDP:
 * - styles: matched CSS rules, specificity/origin, stylesheet line, and computed styles
 * - issues: Audits.issueAdded warnings (CORS, CSP, SameSite cookies, deprecations) with cookie values stripped
 * - perf: Tracing.start/end with FCP, LCP, CLS (worst session window), TBT, and top long tasks
 */
import type { InvokeResult } from "@agent-software/core";
import type { ElementStep } from "./page-helpers";

type Json = Record<string, unknown>;
type Invoker = (operation: string, input?: Json) => Promise<InvokeResult>;
type EvalObj = (target: ElementStep, targetId?: string) => Promise<{ ok: true; objectId: string } | { ok: false; res: InvokeResult }>;

const failure = (code: string, message: string): InvokeResult =>
  ({ ok: false, error: { code, message } }) as InvokeResult;
const success = (value: string): InvokeResult => ({ ok: true, data: { value } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_STYLE_PROPS = [
  "display", "position", "visibility", "opacity", "z-index", "overflow", "pointer-events",
  "width", "height", "color", "background-color", "font-size", "font-weight", "margin", "padding",
];

function stripCookieSecrets(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripCookieSecrets);
  if (obj && typeof obj === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(obj as Json)) {
      if (/rawCookieLine|cookieValue|set-cookie/i.test(k)) continue;
      out[k] = stripCookieSecrets(v);
    }
    return out;
  }
  return obj;
}

export async function inspectStyles(
  invoke: Invoker,
  resolveObject: EvalObj,
  input: Json,
  targetId?: string,
): Promise<InvokeResult> {
  const cdp = (method: string, params: Json = {}) =>
    invoke("execute_cdp", { method, params, ...(targetId ? { targetId } : {}) });

  const target = typeof input["ref"] === "string" ? input["ref"].trim() : "";
  if (!target) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: styles requires a ref (e12) or CSS selector");
  const props = Array.isArray(input["properties"]) && input["properties"].length > 0
    ? (input["properties"] as unknown[]).map(String)
    : DEFAULT_STYLE_PROPS;
  const want = new Set(props.map((p) => p.toLowerCase()));

  await cdp("DOM.enable");
  await cdp("CSS.enable");
  const targetStep: ElementStep = /^@?e\d+$/.test(target)
    ? { kind: "bc", method: "el", args: [target] }
    : { kind: "querySelector", selector: target };
  const objRes = await resolveObject(targetStep, targetId);
  if (!objRes.ok) return objRes.res;
  let nodeId: number | undefined;
  try {
    const req = await cdp("DOM.requestNode", { objectId: objRes.objectId });
    if (!req.ok) return req;
    nodeId = ((req.data as Json)["result"] as Json | undefined)?.["nodeId"] as number | undefined;
  } finally {
    await cdp("Runtime.releaseObject", { objectId: objRes.objectId }).catch(() => {});
  }
  if (!nodeId) return failure("EXECUTION_FAILED", `NO_MATCH: could not resolve node for "${target}"`);

  const [matchedRes, computedRes] = await Promise.all([
    cdp("CSS.getMatchedStylesForNode", { nodeId }),
    cdp("CSS.getComputedStyleForNode", { nodeId }),
  ]);
  if (!matchedRes.ok) return matchedRes;

  const computedMap = new Map<string, string>();
  if (computedRes.ok) {
    const list = (((computedRes.data as Json)["result"] as Json | undefined)?.["computedStyle"] as Array<{ name: string; value: string }>) ?? [];
    for (const c of list) {
      if (want.has(c.name.toLowerCase())) computedMap.set(c.name.toLowerCase(), c.value);
    }
  }

  const matched = (matchedRes.data as Json)["result"] as {
    inlineStyle?: { cssProperties?: Array<{ name: string; value: string; important?: boolean }> };
    matchedCSSRules?: Array<{
      rule?: {
        origin?: string;
        selectorList?: { text?: string };
        style?: { cssProperties?: Array<{ name: string; value: string; important?: boolean }>; range?: { startLine?: number } };
      };
    }>;
  } | undefined;

  const winners = new Map<string, { value: string; source: string; important: boolean }>();
  for (const entry of matched?.matchedCSSRules ?? []) {
    const r = entry.rule;
    const sel = r?.selectorList?.text ?? "(rule)";
    const line = r?.style?.range?.startLine !== undefined ? `:${r.style.range.startLine + 1}` : "";
    const src = `${sel} (${r?.origin ?? "regular"}${line})`;
    for (const p of r?.style?.cssProperties ?? []) {
      const k = p.name.toLowerCase();
      if (!want.has(k) || !p.value) continue;
      const cur = winners.get(k);
      if (!cur || !cur.important || p.important) {
        winners.set(k, { value: p.value, source: src, important: !!p.important });
      }
    }
  }
  for (const p of matched?.inlineStyle?.cssProperties ?? []) {
    const k = p.name.toLowerCase();
    if (!want.has(k) || !p.value) continue;
    const cur = winners.get(k);
    if (!cur || !cur.important || p.important) {
      winners.set(k, { value: p.value, source: "inline style", important: !!p.important });
    }
  }

  const lines = [`# styles for ${target}`];
  for (const p of props) {
    const k = p.toLowerCase();
    const comp = computedMap.get(k);
    const win = winners.get(k);
    if (comp === undefined && !win) continue;
    lines.push(`- ${p}: ${comp ?? win?.value ?? ""}${win ? `  <- ${win.value}${win.important ? " !important" : ""} from ${win.source}` : ""}`);
  }
  return success(lines.join("\n"));
}

export async function inspectIssues(invoke: Invoker, input: Json, targetId?: string): Promise<InvokeResult> {
  const cdp = (method: string, params: Json = {}) =>
    invoke("execute_cdp", { method, params, ...(targetId ? { targetId } : {}) });
  const waitMs = Math.min(Math.max(0, Number(input["waitMs"]) || 250), 5000);
  const en = await cdp("Audits.enable");
  if (!en.ok) return en;
  if (waitMs > 0) await sleep(waitMs);
  const read = await invoke("read_events", {
    method: "Audits.issueAdded",
    limit: 100,
    clear: input["clear"] === true,
    ...(targetId ? { targetId } : {}),
  });
  if (!read.ok) return read;
  const events = ((read.data as Json)["events"] as Array<{ params?: { issue?: Json } }>) ?? [];
  const kindFilter = typeof input["kind"] === "string" ? input["kind"].toLowerCase() : "";
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const ev of events) {
    const issue = stripCookieSecrets(ev.params?.issue ?? {}) as { code?: string; details?: Json };
    const code = String(issue.code ?? "UnknownIssue");
    if (kindFilter && !code.toLowerCase().includes(kindFilter)) continue;
    const detail = JSON.stringify(issue.details ?? {}).slice(0, 240);
    const key = `${code}:${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- [${code}] ${detail}`);
  }
  return success([`# issues: ${lines.length} unique DevTools issue(s)`, ...lines].join("\n"));
}

export type TraceEvent = {
  name?: string;
  cat?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  args?: Record<string, any>;
};

/** Compute FCP, LCP, CLS (worst session window), TBT, and top long tasks from Chromium trace events. */
export function analyzeTrace(events: TraceEvent[]): {
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number;
  tbtMs: number;
  longTasks: Array<{ ms: number; url?: string }>;
} {
  let navStart: number | undefined;
  let fcpUs: number | undefined;
  let lcpUs: number | undefined;
  const shifts: Array<{ ts: number; value: number }> = [];
  const longTasks: Array<{ ms: number; url?: string }> = [];
  let tbtMs = 0;

  for (const e of events) {
    const ts = typeof e.ts === "number" ? e.ts : 0;
    if (e.name === "navigationStart" && (navStart === undefined || ts < navStart)) navStart = ts;
    if (e.name === "firstContentfulPaint" && (fcpUs === undefined || ts < fcpUs)) fcpUs = ts;
    if (e.name === "largestContentfulPaint::Candidate") lcpUs = ts;
    if (e.name === "LayoutShift" && e.args?.["data"] && !e.args["data"]["had_recent_input"]) {
      const score = Number(e.args["data"]["score"] ?? 0);
      if (score > 0) shifts.push({ ts, value: score });
    }
    if ((e.name === "RunTask" || e.name === "FunctionCall") && typeof e.dur === "number" && e.dur > 50_000) {
      const ms = Math.round(e.dur / 1000);
      tbtMs += ms - 50;
      const url = typeof e.args?.["data"]?.["url"] === "string" ? e.args["data"]["url"] : undefined;
      longTasks.push({ ms, ...(url ? { url } : {}) });
    }
  }

  // CLS worst session window (gaps <= 1s, total window <= 5s).
  shifts.sort((a, b) => a.ts - b.ts);
  let cls = 0;
  let winSum = 0;
  let winStart = 0;
  let prevTs = 0;
  for (const s of shifts) {
    if (winSum === 0 || s.ts - prevTs > 1_000_000 || s.ts - winStart > 5_000_000) {
      winStart = s.ts;
      winSum = s.value;
    } else {
      winSum += s.value;
    }
    prevTs = s.ts;
    if (winSum > cls) cls = winSum;
  }

  longTasks.sort((a, b) => b.ms - a.ms);
  const fcpMs = navStart !== undefined && fcpUs !== undefined ? Math.max(0, Math.round((fcpUs - navStart) / 1000)) : null;
  const lcpMs = navStart !== undefined && lcpUs !== undefined ? Math.max(0, Math.round((lcpUs - navStart) / 1000)) : null;
  return { fcpMs, lcpMs, cls: Number(cls.toFixed(4)), tbtMs, longTasks: longTasks.slice(0, 8) };
}

export async function inspectPerf(invoke: Invoker, input: Json, targetId?: string): Promise<InvokeResult> {
  const cdp = (method: string, params: Json = {}) =>
    invoke("execute_cdp", { method, params, ...(targetId ? { targetId } : {}) });
  const durationMs = Math.min(Math.max(250, Number(input["durationMs"]) || 2500), 15000);
  const reload = input["reload"] === true;

  await invoke("read_events", { method: "Tracing.dataCollected", limit: 1000, clear: true, ...(targetId ? { targetId } : {}) });
  const start = await cdp("Tracing.start", {
    categories: "devtools.timeline,loading,blink.user_timing,latencyInfo",
    transferMode: "ReportEvents",
  });
  if (!start.ok) return start;
  try {
    if (reload) await cdp("Page.reload", { ignoreCache: false });
    await sleep(durationMs);
  } finally {
    await cdp("Tracing.end").catch(() => {});
  }
  await invoke("wait_for_event", { method: "Tracing.tracingComplete", timeoutMs: 4000, ...(targetId ? { targetId } : {}) });
  const read = await invoke("read_events", { method: "Tracing.dataCollected", limit: 1000, clear: true, ...(targetId ? { targetId } : {}) });
  const chunks = read.ok ? (((read.data as Json)["events"] as Array<{ params?: { value?: TraceEvent[] } }>) ?? []) : [];
  const allEvents: TraceEvent[] = [];
  for (const ch of chunks) {
    if (Array.isArray(ch.params?.value)) allEvents.push(...ch.params.value);
  }
  const metrics = analyzeTrace(allEvents);
  const lines = [
    `# perf trace (${durationMs}ms${reload ? ", reloaded" : ""}, ${allEvents.length} trace events)`,
    `- FCP: ${metrics.fcpMs !== null ? `${metrics.fcpMs}ms` : "n/a"}`,
    `- LCP: ${metrics.lcpMs !== null ? `${metrics.lcpMs}ms` : "n/a"}`,
    `- CLS: ${metrics.cls}`,
    `- TBT: ${metrics.tbtMs}ms`,
  ];
  if (metrics.longTasks.length > 0) {
    lines.push("- Top long tasks:");
    for (const t of metrics.longTasks.slice(0, 5)) {
      lines.push(`  - ${t.ms}ms${t.url ? ` (${t.url.slice(0, 100)})` : ""}`);
    }
  }
  return success(lines.join("\n"));
}
