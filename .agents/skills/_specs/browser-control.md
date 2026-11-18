# Spec: `browser-control`

Agent-native capability for driving and inspecting a Chromium-based browser over the
Chrome DevTools Protocol (CDP).

- Source studied (read-only): `https://github.com/browser-use/browser-harness-js`
- Default branch at study time: `main`
- Resolved commit: `2d9a5ed37ed11f31b2622cd69c4b55f979cb905f` (2026-08-30, `fix: route extension commands through browser session (#7)`)
- Contract: `docs/repo-to-spec.md`
- artifact_plan: `both` (executable capability primitives + interaction skills)
- delivery_plan: `both` (standalone capability CLI + standalone MCP over the shared implementation; the skill consumes the logical operations)
- required executable capability: the 12 CDP operations under `operations/tools`
- required skill/workflow knowledge: the `browser-control` skill plus its reference workflows
- Status: implemented. The capability's `src/` is the shared implementation; `cli.ts` and `mcp.ts` are thin standalone bootstrappers, and the aggregate Agent Software MCP remains optional. Nothing was written to the source repository.

This is an original specification. No donor source, branding, or product language is reproduced.

---

## artifact_plan: both

The executable primitives (browser/CDP connection, target routing, artifact materialization,
cross-call event state) cannot be performed with tools the agent already has, so a
**capability** is required. The repository's value also includes reusable interaction
techniques — dropdowns, iframes/OOPIFs, shadow DOM, dialogs, uploads, scrolling,
drag-and-drop, cookies, network interception, screenshot/print recipes — that compose those
primitives and belong in **skills**. The capability alone would force agents to rediscover
those techniques; skills alone would be impossible without the primitives. Hence `both`.

The `capability operations` are specified below under `operations/tools`; the
`agent skills/workflows` are specified in `skills/workflows`.

---

## purpose

Give an arbitrary agent structured control over a user's real Chromium-based browser
(Chrome, Chromium, Edge, Brave, Arc, Vivaldi, Opera, Comet, Canary) by:

1. discovering running browsers that expose a remote-debugging endpoint;
2. establishing and retaining one browser-level CDP connection across many operations;
3. enumerating and routing to browser targets (tabs / out-of-process iframes / workers);
4. executing any CDP command as a general primitive;
5. materializing binary browser output (screenshots, PDFs) as files;
6. observing CDP events across operation boundaries (poll and wait).

The capability is **infrastructure**: its domain is browser control, so low-level browser
primitives are legitimate. It deliberately exposes one general operation (`execute_cdp`)
that carries most of the protocol surface, and a small number of operations that exist
only where a raw protocol call is insufficient — binary artifacts and cross-call event
state. Higher-level usage patterns (dropdowns, drag-and-drop, dialogs, OOPIFs, uploads,
scrolling, network interception, tab ordering) are **agent skills**, not capability
operations.

## Domain model

### Entities

| Entity | Fields | Notes |
| --- | --- | --- |
| `BrowserEndpoint` | `name`, `profileDir`, `port`, `wsUrl`, `mtimeMs` | A running browser exposing remote debugging. Discovered from `DevToolsActivePort` per profile dir. |
| `Connection` | `state` (`disconnected`/`connecting`/`connected`/`error`), `wsUrl`, `browserVersion`, `lastError` | One retained browser-level WebSocket owned by the capability process. |
| `Target` | `targetId`, `type` (`page`/`iframe`/`worker`/`service_worker`/`browser`/`other`), `title`, `url`, `attached`, `openerId?` | From `Target.getTargets`. `chrome://` and `devtools://` hidden by default. |
| `ActiveRoute` | `targetId`, `sessionId` | The single target that target-scoped calls auto-route to. |
| `CdpCall` | `id`, `method`, `params`, `sessionId?`, `result` \| `error` | One request/response exchange on the retained socket. |
| `CdpEvent` | `seq`, `method`, `params`, `sessionId?`, `at` | Asynchronous CDP event copied into the in-process buffer. |
| `Artifact` | `path`, `mimeType`, `bytes`, optional `width`/`height` | Screenshot/PDF materialized to a stable absolute directory. |

### State and transitions

Connection:

