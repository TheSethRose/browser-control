/**
 * Natural typing v2: speed, rhythm, rollover, real Shift, and typo policy.
 * Every assertion runs against the pure planner, so it is deterministic and instant.
 */
import { describe, expect, test } from "bun:test";
import { createSeededRng } from "../src/natural";
import { classifyFieldKind, planTyping, type HumanKeystroke, type HumanTypingOptions, type TypingPlan } from "../src/typing";

const PROSE =
  "The quick brown fox jumps over the lazy dog. She packed her bag before dawn, then walked to the station. " +
  "It was cold enough that the platform lights looked warm. Nobody spoke on the train.";
const SEEDS = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const plan = (text: string, seed: number, opts: HumanTypingOptions = {}): TypingPlan =>
  planTyping(text, { rng: createSeededRng(seed), fieldKind: "prose", ...opts });
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const wpm = (text: string, p: TypingPlan): number => (text.length / 5) / (p.durationMs / 60000);
const both = (a: boolean, b: boolean) => expect([a, b]).toEqual([true, true]);

/** Replay as a text editor: Shift and keyUp insert nothing, Backspace deletes one grapheme. */
function replay(events: HumanKeystroke[]): string {
  let buf = "";
  for (const ev of events) {
    if (ev.kind === "insert") buf += ev.text;
    else if (ev.kind !== "keyDown") continue;
    else if (ev.spec.key === "Backspace") buf = [...new Intl.Segmenter().segment(buf)].slice(0, -1).map((g) => g.segment).join("");
    else if (ev.spec.text !== undefined) buf += ev.spec.text === "\r" ? "\n" : ev.spec.text;
  }
  return buf;
}

type Down = { ch: string; down: number; mod?: number };
/** Character keys in absolute time, each keyUp paired with its keyDown (rollover keeps that order). */
function charKeys(events: HumanKeystroke[]) {
  let t = 0;
  const keys: Array<Down & { up: number }> = [], shiftDowns: number[] = [], shiftUps: number[] = [], open: Down[] = [];
  for (const ev of events) {
    t += ev.delayMs;
    if (ev.kind === "insert" || ev.spec.key === "Backspace") continue;
    if (ev.spec.key === "Shift") (ev.kind === "keyDown" ? shiftDowns : shiftUps).push(t);
    else if (ev.kind === "keyDown") open.push({ ch: ev.ch, down: t, mod: ev.spec.modifiers });
    else keys.push({ ...open.shift()!, up: t });
  }
  return { keys, shiftDowns, shiftUps };
}

const gaps = (keys: Array<Down & { up: number }>) =>
  keys.slice(1).map((b, i) => ({ ms: b.down - keys[i]!.down, a: keys[i]!.ch, b: b.ch, shifted: Boolean(keys[i]!.mod || b.mod) }));

