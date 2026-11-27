/**
 * Human-like keyboard typing planner and CDP key metadata. Pure (inject `rng`): log-normal gaps,
 * word pauses, rollover on fast pairs, real Shift, and self-corrected typos (adjacent key,
 * transposition, doubled, dropped). Replaying a plan through an editor yields the text exactly.
 */

export interface CharKeySpec {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
  modifiers?: number;
}

/** One dispatch step. `delayMs` is the wait before it; events are already in dispatch order. */
export type HumanKeystroke =
  | { kind: "keyDown"; ch: string; spec: CharKeySpec; delayMs: number }
  | { kind: "keyUp"; ch: string; spec: CharKeySpec; delayMs: number }
  | { kind: "insert"; text: string; delayMs: number };

/** `prose` and `structured` get their own typo rates; `none` never types a typo. */
export type FieldKind = "prose" | "structured" | "none";

export interface HumanTypingOptions {
  rng?: () => number;
  fieldKind?: FieldKind;
  typoRate?: number;
  maxTypos?: number;
  /** >1 types faster. The daemon passes one value for the whole session (0.85-1.15). */
  speedFactor?: number;
}

export interface TypingPlan {
  events: HumanKeystroke[];
  /** Typo episodes; each one is corrected with fast repeated Backspace and a retype. */
  typos: number;
  /** The kind of each typo episode, in order. */
  typoKinds: TypoKind[];
  chars: number;
  durationMs: number;
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
  // Digits stay digits, so a typo in a structured field is still a character it accepts.
  ...Object.fromEntries([..."1234567890"].map((d, i, row) => [d, (row[i - 1] ?? "") + (row[i + 1] ?? "")])),
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

const SHIFT_DOWN_SPEC: CharKeySpec = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: SHIFT };
const SHIFT_UP_SPEC: CharKeySpec = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 };
const BACKSPACE_SPEC: CharKeySpec = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 };

/** Per-character typo probability. */
const PROSE_TYPO_RATE = 0.032;
const STRUCTURED_TYPO_RATE = 0.008;

/** Share of fast pairs (keyDown to keyDown under FAST_PAIR_MS) where the next key goes down first. */
const FAST_PAIR_MS = 130;
const ROLLOVER_CHANCE = 0.3;

const INTRA_MEDIAN = 74;
const INTRA_SIGMA = 0.3;
const INTRA_MIN = 42;
const WORD_MEDIAN = 172;
const WORD_SIGMA = 0.26;
const WORD_MIN = 120;
const WORD_MAX = 262;
const WORD_PAUSE_CHANCE = 0.24;
const WORD_PAUSE_MIN = 350;
const WORD_PAUSE_MAX = 900;

const STRONG_PUNCT = new Set([".", "!", "?", "…"]);
const WEAK_PUNCT = new Set([",", ";", ":", "–", "—", ")", "]"]);

const STRUCTURED_HINT =
  /\b(email|e-mail|phone|tel|mobile|number|zip|postal|date|time|url|website|username|handle|amount|quantity|age|code)\b/i;