```text
disconnected --connect_browser--> connecting --ok--> connected
                                       \--error--> error
connected --socket close / disconnect_browser--> disconnected
```

Routing:

```text
none --select_target(targetId)--> active(targetId, sessionId)
active --select_target(other)--> active(other)
active --clear_target--> none
```

Event buffer:

- Always fed by the browser socket's message pump while `connected`.
- Appended in receive order; bounded (default 1000, oldest dropped).
- `read_events` drains; `wait_for_event` installs a one-shot matcher and also consumes
  the buffer for a matching event that already arrived.
- Reset to empty on connect/disconnect/reload.

Artifacts:

```text
execute capture_screenshot / capture_pdf --> Artifact path on disk (no state carried forward)
```

## operations/tools

Naming follows `docs/operations-conventions.md` (`verb_object`, no whitespace). This is an
infrastructure capability: the operation vocabulary is the browser's own control surface,
which is documented and intentional (see "convention changes"). No operation is a UI
automation wrapper around a human GUI flow; `execute_cdp` is a protocol call, not a click
helper.

### `list_browsers`

- Purpose: enumerate running Chromium browsers with remote debugging enabled so the agent can pick one when several are running.
- Input: `{}` (no parameters).
- Output: `{ browsers: [{ name, profileDir, port, wsUrl, mtimeMs }] }`, most recently launched first.
- Side effects: none.

### `connect_browser`

- Purpose: open and retain the browser-level CDP WebSocket. Idempotent: if already connected, returns current connection info.
- Input:
  - `wsUrl?` (string) — explicit browser endpoint, e.g. `ws://127.0.0.1:9222/devtools/browser/<uuid>`.
  - `profileDir?` (string) — read `<profileDir>/DevToolsActivePort` to build the endpoint.
  - `port?` (number), `host?` (string, default `127.0.0.1`) — explicit port form.
  - `timeoutMs?` (number, default 5000) — per-candidate WebSocket-open timeout. Raise toward 30000 when a user must click the browser's remote-debugging "Allow" prompt.
  - Address forms are mutually exclusive; none means auto-detect from `list_browsers` order.
- Output: `{ connected: true, via: { name?, profileDir?, wsUrl }, browserVersion }`.
- Errors: no browser found; all candidates refused (403 / not allowed); timeout; malformed `DevToolsActivePort`.

### `disconnect_browser`

- Purpose: close the retained socket, clear the active route and event buffer.
- Input: `{}`.
- Output: `{ connected: false }`.
- Idempotent.

### `get_browser_status`

- Purpose: report capability-level state that CDP cannot report (connection, routing, buffer, artifact dir).
- Input: `{}`.
- Output: `{ connected, wsUrl?, browserVersion?, activeTargetId?, activeSessionId?, eventsBuffered, artifactDir }`.
- Side effects: none.

### `list_targets`

- Purpose: enumerate browser targets; find attachable tabs and out-of-process iframes.
- Input: `{ includeAll?: boolean (default false), types?: string[] }`.
  - Default excludes `chrome://` and `devtools://` URLs (avoids the invisible omnibox-popup surface).
  - `includeAll: true` returns every target, including internals.
- Output: `{ targets: [{ targetId, type, title, url, attached, openerId? }] }`.
- Side effects: none. Uses browser-level `Target.getTargets` regardless of active route.

### `select_target`

- Purpose: attach to a target with a flattened session and route subsequent target-scoped `execute_cdp` calls to it. This is the routing primitive.
- Input: `{ targetId: string }`.
- Output: `{ targetId, sessionId }`.
- Side effects: changes the single active route (shared mutable state across operations).
- Idempotent for the same `targetId` within one connection.

### `clear_target`

- Purpose: detach routing so target-scoped calls no longer auto-route.
- Input: `{}`.
- Output: `{ activeTargetId: null, activeSessionId: null }`.
- Idempotent.

### `execute_cdp`

