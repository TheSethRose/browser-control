/**
 * Pure planners for natural browsing motion, click targeting, timing, and wheel scroll.
 *
 * Every planner takes an injectable `rng` (see `createSeededRng`) and returns plain data
 * (points + millisecond delays) with no I/O or timers so tests are deterministic and instant.
 */
import { readFileSync } from "node:fs";
import { configFilePath } from "./backends/router";

export interface Point2D {
  x: number;
  y: number;
}

export interface Box2D {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface PointerStep {
  x: number;
  y: number;
  delayMs: number;
}

export interface PointerPathOptions {
  from?: Point2D;
  to: Point2D;
  viewport?: Viewport;
  targetSize?: number;
  maxSteps?: number;
  overshootProb?: number;
  rng?: () => number;
}

export interface PointerPathPlan {
  start: Point2D;
  steps: PointerStep[];
  /** Main arc duration in ms (0 for <3 px short moves; otherwise 90–460 ms). */
  durationMs: number;
  /** Overshoot return duration in ms (0 when no overshoot; otherwise 45–85 ms). */
  overshootDurationMs: number;
  /** Total duration across all steps in ms. */
  totalDurationMs: number;
  overshot: boolean;
  arcSteps: number;
  overshootSteps: number;
  /** Signed perpendicular Bezier bow magnitude in px (|bowPx| <= 110). */
  bowPx: number;
}

export interface ClickTimingPlan {
  /** Hover dwell before mousePressed (45–115 ms). */
  dwellMs: number;
  /** Press-to-release hold per click (55–130 ms each). */
  holdsMs: number[];
  /** Inter-click gaps for multi-click (65–135 ms each). */
  gapsMs: number[];
}

export interface WheelEventStep {
  deltaY: number;
  delayMs: number;
}

export interface WheelFlickPlan {
  deltaY: number;
  events: WheelEventStep[];
  durationMs: number;
  pauseAfterMs: number;
}

export interface WheelScrollPlan {
  flicks: WheelFlickPlan[];
  totalDeltaY: number;
  totalDurationMs: number;
}

export interface NaturalSwitchOptions {
  env?: Record<string, string | undefined>;
  configFile?: string;
  defaultEnabled?: boolean;
}

export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 };

/** Minimum forward room past the target before an overshoot leg is worth adding. */
const OVERSHOOT_MIN_ROOM_PX = 4;

