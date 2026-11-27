/**
 * Single-call JavaScript script runner with a Playwright-like `page` API,
 * persistent session `state` surviving timeouts/errors, step history reporting,
 * and `--out <path>` file export (including automatic CSV for arrays of objects).
 */
import type { InvokeResult } from "@agent-software/core";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import vm from "node:vm";

type Json = Record<string, unknown>;
type PageDispatch = (action: string, input: Json, targetId?: string) => Promise<InvokeResult>;
type EvalFn = (expression: string, targetId?: string) => Promise<InvokeResult>;

const failure = (code: string, message: string): InvokeResult =>
  ({ ok: false, error: { code, message } }) as InvokeResult;
const success = (value: string): InvokeResult => ({ ok: true, data: { value } });
const valueOf = (res: InvokeResult): string => (res.ok ? String((res.data as Json)["value"] ?? "") : "");

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Convert an array of plain objects (or an object holding one array of objects) into RFC 4180 CSV. */
export function toCsv(value: unknown): string | undefined {
  let rows: Array<Record<string, unknown>> | undefined;
  if (Array.isArray(value) && value.length > 0 && value.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
    rows = value as Array<Record<string, unknown>>;
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    const arrs = Object.values(value as Json).filter(
      (v) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && !Array.isArray(x)),
    );
    if (arrs.length === 1) rows = arrs[0] as Array<Record<string, unknown>>;
  }
  if (!rows) return undefined;
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  const lines = [cols.map(csvEscape).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(","));
  return `${lines.join("\n")}\n`;
}

export async function writeOutputFile(rawPath: string, value: unknown): Promise<string> {
  const filePath = resolvePath(rawPath);
  await mkdir(dirname(filePath), { recursive: true });
  let content: string;
  let format = "text";
  if (/\.csv$/i.test(filePath)) {
    const csv = toCsv(value);
    content = csv ?? (typeof value === "string" ? value : JSON.stringify(value, null, 2));
    format = csv ? "csv" : "text";
  } else if (/\.json$/i.test(filePath)) {
    content = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    format = "json";
  } else {
    content = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  }
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
  const summary = Array.isArray(value)
    ? `list of ${value.length} item(s)`
    : typeof value === "string"
      ? `${value.length} chars`
      : format;
  return `saved to ${filePath} (${content.length} bytes, ${summary})`;
}

