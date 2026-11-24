# AGENTS.md

## Project overview

**Agent** means any compatible reasoning/coding agent working in this repository.

`browser-control` drives a real, already-running Chromium browser (Chrome, Chromium, Edge,
Brave, Arc, Vivaldi, Opera, Comet, Canary) over the Chrome DevTools Protocol. It is an
**infrastructure capability**: the domain is the browser's own control surface, so the
operations are deliberately low-level protocol primitives rather than user-story verbs.
`execute_cdp` is the general operation; `evaluate`, `navigate`, `capture_screenshot`,
`capture_pdf`, `read_events`, and `wait_for_event` exist only where a raw protocol call is
insufficient or where hand-writing it is disproportionate. Composed browser *procedures*
(tabs, frames, input, dialogs, network, scrolling, downloads, cookies) live as agent skills
in `.agents/skills/browser-control/`, not as new operations.

The user's real browser is the target, signed in, with their extensions and open tabs. That
is the whole point: this is not a headless test harness, and it never launches a throwaway
profile.

## Repository layout

- `capability.json` — the manifest: name, version, entrypoint, delivery surfaces, and every
  operation's input/output schema. The single source of truth for the public surface.
- `src/index.ts` — the entrypoint contract: the `operations` map plus `initialize()` /
  `dispose()` lifecycle hooks.
- `src/session.ts` — browser discovery (process table + `DevToolsActivePort`), connection,
  target routing, and CDP call plumbing.
- `src/backends/` — optional extra backends beside CDP: `types.ts` (the `Backend` interface),
  `router.ts` (per-call routing and the backend order), `registry.ts` (the list), and one file per
  backend (`browse.ts`). CDP in `src/index.ts` stays the fallback for every operation.
- `src/events.ts` — the bounded cross-call event ring buffer and `wait_for_event`.
- `cli.ts` — thin standalone CLI bootstrap, and `--serve <socket>` to run the daemon.
- `daemon.ts` — long-lived Unix-socket server over the same runtime, so one CDP connection
  (and one Chrome "Allow" prompt) serves many short client calls.
- `mcp.ts` — thin standalone MCP bootstrap (plain tool names: `execute_cdp`, not
  `browser-control__execute_cdp`).
- `tests/` — `bun test` suites: manifest validity, operation behavior, session routing,
  standalone adapters.
- `src/page-helpers.ts` + `src/page-helpers.js.txt` — the in-page helper script (`__bc`),
  written as plain JavaScript in the `.js.txt` file and imported as text. `daemon.ts` injects
  it lazily once per document. It lists controls with stable refs, finds a control by label,
  reports what an action changed (`baseline`/`settle`/`diff`), returns readable text, and
  draws screenshot marks. Bump `VERSION` in the `.js.txt` and `PAGE_HELPERS_VERSION` in the
  `.ts` together on every change so tabs holding an old copy reinstall it. These are
  daemon/skill procedures, not capability operations.
- `src/ocr.ts` + `src/ocr.swift.txt` — text recognition for pages that are only a picture
  (macOS Vision). The Swift source is compiled once into `~/.cache/browser-control/`.
- `.agents/skills/browser-control/` — the skill that ships with this capability:
  `SKILL.md` (trigger + workflow routing), `references/*.md` (one procedure per file),
  `scripts/` (the thin curl-over-Unix-socket daemon client + CLI/MCP wrappers),
  `agents/openai.yaml`, and `runtime/` (**generated**, see below).

This repository is **not standalone**: it depends on `@agent-software/core` from the
`agent-software` repository, resolved as a sibling checkout
(`file:../agent-software/core`). Both repositories are private. Do not copy core into this
repository; the sibling dependency is the single source of truth.

## Setup

```bash
ls ../agent-software/core   # required: the sibling checkout that provides @agent-software/core
bun install
```