- Purpose: the general primitive — call any CDP method. This is where most browser functionality lives (`Page.navigate`, `Runtime.evaluate`, `DOM.*`, `Input.*`, `Network.*`, `Fetch.*`, `Storage.*`, `Emulation.*`, `Browser.*`, `Target.*`, `DOMSnapshot.*`, `Accessibility.*`, `Debugger.*`, …).
- Input:
  - `method` (string, required) — dotted `Domain.command`, e.g. `Page.navigate`.
  - `params?` (object, required by protocol only for commands that need it).
  - `targetId?` / `sessionId?` — explicit routing override for this call.
  - `timeoutMs?` (number, optional) — reject the call if no response arrives.
- Routing rules:
  - `Browser.*`, `Target.*`, `Extensions.*` always go to the browser endpoint.
  - Otherwise use explicit `sessionId` / `targetId`, else the active route, else fail with `NO_ACTIVE_TARGET`.
- Output: `{ result }` — the raw CDP result, passed through unchanged.
- Errors: CDP error code/message/data are surfaced verbatim; validation errors for empty/malformed `method`; `NOT_CONNECTED`; `NO_ACTIVE_TARGET`; `CDP_TIMEOUT`; socket closed mid-call.

### `evaluate`

Added 2026-11-11 from usage evidence: `Runtime.evaluate` was 42% of all `execute_cdp` calls
across 72 sessions, and over half of all commands built JSON by hand to make it. Input
`{ expression, targetId?, timeoutMs? }`; returns `{ value }`. Always `returnByValue`,
`awaitPromise` and `replMode`. A thrown error fails with `JS_EXCEPTION`.

### `navigate`

Added 2026-11-11: agents slept after `Page.navigate` instead of waiting. Input
`{ url, targetId?, timeoutMs? }`; enables `Page`, navigates, waits for
`Page.loadEventFired`; returns `{ loaded, frameId }`. `errorText` fails with
`NAVIGATION_FAILED`.

### `capture_screenshot`

- Purpose: materialize a page screenshot to a file so binary data never travels through the agent envelope. Wraps `Page.captureScreenshot`.
- Input: `{ format?: 'png'|'jpeg' (default 'png'), quality? (jpeg), fullPage?: boolean (default false, sets captureBeyondViewport), clip?: { x, y, width, height, scale? }, targetId? }`.
- Output: `{ path, mimeType, bytes, width?, height?, targetId }`.
- Errors: no active target; zero-size surface; unwritable artifact dir; CDP screenshot failure.

### `capture_pdf`

- Purpose: render the current page to a PDF file. Wraps `Page.printToPDF`.
- Input: `{ printBackground?: boolean (default true), landscape?, paperWidth?, paperHeight?, marginTop?/marginBottom?/marginLeft?/marginRight?, pageRanges?, scale?, preferCSSPageSize?, targetId? }`.
- Output: `{ path, mimeType: 'application/pdf', bytes, targetId }`.
- Errors: no active target; print-media CSS hiding content; Chrome PDF size limits.

### `read_events`

- Purpose: drain buffered CDP events across operation boundaries (the protocol is asynchronous; agents cannot hold live callbacks). Use for network traces, console logs, navigation history, dialog detection, download progress.
- Input: `{ method?: string, targetId?: string, sessionId?: string, sinceSeq?: number, limit?: number (default 100), clear?: boolean (default true) }`.
- Output: `{ events: [{ seq, method, params, sessionId?, at }], nextSeq, dropped }`.
- Notes: events only arrive after the relevant domain is enabled (e.g. `execute_cdp { method: 'Network.enable' }`). Buffer is bounded; `dropped` counts events evicted before read.

### `wait_for_event`

- Purpose: block until the next event matching a method (and optional shallow params predicate) arrives, or until timeout. This is the sequencing primitive for "do X, then wait for Y".
- Input: `{ method: string, match?: object (shallow subset compared to params), targetId?, sessionId?, timeoutMs?: number (default 10000), consumeBuffer?: boolean (default true) }`.
- Output: `{ found: true, event } | { found: false, timedOut: true, waitedMs }`.
- Errors: no active connection; timeout returns `found:false` (not an execution error) so agents can branch.

## persistent state

- Durable: none owned by the capability by default. Screenshots/PDFs are written to an
  absolute artifact directory (`BROWSER_ARTIFACT_DIR`, default an OS temp subdirectory),
  but they are outputs, not capability state.