export function createScriptRunner(dispatch: PageDispatch, evalPage: EvalFn) {
  /** Session-persistent state map that survives across script runs and timeouts. */
  const state: Json = {};

  return async function runScript(input: Json, targetId?: string): Promise<InvokeResult> {
    const code = typeof input["code"] === "string" ? input["code"] : "";
    if (!code.trim()) return failure("INPUT_VALIDATION_FAILED", "INPUT_INVALID: script requires JavaScript code");
    const timeoutMs = Math.min(Math.max(1000, Number(input["timeoutMs"]) || 60_000), 300_000);
    const outPath = typeof input["out"] === "string" && input["out"].trim() !== "" ? input["out"].trim() : undefined;

    const logs: string[] = [];
    const steps: Array<{ n: number; cmd: string; ok: boolean }> = [];
    let callNum = 0;

    const step = async <T>(cmd: string, fn: () => Promise<T>): Promise<T> => {
      const n = ++callNum;
      try {
        const res = await fn();
        steps.push({ n, cmd, ok: true });
        return res;
      } catch (err) {
        steps.push({ n, cmd, ok: false });
        throw err;
      }
    };

    const runAction = async (action: string, params: Json): Promise<string> => {
      const res = await dispatch(action, { ...params, quiet: params["quiet"] ?? true }, targetId);
      if (!res.ok) throw new Error(res.error.message);
      return valueOf(res);
    };

    let remainingMs = timeoutMs;
    let timerStartedAt = Date.now();
    let handoffDepth = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectTimeout!: (err: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });

    const armTimer = () => {
      if (timer) clearTimeout(timer);
      timerStartedAt = Date.now();
      timer = setTimeout(
        () => rejectTimeout(new Error(`SCRIPT_TIMEOUT: script exceeded ${timeoutMs}ms`)),
        Math.max(1, remainingMs),
      );
    };
    const pauseTimer = () => {
      if (handoffDepth++ === 0 && timer) {
        clearTimeout(timer);
        timer = undefined;
        remainingMs = Math.max(1, remainingMs - (Date.now() - timerStartedAt));
      }
    };
    const resumeTimer = () => {
      if (handoffDepth > 0 && --handoffDepth === 0) {
        armTimer();
      }
    };

    const page = {
      goto: (url: string, opts: Json = {}) => step(`goto(${url})`, () => runAction("nav", { url, ...opts })),
      click: (ref: string, opts: Json = {}) => step(`click(${ref})`, () => runAction("click", { ref, ...opts })),
      type: (ref: string, text: string, opts: Json = {}) => step(`type(${ref})`, () => runAction("type", { ref, text, ...opts })),
      fill: (ref: string, text: string, opts: Json = {}) => step(`fill(${ref})`, () => runAction("type", { ref, text, ...opts })),
      select: (ref: string, option: string, opts: Json = {}) => step(`select(${ref})`, () => runAction("select", { ref, option, ...opts })),
      drag: (from: string, to: string, opts: Json = {}) => step(`drag(${from},${to})`, () => runAction("drag", { from, to, ...opts })),
      key: (key: string) => step(`key(${key})`, () => runAction("key", { key })),
      press: (key: string) => step(`press(${key})`, () => runAction("key", { key })),
      wait: (opts: string | Json) => step("wait", () => runAction("wait", typeof opts === "string" ? { text: opts } : opts)),
      snap: (opts: Json = {}) => step("snap", () => runAction("snap", { ...opts, quiet: false })),
      text: (opts: Json = {}) => step("text", () => runAction("text", { ...opts, quiet: false })),
      form: (opts: Json = {}) => step("form", () => runAction("form", { ...opts, quiet: false })),
      query: (selector: string, opts: Json = {}) => step(`query(${selector})`, () => runAction("query", { selector, ...opts, quiet: false })),
      readUrls: (urls: string[], opts: Json = {}) => step(`readUrls(${urls.length})`, () => runAction("read-urls", { urls, ...opts, quiet: false })),
      value: (ref: string) => step(`value(${ref})`, () => runAction("value", { ref })),
      handoff: (message?: string | Json, opts: Json = {}) =>
        step("handoff", async () => {
          const params: Json =
            typeof message === "object" && message !== null && !Array.isArray(message)
              ? { ...message }
              : { ...(typeof message === "string" ? { message } : {}), ...opts };
          pauseTimer();
          try {
            return await runAction("handoff", params);
          } finally {
            resumeTimer();
          }
        }),
      evaluate: (fnOrExpr: string | ((...a: unknown[]) => unknown), ...args: unknown[]) =>
        step("evaluate", async () => {
          const expr = typeof fnOrExpr === "function"
            ? `(${fnOrExpr.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`
            : fnOrExpr;
          const res = await evalPage(expr, targetId);
          if (!res.ok) throw new Error(res.error.message);
          return (res.data as Json)["value"];
        }),
      url: () => step("url", async () => {
        const res = await evalPage("location.href", targetId);
        if (!res.ok) throw new Error(res.error.message);
        return String((res.data as Json)["value"] ?? "");
      }),
      title: () => step("title", async () => {
        const res = await evalPage("document.title", targetId);
        if (!res.ok) throw new Error(res.error.message);
        return String((res.data as Json)["value"] ?? "");
      }),
    };

    const sandbox = vm.createContext({
      page,
      state,
      sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(Math.max(0, ms), 30_000))),
      log: (...a: unknown[]) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")),
      console: {
        log: (...a: unknown[]) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")),
      },
      URL,
      URLSearchParams,
      JSON,
      Math,
      Date,
      Array,
      Object,
      Map,
      Set,
      RegExp,
      Promise,
      setTimeout,
      clearTimeout,
    });

    const wrapped = `(async () => {\n${code}\n})()`;
    try {
      armTimer();
      const script = new vm.Script(wrapped, { filename: "browser-control-script.js" });
      const runPromise = Promise.resolve(script.runInContext(sandbox, { timeout: Math.min(timeoutMs, 10_000) }));
      const result = await Promise.race([runPromise, timeoutPromise]);
      if (outPath) {
        const digest = await writeOutputFile(outPath, result);
        const logTail = logs.slice(-10).map((l) => `log: ${l}`);
        return success([digest, ...logTail].join("\n"));
      }
      const rendered = result === undefined
        ? (logs.length ? logs.join("\n") : "ok")
        : typeof result === "string"
          ? result
          : Array.isArray(result) && result.every((x) => x && typeof x === "object")
            ? result.map((r) => JSON.stringify(r)).join("\n")
            : JSON.stringify(result, null, 2);
      const prefix = logs.length && result !== undefined ? `${logs.slice(-10).map((l) => `# log: ${l}`).join("\n")}\n` : "";
      return success(`${prefix}${rendered}`);
    } catch (err) {
      const msg = (err as Error).message || String(err);
      const history = steps.slice(-12).map((s) => `#${s.n} ${s.cmd} ${s.ok ? "ok" : "FAIL"}`).join(" | ");
      const stateKeys = Object.keys(state);
      const hint = /\b(document|window|localStorage)\b is not defined/.test(msg)
        ? "\nhint: scripts run outside the page; use page.evaluate(...) for DOM access"
        : "";
      return failure(
        "EXECUTION_FAILED",
        `SCRIPT_ERROR: ${msg}${hint}${history ? `\nsteps (${steps.filter((s) => s.ok).length}/${steps.length} ok): ${history}` : ""}${stateKeys.length ? `\nstate preserved keys: ${stateKeys.join(", ")}` : ""}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