Bun is the only runtime requirement. There are no credentials and no configuration files:
the browser must merely allow remote debugging (in current Chrome, open
`chrome://inspect/#remote-debugging` and check "Allow remote debugging for this browser
instance"). The port changes on every browser restart, which is why callers must never pass
a port — `connect_browser` discovers the live one.

## Commands

- Run all tests: `bun test` (if the standalone tests fail with "Cannot copy a socket file",
  git's file watcher has a socket in `.git`: run `git fsmonitor--daemon stop` and retry)
- Typecheck: `bun run typecheck`
- Standalone CLI, one process per call: `bun ./cli.ts <operation> '<json>'`
  (add `--init <operation> '<json>'` to prepare state, or `--session` to read operations from
  stdin in one process)
- Standalone MCP server: `bun ./mcp.ts`
- Daemon mode: `bun ./cli.ts --serve <socket>`
- Rebuild the skill's bundled runtime: `bun run build:skill`

Run `bun test` and `bun run typecheck` while editing; run both before calling work complete.
No linter is configured.

## Generated files

`.agents/skills/browser-control/runtime/` is build output from `bun run build:skill`: it
bundles `cli.ts`, `mcp.ts`, `capability.json`, `README.md`, and all of `src/` so the skill folder
is self-contained. It is committed, because the skill is expected to work straight from a
clone. **Never hand-edit anything under `runtime/`.** After changing `src/`, `cli.ts`,
`daemon.ts`, or `capability.json`, run `bun run build:skill` and commit the result, or the
skill silently ships old behavior. A drifted runtime is the most likely bug in this repo.

## Code style

- Bun + TypeScript, `strict` (`tsconfig.json`).
- Extensionless relative imports (`./session`, not `./session.ts`).
- Operation names are `snake_case` and are enforced by the manifest validator.
- Match the existing shape: top-level handlers in `src/index.ts` delegating to `session.ts`
  helpers, `InvokeResult` envelopes at the boundary, no transport logic in `cli.ts`/`mcp.ts`.

## Contracts

- `operations: Record<string, (input) => Promise<unknown> | unknown>` must cover every
  operation declared in `capability.json`. `initialize()`/`dispose()` manage long-lived
  resources; never acquire a connection at module top level (modules are re-imported on
  reload).
- `invoke` returns `{ ok: true, data }` or
  `{ ok: false, error: { code, message } }`. Codes: `CAPABILITY_NOT_FOUND`,
  `OPERATION_NOT_FOUND`, `INPUT_VALIDATION_FAILED`, `EXECUTION_FAILED`.
- Operation handlers surface stable message prefixes inside `EXECUTION_FAILED` messages:
  `NOT_CONNECTED`, `NO_ACTIVE_TARGET`, `CDP_TIMEOUT`, `JS_EXCEPTION`, `NAVIGATION_FAILED`,
  `INPUT_INVALID`, `ARTIFACT_WRITE_FAILED`. Raw CDP errors are passed through as
  `CDP <code>: <message>`. `wait_for_event` timing out is a normal `found: false` result.
- `state.kind` is `external-service`: tabs, cookies, and storage live in the browser. The
  connection, the single active target route, and the event buffer are in-process state.
  The active route is shared mutable state; serialize routing-sensitive flows.

## Safety and data rules

- **Never restart, stop, or disconnect the daemon to "fix" a failure.** Each new connection
  costs the user a physical Allow click in Chrome, and the daemon holds an approved one.
  `disconnect_browser` and a bare `stop` refuse by design; `stop --force` only when the user
  asks for it.
- **Never guess or pass a debugging port.** Discover it.
- Do not open a second path to the browser (another daemon, a custom script, or a saved
  port). If a command fails, read the error and fix the command.
- Screenshots, PDFs, and captured payloads are user data. The artifact directory defaults to
  the OS temp dir and `data/` is gitignored; nothing from a browsing session belongs in a
  commit, a test fixture, or a README example.
- Never commit `.env` files, tokens, cookies, or captured page content.
