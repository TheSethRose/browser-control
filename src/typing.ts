/**
 * Human-like keyboard typing planner and CDP key metadata.
 *
 * Produces per-character key events with realistic hold times, variable inter-key
 * cadence, and occasional QWERTY-neighbor typos followed by Backspace corrections.
 */

export interface CharKeySpec {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
  modifiers?: number;
}

export type HumanKeystroke =
  | { kind: "char"; ch: string; spec: CharKeySpec; holdMs: number; pauseAfterMs: number }
  | { kind: "backspace"; holdMs: number; pauseAfterMs: number }
  | { kind: "insert"; text: string; pauseAfterMs: number };

export interface HumanTypingOptions {
  rng?: () => number;
  typoRate?: number;
  maxTypos?: number;
}

const SHIFT = 8;

export const QWERTY_NEIGHBORS: Record<string, string> = {
  a: "sqwz",
  b: "vghn",
  c: "xdfv",
  d: "serfcx",
  e: "wsdr",
  f: "drtgvc",
  g: "ftyhbv",
  h: "gyujnb",
  i: "ujko",
  j: "huikmn",
  k: "jiolm",
  l: "kop",
  m: "njk",
  n: "bhjm",
  o: "iklp",
  p: "ol",
  q: "wa",
  r: "edft",
  s: "awedxz",
  t: "rfgy",
  u: "yhji",
  v: "cfgb",
  w: "qase",
  x: "zsdc",
  y: "tghu",
  z: "asx",
};

const PUNCTUATION: Record<string, { code: string; vk: number; shift?: boolean }> = {
  " ": { code: "Space", vk: 32 },
  "-": { code: "Minus", vk: 189 },
  "_": { code: "Minus", vk: 189, shift: true },
  "=": { code: "Equal", vk: 187 },
  "+": { code: "Equal", vk: 187, shift: true },
  "[": { code: "BracketLeft", vk: 219 },
  "{": { code: "BracketLeft", vk: 219, shift: true },
  "]": { code: "BracketRight", vk: 221 },
  "}": { code: "BracketRight", vk: 221, shift: true },
  "\\": { code: "Backslash", vk: 220 },
  "|": { code: "Backslash", vk: 220, shift: true },
  ";": { code: "Semicolon", vk: 186 },
  ":": { code: "Semicolon", vk: 186, shift: true },
  "'": { code: "Quote", vk: 222 },
  '"': { code: "Quote", vk: 222, shift: true },
  ",": { code: "Comma", vk: 188 },
  "<": { code: "Comma", vk: 188, shift: true },
  ".": { code: "Period", vk: 190 },
  ">": { code: "Period", vk: 190, shift: true },
  "/": { code: "Slash", vk: 191 },
  "?": { code: "Slash", vk: 191, shift: true },
  "`": { code: "Backquote", vk: 192 },
  "~": { code: "Backquote", vk: 192, shift: true },
  "!": { code: "Digit1", vk: 49, shift: true },
  "@": { code: "Digit2", vk: 50, shift: true },
  "#": { code: "Digit3", vk: 51, shift: true },
  "$": { code: "Digit4", vk: 52, shift: true },
  "%": { code: "Digit5", vk: 53, shift: true },
  "^": { code: "Digit6", vk: 54, shift: true },
  "&": { code: "Digit7", vk: 55, shift: true },
  "*": { code: "Digit8", vk: 56, shift: true },
  "(": { code: "Digit9", vk: 57, shift: true },
  ")": { code: "Digit0", vk: 48, shift: true },
};

export function keySpecForChar(ch: string): CharKeySpec | null {
  if (ch === "\n" || ch === "\r") {
    return { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
  }
  if (ch === "\t") {
    return { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 };
  }
  if (/^[a-z]$/.test(ch)) {
    const upper = ch.toUpperCase();
    return { key: ch, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: ch };
  }
  if (/^[A-Z]$/.test(ch)) {
    return { key: ch, code: `Key${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0), text: ch, modifiers: SHIFT };
  }
  if (/^[0-9]$/.test(ch)) {
    return { key: ch, code: `Digit${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0), text: ch };
  }
  const punct = PUNCTUATION[ch];
  if (punct) {
    return {
      key: ch,
      code: punct.code,
      windowsVirtualKeyCode: punct.vk,
      text: ch,
      ...(punct.shift ? { modifiers: SHIFT } : {}),
    };
  }
  return null;
}

function randRange(rng: () => number, min: number, max: number): number {
  return Math.round(min + rng() * (max - min));
}

function interKeyPause(rng: () => number, ch: string, prev: string, isLast: boolean): number {
  if (isLast) return 0;
  // Triangular-ish base spread (~55-139 ms, centered ~97 ms)
  let ms = 55 + (rng() + rng()) * 42;
  if (ch === " ") {
    ms += 30 + rng() * 80;
  } else if (/[A-Z0-9]/.test(ch) || PUNCTUATION[ch]) {
    ms += 20 + rng() * 45;
  }
  if (prev === ch) {
    ms *= 0.75;
  }
  // Occasional brief thinking pause
  if (rng() < 0.06) {
    ms += 140 + rng() * 180;
  }
  return Math.round(ms);
}

/**
 * Plan a human-like keystroke sequence for `text`.
 * Replaying the returned sequence always yields `text`.
 */
export function buildHumanKeystrokes(text: string, opts: HumanTypingOptions = {}): HumanKeystroke[] {
  const rng = opts.rng ?? Math.random;
  const chars = Array.from(text);
  const typoRate = opts.typoRate ?? 0.045;
  const maxTypos = opts.maxTypos ?? Math.min(2, Math.max(1, Math.floor(chars.length / 10)));
  const plan: HumanKeystroke[] = [];
  let typos = 0;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const prev = i > 0 ? chars[i - 1]! : "";
    const isLast = i === chars.length - 1;

    // Occasional neighbor typo on interior lowercase letters, immediately corrected with Backspace
    const neighbors = QWERTY_NEIGHBORS[ch];
    if (
      chars.length >= 4 &&
      i >= 1 &&
      !isLast &&
      neighbors &&
      typos < maxTypos &&
      typoRate > 0 &&
      rng() < typoRate
    ) {
      const wrong = neighbors[Math.floor(rng() * neighbors.length)]!;
      const wrongSpec = keySpecForChar(wrong)!;
      plan.push({
        kind: "char",
        ch: wrong,
        spec: wrongSpec,
        holdMs: randRange(rng, 28, 68),
        pauseAfterMs: randRange(rng, 120, 260),
      });
      plan.push({
        kind: "backspace",
        holdMs: randRange(rng, 28, 60),
        pauseAfterMs: randRange(rng, 70, 150),
      });
      typos++;
    }

    const spec = keySpecForChar(ch);
    const pauseAfterMs = interKeyPause(rng, ch, prev, isLast);
    if (spec) {
      plan.push({
        kind: "char",
        ch,
        spec,
        holdMs: randRange(rng, 28, 72),
        pauseAfterMs,
      });
    } else {
      plan.push({
        kind: "insert",
        text: ch,
        pauseAfterMs,
      });
    }
  }

  return plan;
}
