/**
 * Natural typing v2: speed, rhythm, rollover, real Shift, and typo policy.
 * Every assertion runs against the pure planner, so it is deterministic and instant.
 */
import { describe, expect, test } from "bun:test";
import { createSeededRng } from "../src/natural";
import {
  classifyFieldKind,
  planTyping,
  type HumanKeystroke,
  type HumanTypingOptions,
  type TypingPlan,
} from "../src/typing";

const PROSE =
  "The quick brown fox jumps over the lazy dog. She packed her bag before dawn, then walked to the station. " +
  "It was cold enough that the platform lights looked warm. Nobody spoke on the train.";

const SEEDS = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const plan = (text: string, seed: number, opts: HumanTypingOptions = {}): TypingPlan =>
  planTyping(text, { rng: createSeededRng(seed), ...opts });

/** Replay as a text editor: Shift and keyUp insert nothing, Backspace deletes one. */
function replay(events: HumanKeystroke[]): string {
  let buf = "";
  for (const ev of events) {
    if (ev.kind === "insert") buf += ev.text;
    else if (ev.kind !== "keyDown") continue;
    else if (ev.spec.key === "Backspace") buf = buf.slice(0, -1);
    else if (ev.spec.text !== undefined) buf += ev.spec.text === "\r" ? "\n" : ev.spec.text;
  }
  return buf;
}

type Key = { ch: string; down: number; up: number; mod?: number };

/** Character keys in absolute time, each keyUp paired with its keyDown (rollover keeps that order). */
function charKeys(events: HumanKeystroke[]) {
  let t = 0;
  const keys: Key[] = [];
  const shiftDowns: number[] = [];
  const shiftUps: number[] = [];
  const open: Array<Omit<Key, "up">> = [];
  for (const ev of events) {
    t += ev.delayMs;
    if (ev.kind === "insert") continue;
    if (ev.spec.key === "Backspace") continue;
    if (ev.spec.key === "Shift") (ev.kind === "keyDown" ? shiftDowns : shiftUps).push(t);
    else if (ev.kind === "keyDown") open.push({ ch: ev.ch, down: t, mod: ev.spec.modifiers });
    else keys.push({ ...open.shift()!, up: t });
  }
  return { keys, shiftDowns, shiftUps };
}

type Gap = { ms: number; a: string; b: string; shifted: boolean };

