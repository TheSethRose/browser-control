// Real-browser natural pacing check (PLAN.md Phase 6). Drives fixtures/pacing.html through the real wrapper and
// daemon, reads the page's own capture-phase event log back over attach-free eval, and checks the timeline
// against the spec bounds in src/natural.ts. Called from run.ts once the extension is connected.

export type Bc = (args: string[], timeoutMs?: number) => Promise<string>;
export type PacingRecord = (name: string, ok: boolean, detail: string) => void;

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
// Fast and natural-off steps still pay settle + start-up (140-180 ms typical, one-offs up to 262 ms measured); a
// think pause would add at least 160 ms to every gap. Single gaps flaked at 250 ms, so the fill checks use the
// median of the 9 gaps, which a pause in each gap would push past 300 ms.
const NO_PAUSE_MAX = 250;
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

export async function runPacingCheck(bc: Bc, base: string, record: PacingRecord): Promise<void> {
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
    return { r, evs, values, submitted, gaps, tail: r.end - lastInput, name };
  };
  const fillN = await fillRun(false, "natural");
  const valuesOk = JSON.stringify(fillN.values) === JSON.stringify(EXPECTED);
  record("pacing-fill10-values", valuesOk && !/STOPPED|FAILED/.test(fillN.r.out), `${JSON.stringify(fillN.values)} ${fillN.r.out}`);
  record("pacing-fill10-gaps", fillN.gaps.every(stepGap), `gaps=${fillN.gaps.map(fmt).join(",")}`);
  record("pacing-fill10-no-submit", fillN.submitted === 0, `submitted=${fillN.submitted}`);
  timing["fill10"] = { natural: fillN.r.ms };

  const fillF = await fillRun(true, "fast");
  record("pacing-fill10-fast-values", JSON.stringify(fillF.values) === JSON.stringify(EXPECTED), JSON.stringify(fillF.values));
  record("pacing-fill10-fast-gaps", median(fillF.gaps) < NO_PAUSE_MAX, `gaps=${fillF.gaps.map(fmt).join(",")}`);
  record("pacing-fill10-fast-no-submit", fillF.submitted === 0, `submitted=${fillF.submitted}`);
  // The tail after the last keystroke is settle + diff + wrapper exit in both modes; natural must add no pause.
  record("pacing-fill10-no-trailing-pause", fillN.tail <= fillF.tail + TOL + 100, `natural tail=${fmt(fillN.tail)} fast tail=${fmt(fillF.tail)}`);
  timing["fill10"]!.fast = fillF.r.ms;
  const span = (xs: number[]) => `${fmt(Math.min(...xs))}-${fmt(Math.max(...xs))}`;
  console.log(`NOTE pacing gaps natural=${span(fillN.gaps)} fast=${span(fillF.gaps)} tails natural=${fmt(fillN.tail)} fast=${fmt(fillF.tail)}`);

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
    };
  };
  const doN = await doRun(false);
  const doF = await doRun(true);
  const doOk = (d: typeof doN) => !/STOPPED|FAILED/.test(d.r.out) && d.submitted === 0 && d.values.join() === "Grace,true,true,Peru";
  record("pacing-do5-ran", doOk(doN) && doOk(doF), `${doN.values} / ${doF.values} ${doN.r.out}`);
  record("pacing-do5-gaps", stepGap(doN.gap12) && stepGap(doN.gap45), `gap12=${fmt(doN.gap12)} gap45=${fmt(doN.gap45)}`);
  // Across the wait: one think pause (after the click) plus the wait itself, measured in fast mode where no
  // think pause runs. A second pause after `wait` would push this past 420 ms + the wait's own cost.
  const waitCost = Math.max(0, doF.gap24);
  record("pacing-do5-no-pause-after-wait", between(doN.gap24, 160, 420 + waitCost, TOL + STEP_START), `gap24=${fmt(doN.gap24)} fast gap24=${fmt(doF.gap24)}`);
  record("pacing-do5-no-trailing-pause", doN.tail <= doF.tail + TOL + 100, `natural tail=${fmt(doN.tail)} fast tail=${fmt(doF.tail)}`);
  record("pacing-do5-fast-gaps", doF.gap12 < NO_PAUSE_MAX && doF.gap45 < NO_PAUSE_MAX, `gap12=${fmt(doF.gap12)} gap45=${fmt(doF.gap45)}`);
  timing["do5"] = { natural: doN.r.ms, fast: doF.r.ms };

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
  const firstInput = ncN.evs.find((e) => e[0] !== "scroll")?.[1] ?? NaN;
  // Dwell is owed from the daemon's nav record, which is just before `nav` returns: the first input lands at
  // least 220 ms after it, less the wrapper's exit and the next call's start-up (both inside the window).
  record("pacing-nav-dwell", firstInput - ncN.nav.end >= 220 - TOL, `first input ${fmt(firstInput - ncN.nav.end)}ms after nav returned`);

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
    record("pacing-click-hover-dwell", between(dwell, 45, 115), `dwell=${fmt(dwell)}ms`);
    const hold = d && up ? up[1] - d[1] : NaN;
    record("pacing-click-hold", between(hold, 55, 130), `hold=${fmt(hold)}ms`);
    const [x, y] = d ? [d[3]!, d[4]!] : [NaN, NaN];
    const inside = x > b.l && x < b.r && y > b.t && y < b.b;
    const offCenter = Math.abs(x - (b.l + b.r) / 2) > 0.5 || Math.abs(y - (b.t + b.b) / 2) > 0.5;
    record("pacing-click-point", inside && offCenter, `point=${x},${y} box=${JSON.stringify(b)}`);
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
  record("pacing-reads-no-dwell", rN.snap <= rF.snap + 120 && rN.text <= rF.text + 120, `natural snap=${rN.snap} text=${rN.text} fast snap=${rF.snap} text=${rF.text}`);

  // 5. Off-screen target: eased wheel flicks, no jump past one flick.
  await reset();
  await bc(["click", "Far target"]);
  {
    const evs = keep(await events());
    const wheels = evs.filter((e) => e[0] === "wheel");
    const deltas = new Set(wheels.map((e) => e[5]));
    const ys = [0, ...evs.filter((e) => e[0] === "scroll").map((e) => e[6])];
    const maxJump = Math.max(0, ...ys.slice(1).map((y, i) => Math.abs(y - ys[i]!)));
    const clicked = evs.some((e) => e[0] === "click" && e[7] === "far");
    record("pacing-wheel-flicks", wheels.length >= 2 && deltas.size >= 2 && clicked, `wheels=${wheels.length} distinct deltaY=${deltas.size} clicked=${clicked}`);
    record("pacing-wheel-no-jump", maxJump <= 680 && ys.length > 1, `max scroll jump=${maxJump}px over ${ys.length - 1} scroll events`);
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
    record("pacing-natural-off-fill-gaps", median(off.gaps) < NO_PAUSE_MAX && off.submitted === 0, `gaps=${off.gaps.map(fmt).join(",")}`);
    const nc = await navClick(false);
    const first = nc.evs.find((e) => e[0] !== "scroll")?.[1] ?? NaN;
    record("pacing-natural-off-no-dwell", first - nc.nav.end < 220 - TOL, `first input ${fmt(first - nc.nav.end)}ms after nav returned`);
  } finally {
    await bc(["natural", "on"]);
  }

  // 9. Wall-clock totals (nav -> click fast measured here so pagination waits don't skew natural only).
  await Bun.sleep(4_100); // outside the 4 s pagination window, as the natural nav above was
  const ncF = await navClick(true);
  timing["nav-click"] = { natural: ncN.ms, fast: ncF.ms };
  for (const [name, t] of Object.entries(timing)) {
    console.log(`TIMING ${name} natural=${t.natural} fast=${t.fast}`);
    record(`pacing-timing-${name}`, t.natural !== undefined && t.fast !== undefined, `natural=${t.natural} fast=${t.fast}`);
  }

  // 6. Every event these commands dispatch is trusted input. `select` and `type` into a date field set the value
  // in the page by design, so the input/change echo on those two controls is untrusted; it is counted and printed,
  // and every pointer, key, wheel, focus and scroll event must still be trusted.
  const valueSet = (e: Ev) => (e[0] === "input" || e[0] === "change") && (e[7] === "country" || e[7] === "start");
  const untrusted = allTrusted.filter((e) => e[2] !== true && !valueSet(e));
  const echoes = allTrusted.filter((e) => e[2] !== true && valueSet(e)).length;
  console.log(`NOTE pacing: ${echoes} untrusted input/change echoes from select/date value sets`);
  record("pacing-all-trusted", allTrusted.length > 0 && untrusted.length === 0, `${allTrusted.length} events, untrusted=${JSON.stringify(untrusted.slice(0, 3))}`);

  // 8. A challenge page stops fill/do before any field is set or anything is pressed.
  const wallState = () => evalJson<{ v: string; p: number }>("({v:document.getElementById('wall-field').value,p:window.__pressed||0})");
  const wallNav = await bc(["nav", `${base}/pacing-wall`]);
  record("pacing-wall-nav", /CHALLENGE:|WALL:/.test(wallNav), wallNav);
  const wallFill = await bc(["fill", JSON.stringify({ "Wall field": "nope" })]);
  const afterFill = await wallState();
  await dump("wall", { wallNav, wallFill, afterFill });
  record("pacing-wall-fill-stops", /CHALLENGE:|WALL:/.test(wallFill) && afterFill.v === "", `${JSON.stringify(afterFill)} ${wallFill}`);
  await bc(["eval", "document.getElementById('wall-field').value='';1"]);
  const wallDo = await bc(["do", JSON.stringify([{ click: "Wall button" }, { type: ["Wall field", "nope"] }])]);
  const afterDo = await wallState();
  await dump("wall-do", { wallDo, afterDo });
  record("pacing-wall-do-stops", /CHALLENGE:|WALL:/.test(wallDo) && afterDo.v === "" && afterDo.p === 0, `${JSON.stringify(afterDo)} ${wallDo}`);
}
