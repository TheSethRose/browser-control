/**
 * Natural typing v2: speed, rhythm, rollover, real Shift, and typo policy.
 * Every assertion runs against the pure planner, so it is deterministic and instant.
 */
import { describe, expect, test } from "bun:test";
import { createSeededRng } from "../src/natural";
import {
  buildHumanKeystrokes,
  classifyFieldKind,
  keySpecForChar,
  planTyping,
  QWERTY_NEIGHBORS,
  type HumanKeystroke,
} from "../src/typing";

const PROSE =
  "The quick brown fox jumps over the lazy dog. She packed her bag before dawn, then walked to the station. " +
  "It was cold enough that the platform lights looked warm. Nobody spoke on the train.";

type Absolute = { t: number; ev: HumanKeystroke };

function timeline(events: HumanKeystroke[]): Absolute[] {
  let t = 0;
  return events.map((ev) => {
    t += ev.delayMs;
    return { t, ev };
  });
}

/** Replay as a text editor. Shift key events insert nothing. */
function replay(events: HumanKeystroke[]): string {
  let buf = "";
  for (const ev of events) {
    if (ev.kind === "insert") {
      buf += ev.text;
      continue;
    }
    if (ev.kind !== "keyDown") continue;
    if (ev.spec.key === "Shift") continue;
    if (ev.spec.key === "Backspace") {
      buf = buf.slice(0, -1);
      continue;
    }
    if (ev.spec.text !== undefined) buf += ev.spec.text === "\r" ? "\n" : ev.spec.text;
  }
  return buf;
}

const isCharKey = (ev: HumanKeystroke): boolean =>
  ev.kind !== "insert" && ev.ch !== "" && ev.spec.key !== "Shift";

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

const wpm = (text: string, plan: { durationMs: number }): number =>
  (text.length / 5) / (plan.durationMs / 60000);

type KeySpan = { ch: string; down: number; up: number };

/** Pair each character keyUp with its keyDown, in order (rollover keeps that order). */
function keySpans(events: HumanKeystroke[]): KeySpan[] {
  const abs = timeline(events).filter((a) => isCharKey(a.ev));
  const downs: number[] = [];
  const chs: string[] = [];
  const ups: number[] = [];
  for (const a of abs) {
    if (a.ev.kind === "keyDown") {
      downs.push(a.t);
      chs.push(a.ev.ch);
    } else {
      ups.push(a.t);
    }
  }
  return downs.map((down, i) => ({ ch: chs[i]!, down, up: ups[i] ?? down }));
}

type Episode = { wrong: string[]; right: string[] };

/** Recover every typo episode: the characters typed before a Backspace run and the retype after it. */
function typoEpisodes(events: HumanKeystroke[]): Episode[] {
  const steps: Array<{ bs: boolean; ch: string }> = [];
  for (const ev of events) {
    if (ev.kind !== "keyDown") continue;
    if (ev.spec.key === "Shift") continue;
    if (ev.spec.key === "Backspace") steps.push({ bs: true, ch: "" });
    else if (ev.spec.text !== undefined) steps.push({ bs: false, ch: ev.spec.text });
  }
  const buffer: string[] = [];
  const episodes: Episode[] = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i]!;
    if (!step.bs) {
      buffer.push(step.ch);
      i++;
      continue;
    }
    let n = 0;
    while (i + n < steps.length && steps[i + n]!.bs) n++;
    const wrong = buffer.slice(-n);
    buffer.length -= n;
    i += n;
    const right: string[] = [];
    while (i < steps.length && !steps[i]!.bs && right.length <= n + 1) {
      const ch = steps[i]!.ch;
      right.push(ch);
      buffer.push(ch);
      i++;
    }
    episodes.push({ wrong, right });
  }
  return episodes;
}