- In-process (lost on process restart or `reload_capabilities`): the `Connection`, the
  `ActiveRoute`, the bounded event buffer, and the message pump.
- External: all durable browser state (tabs, cookies, storage, history, downloads) lives
  in the browser, which the capability never owns or migrates.

`capability.json` should declare `state.kind: "external-service"` and document the artifact
directory. Because the loader stages a capability copy into a temporary directory before
import (`core/src/loader.ts:140`), the capability must **not** persist files relative to
its own module path; it must resolve an absolute, stable location.

### Lifecycle hooks (`initialize` / `dispose`)

The runtime now supports optional `initialize()`/`dispose()` exports on the capability
module (`core/src/types.ts`, `core/src/runtime.ts`; see `docs/capability-system.md`).

- `initialize()` — allocate the in-process connection object, event buffer, and resolved
  absolute artifact directory. Must not contact the browser: connection stays explicit via
  `connect_browser`.
- `dispose()` — close the WebSocket if open, reject pending CDP calls, remove event
  listeners, clear the event buffer, and drop the active route. Runs before the module is
  replaced on reload and on runtime shutdown, so the browser socket never keeps a discarded
  module alive.
- On reload the sequence is: import new module → `dispose()` old → `initialize()` new. The
  active target and connection do **not** survive a reload; the agent calls `connect_browser`
  again.

## external integrations

- **Chrome DevTools Protocol** over a WebSocket to the browser endpoint. One socket,
  JSON messages correlated by `id`, target-scoped messages carrying `sessionId`, flattened
  attach so all sessions share one socket.
- **`DevToolsActivePort` files** in OS-specific profile directories
  (`~/Library/Application Support/<Browser>` on macOS, `~/.config/<browser>` on Linux,
  `%LOCALAPPDATA%\<Browser>\User Data` on Windows). Line 1 is the port, line 2 the
  WebSocket path. This is the only reliable discovery mechanism for browsers that do not
  serve `/json/version`.
- **Filesystem** for artifacts.
- **OS process surface** (read-only): profile directories and candidate browser names.
- No third-party API, account, or network registry. No dependency on a specific browser
  package; the host runtime provides `WebSocket`.

## authentication/configuration

No credentials or API keys. Configuration is environmental:

| Variable | Required | Purpose |
| --- | --- | --- |
| `BROWSER_CDP_WS_URL` | no | Explicit browser endpoint when auto-detect is wrong. |
| `BROWSER_PROFILE_DIR` | no | Explicit profile directory to resolve `DevToolsActivePort`. |
| `BROWSER_CDP_TIMEOUT_MS` | no | WebSocket-open timeout; raise for the "Allow" prompt. Default 5000. |
| `BROWSER_ARTIFACT_DIR` | no | Absolute directory for screenshots/PDFs. Default OS temp. |
| `BROWSER_EVENT_BUFFER_SIZE` | no | Event ring-buffer capacity. Default 1000. |

Operational prerequisite (not a capability credential): the target browser must have
remote debugging enabled and must have granted the connection. When it has not, the agent
is told exactly what the user must do (open `chrome://inspect#remote-debugging`, enable
discovery, click **Allow**) rather than failing opaquely.

## background workers/jobs

- None. No scheduler, queue, or durable job runner.
- The only ongoing activity is the in-process WebSocket message pump that resolves pending
  CDP calls and appends events to the buffer.
- An optional idle keepalive/auto-reconnect may reopen a previously connected endpoint if
  the socket drops, but this must never trigger a fresh auto-detect attach without an
  explicit `connect_browser` call.
- `read_events` / `wait_for_event` provide the temporal semantics that would otherwise
  require a worker; no separate process is needed.

## errors and edge cases

Input/validation:
- Empty or malformed `method` (must be `Domain.command`) rejected before any CDP call.
- Mutually exclusive connect address forms rejected.
- Artifact options validated (format enum, clip numeric).

Configuration/auth:
- No browser with `DevToolsActivePort` found → actionable message naming `chrome://inspect`.
- Browser present but endpoint refused (403 / not allowed) → message telling the user to click **Allow**, or to raise `timeoutMs`.
- <code>DevToolsActivePort</code> malformed or missing its path line → retry with a bounded deadline, then a clear error.
- Artifact dir missing/unwritable → created if possible, otherwise a filesystem error naming the path.

