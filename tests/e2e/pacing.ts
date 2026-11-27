// Real-browser natural pacing check (PLAN.md Phase 6). Drives fixtures/pacing.html through the real wrapper and
// daemon, reads the page's own capture-phase event log back over attach-free eval, and checks the timeline
// against the spec bounds in src/natural.ts. Called from run.ts once the extension is connected.

export type Bc = (args: string[], timeoutMs?: number) => Promise<string>;
export type PacingRecord = (name: string, ok: boolean, detail: string) => void;
/** One request the fixture server answered, stamped when it arrived. */
export type NavEntry = { path: string; t: number };

// [type, epoch ms, isTrusted, x, y, deltaY, scrollY, target id], as fixtures/pacing.html logs it.
type Ev = [string, number, boolean, number | null, number | null, number | null, number, string];

// Slack on every timing bound. The page stamps events when Chrome delivers them, and each Input.dispatch*
// call crosses daemon -> relay -> extension -> debugger, so a planned delay lands up to a few tens of ms late
// (or early, when the previous dispatch was the delayed one).
const TOL = 60;
// Extra upper slack on step gaps: after the think pause the next step still resolves its target (locate, guard,
// focus or pointer planning: several relay round-trips) before its first event. A typing step ends at its last
// keyup; a pointer-led step (click after type) measured up to 478 ms, at the edge of a 480 ms limit.
const STEP_START = 150;
// Fast and natural-off steps still pay settle + start-up (140-180 ms typical, one-offs up to 262 ms measured);
// a think pause would add at least 160 ms to every gap, so the fill checks use the median of the 9 gaps, which
// a pause in each gap pushes past 300 ms. The whole baseline moves with the host: the median was 253-262 ms
// over all 9 gaps on a machine at load ~4, so the cap is 340. pacing-pause-sum backs it up: a pause leaking
// into a fast run shrinks those deltas and fails the sum.
const NO_PAUSE_MAX = 340;
// A fast-mode step gap this long means input acks wait on a ~1 Hz frame (a test tab that is not painting).
const SLOW_ACK_MS = 600;
// planThinkPause floors at 160 ms and planNavDwell at 220 ms; both subtract the time already elapsed. A
// settle is one 40 ms tick plus the relay hop (60-130 ms idle), so a single boundary's natural-minus-fast
// delta can be 0: measured 97-250 ms idle and -8..152 ms at host load ~4. The pause floor is therefore an
// aggregate one (summed over every boundary) and the per-boundary bound is the ceiling only.
const MIN_PAUSE = 160;
const MIN_DWELL = 220;
// The reading dwell's ceiling (src/natural.ts). The long fixture carries enough text that the uncapped
// plan clears it at the lowest jitter roll, so its measured dwell is the cap and nothing else.
const DWELL_CAP = 850;
const THINK_SETTLE_CAP = 130;
const THINK_FLOOR = MIN_PAUSE - THINK_SETTLE_CAP;
const THINK_CEILING = 420;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

// `fill` is a batch of `type` steps, so its 10 fields are the typeable ones; the select, checkbox and radio
// are set by the `do` run below, which has the verbs for them.
const FIELDS: Array<[label: string, id: string, value: string]> = [
  ["First name", "first", "Ada"],
  ["Email", "email", "ada@example.com"],
  ["Start date", "start", "2026-11-27"],
  ["Notes", "notes", "Hello there"],
  ["Last name", "last", "Lovelace"],
  ["Age", "age", "36"],
  ["Phone", "phone", "5551234567"],
  ["Website", "website", "https://example.com"],
  ["City", "city", "London"],
  ["Zip", "zip", "90210"],
];
const EXPECTED = FIELDS.map((f) => f[2]);
// Events that open a step: what the pointer or keyboard does first, not the page's echo of the last step.
const LEAD = new Set(["mousemove", "mousedown", "focus", "keydown", "wheel"]);
// A field's keystrokes, through the release of its last key (natural typing holds each key 35+ ms).
const isKey = (e: Ev, id: string) => e[7] === id && (e[0] === "keydown" || e[0] === "keyup" || e[0] === "input");