/** Purely shape-based: a plain single word (a name, say) stays prose. */
export function classifyFieldKind(text: string, hint = ""): FieldKind {
  const t = text.trim();
  if (t === "") return "prose";
  const shapes = [
    /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/,
    /^(?:https?:\/\/|www\.)\S+$/i,
    /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/,
    /^[+-]?\d+(?:[.,]\d+)?$/,
    /^\+?[\d(][\d\s().-]{5,}$/,
  ];
  return shapes.some((re) => re.test(t)) || STRUCTURED_HINT.test(hint) ? "structured" : "prose";
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
const gauss = (rng: () => number): number =>
  Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng());
const logNormal = (rng: () => number, median: number, sigma: number): number => median * Math.exp(sigma * gauss(rng));

interface Unit {
  ch: string;
  spec: CharKeySpec | null;
  back?: boolean;
}

export type TypoKind = "adjacent" | "transpose" | "double" | "drop";

function pickTypoKind(rng: () => number, ch: string, next: string | undefined): TypoKind {
  const adjacent = QWERTY_NEIGHBORS[ch.toLowerCase()] !== undefined;
  const transpose = next !== undefined && next !== ch && !/\s/.test(next);
  const roll = rng();
  if (roll < 0.45) return adjacent ? "adjacent" : transpose ? "transpose" : "double";
  if (roll < 0.62) return transpose ? "transpose" : "double";
  return roll < 0.82 ? "double" : "drop";
}

function planUnits(
  chars: string[],
  rng: () => number,
  typoRate: number,
  maxTypos: number,
): { units: Unit[]; typos: number; typoKinds: TypoKind[] } {
  const units: Unit[] = [];
  const typoKinds: TypoKind[] = [];
  const pushChar = (ch: string) => units.push({ ch, spec: keySpecForChar(ch) });
  const backspaces = (n: number) => {
    for (let k = 0; k < n; k++) units.push({ ch: "", spec: BACKSPACE_SPEC, back: true });
  };
  // A typo span stays inside printable ASCII, where one Backspace deletes one typed character.
  const asciiRun = new Array<number>(chars.length + 1).fill(0);
  for (let k = chars.length - 1; k >= 0; k--) asciiRun[k] = /^[ -~]$/.test(chars[k]!) ? asciiRun[k + 1]! + 1 : 0;
  let typos = 0;
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    const room = asciiRun[i]! - 2;
    const plain = !/\s/.test(ch) && !/\s/.test(chars[i - 1] ?? "");
    const wantTypo = typoRate > 0 && typos < maxTypos && plain && room >= 0 && rng() < typoRate;
    if (!wantTypo) {
      pushChar(ch);
      i++;
      continue;
    }
    const kind = pickTypoKind(rng, ch, chars[i + 1]);
    let notice = Math.floor(rng() * (Math.min(4, room) + 1));
    // A dropped character with no characters typed after it leaves no visible error.
    if (kind === "drop" && notice === 0) notice = Math.min(1, room);
    typos++;
    typoKinds.push(kind);
    if (kind === "adjacent") {
      const neighbors = QWERTY_NEIGHBORS[ch.toLowerCase()]!;
      let wrong = neighbors[Math.floor(rng() * neighbors.length)]!;
      if (ch !== ch.toLowerCase()) wrong = wrong.toUpperCase();
      pushChar(wrong);
      for (let k = 1; k <= notice; k++) pushChar(chars[i + k]!);
      backspaces(notice + 1);
      for (let k = 0; k <= notice; k++) pushChar(chars[i + k]!);
      i += notice + 1;
    } else if (kind === "transpose") {
      pushChar(chars[i + 1]!);
      pushChar(ch);
      for (let k = 2; k <= notice + 1; k++) pushChar(chars[i + k]!);
      backspaces(notice + 2);
      for (let k = 0; k <= notice + 1; k++) pushChar(chars[i + k]!);
      i += notice + 2;
    } else if (kind === "drop") {
      for (let k = 1; k <= notice; k++) pushChar(chars[i + k]!);
      backspaces(notice);
      for (let k = 0; k <= notice; k++) pushChar(chars[i + k]!);
      i += notice + 1;
    } else {
      pushChar(ch);
      pushChar(ch);
      for (let k = 1; k <= notice; k++) pushChar(chars[i + k]!);
      backspaces(notice + 1);
      for (let k = 1; k <= notice; k++) pushChar(chars[i + k]!);
      i += notice + 1;
    }
  }
  return { units, typos, typoKinds };
}

function gapBetween(cur: Unit, next: Unit, rng: () => number): number {
  if (cur.back) return 50 + rng() * 60; // fast repeated Backspace, 50-110 ms
  if (next.back) return 60 + rng() * 80; // notice the typo, then correct it
  if (cur.ch === " ") {
    let gap = clamp(logNormal(rng, WORD_MEDIAN, WORD_SIGMA), WORD_MIN, WORD_MAX);
    if (rng() < WORD_PAUSE_CHANCE) gap += WORD_PAUSE_MIN + rng() * (WORD_PAUSE_MAX - WORD_PAUSE_MIN);
    return gap;
  }
  if (STRONG_PUNCT.has(cur.ch)) {
    return clamp(logNormal(rng, 200, 0.24), 130, 320) + 300 + rng() * 480;
  }
  if (WEAK_PUNCT.has(cur.ch)) {
    let gap = clamp(logNormal(rng, 130, 0.22), 90, 210);
    if (rng() < 0.5) gap += 140 + rng() * 280;
    return gap;
  }
  if (next.ch === " ") return clamp(logNormal(rng, INTRA_MEDIAN + 14, INTRA_SIGMA), INTRA_MIN, 130);
  return clamp(logNormal(rng, INTRA_MEDIAN, INTRA_SIGMA), INTRA_MIN, 116);
}

/**
 * Plan a human-like keystroke sequence for `text`.
 * Replaying the returned events always yields `text`.
 */