External-service:
- CDP errors (`-32602 invalid params`, unknown method, detached target) are surfaced verbatim with code/message/data.
- Socket closed while calls are pending → all pending calls reject, connection becomes `disconnected`.
- Target-scoped call with no active route → `NO_ACTIVE_TARGET`.
- Stale `targetId` after navigation/tab close → CDP error; the active route should be cleared and the agent re-lists targets.
- `wait_for_event` timeout is a normal result (`found:false`), not `EXECUTION_FAILED`.
- Events are only emitted after their domain is enabled; `Network.getResponseBody` may fail after the fact even with the event.

State conflicts:
- Single active route is shared mutable state: two concurrent workflows that call `select_target` interfere. Documented as a session-wide singleton; agents must serialize routing-sensitive flows.
- `connect_browser` while connected is a no-op unless an explicit different endpoint is given (then it reconnects).
- `reload_capabilities` resets in-process state and drops the socket (`dispose()` closes it); the next target-scoped call reports `NOT_CONNECTED` and the agent reconnects.
- Idempotent: `connect_browser` (same target), `disconnect_browser`, `clear_target`, `select_target` (same id). Destructive/stateful: `execute_cdp` (arbitrary by definition), `select_target` (changes routing), `disconnect_browser`.

Browser traps documented for skills (not handled in operations):
- CDP target order is not visible tab-strip order; `Target.activateTarget` needs a known id.
- Default filter drops the 1px omnibox-popup surface; attaching to it yields `innerWidth = 0`.
- Screenshots are device pixels, while input coordinates are CSS pixels.
- Out-of-process iframe targets disappear on parent navigation.
- Downloads require an existing destination directory.
- `captureBeyondViewport` re-layouts and can duplicate sticky headers.

## suggested CLI/MCP interface

Standalone MCP (`mcp.ts`) exposes only these operations, with **plain** tool names:

```text
list_browsers
connect_browser
disconnect_browser
get_browser_status
list_targets
select_target
clear_target
execute_cdp
capture_screenshot
capture_pdf
read_events
wait_for_event
```

Standalone CLI (`cli.ts`, package `bin: browser-control`), same implementation:

```bash
browser-control list_browsers
browser-control connect_browser '{}'
browser-control list_targets '{}'
browser-control select_target '{"targetId":"<id>"}'
browser-control execute_cdp '{"method":"Page.navigate","params":{"url":"https://example.com"}}'
browser-control execute_cdp '{"method":"Runtime.evaluate","params":{"expression":"document.title","returnByValue":true}}'
browser-control execute_cdp '{"method":"Network.enable","params":{}}'
browser-control wait_for_event '{"method":"Page.loadEventFired","timeoutMs":10000}'
browser-control capture_screenshot '{"format":"png","fullPage":true}'
```

The optional aggregate Agent Software MCP exposes the same operations with a
`<capability>__<operation>` prefix; it is a convenience host, never required.

