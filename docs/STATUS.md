# Phase 6 status (natural browsing)

Updated 2026-11-27. Spec: PLAN.md, "### Phase 6 — Natural browsing".

## Done

- PR #31 merged to main (e830d7a): `src/natural.ts` planners, the natural switch, `configFilePath()`, planner unit tests, the spec. No behavior change.
- Branch `feat/natural-pointer` (worktree `~/Developer/tools/browser-control-v2/p6-natural`): wiring into pointer, click, hover, drag, `key` and wheel scroll; page helpers v10; wrapper `natural [on|off|status]` and `--fast`; docs. Head d8fed3a passes unit 476/0 and e2e 56/0.
- d8fed3a: wheel from the resting pointer (no extra anchor move) and a cumulative pacer. alert-detect 1954 to 1263 ms.

## Open

1. Merge main (e830d7a) into `feat/natural-pointer`. Conflicts in `src/natural.ts` and `tests/natural.test.ts`, and maybe PLAN.md. Take main's `src/natural.ts` and PLAN.md. In the test file, keep main's planner sections and the branch's later sections (page-runner integration, helpers v10, wrapper).
2. Split the branch into PRs of 800 or fewer hand-written lines. Suggested: (B1) page helpers v10 plus pointer/click/hover/drag/key/wheel wiring and tests; (B2) wrapper `natural` and `--fast`, docs and guardrails.
3. Pacing PR: `do`/`fill` think pauses, lazy post-`nav` dwell, pagination gap, `text --scroll` jitter.
4. e2e fixture that records the real event stream (mousemove count, curvature, dwell, wheel deltas, isTrusted), plus a before/after timing table.
5. Each PR: Sol review (medium, 3 rounds), CI green, squash-merge with `--match-head-commit`.
6. After the last merge: `git pull --ff-only` in `~/Developer/tools/browser-control`, rebuild, tell the supervisor thread. Helpers v10 needs an extension reload.

## Timing (e2e, main vs branch)

- Whole suite 1.24× main (15.8 to 19.6 s).
- One natural click is about 860 ms against about 300 ms on main. The spec adds 520 to 570 ms (move 90 to 460 ms, dwell 45 to 115 ms, hold 55 to 130 ms). Neon could not go lower without shrinking the spec bounds. Per-flow budgets in PLAN.md include agent think time, so flows stay near 1.2 to 1.5×.

## Gotchas

- The e2e runs the built runtime. Run `bun run build:skill` after any `src` change before e2e.
- `tests/setup.ts` sets `BROWSER_CONTROL_NATURAL=off` and `BROWSER_CONTROL_BACKENDS=cdp`. Natural tests must turn natural on themselves.
- Run unit tests as `env -u BROWSER_CONTROL_BACKENDS bun test`.
- e2e: `BC_E2E_CHROME=<CfT path> BROWSER_CONTROL_BACKENDS=extension bun run test:e2e`. Every Chrome launch uses `--use-mock-keychain --password-store=basic` and a throwaway `--user-data-dir`. Never use ports 49222 to 49229 for test extensions, and never touch the user's Chrome Beta or `~/.config/browser-control`.
- `gh event listen` is unreliable here. Loop on `gh run list --branch <b> --limit 1 --json headSha,status,conclusion`.