export function planTyping(text: string, opts: HumanTypingOptions = {}): TypingPlan {
  const rng = opts.rng ?? Math.random;
  const chars = Array.from(text);
  const fieldKind = opts.fieldKind ?? "prose";
  const speed = clamp(opts.speedFactor ?? 1, 0.6, 1.4);
  const typoRate =
    opts.typoRate ??
    (fieldKind === "prose" ? PROSE_TYPO_RATE : fieldKind === "structured" ? STRUCTURED_TYPO_RATE : 0);
  const maxTypos = opts.maxTypos ?? Math.max(1, Math.round(chars.length * 0.05));
  if (chars.length === 0) return { events: [], typos: 0, typoKinds: [], chars: 0, durationMs: 0 };

  const { units, typos, typoKinds } = planUnits(chars, rng, typoRate, maxTypos);

  const starts: number[] = [];
  const ups: number[] = [];
  // Small settle before the first key so a leading Shift can land before its capital.
  let t = 120 + rng() * 80;
  for (let j = 0; j < units.length; j++) {
    const u = units[j]!;
    const next = units[j + 1];
    const gap = next ? gapBetween(u, next, rng) : 0;
    const rawHold = u.back ? 24 + rng() * 30 : u.spec ? 32 + rng() * 48 : 0;
    // A key comes up before the next goes down unless the pair is chosen for rollover below.
    const hold = gap > 0 ? Math.min(rawHold, Math.max(18, gap - 5)) : rawHold;
    starts.push(t);
    ups.push(t + hold);
    t += gap;
  }

  // Rollover: on some fast plain pairs the next key goes down before the previous one comes up.
  for (let j = 0; j + 1 < units.length; j++) {
    const cur = units[j]!;
    const next = units[j + 1]!;
    if (cur.back || next.back || !cur.spec || !next.spec) continue;
    if ((cur.spec.modifiers ?? 0) !== 0 || (next.spec.modifiers ?? 0) !== 0) continue;
    if (cur.ch === " " || next.ch === " ") continue;
    // A keyboard can't press the same key twice without releasing it first.
    if (cur.ch === next.ch) continue;
    const gap = starts[j + 1]! - starts[j]!;
    if (gap > FAST_PAIR_MS) continue;
    if (rng() >= ROLLOVER_CHANCE) continue;
    ups[j] = starts[j + 1]! + 5 + rng() * 16;
  }

  // Shift runs: Shift goes down after every earlier key is up, spans consecutive capitals or shifted
  // symbols, and comes up before the next key goes down. Too short a gap delays the later keys.
  const isShifted = (u: Unit) => (u.spec?.modifiers ?? 0) === SHIFT;
  const delayFrom = (from: number, by: number) => {
    for (let k = from; k < units.length; k++) {
      starts[k] = starts[k]! + by;
      ups[k] = ups[k]! + by;
    }
  };
  const shiftRuns: Array<[number, number]> = [];
  let prevUp = -Infinity;
  let scanned = 0;
  for (let j = 0; j < units.length; ) {
    if (!isShifted(units[j]!)) {
      j++;
      continue;
    }
    let last = j;
    while (last + 1 < units.length && isShifted(units[last + 1]!)) last++;
    for (; scanned < j; scanned++) prevUp = Math.max(prevUp, ups[scanned]!);
    let down = starts[j]! - (30 + rng() * 58);
    if (down < prevUp + 4) {
      delayFrom(j, prevUp + 4 - down);
      down = prevUp + 4;
    }
    const up = ups[last]! + 20 + rng() * 48;
    if (last + 1 < units.length && starts[last + 1]! < up + 4) delayFrom(last + 1, up + 4 - starts[last + 1]!);
    shiftRuns.push([down, up]);
    j = last + 1;
  }

  const out: Array<{ at: number; prio: number; ev: HumanKeystroke }> = [];
  for (let j = 0; j < units.length; j++) {
    const u = units[j]!;
    const at = starts[j]!;
    if (u.back) {
      out.push({ at, prio: 3, ev: { kind: "keyDown", ch: "", spec: { ...BACKSPACE_SPEC }, delayMs: 0 } });
      out.push({ at: ups[j]!, prio: 1, ev: { kind: "keyUp", ch: "", spec: { ...BACKSPACE_SPEC }, delayMs: 0 } });
      continue;
    }
    if (!u.spec) {
      out.push({ at, prio: 4, ev: { kind: "insert", text: u.ch, delayMs: 0 } });
      continue;
    }
    const { text: _text, ...rest } = u.spec;
    out.push({ at, prio: 3, ev: { kind: "keyDown", ch: u.ch, spec: u.spec, delayMs: 0 } });
    out.push({ at: ups[j]!, prio: 1, ev: { kind: "keyUp", ch: u.ch, spec: rest, delayMs: 0 } });
  }

  for (const [down, up] of shiftRuns) {
    out.push({ at: down, prio: 2, ev: { kind: "keyDown", ch: "", spec: { ...SHIFT_DOWN_SPEC }, delayMs: 0 } });
    out.push({ at: up, prio: 0, ev: { kind: "keyUp", ch: "", spec: { ...SHIFT_UP_SPEC }, delayMs: 0 } });
  }

  out.sort((a, b) => a.at - b.at || a.prio - b.prio);
  const events: HumanKeystroke[] = [];
  let prevAt = 0;
  for (const item of out) {
    const delayMs = Math.max(0, Math.round((item.at - prevAt) / speed));
    events.push({ ...item.ev, delayMs });
    prevAt = item.at;
  }
  return {
    events,
    typos,
    typoKinds,
    chars: chars.length,
    durationMs: Math.round((out.at(-1)?.at ?? 0) / speed),
  };
}