Illustrative agent flow (each step is one tool call; sequencing is the agent's job):

```text
connect_browser -> list_targets -> select_target
 -> execute_cdp(Page.navigate) -> wait_for_event(Page.loadEventFired)
 -> capture_screenshot -> execute_cdp(Runtime.evaluate)
 -> execute_cdp(Input.dispatchMouseEvent)
 -> execute_cdp(Network.enable) -> read_events
```

## skills/workflows

These are the `agent skills/workflows` half of `both`. Each composes the capability
operations above; none reimplements them. Detailed recipes come from the studied
interaction-skills knowledge and are authored with `skill-author` (no executable logic in
prose). Names are proposals; the exact set is settled during skill-authoring.

| Skill | When to use | Composes |
| --- | --- | --- |
| `browser-session` | Attach to a real browser, choose a target, verify routing, startup sequence. | `list_browsers`, `connect_browser`, `get_browser_status`, `list_targets`, `select_target`, `execute_cdp` |
| `browser-tabs` | Create, switch, close, or visibly activate tabs; reason about tab order. | `list_targets`, `select_target`, `execute_cdp` (`Target.*`) |
| `browser-inspect` | Discover page state via screenshots and DOM/Runtime inspection; viewport and DPR. | `capture_screenshot`, `execute_cdp` (`Runtime.evaluate`, `DOM.*`, `Emulation.*`) |
| `browser-input` | Click, type, choose from dropdowns, drag-and-drop, upload files. | `execute_cdp` (`Input.*`, `DOM.setFileInputFiles`) |
| `browser-frames` | Same-origin iframes, OOPIF attach, shadow DOM traversal. | `list_targets`, `select_target`, `execute_cdp` |
| `browser-dialogs` | Handle alert/confirm/prompt/beforeunload without freezing. | `execute_cdp` (`Page.*`), `wait_for_event`, `read_events` |
| `browser-network` | Wait for or trace requests; intercept, modify, or mock responses. | `execute_cdp` (`Network.*`, `Fetch.*`), `wait_for_event`, `read_events` |
| `browser-artifacts` | Capture screenshots and print pages to PDF. | `capture_screenshot`, `capture_pdf` |
| `browser-downloads` | Route downloads to a directory and detect completion; read/write cookies. | `execute_cdp` (`Browser.*`, `Network.*`, `Storage.*`), `read_events` |
| `browser-scrolling` | Scroll containers and pages; force or clear emulated viewports. | `execute_cdp` (`Input.dispatchMouseEvent`, `Runtime.evaluate`, `Emulation.*`) |

Workflows that require waiting or reading asynchronous protocol data use `wait_for_event`
and `read_events`; workflows that produce binary output use `capture_screenshot` /
`capture_pdf`; everything else is `execute_cdp`.

## intentionally omitted

Excluded because it only served the source project's human/developer experience, or because
a general operation already covers it:

- **The HTTP REPL / `/eval` server, `/health`, `/quit` endpoints** — a transport for running
  arbitrary JavaScript snippets. Replaced by structured operations.
- **Arbitrary JavaScript snippet evaluation** as the public interface. Agents invoke typed
  operations; page JavaScript is reachable through `execute_cdp` (`Runtime.evaluate`), not a
  capability-level eval endpoint.
- **The shell CLI wrapper and Bun auto-install bootstrap** — host/dev environment concerns,
  not browser capability.
- **Code generation and the vendored protocol JSONs** (`gen.ts`, `browser_protocol.json`,
  `js_protocol.json`) and the ~15k-line typed wrapper file — a TypeScript ergonomics layer.
  This capability takes method names and params as data; no generated bindings.
- **Everything typed per CDP method (652 wrappers)** — covered by `execute_cdp`.
- **The interaction-skills recipes** (connection, tabs, iframes, cross-origin iframes,
  shadow DOM, dropdowns, drag-and-drop, uploads, downloads, dialogs, cookies,
  network-requests, print-as-pdf, screenshots, scrolling, viewport) — these become **agent
  skills** that compose `execute_cdp` and the event/materialization operations. They are
  knowledge, not capability operations.
- **OS/window-manager automation** (AppleScript, `wmctrl`, `xdotool`, PowerShell AppActivate)
  — used only to recover visible tab order and raise a window. Out of domain; the agent may
  use separate tooling if needed.
- **`/json` HTTP discovery probing** — superseded by `DevToolsActivePort` parsing, which works
  on browsers that do not serve `/json`.
- **Donor branding, product names, and file layout.**

## convention changes required

The capability conventions were written for application/SaaS domains and assume
request/response, stateless operations. Infrastructure capabilities expose gaps:

1. **Permit domain-native low-level primitives for infrastructure capabilities.**
   `docs/operations-conventions.md` forbids UI verbs (`open_`, `click_`, `fill_`,
   `navigate_`) and page nouns (`page`, `button`, `form`, `settings`). For a browser
   capability the domain *is* the browser's control surface, and words like `target` are
   unavoidable. The current validator (`core/src/loader.ts:9`) does not enforce these bans
   — they are documentation only. Recommend documenting an explicit category: the ban
   applies to capabilities that re-create a human GUI workflow (UI automation); it does not
   apply to infrastructure capabilities whose operations are the external system's own
   programmatic control surface. Consider an optional `"kind": "infrastructure"` manifest
   field (with a `types.ts` update) so tooling and reviewers can distinguish the two.

2. **Sanction a general passthrough operation when the external system already defines a
   stable, typed API.** Codify that `execute_<system>` / `invoke_<system>` is acceptable for
   infrastructure capabilities, provided the protocol is documented, inputs are validated
   (method shape, routing), and higher-level workflows remain agent skills. This prevents
   re-deriving hundreds of narrow helpers and is the central design decision here.

3. **Define a binary-artifact convention.** Operations that produce files (screenshots,
   PDFs, exports) should materialize to an absolute path and return `{ path, mimeType,
   bytes }` rather than inline base64. Add this to `docs/operations-conventions.md` so
   agents consistently read artifacts from disk.

4. **Process-lifetime state vs `reload()` — lifecycle hook now provided.** The runtime
   gained optional `initialize()`/`dispose()` module hooks and a `shutdown()` call on both
   adapters (implemented: `core/src/types.ts`, `core/src/runtime.ts`, `core/src/mcp.ts`,
   `agent-software.ts`). Still outstanding for conventions: `state.location: "./data/"` is
   misleading because the loader stages capability copies into a temp directory
   (`core/src/loader.ts:140-161`); local file state must resolve an absolute location.
   Consider extending `state.kind` beyond `stateless | local-files | external-service` or
   documenting the combination of in-process resources and external services explicitly.

5. **Document session-wide mutable state and idempotency.** A single active target/socket is
   shared across concurrent tool calls. Conventions should require capabilities with global
   state to document it, name idempotent vs destructive operations, and advise agents to
   serialize routing-sensitive flows.

6. **Add a long-running-operation convention.** `wait_for_event` blocks up to a timeout;
   blocking semantics, default timeouts, and the distinction between a timeout result and an
   execution error should be standardized so MCP clients behave predictably.

---

## appendix: evidence observed

Source tree at `2d9a5ed37ed11f31b2622cd69c4b55f979cb905f` (read-only):

- `README.md` — "thinnest possible bridge from the LLM to Chrome", "every CDP method as a
  typed JS call", 56 domains / 652 typed wrappers, no pre-baked helpers, auto-install bun.
- `SKILL.md` — connect/auto-detect, `listPageTargets`, `detectBrowsers`, `resolveWsUrl`,
  `session.use`, `session.waitFor`, `onEvent`, events, persistent globals, CLI commands,
  output rendering rules, `chrome://inspect` flow.
- `sdk/session.ts` — `Session` class: one browser-level WebSocket, `_call` correlates by id,
  injects `sessionId` for target-scoped methods, browser-level exemption for
  `Browser.*`/`Target.*`/`Extensions.*`, `use`, `setActiveSession`, `onEvent`, `waitFor`,
  `CdpError`, `resolveWsUrl`, `readDevToolsActivePort`, `listPageTargets`,
  `detectBrowsers`, OS candidate profile dirs, `tryReadDevToolsActivePort`.
- `sdk/repl.ts` — long-lived `Bun.serve` process holding one `Session`; `/eval`, `/health`,
  `/quit`; expression auto-return; result rendering rules.
- `sdk/browser-harness-js` — bash CLI: auto-start/spawn server, auto-install bun, `--status`,
  `--start`, `--stop`, `--restart`, `--logs`; forwards snippets via HTTP.
- `sdk/gen.ts` — codegen from `browser_protocol.json` + `js_protocol.json`; skips redirected
  commands and events; emits typed params/returns and `bindDomains`.
- `sdk/generated.ts` — generated; footer reports "56 domains, 652 commands (excl. redirects),
  608 types". `browser_protocol.json` is 1,406,521 bytes; `js_protocol.json` 181,640 bytes.
- `interaction-skills/*.md` — 17 recipe documents (connection, tabs, iframes,
  cross-origin-iframes, shadow-dom, dropdowns, drag-and-drop, uploads, downloads, dialogs,
  cookies, network-requests, print-as-pdf, screenshots, scrolling, viewport). These map to
  agent skills.
- `sdk/session.test.ts` — verifies page commands carry the active `sessionId` and extension
  commands do not.
- `LICENSE` — MIT (2026 Browser Use). License is noted for provenance; no code is copied.
