# CAPTCHA Solving — Research, Plan, and Progress

**Target:** the final browser-control update (v2.0.0 release, `v2` branch).
**Status:** approved and Phase A implemented (agent-native: `solve_captcha` + `--verify`). Small, opt-in, zero new permissions/dependencies/network.
**Goal:** CAPTCHAs are solved by the agent itself — vision + browser-control tools — locally, with **zero paid services**, as a deterministic extension of the existing `challenges.ts` detection pipeline.

---

## 1. Goal and decisions

- **The agent is the solver.** The user's own experience proves it: an agent drove the "I'm Not a Robot" game to **level 50** using vision + browser control, in about 4 hours. No API service involved.
- **No paid service, by default.** No API keys, no network calls, no subscription. Paid providers (NopeCHA, 2Captcha, CapSolver) are opt-in fallbacks for non-vision deployments only — off by default.
- **Local first.** Static-text challenges get deterministic local OCR (macOS Vision, already in the toolchain). Everything else is vision. No network.
- **Human stays the last resort.** MFA, account recovery, fraud-prevention, and anything the agent genuinely cannot solve → `handoff` (unchanged).

### Real-world evidence (this session, live)

The game at `https://neal.fun/not-a-robot/` **is** the challenge:

- **Level 1: Checkbox** — a reCAPTCHA checkbox. Verified: one click advanced the page to Level 2.
- **Level 2: Stop Signs** — a 4×4 visual grid ("Select all the squares with a Stop Sign"), with a Verify button and a Reset button in the footer. Requires vision over the grid + ref/coordinate clicks + verify + level-advancement as the solved signal.
- The agent's loop is: detect → report → act → verify → advance. The gate (Level 1) is one-time; after the gate, levels are ordinary interactive worlds — no captcha machinery needed beyond the one-time gate.

This confirms the shape of the solution: a **structured report + agent loop**, not an API call.

## 2. Why the agent can solve today — and what it's missing

**Already in the toolchain (no changes):**
`snap` (refs, frame refs `fN:eM`), `shot --ref` (element crop), `ocr` (macOS Vision, whole-tab), `click` (ref/xy/label), `type`, `drag`, `key`, `verdict`, `text`, `handoff`, `do`.

**The gap:** today `solve_captcha` does not exist. The classifier only reports `cloudflare interactive` (vendor + kind). The agent must re-derive *what* the widget is, *which tool* to use, and *how to verify* it worked. Existing CHALLENGE: output says only "A person has to answer it" — which is exactly what makes the agent reach for `handoff` instead of solving it.

**Real gaps to close (small, targeted):**
1. **Widget-type classification** — checkbox / image-text / slider / audio / video / math / unknown, from the same vendor markers we already probe.
2. **Frame-ref capture** — `shot --ref f1:e2` fails today (`shot` requires main-page `eN` refs); Turnstile/reCAPTCHA widgets live in cross-origin iframes.
3. **Crop-aware OCR** — `ocr` reads the whole tab; `ocr --ref eN` crops the widget (agent needs an exact answer for static-text challenges).
4. **`solve_captcha` report** — structured output: vendor, kind, widgetType, widget ref/box, suggested action, verify command.
5. **`--verify`** — deterministic re-probe + report (`solved` / `pending` / `unresolved`), including the ability to diff game-state headings (`Level N: <task>`).
6. **`drag --xy` / coordinate drag** (optional) — iframe sliders can't use main-page `drag`; `click --xy` is the fallback today.

## 3. What changes — and what doesn't

**New files (no extension-side changes):**
- `src/captcha.ts` — widgetType classification + report builder (detection logic unchanged).
- `src/captcha-config.ts` — optional config (agent-first; no keys required; paid providers off by default).