function gaps(events: HumanKeystroke[]): Array<{ ms: number; a: string; b: string; shifted: boolean }> {
  const spans = keySpans(events);
  const out: Array<{ ms: number; a: string; b: string; shifted: boolean }> = [];
  for (let i = 0; i + 1 < spans.length; i++) {
    const a = spans[i]!;
    const b = spans[i + 1]!;
    out.push({
      ms: b.down - a.down,
      a: a.ch,
      b: b.ch,
      shifted: (keySpecForChar(a.ch)?.modifiers ?? 0) !== 0 || (keySpecForChar(b.ch)?.modifiers ?? 0) !== 0,
    });
  }
  return out;
}

describe("typing v2: determinism", () => {
  test("the same seed produces the same plan", () => {
    const a = planTyping(PROSE, { rng: createSeededRng(99) });
    const b = planTyping(PROSE, { rng: createSeededRng(99) });
    expect(a).toEqual(b);
    const c = planTyping(PROSE, { rng: createSeededRng(100) });
    expect(c).not.toEqual(a);
  });
});

describe("typing v2: speed and rhythm", () => {
  test("median prose speed lands in the 75-95 wpm band", () => {
    const rates: number[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      rates.push(wpm(PROSE, planTyping(PROSE, { rng: createSeededRng(seed) })));
    }
    const med = median(rates);
    expect(med).toBeGreaterThanOrEqual(75);
    expect(med).toBeLessThanOrEqual(95);
  });

  test("within-word gaps sit in 45-100 ms, nothing below 40 ms, and pauses happen", () => {
    const intra: number[] = [];
    const all: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const plan = planTyping(PROSE, { rng: createSeededRng(seed) });
      for (const g of gaps(plan.events)) {
        all.push(g.ms);
        const wordish = g.a !== " " && g.b !== " " && !/[.!?,;:]/.test(g.a);
        if (wordish && !g.shifted) intra.push(g.ms);
      }
    }
    const intraMedian = median(intra);
    expect(intraMedian).toBeGreaterThanOrEqual(45);
    expect(intraMedian).toBeLessThanOrEqual(100);
    expect(Math.min(...all)).toBeGreaterThanOrEqual(40);
    const pauseShare = all.filter((ms) => ms >= 300).length / all.length;
    expect(pauseShare).toBeGreaterThan(0.02);
    expect(pauseShare).toBeLessThan(0.2);
  });

  test("word boundaries are slower than within-word letters", () => {
    const plan = planTyping(PROSE, { rng: createSeededRng(11) });
    const gs = gaps(plan.events);
    const boundary = gs.filter((g) => g.a === " " && !g.shifted).map((g) => g.ms);
    const intra = gs.filter((g) => g.a !== " " && g.b !== " " && !g.shifted && !/[.!?,;:]/.test(g.a)).map((g) => g.ms);
    expect(boundary.length).toBeGreaterThan(10);
    expect(median(boundary)).toBeGreaterThan(median(intra));
    expect(Math.min(...boundary)).toBeGreaterThanOrEqual(118);
  });
});

describe("typing v2: rollover", () => {
  test("the next key goes down before the previous comes up on 20-40% of fast pairs", () => {
    let fast = 0;
    let rolled = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const spans = keySpans(planTyping(PROSE, { rng: createSeededRng(seed) }).events);
      for (let i = 0; i + 1 < spans.length; i++) {
        const a = spans[i]!;
        const b = spans[i + 1]!;
        if (b.down - a.down > 130) continue;
        if (a.ch === " " || b.ch === " " || /\s/.test(a.ch)) continue;
        fast++;
        if (b.down < a.up) rolled++;
      }
    }
    expect(fast).toBeGreaterThan(200);
    const share = rolled / fast;
    expect(share).toBeGreaterThanOrEqual(0.2);
    expect(share).toBeLessThanOrEqual(0.4);
  });

  test("every key is released, and no key is left down at the end", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const events = planTyping("Hello there, friend!", { rng: createSeededRng(seed) }).events;
      const downs = new Map<string, number>();
      for (const ev of events) {
        if (ev.kind === "keyDown") downs.set(ev.spec.key + (ev.ch || ""), (downs.get(ev.spec.key + (ev.ch || "")) ?? 0) + 1);
        if (ev.kind === "keyUp") downs.set(ev.spec.key + (ev.ch || ""), (downs.get(ev.spec.key + (ev.ch || "")) ?? 0) - 1);
      }
      for (const count of downs.values()) expect(count).toBe(0);
    }
  });
});

