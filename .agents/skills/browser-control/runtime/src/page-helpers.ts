/**
 * In-page helpers (`__bc`) and input metadata used by the daemon's `/page/*` routes.
 *
 * The in-page code lives in `page-helpers.js.txt` (plain JavaScript, imported as text).
 * Bump `VERSION` there and `PAGE_HELPERS_VERSION` here together whenever it changes, so
 * tabs holding an older `__bc` copy reinstall it automatically.
 */
import source from "./page-helpers.js.txt";

export const PAGE_HELPERS_VERSION = 5;

/**
 * In-page IIFE installed once per document. Keeps refs in memory (WeakRef), so an element
 * keeps its ref until it leaves the document. Only `marks` touches the DOM, and only for
 * the length of one screenshot.
 */
export const PAGE_HELPERS_SOURCE: string = source;

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
  | { kind: "frame"; frame: number; ref: string }
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

/** Validate and normalize a snapshot ref like `e12` or `@e12`. */
export function parseRef(raw: unknown): string {
  if (typeof raw !== "string" || !/^@?e[0-9]+$/.test(raw)) {
    throw new Error(`INPUT_INVALID: ref must look like e12 (from snap), got '${String(raw ?? "")}'`);
  }
  return raw.replace(/^@/, "");
}