**Changed:**
- `src/challenges.ts` — **addition only:** widget type heuristic from the existing vendor/marker signals. Existing `{vendor, kind, reason}` output unchanged.
- `src/page-runner.ts` — new `solve_captcha` action (`--no-solve` report mode is the agent's default; `--verify` to re-check; `--crop` to capture).
- `src/page-runner.ts` (`shot`) — resolve frame refs (`fN:eM`) for `--ref`.
- `src/page-runner.ts` (`ocr`) — `--ref`/`--crop` support (crop-aware OCR).
- `src/page-runner.ts` (`checkChallenge`) — `CHALLENGE:` remedy line changes from the unconditional human-first text to **agent-first** guidance: solve via `solve_captcha`, then verify; `handoff` as fallback.
- `capability.json` / `daemon.ts` / `cli.ts` — `solve_captcha` command, same pattern as `handoff`.
- `tests/captcha.test.ts` — unit fixtures for widgetType, report shape, `--verify`, frame refs.

**Unchanged (deliberately):**
- `extension/` — **zero changes**. No new permissions, no network, no key material, no relay changes.
- The `CHALLENGE:` detection/auto-wait for `non-interactive` interstitials — unchanged.
- `block` hard-stop — unchanged (never retry past a block).
- `handoff` UX/overlay — unchanged.
- No dependencies beyond the existing toolchain. No new npm packages. No new network calls.

## 4. Agent flow (concrete)

```text
nav / snap / do  →  CHALLENGE: (existing)
  ↓ agent calls
solve_captcha                   →  vendor, kind, widgetType, widget ref/box, suggested action, verify hint
  ↓ agent acts with existing tools:
      checkbox   → click --ref f1:e2          (or click --xy WxH)
      image/text → shot --ref eN → ocr --ref eN or vision → type into the input
      slider     → shot --ref eN → vision → drag --ref / drag --xy / click --xy fallback
      audio      → not vision-solvable → handoff (honest answer, matches the truth)
      video      → vision on crop
  ↓ verify:
solve_captcha --verify           →  solved | pending | unresolved (+ heading diff for game pages)
  ↓ failed after N attempts:
handoff (unchanged overlay)
```

**Example agent-facing output:**

```text
CAPTCHA: recaptcha interactive on https://example.com
widget: recaptcha checkbox (f1:e2)
ask: click the checkbox in the widget
verify: solve_captcha --verify
```

## 5. Candidate landscape (researched, verified)

| Candidate | License | Maintenance | Local? | Solves | Fit | Verdict |
|---|---|---|---|---|---|---|
| **Agent + vision (this plan)** | — | — | **Yes (all)** | checkbox / image / slider / text / game levels | Fully agent-native; $0; no network | **Primary — default** |
| **Captcha Helper** (`hongshuo-wang/local-captcha-solver`) | MIT | Active | **Yes (static text OCR)** | static text/image | Closest local-first pattern; narrow scope | **Pattern for the local OCR tier** |
| **EzSolver** (`ismoiloffS/EzSolver`) | MIT | Active | **Yes (real browser)** | Cloudflare Turnstile only | Non-extension; solver binary/service | Future local option, not needed now |
| **Buster** (`dessant/buster`) | GPL-3.0 | Active | Yes (speech OCR) | reCAPTCHA audio | Human-oriented; needs native client app | Reference for audio-challenge pattern; not needed now |
| **NopeCHA** (`NopeCHALLC/nopecha-extension`) | MIT | Active | No (API) | broad (reCAPTCHA, Turnstile, AWS WAF, GeeTest, video, …) | Free 100/day no key; API-only usable surface | **Opt-in paid fallback (off by default)** |
| **2Captcha** (`rucaptcha/2captcha-solver`) | MIT | Quiet but official | No (API) | wide | Vendor pricing; MIT extension | **Opt-in paid fallback** |
| **CapSolver** (`capsolver/capsolver-browser-extension`) | ⚠️ none | Active | No (API) | broad AI | No public pricing (SPA) | **Opt-in paid fallback** |
| **Steel / CloakBrowser / Browserless** | Apache/MIT/SSPL | Active | Cloud/Docker | various | Different architectures (browser services) | Reference only; not a fit |

**Known limits:** all paid providers are unverified for usability; agent-native is unverified beyond the observed 4-hour / 50-level run (which is itself the strongest evidence). Level-2-class visual tasks will not be solved by an API either.

## 6. Decisions (resolved 2026-11-27, Phase A)

1. **CHALLENGE: remedy text** — unchanged in this PR. `solve_captcha`'s report is the agent-first guidance; the existing human-first `CHALLENGE:` text stays to avoid colliding with Phase 6's challenge code.
2. **`--verify` semantics** — re-probe via the same `checkChallenge` engine; reports `still present` / `clear` / `BLOCKED`. Deterministic; no snap-and-diff.
3. **Paid providers** — fully off (no keys, no network, no subscription). NopeCHA/2Captcha/CapSolver are opt-in fallbacks only, not wired in this PR.
4. **Audio/video** — `solve_captcha` reports the widget hint (`audio` / `video`) with an honest next action; the agent hands off instead of pretending to hear/see. No added dependencies.
5. **Game-state reporting** — deferred (Phase C). The report is bounded; game headings add a text read on every call. Revisit if game pages need it.
6. **`drag --xy`** — deferred; `click --xy` / frame-ref click is the fallback today.

**Explicitly out of this PR** (all deferred, deliberately): frame-ref `shot --ref`, crop-aware `ocr --ref`, remedy-line change, game heading reporting, drag --xy, paid opt-in.

## 7. Progress log

- **2026-11-27:** Inspected the repo (`PLAN.md`, `src/challenges.ts`, `src/page-runner.ts`, `extension/manifest.json`, `src/index.ts`, `capability.json`, `daemon.ts`). No code changed.
- **2026-11-27:** Researched 9 candidates (NopeCHA, CapSolver, Buster, 2Captcha Solver, Steel, CloakBrowser, Browserless, Captcha Helper, EzSolver) against the current architecture. No code changed.
- **2026-11-27:** Ran the neal.fun/not-a-robot/ game live: Level 1 reCAPTCHA checkbox clicked → page advanced to Level 2 (4×4 visual grid, "Stop Signs", Verify button). This is the real-world proof; the game is the challenge.
- **2026-11-27:** Pivot — dropped the paid-provider-default design in favor of agent-native solving with zero network. Decisions 1–6 above pending.
- **Final pending:** Seth approves the plan; then Phase A (no extension changes).

## 8. What is NOT changing (guardrails)

- No paid services, no API keys, no network calls — by default.
- Extension stays network-free and credential-free (no new `permissions` in the manifest).
- Existing `CHALLENGE:` / `BLOCKED:` behavior and `handoff` UX are preserved.
- No new npm dependencies.
- No over-engineering: one new module, one new command, two small extensions (frame-ref `shot`, `--ref` `ocr`).

## 9. Phase plan

- **Phase A (no extension changes) — shipped:** `src/captcha.ts` (widgetType + report), `solve_captcha` command + `--verify` (report-only), unit tests, docs, wrapper route. **Done:** `solve_captcha` reports detection + widgetType + suggested action on a real page; existing tests green.
- **Phase B (local OCR tier):** `ocr --ref`, crop-aware OCR for static-text challenges, verification loop, fallback to vision. **Done when:** static-text challenges solve with zero network.
- **Phase C (game-state reporting):** `solve_captcha` reports game/task heading; `--verify` diffs levels. **Done when:** the neal.fun game can be verified at the level boundary without a full re-read.
- **Phase D (optional paid opt-in):** NopeCHA/2Captcha/CapSolver behind a config flag, off by default. **Done when:** one keyed provider can be selected without changing defaults.
- **Phase E (hardening):** e2e against official pages, budget/usage reporting, docs (`PLAN.md`, `README.md`). **Done when:** e2e green + acceptance criteria below.

## 10. What the report proves (and what it doesn't)

`solve_captcha` (and `--verify`) report **detection evidence**, not ground truth:

- **True:** the page was probed; the probe either found a challenge, found nothing, or could not read the page. `unknown` means the read failed or was incomplete — never "clear".
- **True:** `--verify` re-reads with a forced full probe (no fast-path skip) and a widget-marker double-check on long pages, so a page that still carries a widget reports still present.
- **Not true:** that the answer was accepted or the challenge is solved — only the agent (or the user) can confirm that. `--verify` says whether the page still shows a challenge after the agent's answer; it says nothing about the answer's correctness.

## 10b. Acceptance criteria

- Detection rate ≥ 95% on official demo pages (manual, not vendor-claimed).
- Agent-native solve rate on checkbox/image/slider/text challenges: measured in Phase A/C on the official pages; no vendor claim.
- Zero network on the default path; zero new permissions; zero new dependencies.
- `--verify` reports the solved signal deterministically (marker-clear or heading-advance).
- Any unsolvable case → `handoff` in <5 s, never a hang.
- Existing `CHALLENGE:` output format preserved when no solve happens (except the remedy line, which changes per decision #1).

## 11. Known limitations

- Visual-grid / multi-step game tasks remain vision-bound; structured reports cut exploration overhead, not the wall-clock.
- Frame-ref capture and `ocr --ref` need small, contained code changes before agents can use them; not yet verified.
- Game-state diffing ("Level N advanced") is a best-effort signal; the heading may not always change — report honestly, don't overclaim.
- Audio challenges are out of scope for vision; honest handoff is the answer.
- Vendor claims (NopeCHA 100 free/day, etc.) remain unverified and are only relevant if a paid provider is later enabled.

---

**Plan saved:** 2026-11-27 · **Goal:** final browser-control update · **Awaiting approval** for Phase A.

---

## Phase A — implemented (this PR, review round 1)

- `src/captcha.ts` (new, pure): `widgetTypeOf` + `formatCaptchaReport`. `widgetTypeOf` maps detection to `checkbox | image | slider | audio | video | unknown` (reason text first, then vendor map; `unknown` is honest). Never throws. The page-derived reason is always inside its own untrusted-content boundary; the report's first line is tool guidance only.
- `src/page-runner.ts`: new opt-in `solve_captcha` action (report-only by default, `--verify` re-checks with a forced full probe + widget-marker double-check). Uses the same `checkChallenge` engine as nav/snap/do. `solve_captcha` added to `PAGE_ACTIONS`; no other challenge-path code touched.
- `daemon.ts`: `solve_captcha` joins `UNTRUSTED_PAGE_ACTIONS` (page-derived reason text is escaped/wrapped like all page-derived output).
- Wrapper script: `solve_captcha [--verify]` routed to `page/solve_captcha`; listed in `help`.
- `tests/captcha.test.ts` (new): widgetType fixtures, report shape + untrusted boundary, `--verify`, garbage-input safety, fake-CDP-probe wiring, and both-tier harness tests (CDP + silent extension `bcCall` tier: attach-free, one status read, no `evaluate`/`Input.*`).
- The tool reports; the agent solves. The tool never clicks, never calls an API, never mutates the page.
- No changes to: `challenges.ts`, `extension/`, page-helpers, `checkChallenge`/`formatChallengeOutput`/`do`/`fill` (Phase 6 surface). No new permissions, dependencies, or network. No MCP command, no frame-ref screenshots — deliberately out of Phase A.