describe("typing v2: real modifiers", () => {
  test("Shift goes down before and up after every capital and shifted symbol", () => {
    const text = "Hello Big World: 2026! (yes) @ $5 total?";
    const events = planTyping(text, { rng: createSeededRng(5) }).events;
    const abs = timeline(events);
    const shiftDowns = abs.filter((a) => a.ev.kind === "keyDown" && a.ev.spec.key === "Shift").map((a) => a.t);
    const shiftUps = abs.filter((a) => a.ev.kind === "keyUp" && a.ev.spec.key === "Shift").map((a) => a.t);
    expect(shiftDowns.length).toBeGreaterThan(0);
    expect(shiftDowns.length).toBe(shiftUps.length);
    const charKeys = abs.filter((a) => a.ev.kind === "keyDown" && isCharKey(a.ev)) as Array<{ t: number; ev: HumanKeystroke }>;
    for (const key of charKeys) {
      if (key.ev.kind !== "keyDown") continue;
      const shifted = /^[A-Z]$/.test(key.ev.ch) || /[!@#$%^&*()_+{}|:"<>?~]/.test(key.ev.ch);
      if (!shifted) continue;
      const down = shiftDowns.filter((t) => t <= key.t).at(-1);
      const keyUp = abs.find((a) => a.ev.kind === "keyUp" && isCharKey(a.ev) && a.t >= key.t)!.t;
      const up = shiftUps.filter((t) => t >= keyUp)[0];
      expect(key.ev.spec.modifiers).toBe(8);
      expect(down).toBeDefined();
      const lead = key.t - down!;
      expect(lead).toBeGreaterThanOrEqual(25);
      expect(lead).toBeLessThanOrEqual(95);
      expect(up).toBeDefined();
      const lag = up! - keyUp;
      expect(lag).toBeGreaterThanOrEqual(15);
      expect(lag).toBeLessThanOrEqual(80);
    }
  });

  test("consecutive capitals hold Shift across the run", () => {
    const events = planTyping("NASA", { rng: createSeededRng(8) }).events;
    expect(events.filter((e) => e.kind === "keyDown" && e.spec.key === "Shift")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "keyUp" && e.spec.key === "Shift")).toHaveLength(1);
    expect(replay(events)).toBe("NASA");
  });
});

