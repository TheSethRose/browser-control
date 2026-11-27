/**
 * In-page helpers (`__bc`) and input metadata used by the daemon's `/page/*` routes.
 *
 * The in-page code lives in `page-helpers.js.txt` (plain JavaScript, imported as text).
 * `PAGE_HELPERS_VERSION` is read directly from `const VERSION = <n>;` in that file, so
 * bumping it in one place causes tabs holding an older `__bc` copy to reinstall it.
 */
import source from "./page-helpers.js.txt";

const versionMatch = /\bconst VERSION = (\d+);/.exec(source);
if (!versionMatch) throw new Error("page-helpers.js.txt is missing const VERSION = <n>;");
export const PAGE_HELPERS_VERSION = Number(versionMatch[1]);

/**
 * In-page IIFE installed once per document. Keeps refs in memory (WeakRef), so an element
 * keeps its ref until it leaves the document. Only `marks` touches the DOM, and only for
 * the length of one screenshot.
 */
export const PAGE_HELPERS_SOURCE: string = source;

/** Field-name patterns also checked on `browse:<n>` tabs where `__bc` refs aren't used. */
export const HONEYPOT_NAME =
  /honeypot|honey.?pot|bot.?field|leave.?this.?empty|do.?not.?fill|anti.?spam|gotcha|trap.?field/i;
export const PAYMENT_FIELD =
  /card.?number|cardnumber|cc-?(number|csc|exp)|ccnumber|cvc|cvv|expir(y|ation)|security.?code|iban|account.?number|routing.?number|payment.?method/i;

export interface KeySpec {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

export const KEYS: Record<string, KeySpec> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

/** Where a `<ref>` argument points: a page ref, a ref inside iframe n, an accessibility node, or a label. */
export type Locator =
  | { kind: "dom"; ref: string }
  | { kind: "frame"; frame: number; ref: string; target?: string }
  | { kind: "ax"; node: number }
  | { kind: "label"; label: string };

export function parseLocator(raw: unknown): Locator {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("INPUT_INVALID: a ref (e12, f2:e5, a41) or a control's label is required");
  }
  const s = raw.trim().replace(/^@/, "");
  if (/^e[0-9]+$/.test(s)) return { kind: "dom", ref: s };
  const frame = /^f([0-9]+):(e[0-9]+)$/.exec(s);
  if (frame) return { kind: "frame", frame: Number(frame[1]), ref: frame[2]! };
  if (/^a[0-9]+$/.test(s)) return { kind: "ax", node: Number(s.slice(1)) };
  return { kind: "label", label: raw.trim() };
}

const BC_METHOD_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `__bc` methods in `page-helpers.js.txt` that return a Promise and must be awaited on CDP. */
const ASYNC_BC_METHODS = new Set(["point", "settle", "readUrls", "scrollRead"]);

/** One structured step for `evalHelper` (rendered to JS on CDP, sent verbatim as `bc_call` on extension tabs). */
export type HelperStep =
  | { kind: "bc"; method: string; args?: readonly unknown[]; fallback?: ""; discard?: true }
  | { kind: "href" | "readyState" | "origin" | "host" | "title"; discard?: true };

export type NormalizedHelperCall = {
  steps: readonly HelperStep[];
  join?: string;
};

export type HelperCall = HelperStep | readonly HelperStep[] | NormalizedHelperCall;

/** Structured element target for `resolveObject` (`upload` and `styles`). */
export type ElementStep =
  | { kind: "bc"; method: "el"; args: readonly [string] }
  | { kind: "querySelector"; selector: string };

export function normalizeHelperCall(call: HelperCall): NormalizedHelperCall {
  if (Array.isArray(call)) return { steps: call };
  if ("steps" in call) return call;
  return { steps: [call as HelperStep] };
}

function serializeArg(arg: unknown): string {
  if (arg === undefined) return "undefined";
  const json = JSON.stringify(arg);
  if (json === undefined) {
    throw new Error("INPUT_INVALID: helper step argument is not JSON-serializable");
  }
  return json;
}

function renderStep(step: HelperStep): string {
  switch (step.kind) {
    case "href":
      return "location.href";
    case "readyState":
      return "document.readyState";
    case "origin":
      return "location.origin";
    case "host":
      return "location.host";
    case "title":
      return "document.title";
    case "bc": {
      if (!BC_METHOD_IDENT.test(step.method)) {
        throw new Error(`INPUT_INVALID: invalid __bc method "${step.method}"`);
      }
      const args = (step.args ?? []).map(serializeArg).join(", ");
      const prefix = ASYNC_BC_METHODS.has(step.method) ? "await " : "";
      const expr = `${prefix}__bc.${step.method}(${args})`;
      return step.fallback === "" ? `${expr} || ""` : expr;
    }
  }
}

/** Render structured helper steps into the exact JavaScript expression executed on direct CDP. */
export function renderSteps(call: HelperCall): string {
  const { steps, join } = normalizeHelperCall(call);
  if (steps.length === 0) {
    throw new Error("INPUT_INVALID: helper call requires at least one step");
  }
  if (join === undefined) {
    return steps.length === 1 ? renderStep(steps[0]!) : `(${steps.map(renderStep).join(", ")})`;
  }
  const discarded: string[] = [];
  const kept: string[] = [];
  for (const step of steps) {
    if (step.discard) {
      if (kept.length > 0) {
        throw new Error("INPUT_INVALID: discarded steps must precede joined steps");
      }
      discarded.push(renderStep(step));
    } else {
      kept.push(renderStep(step));
    }
  }
  if (kept.length === 0) {
    throw new Error("INPUT_INVALID: join requires at least one non-discarded step");
  }
  const joined = `[${kept.join(", ")}].join(${JSON.stringify(join)})`;
  return discarded.length > 0 ? `(${discarded.join(", ")}, ${joined})` : joined;
}

/** Render a structured element target (`__bc.el(...)` or `document.querySelector(...)`) for CDP `Runtime.evaluate`. */
export function renderElementStep(step: ElementStep): string {
  if (step.kind === "querySelector") {
    return `document.querySelector(${serializeArg(step.selector)})`;
  }
  return renderSteps(step);
}