/** 32-bit Mulberry32 PRNG returning values in [0, 1). */
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function randBetween(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function triangular(rng: () => number, min: number, max: number): number {
  return min + ((rng() + rng()) / 2) * (max - min);
}

/** Minimum-jerk easing polynomial: slow start, fast middle, slow arrival */
function minimumJerk(u: number): number {
  const t = clamp(u, 0, 1);
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

function clampToViewport(pt: Point2D, viewport: Viewport): Point2D {
  const maxX = Math.max(0, viewport.width - 1);
  const maxY = Math.max(0, viewport.height - 1);
  return {
    x: round1(clamp(pt.x, 0, maxX)),
    y: round1(clamp(pt.y, 0, maxY)),
  };
}

function parseBoolSetting(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  return undefined;
}

function readOneLine(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}

export function naturalConfigFilePath(): string {
  return configFilePath("natural");
}

/**
 * Determine whether natural browsing is enabled for this call.
 * Precedence:
 *   1. `input.fast === true` -> false (fast)
 *   2. env `BROWSER_CONTROL_NATURAL` (`on`/`off`/`1`/`0`/`true`/`false`)
 *   3. one-line file `~/.config/browser-control/natural` (`on`/`off`, read per call, honoring XDG_CONFIG_HOME)
 *   4. default true
 */
export function isNaturalEnabled(
  input?: Record<string, unknown>,
  options: NaturalSwitchOptions = {},
): boolean {
  if (input?.["fast"] === true) return false;
  const env = options.env ?? process.env;
  const fromEnv = parseBoolSetting(env["BROWSER_CONTROL_NATURAL"]);
  if (fromEnv !== undefined) return fromEnv;
  const file = options.configFile ?? naturalConfigFilePath();
  const fromFile = parseBoolSetting(readOneLine(file));
  if (fromFile !== undefined) return fromFile;
  return options.defaultEnabled ?? true;
}

/**
 * Pick one axis of a synthesized start: `minMag`–`maxMag` px from `to`, on a side that has
 * room for the minimum offset. When neither side has room, use the farthest in-viewport point.
 */
function synthesizeAxis(
  to: number,
  lo: number,
  hi: number,
  minMag: number,
  maxMag: number,
  rng: () => number,
): number {
  const plusRoom = hi - to;
  const minusRoom = to - lo;
  const canPlus = plusRoom >= minMag;
  const canMinus = minusRoom >= minMag;
  if (!canPlus && !canMinus) return plusRoom >= minusRoom ? hi : lo; // also covers an off-screen `to`

  let sign = rng() < 0.5 ? -1 : 1;
  if (!canPlus) sign = -1;
  else if (!canMinus) sign = 1;

  const room = sign === 1 ? plusRoom : minusRoom;
  const mag = randBetween(rng, minMag, Math.min(maxMag, room));
  return Math.min(hi, Math.max(lo, to + sign * mag));
}

/**
 * Synthesize a realistic interior starting pointer when a tab has no prior pointer position.
 * Starts 120–280 px horizontally and 80–180 px vertically from `to` when a side has room,
 * otherwise at the farthest in-viewport point on that axis; never (0, 0).
 */
export function synthesizeStartPoint(
  to: Point2D,
  viewport: Viewport = DEFAULT_VIEWPORT,
  rng: () => number = Math.random,
): Point2D {
  const padX = Math.min(12, Math.floor(viewport.width / 4));
  const padY = Math.min(12, Math.floor(viewport.height / 4));
  const minX = Math.max(1, padX);
  const maxX = Math.max(minX, viewport.width - padX);
  const minY = Math.max(1, padY);
  const maxY = Math.max(minY, viewport.height - padY);

  let x = round1(synthesizeAxis(to.x, minX, maxX, 120, 280, rng));
  let y = round1(synthesizeAxis(to.y, minY, maxY, 80, 180, rng));
  if (x === 0 && y === 0) {
    x = Math.min(12, Math.max(1, viewport.width - 1));
    y = Math.min(12, Math.max(1, viewport.height - 1));
  }
  return { x, y };
}

/**
 * Distribute `totalMs` across `count` integer delays in `[minMs, maxMs]` with jitter.
 * Preserves exact sum `totalMs` whenever `count * minMs <= totalMs <= count * maxMs`.
 */
function distributeDelays(
  totalMs: number,
  count: number,
  minMs: number,
  maxMs: number,
  rng: () => number,
): number[] {
  if (count <= 0) return [];
  if (count === 1) return [Math.max(0, Math.round(totalMs))];
  const target = Math.round(totalMs);
  const lo = Math.min(minMs, Math.floor(target / count));
  const hi = Math.max(maxMs, Math.ceil(target / count));

  const weights: number[] = [];
  let sumW = 0;
  for (let i = 0; i < count; i++) {
    const w = randBetween(rng, 0.85, 1.15);
    weights.push(w);
    sumW += w;
  }
  const delays = weights.map((w) => clamp(Math.round((w / sumW) * target), lo, hi));
  let diff = target - delays.reduce((a, b) => a + b, 0);
  // Adjust +/-1 across entries that still have headroom within [lo, hi].
  for (let guard = 0; diff !== 0 && guard < count * (hi - lo + 2); guard++) {
    const idx = guard % count;
    if (diff > 0 && delays[idx]! < hi) {
      delays[idx]!++;
      diff--;
    } else if (diff < 0 && delays[idx]! > lo) {
      delays[idx]!--;
      diff++;
    }
  }
  return delays;
}

/**
 * Plan a natural curved pointer path from `from` (or synthesized interior start) to `to`.
 *
 * Bounds (from PLAN.md Phase 6):
 * - Short-move bypass: distance < 3 px -> 1 direct move, 0 ms.
 * - Fitts-like duration: clamp(round((65 + 75 * log2(d / W_eff + 1)) * rand(0.85, 1.18)), 90, 460) ms,
 *   where W_eff = clamp(targetSize ?? 36, 16, 120).
 * - Cubic Bezier bow: ±(5–16%) * d, capped at 110 px.
 * - Step cadence: 12–20 ms, max 24 main arc steps.
 * - Overshoot: 18% when d >= 220 px (0 below); 4–11 px past target, 3–5 return steps over 45–85 ms.
 *   Skipped when viewport clamping leaves under 4 px of forward room, so no empty return leg.
 */
export function planPointerPath(opts: PointerPathOptions): PointerPathPlan {
  const rng = opts.rng ?? Math.random;
  const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
  const maxSteps = Math.max(2, Math.min(24, opts.maxSteps ?? 24));
  const overshootProb = opts.overshootProb ?? 0.18;

  const start = opts.from
    ? clampToViewport(opts.from, viewport)
    : synthesizeStartPoint(opts.to, viewport, rng);
  const dest = opts.to;
  const to = { x: round1(dest.x), y: round1(dest.y) };

  const dx = to.x - start.x;
  const dy = to.y - start.y;
  const distance = Math.hypot(dx, dy);

  if (distance < 3) {
    return {
      start,
      steps: [{ x: dest.x, y: dest.y, delayMs: 0 }],
      durationMs: 0,
      overshootDurationMs: 0,
      totalDurationMs: 0,
      overshot: false,
      arcSteps: 1,
      overshootSteps: 0,
      bowPx: 0,
    };
  }

  const wEff = clamp(opts.targetSize ?? 36, 16, 120);
  const rawDuration = (65 + 75 * Math.log2(distance / wEff + 1)) * randBetween(rng, 0.85, 1.18);
  const durationMs = clamp(Math.round(rawDuration), 90, 460);

  // Perpendicular normal and cubic Bezier control points.
  const nx = -dy / distance;
  const ny = dx / distance;
  const sign = rng() < 0.5 ? -1 : 1;
  const bowMag = Math.min(randBetween(rng, 0.05, 0.16) * distance, 110);
  const bowPx = sign * bowMag;
  const t1 = randBetween(rng, 0.2, 0.36);
  const t2 = randBetween(rng, 0.64, 0.8);
  const bow2 = bowPx * randBetween(rng, 0.45, 0.7);
  const c1 = { x: start.x + dx * t1 + nx * bowPx, y: start.y + dy * t1 + ny * bowPx };
  const c2 = { x: start.x + dx * t2 + nx * bow2, y: start.y + dy * t2 + ny * bow2 };

  let overshot = distance >= 220 && overshootProb > 0 && rng() < overshootProb;
  let arcEnd = to;
  if (overshot) {
    let tx = to.x - c2.x;
    let ty = to.y - c2.y;
    const tLen = Math.hypot(tx, ty);
    if (tLen > 0.001) {
      tx /= tLen;
      ty /= tLen;
    } else {
      tx = dx / distance;
      ty = dy / distance;
    }
    const overDist = randBetween(rng, 4, 11);
    // Viewport clamping can erase the forward overshoot, which would leave a pointless
    // return leg. Measure the room left along the approach direction first.
    const rawX = clamp(to.x + tx * overDist, 0, Math.max(0, viewport.width - 1));
    const rawY = clamp(to.y + ty * overDist, 0, Math.max(0, viewport.height - 1));
    const forwardRoom = (rawX - to.x) * tx + (rawY - to.y) * ty;
    if (forwardRoom < OVERSHOOT_MIN_ROOM_PX) {
      overshot = false;
    } else {
      arcEnd = { x: round1(rawX), y: round1(rawY) };
    }
  }

  const arcSteps = clamp(Math.round(durationMs / 16), Math.ceil(durationMs / 20), Math.min(maxSteps, Math.floor(durationMs / 12)));
  const arcStepCount = Math.max(2, Math.min(maxSteps, arcSteps));
  const arcDelays = distributeDelays(durationMs, arcStepCount, 12, 20, rng);

  const steps: PointerStep[] = [];
  let elapsed = 0;
  for (let i = 0; i < arcStepCount; i++) {
    const delayMs = arcDelays[i]!;
    elapsed += delayMs;
    const isLast = i === arcStepCount - 1;
    if (isLast) {
      // The arc ends at the overshoot point, or exactly on the supplied destination when there is none.
      steps.push(overshot ? { x: arcEnd.x, y: arcEnd.y, delayMs } : { x: dest.x, y: dest.y, delayMs });
      continue;
    }
    const u = elapsed / durationMs;
    const s = minimumJerk(u);
    const inv = 1 - s;
    const bx =
      inv * inv * inv * start.x +
      3 * inv * inv * s * c1.x +
      3 * inv * s * s * c2.x +
      s * s * s * arcEnd.x;
    const by =
      inv * inv * inv * start.y +
      3 * inv * inv * s * c1.y +
      3 * inv * s * s * c2.y +
      s * s * s * arcEnd.y;
    // Tapering Irwin-Hall triangular tremor.
    const tremorScale = 0.85 * (1 - s);
    const jx = (rng() + rng() + rng() - 1.5) * tremorScale;
    const jy = (rng() + rng() + rng() - 1.5) * tremorScale;
    const pt = clampToViewport({ x: bx + jx, y: by + jy }, viewport);
    steps.push({ x: pt.x, y: pt.y, delayMs });
  }

  let overshootSteps = 0;
  let overshootDurationMs = 0;
  if (overshot) {
    overshootSteps = clamp(Math.floor(randBetween(rng, 3, 6)), 3, 5);
    overshootDurationMs = clamp(Math.round(randBetween(rng, 45, 85)), 45, 85);
    const backDelays = distributeDelays(overshootDurationMs, overshootSteps, 10, 28, rng);
    let backElapsed = 0;
    for (let j = 0; j < overshootSteps; j++) {
      const delayMs = backDelays[j]!;
      backElapsed += delayMs;
      const isLast = j === overshootSteps - 1;
      if (isLast) {
        steps.push({ x: dest.x, y: dest.y, delayMs });
        continue;
      }
      const s = minimumJerk(backElapsed / overshootDurationMs);
      const pt = clampToViewport(
        { x: arcEnd.x + (dest.x - arcEnd.x) * s, y: arcEnd.y + (dest.y - arcEnd.y) * s },
        viewport,
      );
      steps.push({ x: pt.x, y: pt.y, delayMs });
    }
  }

  return {
    start,
    steps,
    durationMs,
    overshootDurationMs,
    totalDurationMs: durationMs + overshootDurationMs,
    overshot,
    arcSteps: arcStepCount,
    overshootSteps,
    bowPx: round1(bowPx),
  };
}

/**
 * Pick a center-weighted random click point strictly inside `box` inset by margin:
 * mx = width < 14 ? width * 0.15 : min(width * 0.20, 10)
 * my = height < 14 ? height * 0.15 : min(height * 0.20, 8)
 */
export function pickClickPoint(box: Box2D, rng: () => number = Math.random): Point2D {
  const mx = box.width < 14 ? box.width * 0.15 : Math.min(box.width * 0.2, 10);
  const my = box.height < 14 ? box.height * 0.15 : Math.min(box.height * 0.2, 8);
  const minX = box.left + mx;
  const maxX = box.left + box.width - mx;
  const minY = box.top + my;
  const maxY = box.top + box.height - my;

  const u = (rng() + rng()) / 2;
  const v = (rng() + rng()) / 2;
  const rawX = maxX > minX ? minX + u * (maxX - minX) : box.left + box.width / 2;
  const rawY = maxY > minY ? minY + v * (maxY - minY) : box.top + box.height / 2;

  const rMinX = Math.ceil(minX * 10) / 10;
  const rMaxX = Math.floor(maxX * 10) / 10;
  const rMinY = Math.ceil(minY * 10) / 10;
  const rMaxY = Math.floor(maxY * 10) / 10;

  return {
    x: rMaxX >= rMinX ? clamp(round1(rawX), rMinX, rMaxX) : rawX,
    y: rMaxY >= rMinY ? clamp(round1(rawY), rMinY, rMaxY) : rawY,
  };
}

/** Plan hover dwell (45–115 ms), press hold (55–130 ms), and multi-click gaps (65–135 ms). */
export function planClickTiming(clickCount = 1, rng: () => number = Math.random): ClickTimingPlan {
  const count = Math.max(1, Math.floor(clickCount));
  const dwellMs = clamp(Math.round(triangular(rng, 45, 115)), 45, 115);
  const holdsMs: number[] = [];
  const gapsMs: number[] = [];
  for (let i = 0; i < count; i++) {
    holdsMs.push(clamp(Math.round(triangular(rng, 55, 130)), 55, 130));
    if (i < count - 1) {
      gapsMs.push(clamp(Math.round(triangular(rng, 65, 135)), 65, 135));
    }
  }
  return { dwellMs, holdsMs, gapsMs };
}

/** Plan single-key hold time (35–85 ms). */
export function planKeyHold(rng: () => number = Math.random): number {
  return clamp(Math.round(triangular(rng, 35, 85)), 35, 85);
}

/**
 * Distribute a single wheel flick's `deltaY` across `eventCount` eased events
 * using cubic ease-out `1 - (1 - t)^3` so the
 * integer event deltas sum to `Math.round(deltaY)` exactly. Zero-delta events are dropped so a
 * short flick never sends a wheel event that moves nothing.
 */
function buildFlickEvents(
  deltaY: number,
  eventCount: number,
  maxFlickMs: number,
  rng: () => number,
): { events: WheelEventStep[]; durationMs: number } {
  const target = Math.round(deltaY);
  const count = clamp(eventCount, 4, 12);
  const intervals = count - 1;
  const maxIntervalBudget = Math.max(intervals * 15, Math.min(intervals * 19, maxFlickMs));
  const rawTotalMs = clamp(
    Math.round(randBetween(rng, intervals * 15, Math.min(intervals * 19, maxIntervalBudget))),
    intervals * 15,
    maxIntervalBudget,
  );
  const delays = [0, ...distributeDelays(rawTotalMs, intervals, 15, 19, rng)];

  const events: WheelEventStep[] = [];
  let emitted = 0;
  for (let i = 0; i < count; i++) {
    const t = (i + 1) / count;
    const eased = 1 - Math.pow(1 - t, 3);
    const cumulative = i === count - 1 ? target : Math.round(target * eased);
    const stepDelta = cumulative - emitted;
    emitted = cumulative;
    // Short flicks round early events to zero; a zero-delta wheel event would just be a pause.
    if (stepDelta === 0) continue;
    events.push({ deltaY: stepDelta, delayMs: delays[i]! });
  }
  return { events, durationMs: events.reduce((a, e) => a + e.delayMs, 0) };
}

const FLICK_MIN_PX = 280;
const FLICK_MAX_PX = 680;
const MAX_FLICKS = 4;
const WHEEL_MAX_DURATION_MS = 650;

/**
 * Plan 1–4 eased wheel flicks for scrolling by `deltaY` px.
 *
 * Bounds (from PLAN.md Phase 6):
 * - 1–4 flicks of 280–680 px (or 1 flick of exact `deltaY` when |deltaY| < 280).
 * - Each flick has 4–12 cubic ease-out events spaced 15–19 ms apart whose deltas sum to the flick delta.
 * - Inter-flick pause 75–175 ms; total gesture duration <= 650 ms.
 * - When |deltaY| <= 2720 (4 * 680), sum of all event deltas equals `Math.round(deltaY)` exactly.
 *   For larger distances, emits 4 flicks (caller falls back to instant scrollIntoView for any remainder).
 */
export function planWheelScroll(deltaY: number, rng: () => number = Math.random): WheelScrollPlan {
  const target = Math.round(deltaY);
  const abs = Math.abs(target);
  if (abs < 1) {
    return { flicks: [], totalDeltaY: 0, totalDurationMs: 0 };
  }
  const sign = target < 0 ? -1 : 1;

  // Choose flick magnitudes.
  const flickMags: number[] = [];
  if (abs < FLICK_MIN_PX) {
    flickMags.push(abs);
  } else if (abs > MAX_FLICKS * FLICK_MAX_PX) {
    for (let i = 0; i < MAX_FLICKS; i++) {
      flickMags.push(Math.round(randBetween(rng, FLICK_MIN_PX, FLICK_MAX_PX)));
    }
  } else {
    const validCounts: number[] = [];
    for (let f = 1; f <= MAX_FLICKS; f++) {
      if (f * FLICK_MIN_PX <= abs && abs <= f * FLICK_MAX_PX) validCounts.push(f);
    }
    const flickCount = validCounts[Math.floor(rng() * validCounts.length)]!;
    let remaining = abs;
    for (let i = 0; i < flickCount; i++) {
      const slotsAfter = flickCount - 1 - i;
      if (slotsAfter === 0) {
        flickMags.push(remaining);
      } else {
        const lo = Math.max(FLICK_MIN_PX, remaining - slotsAfter * FLICK_MAX_PX);
        const hi = Math.min(FLICK_MAX_PX, remaining - slotsAfter * FLICK_MIN_PX);
        const mag = Math.round(randBetween(rng, lo, hi));
        flickMags.push(mag);
        remaining -= mag;
      }
    }
  }

  // Budget inter-flick pauses (75–175 ms) and flick durations (4–12 events @ 15–19 ms) within <= 650 ms.
  const numFlicks = flickMags.length;
  const numPauses = numFlicks - 1;
  const minFlickMs = 3 * 15; // 4 events -> 3 intervals * 15 ms = 45 ms
  const pauses: number[] = [];
  let pauseBudgetUsed = 0;
  for (let i = 0; i < numPauses; i++) {
    const pausesAfter = numPauses - 1 - i;
    const maxAllowed = Math.min(
      175,
      WHEEL_MAX_DURATION_MS - numFlicks * minFlickMs - pauseBudgetUsed - pausesAfter * 75,
    );
    const p = clamp(Math.round(randBetween(rng, 75, Math.max(75, maxAllowed))), 75, 175);
    pauses.push(p);
    pauseBudgetUsed += p;
  }

  let remainingFlickBudget = WHEEL_MAX_DURATION_MS - pauseBudgetUsed;
  const flicks: WheelFlickPlan[] = [];
  let totalDeltaY = 0;
  let totalDurationMs = pauseBudgetUsed;

  for (let i = 0; i < numFlicks; i++) {
    const flicksAfter = numFlicks - 1 - i;
    const maxThisFlickMs = Math.max(minFlickMs, remainingFlickBudget - flicksAfter * minFlickMs);
    const maxEventsForBudget = clamp(Math.floor(maxThisFlickMs / 15) + 1, 4, 12);
    // Scale preferred event count with flick distance (4–12 events).
    const mag = flickMags[i]!;
    const idealEvents = clamp(Math.round(4 + (mag / FLICK_MAX_PX) * 6 + randBetween(rng, -1, 1.5)), 4, maxEventsForBudget);
    const signedDelta = sign * mag;
    const { events, durationMs } = buildFlickEvents(signedDelta, idealEvents, maxThisFlickMs, rng);
    const pauseAfterMs = i < numPauses ? pauses[i]! : 0;
    flicks.push({ deltaY: signedDelta, events, durationMs, pauseAfterMs });
    remainingFlickBudget -= durationMs;
    totalDeltaY += signedDelta;
    totalDurationMs += durationMs;
  }

  return { flicks, totalDeltaY, totalDurationMs };
}

/**
 * Think pause between `do`/`fill` steps: 160–420 ms, minus time already spent settling.
 *
 * Returns 0 when the settle already took longer than the planned pause, so a slow page never
 * stacks extra delay on top of its own latency. Callers skip the pause after a `wait` step, after
 * the last step, and on `--fast` or a `"fast": true` step.
 */
export function planThinkPause(rng: () => number = Math.random, settledMs = 0): number {
  return planThinkPauseDetail(rng, settledMs).sleepMs;
}

/**
 * The same plan, split into the pause it wanted (always 160–420 ms) and what it still has to sleep
 * after crediting the settle. Tests read `want` to prove each boundary was paced on plan.
 */
export function planThinkPauseDetail(
  rng: () => number = Math.random,
  settledMs = 0,
): { want: number; sleepMs: number } {
  const want = clamp(Math.round(triangular(rng, 160, 420)), 160, 420);
  const spent = Number.isFinite(settledMs) ? Math.max(0, Math.round(settledMs)) : 0;
  return { want, sleepMs: Math.max(0, want - spent) };
}

/**
 * Post-`nav` reading dwell: `clamp(220 + 0.08 * chars * rand(0.8, 1.25), 220, 850)` ms.
 *
 * Applied lazily before the next input on that tab, so reads (snap, text, form, query,
 * read-urls, nav) and slow agent turns add nothing.
 */
export function planNavDwell(chars: number, rng: () => number = Math.random): number {
  const count = Number.isFinite(chars) ? Math.max(0, Math.round(chars)) : 0;
  return clamp(Math.round(220 + 0.08 * count * randBetween(rng, 0.8, 1.25)), 220, 850);
}

/** Window in which a second same-host nav on a tab counts as pagination. */
export const PAGINATION_WINDOW_MS = 4000;

/**
 * Jittered minimum gap between paginated navs on one tab, measured from the previous nav.
 * 1.6–2.8 s.
 */
export function planPaginationGap(rng: () => number = Math.random): number {
  return clamp(Math.round(triangular(rng, 1600, 2800)), 1600, 2800);
}

export interface TextScrollStepPlan {
  /** Fraction of the scroller's height to advance (0.72–0.92). */
  heightFactor: number;
  /** Pause after this step: 140–290 ms, or 320–600 ms on roughly 10% of steps. */
  pauseMs: number;
}

/**
 * One `text --scroll` reading step: a jittered slice of the viewport height and a reading pause.
 *
 * Steps stay in-page (`scrollTop` assignment plus `setTimeout`), so the read never attaches the
 * debugger. Plan a batch of steps up front with the injected `rng` for determinism.
 */
export function planTextScrollStep(rng: () => number = Math.random): TextScrollStepPlan {
  const heightFactor = randBetween(rng, 0.72, 0.92);
  const slow = rng() < 0.1;
  const pauseMs = slow
    ? clamp(Math.round(randBetween(rng, 320, 600)), 320, 600)
    : clamp(Math.round(randBetween(rng, 140, 290)), 140, 290);
  return { heightFactor: Math.round(heightFactor * 100) / 100, pauseMs };
}