describe("typing v2: typos", () => {
  test("prose typo rate stays in the 1.5-3% band and every kind appears", () => {
    const text = PROSE.repeat(2).toLowerCase();
    let typos = 0;
    let chars = 0;
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 120; seed++) {
      const plan = planTyping(text, { rng: createSeededRng(seed), maxTypos: 40 });
      typos += plan.typos;
      chars += plan.chars;
      for (const kind of plan.typoKinds) kinds.add(kind);
    }
    const rate = typos / chars;
    expect(rate).toBeGreaterThanOrEqual(0.015);
    expect(rate).toBeLessThanOrEqual(0.03);
    expect(kinds.has("adjacent")).toBe(true);
    expect(kinds.has("transpose")).toBe(true);
    expect(kinds.has("double")).toBe(true);
    expect(kinds.has("drop")).toBe(true);
  });

  test("structured fields type typos at 0.5-1%", () => {
    let typos = 0;
    let chars = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const plan = planTyping("someone@example.com", { rng: createSeededRng(seed), fieldKind: classifyFieldKind("someone@example.com") });
      typos += plan.typos;
      chars += plan.chars;
    }
    const rate = typos / chars;
    expect(rate).toBeGreaterThanOrEqual(0.005);
    expect(rate).toBeLessThanOrEqual(0.01);
  });

  test("noticed 0-4 characters later, then fixed with fast Backspace and a retype", () => {
    const plan = planTyping(PROSE, { rng: createSeededRng(21) });
    const steps: Array<{ bs: boolean; gap: number }> = [];
    let lastChar = 0;
    let t = 0;
    for (const ev of plan.events) {
      t += ev.delayMs;
      if (ev.kind !== "keyDown") continue;
      if (ev.spec.key === "Shift") continue;
      if (ev.spec.key === "Backspace") {
        steps.push({ bs: true, gap: 0 });
        lastChar = t;
      } else {
        if (steps.length && steps.at(-1)!.bs) steps.at(-1)!.gap = t - lastChar;
        steps.push({ bs: false, gap: 0 });
      }
    }
    expect(plan.typos).toBeGreaterThan(0);
    const episodes = typoEpisodes(plan.events);
    expect(episodes.length).toBeGreaterThan(0);
    for (const e of episodes) expect(e.wrong.length).toBeLessThanOrEqual(6);
    // Consecutive Backspaces inside one correction are fast (50-110 ms).
    const abs = timeline(plan.events).filter((a) => isCharKey(a.ev) || (a.ev.kind === "keyDown" && a.ev.spec.key === "Backspace"));
    let run: number[] = [];
    for (const a of abs) {
      if (a.ev.kind === "keyDown" && a.ev.spec.key === "Backspace") run.push(a.t);
      else {
        run = [];
        continue;
      }
      if (run.length >= 2) {
        const d = run.at(-1)! - run.at(-2)!;
        expect(d).toBeGreaterThanOrEqual(45);
        expect(d).toBeLessThanOrEqual(115);
      }
    }
  });
});

describe("typing v2: replay", () => {
  test("every plan rebuilds the requested text exactly", () => {
    const samples = [
      "Hello, World!",
      "seth@example.com",
      "+1 (555) 123-4567",
      "2026-11-27",
      "https://example.com/a?b=c&d=e",
      "The quick brown fox jumps over the lazy dog.",
      "  leading and trailing  ",
      "ünïcodé and 絵文字 mixed 🚀 with ASCII",
      "",
    ];
    for (const text of samples) {
      for (let seed = 1; seed <= 25; seed++) {
        expect(replay(buildHumanKeystrokes(text, { rng: createSeededRng(seed) }))).toBe(text);
      }
    }
  });

  test("heavy typos still rebuild the text exactly", () => {
    const text = "abcdefghij klmnopqrst uvwxyz 0123456789";
    for (let seed = 1; seed <= 40; seed++) {
      const plan = planTyping(text, { rng: createSeededRng(seed), typoRate: 0.6, maxTypos: 30 });
      expect(plan.typos).toBeGreaterThan(3);
      expect(replay(plan.events)).toBe(text);
    }
  });

  test("the speed factor never changes the text", () => {
    for (const factor of [0.85, 1, 1.15]) {
      const plan = planTyping(PROSE, { rng: createSeededRng(4), speedFactor: factor });
      expect(replay(plan.events)).toBe(PROSE);
    }
  });
});

describe("typing v2: no typos where they would hurt", () => {
  test("fieldKind none (fast, keys, secure, focused) never types a typo", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const plan = planTyping(PROSE, { rng: createSeededRng(seed), fieldKind: "none" });
      expect(plan.typos).toBe(0);
      expect(replay(plan.events)).toBe(PROSE);
    }
  });

  test("classifyFieldKind reads field shapes and labels", () => {
    expect(classifyFieldKind("seth@example.com")).toBe("structured");
    expect(classifyFieldKind("+1 (555) 123-4567")).toBe("structured");
    expect(classifyFieldKind("2026-11-27")).toBe("structured");
    expect(classifyFieldKind("https://example.com/x")).toBe("structured");
    expect(classifyFieldKind("12345")).toBe("structured");
    expect(classifyFieldKind("Seth", "Email address")).toBe("structured");
    expect(classifyFieldKind("The quick brown fox")).toBe("prose");
    expect(classifyFieldKind("Seth")).toBe("prose");
  });
});