function gaps(keys: Key[]): Gap[] {
  return keys.slice(1).map((b, i) => {
    const a = keys[i]!;
    return { ms: b.down - a.down, a: a.ch, b: b.ch, shifted: (a.mod ?? 0) !== 0 || (b.mod ?? 0) !== 0 };
  });
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const wpm = (text: string, p: TypingPlan): number => (text.length / 5) / (p.durationMs / 60000);

describe("typing v2: determinism and replay", () => {
  test("the same seed rebuilds the same plan, a new seed does not", () => {
    expect(plan(PROSE, 99)).toEqual(plan(PROSE, 99));
    expect(plan(PROSE, 100)).not.toEqual(plan(PROSE, 99));
  });

  test("every plan replays to the exact text, including under heavy typos and any speed", () => {
    const samples = [
      "Hello, World!",
      "seth@example.com",
      "+1 (555) 123-4567",
      "2026-11-27",
      "https://example.com/a?b=c&d=e",
      PROSE,
      "  leading and trailing  ",
      "ünïcodé and 絵文字 mixed 🚀 with ASCII",
      "",
    ];
    for (const text of samples) for (const seed of SEEDS(15)) expect(replay(plan(text, seed).events)).toBe(text);
    for (const speedFactor of [0.85, 1, 1.15]) expect(replay(plan(PROSE, 4, { speedFactor }).events)).toBe(PROSE);
    const heavy = "abcdefghij klmnopqrst uvwxyz 0123456789";
    for (const seed of SEEDS(40)) {
      const p = plan(heavy, seed, { typoRate: 0.6, maxTypos: 30 });
      expect(p.typos).toBeGreaterThan(3);
      expect(replay(p.events)).toBe(heavy);
    }
  });
});

describe("typing v2: speed, rhythm and rollover", () => {
  test("median prose speed lands in the 75-95 wpm band", () => {
    const med = median(SEEDS(40).map((seed) => wpm(PROSE, plan(PROSE, seed))));
    expect(med).toBeGreaterThanOrEqual(75);
    expect(med).toBeLessThanOrEqual(95);
  });

  test("within-word gaps sit in 45-100 ms, nothing under 40 ms, and pauses stay rare", () => {
    const all = SEEDS(20).flatMap((seed) => gaps(charKeys(plan(PROSE, seed).events).keys));
    const intra = median(all.filter((g) => g.a !== " " && g.b !== " " && !g.shifted && !/[.!?,;:]/.test(g.a)).map((g) => g.ms));
    expect(intra).toBeGreaterThanOrEqual(45);
    expect(intra).toBeLessThanOrEqual(100);
    expect(Math.min(...all.map((g) => g.ms))).toBeGreaterThanOrEqual(40);
    const pauseShare = all.filter((g) => g.ms >= 300).length / all.length;
    expect(pauseShare).toBeGreaterThan(0.02);
    expect(pauseShare).toBeLessThan(0.2);
    expect(median(all.filter((g) => g.a === " " && !g.shifted).map((g) => g.ms))).toBeGreaterThan(intra);
  });

  test("the next key goes down before the previous comes up on 20-40% of fast pairs", () => {
    let fast = 0;
    let rolled = 0;
    for (const seed of SEEDS(25)) {
      const keys = charKeys(plan(PROSE, seed).events).keys;
      for (let i = 0; i + 1 < keys.length; i++) {
        const [a, b] = [keys[i]!, keys[i + 1]!];
        if (b.down - a.down > 130 || /\s/.test(a.ch)) continue;
        fast++;
        if (b.down < a.up) rolled++;
      }
    }
    expect(fast).toBeGreaterThan(200);
    expect(rolled / fast).toBeGreaterThanOrEqual(0.2);
    expect(rolled / fast).toBeLessThanOrEqual(0.4);
  });

  test("every key is released and no key is left down", () => {
    for (const seed of SEEDS(10)) {
      const held = new Map<string, number>();
      for (const ev of plan("Hello there, friend!", seed).events) {
        if (ev.kind === "insert") continue;
        const key = `${ev.spec.key}:${ev.ch}`;
        held.set(key, (held.get(key) ?? 0) + (ev.kind === "keyDown" ? 1 : -1));
      }
      for (const count of held.values()) expect(count).toBe(0);
    }
  });
});

describe("typing v2: real modifiers", () => {
  test("Shift goes down before and up after every capital and shifted symbol", () => {
    const text = "Hello Big World: 2026! (yes) @ $5 total?";
    const { keys, shiftDowns, shiftUps } = charKeys(plan(text, 5).events);
    expect(shiftDowns.length).toBeGreaterThan(0);
    expect(shiftDowns.length).toBe(shiftUps.length);
    const shifted = keys.filter((k) => /^[A-Z]$/.test(k.ch) || /[!@#$%^&*()_+{}|:"<>?~]/.test(k.ch));
    expect(shifted.length).toBeGreaterThan(5);
    for (const key of shifted) {
      const down = shiftDowns.filter((d) => d <= key.down).at(-1)!;
      const up = shiftUps.find((u) => u >= key.up)!;
      expect(key.mod).toBe(8);
      expect(key.down - down).toBeGreaterThanOrEqual(25);
      expect(key.down - down).toBeLessThanOrEqual(95);
      expect(up - key.up).toBeGreaterThanOrEqual(15);
      expect(up - key.up).toBeLessThanOrEqual(80);
    }
    // Consecutive capitals hold one Shift across the run.
    const nasa = charKeys(plan("NASA", 8).events);
    expect(nasa.shiftDowns).toHaveLength(1);
    expect(nasa.shiftUps).toHaveLength(1);
    expect(replay(plan("NASA", 8).events)).toBe("NASA");
  });
});

describe("typing v2: typos", () => {
  test("typo rates stay in band per field kind, every kind appears, every typo is corrected", () => {
    const stats = (text: string, seeds: number, opts: HumanTypingOptions = {}) => {
      let typos = 0;
      let chars = 0;
      let backspaces = 0;
      const kinds = new Set<string>();
      for (const seed of SEEDS(seeds)) {
        const p = plan(text, seed, opts);
        typos += p.typos;
        chars += p.chars;
        backspaces += p.events.filter((e) => e.kind === "keyDown" && e.spec.key === "Backspace").length;
        for (const kind of p.typoKinds) kinds.add(kind);
      }
      return { rate: typos / chars, kinds, typos, backspaces };
    };
    const prose = stats(PROSE.repeat(2).toLowerCase(), 120, { maxTypos: 40 });
    expect(prose.rate).toBeGreaterThanOrEqual(0.015);
    expect(prose.rate).toBeLessThanOrEqual(0.03);
    expect(prose.backspaces).toBeGreaterThanOrEqual(prose.typos);
    for (const kind of ["adjacent", "transpose", "double", "drop"]) expect(prose.kinds.has(kind)).toBe(true);
    const email = stats("someone@example.com", 300, { fieldKind: classifyFieldKind("someone@example.com") });
    expect(email.rate).toBeGreaterThanOrEqual(0.005);
    expect(email.rate).toBeLessThanOrEqual(0.01);
  });
});

describe("typing v2: no typos where they would hurt", () => {
  test("fast, keys, focused and secure fields (fieldKind none) never type a typo", () => {
    for (const seed of SEEDS(30)) {
      const p = plan(PROSE, seed, { fieldKind: "none" });
      expect(p.typos).toBe(0);
      expect(replay(p.events)).toBe(PROSE);
    }
  });

  test("classifyFieldKind reads field shapes and labels", () => {
    for (const text of ["seth@example.com", "+1 (555) 123-4567", "2026-11-27", "https://example.com/x", "12345"]) {
      expect(classifyFieldKind(text)).toBe("structured");
    }
    for (const text of ["Seth", "The quick brown fox"]) expect(classifyFieldKind(text)).toBe("prose");
    expect(classifyFieldKind("Seth", "Email address")).toBe("structured");
  });
});