describe("typing v2", () => {
  test("the same seed rebuilds the same plan, a new seed does not", () => {
    expect(plan(PROSE, 99)).toEqual(plan(PROSE, 99));
    expect(plan(PROSE, 100)).not.toEqual(plan(PROSE, 99));
  });

  test("every plan replays to the exact text, including under heavy typos and any speed", () => {
    const samples = ["Hello, World!", "seth@example.com", "+1 (555) 123-4567", "2026-11-27", "https://example.com/a?b=c&d=e", PROSE, "  leading and trailing  ", "ünïcodé and 絵文字 mixed 🚀 with ASCII", ""];
    for (const text of samples) for (const seed of SEEDS(15)) expect(replay(plan(text, seed).events)).toBe(text);
    for (const speedFactor of [0.85, 1, 1.15]) expect(replay(plan(PROSE, 4, { speedFactor }).events)).toBe(PROSE);
    for (const heavy of ["abcdefghij klmnopqrst uvwxyz 0123456789", "cafe\u0301xyz nai\u0308ve 👍🏽ok Ünï", "\u0600abcdef"]) {
      for (const seed of SEEDS(40)) {
        const p = plan(heavy, seed, { typoRate: 0.6, maxTypos: 30 });
        both(p.typos > 0, replay(p.events) === heavy);
      }
    }
    for (const seed of SEEDS(40)) {
      for (const ev of plan("2026 1127 5550", seed, { typoRate: 0.6, maxTypos: 9 }).events) {
        if (ev.kind === "keyDown" && ev.spec.text) expect(ev.spec.text).toMatch(/^[\d ]$/);
      }
    }
  });

  test("median prose speed lands in the 75-95 wpm band, and Shift barely slows title case", () => {
    const meds = [PROSE, PROSE.replace(/\b[a-z]/g, (c) => c.toUpperCase())].map((text) => {
      const med = median(SEEDS(61).map((seed) => wpm(text, plan(text, seed))));
      expect(med).toBeWithin(75, 95);
      return med;
    });
    expect(meds[1]! / meds[0]!).toBeGreaterThanOrEqual(0.98);
  });

  test("within-word gaps sit in 45-100 ms, nothing under 40 ms, and pauses stay rare", () => {
    const all = SEEDS(20).flatMap((seed) => gaps(charKeys(plan(PROSE, seed).events).keys));
    const intra = median(all.filter((g) => g.a !== " " && g.b !== " " && !g.shifted && !/[.!?,;:]/.test(g.a)).map((g) => g.ms));
    expect(intra).toBeWithin(45, 100);
    expect(Math.min(...all.map((g) => g.ms))).toBeGreaterThanOrEqual(40);
    const pauseShare = all.filter((g) => g.ms >= 300).length / all.length;
    expect(pauseShare).toBeWithin(0.02, 0.2);
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
    expect(rolled / fast).toBeWithin(0.2, 0.4);
  });

  test("Shift goes down before and up after every capital and shifted symbol", () => {
    const text = "Hello Big World: 2026! (yes) @ $5 total?";
    const { keys, shiftDowns, shiftUps } = charKeys(plan(text, 5).events);
    both(shiftDowns.length > 0, shiftDowns.length === shiftUps.length);
    const shifted = keys.filter((k) => /^[A-Z]$/.test(k.ch) || /[!@#$%^&*()_+{}|:"<>?~]/.test(k.ch));
    expect(shifted.length).toBeGreaterThan(5);
    for (const key of shifted) {
      const down = shiftDowns.filter((d) => d <= key.down).at(-1)!;
      const up = shiftUps.find((u) => u >= key.up)!;
      expect(key.mod).toBe(8);
      expect(key.down - down).toBeWithin(25, 95);
      expect(up - key.up).toBeWithin(15, 80);
    }
    // In dispatch order, Shift is down exactly while a Shift-bit key goes down; every key comes up.
    for (const t of ["aAaAa", text, PROSE]) {
      for (const seed of SEEDS(30)) {
        let down = false;
        const held = new Set<string>();
        for (const ev of plan(t, seed).events) {
          if (ev.kind === "insert") continue;
          held[ev.kind === "keyDown" ? "add" : "delete"](`${ev.spec.key}:${ev.ch}`);
          if (ev.spec.key !== "Shift") {
            if (ev.kind === "keyDown") expect((ev.spec.modifiers ?? 0) === 8).toBe(down);
            continue;
          }
          expect(down).toBe(ev.kind === "keyUp");
          down = ev.kind === "keyDown";
        }
        expect([down, held.size]).toEqual([false, 0]);
      }
    }
    // Consecutive capitals hold one Shift across the run.
    const nasa = charKeys(plan("NASA", 8).events);
    expect([nasa.shiftDowns.length, nasa.shiftUps.length]).toEqual([1, 1]);
    expect(replay(plan("NASA", 8).events)).toBe("NASA");
  });

  test("typo rates stay in band per field kind, every kind appears, every typo is corrected", () => {
    const stats = (text: string, seeds: number, opts: HumanTypingOptions = {}) => {
      let [typos, chars, backspaces] = [0, 0, 0];
      const kinds = new Set<string>();
      for (const seed of SEEDS(seeds)) {
        const p = plan(text, seed, opts);
        [typos, chars] = [typos + p.typos, chars + p.chars];
        backspaces += p.events.filter((e) => e.kind === "keyDown" && e.spec.key === "Backspace").length;
        for (const kind of p.typoKinds) kinds.add(kind);
      }
      return { rate: typos / chars, kinds, typos, backspaces };
    };
    const prose = stats(PROSE.repeat(2).toLowerCase(), 120, { maxTypos: 40 });
    expect(prose.rate).toBeWithin(0.015, 0.03);
    expect(prose.backspaces).toBeGreaterThanOrEqual(prose.typos);
    for (const kind of ["adjacent", "transpose", "double", "drop"]) expect(prose.kinds.has(kind)).toBe(true);
    const email = stats("someone@example.com", 300, { fieldKind: classifyFieldKind("someone@example.com") });
    expect(email.rate).toBeWithin(0.005, 0.01);
  });

  test("fieldKind none, the default, never types a typo", () => {
    for (const seed of SEEDS(30)) {
      const p = planTyping(PROSE, { rng: createSeededRng(seed) });
      expect([p.typos, replay(p.events)]).toEqual([0, PROSE]);
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