const fmt = (n: number) => Math.round(n);
const between = (v: number, lo: number, hi: number, up = TOL) => v >= lo - TOL && v <= hi + up;
const stepGap = (v: number) => between(v, 160, 420, TOL + STEP_START);
// One tolerance for "the pause really reached the page": the next step resolves its target (locate,
// guard, focus, pointer planning) after the pause and the page stamps its first event a few ms later,
// so a measured dispatch gap may fall slightly short of the pause the runner planned. Every per-boundary
// floor uses this single constant; the summed floor at the end is only a smoke check.
const PAUSE_TOL = TOL;
/** One planned think pause, as the runner traces it under BC_E2E_PACING_TRACE=1. */
type ThinkPause = { after: number; planned: number; slept: number };
/** Read the runner's test-only trace line (`# PACING {"think":[...]}`); undefined when absent. */
const thinkPauses = (out: string): ThinkPause[] | undefined => {
  if (!/^# PACING /m.test(out)) return undefined;
  try {
    const parsed = JSON.parse(out.split("\n").find((l) => l.startsWith("# PACING "))!.slice(9)) as { think?: ThinkPause[] };
    return Array.isArray(parsed.think) ? parsed.think : undefined;
  } catch {
    return undefined;
  }
};
/** A boundary is on plan when the runner paused there, inside the planner's 160-420 ms range. */
const pauseOnPlan = (rows: ThinkPause[] | undefined, after: number[]) =>
  rows !== undefined &&
  rows.length === after.length &&
  rows.every((r, i) => r.after === after[i] && r.planned >= MIN_PAUSE && r.planned <= THINK_CEILING);

export async function runPacingCheck(
  bc: Bc,
  base: string,
  record: PacingRecord,
  opts: { navLog: NavEntry[]; frameUrl: string; skip?: (name: string, reason: string) => void } = { navLog: [], frameUrl: "" },
): Promise<void> {
  const evalJson = async <T>(expr: string): Promise<T> => {
    const out = await bc(["eval", `"@@"+JSON.stringify(${expr})+"@@"`]);
    const m = /@@([\s\S]*)@@/.exec(out);
    if (!m) throw new Error(`eval read-back failed: ${out.slice(0, 200)}`);
    return JSON.parse(m[1]!) as T;
  };
  const events = () => evalJson<Ev[]>("window.__events");
  const reset = async () => {
    await bc(["eval", "scrollTo(0,0);document.activeElement&&document.activeElement.blur();1"]);
    await Bun.sleep(150);
    await bc(["eval", "window.__events=[];window.__submitted=0;1"]);
  };
  const clearForm = () =>
    bc(["eval", "document.getElementById('f').reset();1"]);
  const timed = async (args: string[]) => {
    const start = Date.now();
    const out = await bc(args, 90_000);
    return { out, start, end: Date.now(), ms: Date.now() - start };
  };
  const allTrusted: Ev[] = [];
  const keep = (evs: Ev[]) => (allTrusted.push(...evs), evs);
  const timing: Record<string, { natural?: number; fast?: number }> = {};

  /** Gap from the last keystroke of each field to the first lead event of the next field. */
  const fieldGaps = (evs: Ev[], ids: string[]) =>
    ids.slice(1).map((_, i) => {
      const prev = ids[i]!;
      const lastT = Math.max(...evs.filter((e) => isKey(e, prev)).map((e) => e[1]));
      const next = evs.find((e) => e[1] > lastT && LEAD.has(e[0]));
      return next ? next[1] - lastT : NaN;
    });
  /**
   * Untrusted echoes on one control in one run. `select` and `type` into a date field set the value in
   * the page by design and emit exactly one input+change pair, so a per-control count on a run's own log
   * cannot be cancelled by a duplicate in one run and a missing pair in another.
   */
  const echoPairs = (evs: Ev[], id: string) => {
    const bad = evs.filter((e) => e[2] !== true && e[7] === id);
    const count = (kind: string) => bad.filter((e) => e[0] === kind).length;
    return { input: count("input"), change: count("change"), other: bad.length - count("input") - count("change") };
  };
  const oneEcho = (echo: ReturnType<typeof echoPairs>) => echo.input === 1 && echo.change === 1 && echo.other === 0;
  const echoText = (echo: ReturnType<typeof echoPairs>) => `input=${echo.input} change=${echo.change} other=${echo.other}`;
  const dumpFile = process.env["BC_E2E_PACING_DUMP"];
  const dump = async (name: string, data: unknown) => {
    if (dumpFile) await Bun.write(`${dumpFile}.${name}.json`, JSON.stringify(data));
  };

  const fillArg = JSON.stringify(Object.fromEntries(FIELDS.map(([label, , value]) => [label, value])));
  const readBack = () => evalJson<string[]>(`[${FIELDS.map((f) => `document.getElementById('${f[1]}').value`).join(",")}]`);

  await bc(["natural", "on"]);
  await bc(["nav", `${base}/pacing`]);

  // 1. fill(10), natural: think pause between fields, none after the last, Submit untouched.
  const fillRun = async (fast: boolean, name: string) => {
    await clearForm();
    await reset();
    const r = await timed(["fill", ...(fast ? ["--fast"] : []), fillArg]);
    const evs = keep(await events());
    await dump(`fill-${name}`, { out: r.out, evs });
    const values = await readBack();
    const submitted = await evalJson<number>("window.__submitted");
    const gaps = fieldGaps(evs, FIELDS.map((f) => f[1]));
    const lastInput = Math.max(...evs.filter((e) => ["keydown", "keyup", "input"].includes(e[0])).map((e) => e[1]));
    // One `type` into the date field per run, so this run's log carries exactly one input+change pair.
    const echo = echoPairs(evs, "start");
    return { r, evs, values, submitted, gaps, tail: r.end - lastInput, name, echo, planned: thinkPauses(r.out) };
  };
  const fillN = await fillRun(false, "natural");
  const valuesOk = JSON.stringify(fillN.values) === JSON.stringify(EXPECTED);
  record("pacing-fill10-values", valuesOk && !/STOPPED|FAILED/.test(fillN.r.out), `${JSON.stringify(fillN.values)} ${fillN.r.out}`);
  record("pacing-fill10-no-submit", fillN.submitted === 0, `submitted=${fillN.submitted}`);
  record("pacing-fill10-date-echo", oneEcho(fillN.echo), echoText(fillN.echo));
  timing["fill10"] = { natural: fillN.r.ms };

  const fillF = await fillRun(true, "fast");
  // Where the test tab is not painting (seen on CI runners), every input ack waits for a ~1 Hz frame, so even
  // fast steps sit ~1 s apart and no pause can be timed. A real browser tab acks in ~50 ms. There, a failed
  // timing check is reported as SKIP with the measured gap; passes still count and functional checks still run.
  const ackMs = median(fillF.gaps);
  const slowAcks = ackMs >= SLOW_ACK_MS;
  if (slowAcks) console.log(`NOTE pacing fast step gap ~${fmt(ackMs)}ms: input acks are frame-bound here, failed timing checks are skipped`);
  const judged: PacingRecord = (name, ok, detail) =>
    slowAcks && !ok && opts.skip ? opts.skip(name, `fast step gap ~${fmt(ackMs)}ms, timing not measurable :: ${detail}`) : record(name, ok, detail);
  judged("pacing-fill10-gaps", fillN.gaps.every(stepGap), `gaps=${fillN.gaps.map(fmt).join(",")}`);
  record("pacing-fill10-fast-values", JSON.stringify(fillF.values) === JSON.stringify(EXPECTED), JSON.stringify(fillF.values));
  judged("pacing-fill10-fast-gaps", median(fillF.gaps) < NO_PAUSE_MAX, `gaps=${fillF.gaps.map(fmt).join(",")}`);
  record("pacing-fill10-fast-no-submit", fillF.submitted === 0, `submitted=${fillF.submitted}`);
  record("pacing-fill10-fast-date-echo", oneEcho(fillF.echo), echoText(fillF.echo));
  // The tail after the last keystroke is settle + diff + wrapper exit in both modes; natural must add no pause.
  judged("pacing-fill10-no-trailing-pause", fillN.tail <= fillF.tail + TOL + 100, `natural tail=${fmt(fillN.tail)} fast tail=${fmt(fillF.tail)}`);
  timing["fill10"]!.fast = fillF.r.ms;
  const span = (xs: number[]) => `${fmt(Math.min(...xs))}-${fmt(Math.max(...xs))}`;
  console.log(`NOTE pacing gaps natural=${span(fillN.gaps)} fast=${span(fillF.gaps)} tails natural=${fmt(fillN.tail)} fast=${fmt(fillF.tail)}`);

  // Every think pause has to show between a step's last keystroke and the next step's first event. Comparing
  // the matched natural and fast runs cancels the start-up, locate and settle both pay, so the difference is
  // the pause itself. The planner subtracts the settle it just spent, so one boundary can legitimately land
  // near 0: each delta is ceiling-bounded here and the floors are aggregated after the do run.
  const pauseDeltas: number[] = [];
  const pauseDelta = (d: number) => d <= THINK_CEILING + TOL;
  const fillDeltas = fillN.gaps.map((g, i) => g - (fillF.gaps[i] ?? NaN));
  pauseDeltas.push(...fillDeltas);
  console.log(`NOTE pacing pause deltas fill10=${fillDeltas.map(fmt).join(",")}`);
  const gapList = (xs: number[]) => xs.map(fmt).join(",");
  judged("pacing-fill10-pause-per-step", fillDeltas.length === 9 && fillDeltas.every(pauseDelta), `natural=${gapList(fillN.gaps)} fast=${gapList(fillF.gaps)}`);
  // Per boundary, from the runner's own plan: the settled difference above can cancel to 0, so the floor is
  // checked against the traced plan and the dispatch gap it produced. One boundary per pair of fields (1-9).
  const fillBoundaries = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const fillPlanned = fillN.planned;
  record(
    "pacing-fill10-pause-plan",
    pauseOnPlan(fillPlanned, fillBoundaries),
    `planned=${JSON.stringify(fillPlanned)} range=${MIN_PAUSE}-${THINK_CEILING}ms`,
  );
  record(
    "pacing-fill10-pause-dispatched",
    fillPlanned !== undefined &&
      fillPlanned.length === 9 &&
      fillPlanned.every((p) => (fillN.gaps[p.after - 1] ?? NaN) >= p.planned - PAUSE_TOL),
    `planned=${fillPlanned?.map((p) => p.planned).join(",")} gaps=${gapList(fillN.gaps)} tol=${PAUSE_TOL}ms`,
  );

  // 2. do(5) with a wait step: pause between steps, none after `wait`, none after the last step.
  const steps = JSON.stringify([
    { type: ["First name", "Grace"] },
    { click: "Subscribe" },
    { wait: { selector: "#target" } },
    { click: "Pro" },
    { select: ["Country", "Peru"] },
  ]);
  const doRun = async (fast: boolean) => {
    await clearForm();
    await reset();
    const r = await timed(["do", ...(fast ? ["--fast"] : []), steps]);
    const evs = keep(await events());
    await dump(`do-${fast ? "fast" : "natural"}`, { out: r.out, evs });
    const lastOf = (pred: (e: Ev) => boolean) => Math.max(...evs.filter(pred).map((e) => e[1]));
    const leadAfter = (t: number, prev: string) => evs.find((e) => e[1] > t && LEAD.has(e[0]) && !(e[0] === "focus" && e[7] === prev))?.[1] ?? NaN;
    const s1End = lastOf((e) => isKey(e, "first"));
    const s2End = lastOf((e) => e[7] === "subscribe" && e[0] === "mouseup");
    const s4End = lastOf((e) => e[7] === "plan-pro" && e[0] === "mouseup");
    const values = await evalJson<string[]>(
      "[first.value, String(subscribe.checked), String(document.getElementById('plan-pro').checked), country.value]",
    );
    return {
      r,
      values,
      gap12: leadAfter(s1End, "first") - s1End,
      gap24: leadAfter(s2End, "subscribe") - s2End, // think after the click + the wait step + no think after `wait`
      // `select` sets the value in the page (no pointer), so the step's first event is the select's own input.
      gap45: (evs.find((e) => e[1] > s4End && e[7] === "country")?.[1] ?? NaN) - s4End,
      tail: r.end - Math.max(...evs.map((e) => e[1])),
      submitted: await evalJson<number>("window.__submitted"),
      // One `select` step per run, so this run's own log carries exactly one input+change pair.
      echo: echoPairs(evs, "country"),
      planned: thinkPauses(r.out),
    };
  };
  const doN = await doRun(false);
  const doF = await doRun(true);
  const doOk = (d: typeof doN) => !/STOPPED|FAILED/.test(d.r.out) && d.submitted === 0 && d.values.join() === "Grace,true,true,Peru";
  record("pacing-do5-ran", doOk(doN) && doOk(doF), `${doN.values} / ${doF.values} ${doN.r.out}`);
  judged("pacing-do5-gaps", stepGap(doN.gap12) && stepGap(doN.gap45), `gap12=${fmt(doN.gap12)} gap45=${fmt(doN.gap45)}`);
  // Across the wait: one think pause (after the click) plus the wait itself, measured in fast mode where no
  // think pause runs. A second pause after `wait` would push this past 420 ms + the wait's own cost.
  const waitCost = Math.max(0, doF.gap24);
  judged("pacing-do5-no-pause-after-wait", between(doN.gap24, 160, 420 + waitCost, TOL + STEP_START), `gap24=${fmt(doN.gap24)} fast gap24=${fmt(doF.gap24)}`);
  judged("pacing-do5-no-trailing-pause", doN.tail <= doF.tail + TOL + 100, `natural tail=${fmt(doN.tail)} fast tail=${fmt(doF.tail)}`);
  judged("pacing-do5-fast-gaps", doF.gap12 < NO_PAUSE_MAX && doF.gap45 < NO_PAUSE_MAX, `gap12=${fmt(doF.gap12)} gap45=${fmt(doF.gap45)}`);
  timing["do5"] = { natural: doN.r.ms, fast: doF.r.ms };
  // Same matched-delta rule as fill, including the boundary across the wait (one pause after the click).
  const doDeltas = { gap12: doN.gap12 - doF.gap12, gap45: doN.gap45 - doF.gap45, wait: doN.gap24 - doF.gap24 };
  pauseDeltas.push(doDeltas.gap12, doDeltas.gap45, doDeltas.wait);
  console.log(`NOTE pacing pause deltas do5 gap12=${fmt(doDeltas.gap12)} gap45=${fmt(doDeltas.gap45)} wait=${fmt(doDeltas.wait)}`);
  judged("pacing-do5-pause-per-step", pauseDelta(doDeltas.gap12) && pauseDelta(doDeltas.gap45), `gap12=${fmt(doDeltas.gap12)} gap45=${fmt(doDeltas.gap45)}`);
  judged("pacing-do5-wait-pause", pauseDelta(doDeltas.wait), `wait boundary delta=${fmt(doDeltas.wait)}`);
  record("pacing-do5-select-echo", oneEcho(doN.echo) && oneEcho(doF.echo), `natural ${echoText(doN.echo)} fast ${echoText(doF.echo)}`);
  // Per boundary from the runner's plan: a pause after steps 1, 2 and 4, and none after `wait` (step 3) or
  // the last step. The dispatch gap must carry each planned pause within one tolerance.
  const doGaps: Record<number, number> = { 1: doN.gap12, 2: doN.gap24, 4: doN.gap45 };
  const doPlanned = doN.planned;
  record(
    "pacing-do5-pause-plan",
    pauseOnPlan(doPlanned, [1, 2, 4]),
    `planned=${JSON.stringify(doPlanned)} range=${MIN_PAUSE}-${THINK_CEILING}ms`,
  );
  record(
    "pacing-do5-pause-dispatched",
    doPlanned !== undefined &&
      doPlanned.length === 3 &&
      doPlanned.every((p) => (doGaps[p.after] ?? NaN) >= p.planned - PAUSE_TOL),
    `planned=${doPlanned?.map((p) => `${p.after}:${p.planned}`).join(",")} gaps=${[doN.gap12, doN.gap24, doN.gap45].map(fmt).join(",")} tol=${PAUSE_TOL}ms`,
  );
  // The per-boundary plan checks above are the floor; this aggregate is the smoke check that the pauses
  // still add up over all 12 boundaries and that none exceeds the plan's ceiling. Removing the pause drops
  // the sum to ~0 (measured -6); the idle and loaded runs measured 1997 and 817.
  const pauseSum = pauseDeltas.filter(Number.isFinite).reduce((a, b) => a + b, 0);
  const pauseFloor = pauseDeltas.length * THINK_FLOOR;
  console.log(`NOTE pacing pause sum=${fmt(pauseSum)} floor=${pauseFloor}`);
  judged("pacing-pause-no-stacking", pauseDeltas.length === 12 && pauseDeltas.every(pauseDelta), `deltas=${gapList(pauseDeltas)} ceiling=${THINK_CEILING + TOL}ms`);
  judged("pacing-pause-sum", pauseDeltas.length === 12 && pauseSum >= pauseFloor, `sum=${fmt(pauseSum)}ms floor=${pauseFloor}ms`);

  // 3 + 4. nav dwell, then a natural click on the target.
  const box = async (id: string) =>
    evalJson<{ l: number; t: number; r: number; b: number }>(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom}})()`);
  const navClick = async (fast: boolean) => {
    const flag = fast ? ["--fast"] : [];
    const nav = await timed(["nav", ...flag, `${base}/pacing`]);
    const click = await timed(["click", ...flag, "Pacing target"]);
    const evs = keep(await events());
    await dump(`navclick-${fast ? "fast" : "natural"}`, { nav, click, evs });
    return { nav, click, evs, ms: click.end - nav.start };
  };
  await Bun.sleep(4_100); // leave the 4 s same-host pagination window so the timing shows dwell, not a pagination gap
  const ncN = await navClick(false);

  const moves = (evs: Ev[]) => {
    const down = evs.findIndex((e) => e[0] === "mousedown");
    return { down, path: evs.slice(0, Math.max(0, down)).filter((e) => e[0] === "mousemove") };
  };
  {
    const { down, path } = moves(ncN.evs);
    const d = ncN.evs[down];
    const up = ncN.evs.find((e) => e[0] === "mouseup");
    const b = await box("target");
    const p0 = path[0];
    const p1 = path[path.length - 1];
    let dev = 0;
    if (p0 && p1) {
      const [x0, y0, x1, y1] = [p0[3]!, p0[4]!, p1[3]!, p1[4]!];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      for (const p of path) dev = Math.max(dev, Math.abs((x1 - x0) * (y0 - p[4]!) - (x0 - p[3]!) * (y1 - y0)) / len);
    }
    record("pacing-click-moves", path.length >= 5, `mousemoves=${path.length}`);
    record("pacing-click-curved", dev > 2, `max deviation=${dev.toFixed(1)}px`);
    const dwell = d && p1 ? d[1] - p1[1] : NaN;
    judged("pacing-click-hover-dwell", between(dwell, 45, 115), `dwell=${fmt(dwell)}ms`);
    const hold = d && up ? up[1] - d[1] : NaN;
    judged("pacing-click-hold", between(hold, 55, 130), `hold=${fmt(hold)}ms`);
    const [x, y] = d ? [d[3]!, d[4]!] : [NaN, NaN];
    const inside = x > b.l && x < b.r && y > b.t && y < b.b;
    const offCenter = Math.abs(x - (b.l + b.r) / 2) > 0.5 || Math.abs(y - (b.t + b.b) / 2) > 0.5;
    record("pacing-click-point", inside && offCenter, `point=${x},${y} box=${JSON.stringify(b)}`);
  }

  // 3. The dwell scales with the page's text length: clamp(220 + 0.08*chars*rand(0.8,1.25), 220, 850). The
  // natural measure lands on the plan: the daemon's nav record sits ~100 ms before `nav` returns (wrapper
  // exit) and the next call's start-up adds about the same. Both ends are asserted, so a missing or
  // text-blind dwell fails the low end and an over-long one the high end. No TIMING entry here, because the
  // natural nav also reads the body length, so the two calls' durations do not isolate the dwell.
  //
  // The long fixture carries ~20k chars, so its uncapped plan is 1520-2250 ms and the 850 ms cap is what
  // decides the number: at the lowest jitter (0.8) it is still over the cap. That makes the `long` bounds
  // both the cap, so removing the clamp in src/natural.ts pushes the measured dwell past 910 and fails.
  const dwellRun = async (path: string, fast: boolean) => {
    const flag = fast ? ["--fast"] : [];
    const nav = await timed(["nav", ...flag, `${base}${path}`]);
    const chars = await evalJson<number>("document.body.textContent.length"); // a read pays no dwell
    await timed(["click", ...flag, "Pacing target"]); // spends it
    const evs = keep(await events());
    const first = evs.find((e) => e[0] !== "scroll")?.[1] ?? NaN;
    return { dwell: first - nav.end, chars };
  };
  for (const [name, path] of [["short", "/pacing-short"], ["long", "/pacing-long"]] as const) {
    const slow = await dwellRun(path, false);
    const quick = await dwellRun(path, true);
    const floor = clamp(220 + 0.08 * slow.chars * 0.8, 220, DWELL_CAP);
    const ceiling = clamp(220 + 0.08 * slow.chars * 1.25, 220, DWELL_CAP);
    const seen = `chars=${slow.chars} planned=${fmt(floor)}-${fmt(ceiling)} natural=${fmt(slow.dwell)} fast=${fmt(quick.dwell)}`;
    console.log(`NOTE pacing dwell ${name} ${seen}`);
    // The capped fixture must sit on the cap at both jitter ends, or its bounds would not test the clamp.
    const capped = name !== "long" || (floor === DWELL_CAP && ceiling === DWELL_CAP);
    judged(`pacing-nav-dwell-${name}`, capped && between(slow.dwell, floor, ceiling), `cap=${DWELL_CAP} ${seen}`);
    judged(`pacing-nav-dwell-${name}-fast`, quick.dwell < floor - TOL, `fast dwell=${fmt(quick.dwell)}ms, planned floor ${fmt(floor)}ms`);
  }

  // 3b. Reads right after nav pay no dwell: snap and text cost the same as after a fast nav.
  const readAfterNav = async (fast: boolean) => {
    await bc(["nav", ...(fast ? ["--fast"] : []), `${base}/pacing`]);
    const snap = await timed(["snap"]);
    const text = await timed(["text"]);
    return { snap: snap.ms, text: text.ms };
  };
  const rN = await readAfterNav(false);
  const rF = await readAfterNav(true);
  // 120 ms: wrapper start-up jitter between two short calls; an owed dwell would add at least 220 ms.
  judged("pacing-reads-no-dwell", rN.snap <= rF.snap + 120 && rN.text <= rF.text + 120, `natural snap=${rN.snap} text=${rN.text} fast snap=${rF.snap} text=${rF.text}`);

  // 5. Off-screen target: eased wheel flicks, no jump past one flick.
  await reset();
  const farOut = await bc(["click", "Far target"]);
  {
    const evs = keep(await events());
    const wheels = evs.filter((e) => e[0] === "wheel");
    const deltas = new Set(wheels.map((e) => e[5]));
    const ys = [0, ...evs.filter((e) => e[0] === "scroll").map((e) => e[6])];
    const maxJump = Math.max(0, ...ys.slice(1).map((y, i) => Math.abs(y - ys[i]!)));
    const clicked = evs.some((e) => e[0] === "click" && e[7] === "far");
    judged("pacing-wheel-flicks", wheels.length >= 2 && deltas.size >= 2, `wheels=${wheels.length} distinct deltaY=${deltas.size}`);
    record("pacing-wheel-click", clicked, `clicked=${clicked} last=${JSON.stringify(evs.slice(-6))} :: ${farOut}`);
    judged("pacing-wheel-no-jump", maxJump <= 680 && ys.length > 1, `max scroll jump=${maxJump}px over ${ys.length - 1} scroll events`);
  }

  // 7. Fast and natural-off clicks: legacy teleport, no wheel. Natural off goes through the per-call config
  // file, the same switch BROWSER_CONTROL_NATURAL=off sets, because the daemon's env is fixed at start.
  const legacyClick = async (name: string, args: string[]) => {
    await reset();
    await bc(["click", ...args, "Pacing target"]);
    await reset();
    await bc(["click", ...args, "Far target"]);
    const evs = keep(await events());
    const { down, path } = moves(evs);
    const up = evs.findIndex((e) => e[0] === "mouseup");
    const wheels = evs.filter((e) => e[0] === "wheel").length;
    record(`pacing-${name}-legacy-click`, down >= 0 && up > down && path.length <= 1 && wheels === 0, `mousemoves=${path.length} wheels=${wheels}`);
  };
  await legacyClick("fast", ["--fast"]);
  await bc(["natural", "off"]);
  try {
    await legacyClick("natural-off", []);
    const off = await fillRun(false, "off");
    judged("pacing-natural-off-fill-gaps", median(off.gaps) < NO_PAUSE_MAX, `gaps=${off.gaps.map(fmt).join(",")}`);
    record("pacing-natural-off-no-submit", off.submitted === 0, `submitted=${off.submitted}`);
    record("pacing-natural-off-date-echo", oneEcho(off.echo), echoText(off.echo));
    const nc = await navClick(false);
    const first = nc.evs.find((e) => e[0] !== "scroll")?.[1] ?? NaN;
    judged("pacing-natural-off-no-dwell", first - nc.nav.end < 220 - TOL, `first input ${fmt(first - nc.nav.end)}ms after nav returned`);
  } finally {
    await bc(["natural", "on"]);
  }

  // 9. Wall-clock totals (nav -> click fast measured here so pagination waits don't skew natural only).
  await Bun.sleep(4_100); // outside the 4 s pagination window, as the natural nav above was
  const ncF = await navClick(true);
  timing["nav-click"] = { natural: ncN.ms, fast: ncF.ms };

  // 10. Pagination: a second same-host nav on the same tab waits 1.6-2.8 s before it dispatches. Measured on
  // the fixture server's request log, so the gap is between the two requests rather than two calls. Per-page
  // /favicon.ico fetches are skipped so a gap is always between the two navigations themselves.
  const reqsSince = (from: number) => opts.navLog.slice(from).filter((r) => r.path !== "/favicon.ico");
  const showReqs = (reqs: NavEntry[]) => reqs.map((r) => `${r.path}@${r.t - (reqs[0]?.t ?? r.t)}`).join(" ");
  const gapBetween = (a: string, b: string) => {
    const at = (p: string) => opts.navLog.filter((r) => r.path === p).at(-1)?.t;
    const [ta, tb] = [at(a), at(b)];
    return ta !== undefined && tb !== undefined ? tb - ta : NaN;
  };
  await Bun.sleep(4_200); // start outside the 4 s window, so only the second nav of a pair may wait
  {
    const from = opts.navLog.length;
    await bc(["nav", `${base}/paging-a`]);
    const second = await timed(["nav", `${base}/paging-b`]);
    const gap = gapBetween("/paging-a", "/paging-b");
    judged("pacing-pagination-gap", between(gap, 1600, 2800) && second.ms >= 1600 - TOL,
      `requests ${showReqs(reqsSince(from))} dispatch gap=${fmt(gap)}ms call=${fmt(second.ms)}ms`);
  }
  {
    // A nav onto another host is not pagination, and neither is the nav back off it: the host changes on
    // both sides of the pair, so nothing waits.
    const from = opts.navLog.length;
    await bc(["nav", opts.frameUrl]);
    const back = await timed(["nav", `${base}/paging-c`]);
    const gap = gapBetween("/frame", "/paging-c");
    judged("pacing-pagination-cross-host", gap < 1600 - TOL && back.ms < 1600 - TOL,
      `requests ${showReqs(reqsSince(from))} cross-host gap=${fmt(gap)}ms call=${fmt(back.ms)}ms`);
  }
  {
    // The previous nav on this tab is more than 4 s old, so there is nothing to wait for.
    await Bun.sleep(4_200);
    const from = opts.navLog.length;
    const nav = await timed(["nav", `${base}/paging-d`]);
    const gap = gapBetween("/paging-c", "/paging-d");
    judged("pacing-pagination-idle-window", nav.ms < 1600 - TOL && gap >= 4000,
      `requests ${showReqs(reqsSince(from))} idle gap=${fmt(gap)}ms call=${fmt(nav.ms)}ms`);
  }

  // 11. Wall-clock totals must separate natural from fast by at least the pauses they add: one think pause per
  // step boundary (9 for fill10, 3 for do5, since none follows `wait` or the last step) and one nav dwell per
  // nav-then-input pair. Each floor is the planner's own minimum minus TOL per boundary; the totals also carry
  // the slower natural typing and pointer work, which keeps them far above that floor.
  const timingFloor: Record<string, number> = {
    fill10: 9 * (MIN_PAUSE - TOL),
    do5: 3 * (MIN_PAUSE - TOL),
    "nav-click": MIN_DWELL - TOL,
  };
  for (const [name, t] of Object.entries(timing)) {
    const floor = timingFloor[name] ?? 0;
    const slowBy = (t.natural ?? NaN) - (t.fast ?? NaN);
    console.log(`TIMING ${name} natural=${t.natural} fast=${t.fast} floor=${floor}`);
    judged(`pacing-timing-${name}`, t.natural !== undefined && t.fast !== undefined && slowBy >= floor,
      `natural=${t.natural} fast=${t.fast} slow by ${fmt(slowBy)}ms, floor ${floor}ms`);
  }

  // 6. Every event these commands dispatch is trusted input, with one exception: `select` and `type` into a
  // date field set the value in the page by design, and each such step emits exactly one untrusted
  // input+change pair on that control. The exact counts are checked on each run's own log above
  // (pacing-*-date-echo, pacing-do5-select-echo), so a duplicate in one run cannot cancel a missing pair in
  // another. What is left for the summed log is that no other untrusted event happened anywhere.
  const allowed = new Set(["input:country", "change:country", "input:start", "change:start"]);
  const counted: Record<string, number> = {};
  for (const e of allTrusted) if (e[2] !== true) counted[`${e[0]}:${e[7]}`] = (counted[`${e[0]}:${e[7]}`] ?? 0) + 1;
  const diff = Object.keys(counted).filter((k) => !allowed.has(k));
  console.log(`NOTE pacing: untrusted echoes ${JSON.stringify(counted)}`);
  record("pacing-all-trusted", allTrusted.length > 0 && diff.length === 0,
    `${allTrusted.length} events; untrusted=${JSON.stringify(counted)} unexpected=${diff.join(",")}`);

  // 8. A challenge page stops fill/do before a field is set, a button is pressed, or the form submits.
  type Wall = { v: string; submitted: number; pressed: number; typed: number };
  const wallState = () => evalJson<Wall>("({v:document.getElementById('wall-field').value,submitted:window.__submitted||0,pressed:window.__pressed||0,typed:window.__typed||0})");
  const wallStop = (out: string, steps: number) => /STOPPED: .*before step 1/.test(out) && new RegExp(`\\b${steps} step\\(s\\) not run`).test(out);
  const wallUntouched = (s: Wall) => s.v === "" && s.submitted === 0 && s.pressed === 0 && s.typed === 0;
  const wallNav = await bc(["nav", `${base}/pacing-wall`]);
  record("pacing-wall-nav", /CHALLENGE:|WALL:/.test(wallNav), wallNav);
  const wallFill = await bc(["fill", JSON.stringify({ "Wall field": "nope" })]);
  const afterFill = await wallState();
  await dump("wall", { wallNav, wallFill, afterFill });
  record("pacing-wall-fill-stops", /CHALLENGE:|WALL:/.test(wallFill) && wallStop(wallFill, 1) && wallUntouched(afterFill), `${JSON.stringify(afterFill)} ${wallFill}`);
  await bc(["eval", "document.getElementById('wall-field').value='';1"]);
  const wallDo = await bc(["do", JSON.stringify([{ click: "Wall button" }, { type: ["Wall field", "nope"] }])]);
  const afterDo = await wallState();
  await dump("wall-do", { wallDo, afterDo });
  record("pacing-wall-do-stops", /CHALLENGE:|WALL:/.test(wallDo) && wallStop(wallDo, 2) && wallUntouched(afterDo), `${JSON.stringify(afterDo)} ${wallDo}`);
}
