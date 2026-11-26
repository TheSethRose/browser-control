# browser-control v2 — Rebuild Plan

> **Where v2 lives:** the `v2` branch of `github.com/TheSethRose/browser-control` (branched from `main` at `7ee11c9`). Work happens in git worktrees; the v1 `main` checkout at `/Users/sethrose/Developer/tools/browser-control` is never edited.
> v1 (`main`) stays untouched until Seth approves the cutover. Agents are using it.
> **Status:** plan final, updated 2026-11-26 after auditing **both** Ardia (`ardia-browser/ardia`) and OpenCode Browse (`anomalyco/browse`, MIT) against v1 `HEAD` `7ee11c9`. The extension is scaffolded and syntax-checked, not yet run in a browser. Next step is Phase 0.

---

## 1. What v2 is

v2 is a first-principles rebuild of `browser-control` that keeps **every v1 feature** and ships its own MV3 Chrome extension companion, replacing the need for both **Ardia** (already folded into v1 as the v7 upgrades) and **OpenCode Browse** (whose MIT-licensed extension/relay patterns we audited and folded into this plan).

The extension removes everything that makes direct CDP awkward:

- Turning on remote debugging at `chrome://inspect`.
- Clicking "Allow remote debugging?" after every browser restart.
- Focus-stealing tabs, background-tab throttling, password-manager debugger crashes, and clumsy login/2FA stops.

Direct CDP (the v1 way) stays as a first-class fallback and for pages extensions cannot touch. The optional `browse` adapter also stays, because nothing is removed.

### Targets

1. **Install in one prompt and three clicks.** The agent installs the skill and runs `browser-control-daemon extension setup`. The user opens `chrome://extensions`, turns on Developer mode, and clicks Load unpacked. Pairing is automatic via a local gitignored `pairing.json` (plus a one-time 8-char pairing code flow for remote browsers or a future Store build).
2. **No yellow debugging banner for reads.** `tabs`, `nav`, `snap`, `text`, `form`, `query`, `read-urls`, `value`, `verdict`, `health`, `wait`, native `select`, and typed inputs run silently in Chrome's extension `ISOLATED` world without attaching `chrome.debugger`.
3. **Every built-in command works on extension tabs.** Commands needing trusted input or DevTools attach `chrome.debugger` on demand and detach after 30 seconds idle. Raw `call` is bounded only by the CDP domains Chrome exposes to extensions (section 10).
4. **Daily-driver browser polish (OpenCode Browse parity).** Agent tabs open in the background without stealing focus, stay out of Memory Saver (`autoDiscardable: false`), adopt `target="_blank"` / `window.open` popups without yanking focus, optionally group into a collapsed `"Agents · N"` tab group, recover automatically from password-manager foreign frames, and support clean human-in-the-loop `handoff` for logins, 2FA, and CAPTCHAs.
5. **Works across Chromium 125+ and multiple browsers/profiles at once:** Chrome (stable, Beta, Dev, Canary), Brave, Edge, Arc, Vivaldi, Opera, Comet, Ardia — each identified by a stable browser slug (`chrome-macbook`, `brave-macbook`) with collision-free tab IDs.
6. **Small footprint, MIT clean.** No new npm dependencies beyond `@agent-software/core`. Bundled `runtime/cli.js` under 500 KB. MIT licensed: **no** code copied from Ardia (GPL-3.0); battle-tested MV3/relay patterns adapted from `anomalyco/browse` (MIT) with attribution.

---

## 2. Decisions

One-way doors (hard to undo, so each has a safeguard):

- **No v1 feature is removed.** Agents depend on every command, flag, MCP tool, and safety guard. Safeguard: the parity checklist in section 3, diffed against v1 `HEAD` before cutover, and all v1 tests ported.
- **The extension-to-daemon link is a security boundary.** It controls signed-in tabs. Safeguard: mutual challenge-response HMAC auth bound to port + nonces, strict `Origin` check against a fixed manifest `key`, unauthenticated `/version` identity probe before sending credentials, and pre-auth size/time limits (section 5).
- **`capability.json` stays stable.** MCP clients validate it strictly. Only optional fields may be added (`isolated` and `contextId` on `evaluate` already exist in v1).
- **Licensing is strictly MIT.** Zero code from Ardia (GPL-3.0 engine). Clean adaptation with MIT notice for patterns derived from `anomalyco/browse` (MIT).

Two-way doors (cheap to change later): module layout, CLI wording, port numbers, tab-group colors, idle timeouts.

Settled in review:

- **Several daemons at once:** port range `49222–49229` with unauthenticated `/version` probing before auth (section 5). If Phase 0 shows sandboxes block port binding, switch to a single host relay hub (`browse`-style).
- **Helper calls:** structured steps (`bc_call`), never parsed strings (section 6).
- **One script world on extension tabs:** enforced by a `__bc` tripwire (section 6).
- **Cold start:** Chrome's 30-second alarm floor is a hard MV3 limit (confirmed in `anomalyco/browse`). The daemon waits up to 35 seconds on the first call with a clear message; once connected, 20-second `ping` calls `chrome.runtime.getPlatformInfo()` to reset Chromium's 30-second worker idle timer so the link stays instant.
- **Explicitly deferred from OpenCode Browse (to avoid bloat):** `demonstrate` flow recorder, `recording` (CDP screencast + `ffmpeg` muxing), `screenshot_diff`, and `webmcp`. None are needed for core agent browsing, and keeping them out keeps the bundle lean and dependency-free. Users who want them can still keep the optional `browse` adapter enabled.
- **Cutover:** v2 is built on the `v2` branch; cutover is a PR from `v2` into `main` on Seth's go-ahead. The `browser-control` folder is never renamed (Phase 5).
- **Version:** `2.0.0` for the repo and the extension.

---

## 3. Parity checklist (nothing removed + v2 additions)

Port from v1 `HEAD` at build time, not from memory. v1 keeps changing while agents use it. Before cutover, diff the wrapper's command and flag list against v1 `HEAD` again.

**Delivery:** shared Unix-socket daemon, standalone MCP server (`mcp.ts`), standalone CLI (`cli.ts`), self-contained skill (`runtime/` + `extension/`).

**Backends:** `extension` (new, default when paired), `cdp` (auto-discovery through `DevToolsActivePort`, `lsof`, `ps`), `browse` (optional OpenCode adapter, kept).

**Capability operations (14):** `connect_browser`, `disconnect_browser`, `list_browsers`, `get_browser_status`, `list_targets`, `select_target`, `clear_target`, `navigate`, `evaluate`, `execute_cdp`, `capture_screenshot`, `capture_pdf`, `read_events`, `wait_for_event`.

**Daemon commands (31 v1 + 5 new):**
- v1 kept verbatim: `start`, `default`, `status`, `stop`, `ops`, `check-update`, `tabs`, `nav`, `eval`, `call`, `snap`, `text`, `form`, `query`, `read-urls`, `value`, `verdict`, `health`, `click`, `type`, `select`, `upload`, `drag`, `wait`, `key`, `fill`, `do`, `shot`, `ocr`, `styles`, `issues`, `perf`, `notes`, `flow`, `script`.
- **New in v2:**
  - `extension setup|pair|status|browsers|revoke|diagnostics|enable|disable`
  - `handoff <message> [--timeout <s>]` (also `page.handoff()` in `script`) — human-in-the-loop pause for logins, 2FA, CAPTCHAs, payments.
  - `dialog accept [promptText] | dismiss` — first-class JS alert/confirm/prompt handler.
  - `hover <locator|--xy x,y>` — pointer hover for menus and tooltips.
  - `emulate [--viewport WxH[@scale]] [--mobile] [--color-scheme dark|light] [--reduced-motion] [--offline] [--ua <str>] [--reset]` — device/media emulation with Chrome's double-clear race fix.

**Flags (all v1 kept):** `--match`, `--quiet`, `--no-boundaries`, `--all`, `--ax`, `--keys`, `--fast`, `--focused`, `--marks`, `--full`, `--png`, `--snap`, `--scroll`, `--reload`, `--clear`, `--find`, `--within`, `--max`, `--until`, `--xy`, `--ref`, `--to`, `--out`, `--text`, `--selector`, `--url`, `--timeout`, `--filter`, `--limit`, `--fields`, `--concurrency`, `--side`, `--duration`, `--kind`, `--properties`, `--site`, `--param`, `--where`, `--force`. New: `--browser <slug>` (target a specific connected browser/profile), `--new-window`, `--keep-open`.

**Reading:** `snap` with stable refs (`eN`, `fN:eM`, `aN`), modal auto-scope, repeat-snap diffs, `--full`, disabled-run folding, disambiguators, 3-pass budget, site-notes header. `text` with nav and filter folding, ARIA grids, `# scope:`, `--scroll` for virtual lists.

**Input:** `click` (drift check, 1.5 s disabled wait, blocker and dismiss refs, input delivery probe), `hover`, `type` (human-like typing by default, `--fast`, `--keys`, `--focused`, native date/time/month/week/color/range, grid cells, focus-swap following), `select` (native and ARIA combobox), `upload`, `drag` (HTML5 intercept, mouse fallback, list position), `dialog`, `do` batches with ref healing and wall/host-change stops.

**Visual:** `shot` (`--ref`, `--marks` drawn off-DOM with CoreGraphics, `--full`, `--png`, `--to`), `ocr` (macOS Vision warm worker, canvas hash diffing), `capture_pdf`.

**DevTools & automation:** `styles`, `issues` (cookie values stripped), `perf` (FCP, LCP, CLS, TBT, long tasks), `emulate`, `notes` (per origin, quarantined until approved), `flow` (read-only GET JSON record and replay), `script` (`node:vm` with `page` API including `page.handoff()`, saved state, CSV/JSON `--out`).

**Safety & walls:** nonce `<<<UNTRUSTED_PAGE_CONTENT>>>` boundaries, fake-marker and chat-token scrubbing, control-character escaping, trap, payment and `# WALL:` guards, sticky secret tracking, Luhn card masking, `Browser.close` and `*.crash*` blocked, fast failure on `Inspector.targetCrashed`, `remedy:` hints, typo suggestions. **New in v2:**
- Per-tab lending (`All tabs` vs `Lent only`) in the extension popup + one-click toolbar lend/revoke.
- Bot-challenge / block-page classifier (`src/challenges.ts`, MIT-adapted from `anomalyco/browse`): detects Cloudflare, Akamai, DataDome, PerimeterX, Imperva, AWS WAF, reCAPTCHA, hCaptcha, and generic blocks; auto-waits briefly on `non-interactive` interstitials, reports `CHALLENGE:` + recommends `handoff` on `interactive`, and hard-stops on `block` so agents never burn the user's IP with retry loops.

---

## 4. Architecture

Two tiers inside the extension:

- **Silent tier (zero banner).** `chrome.tabs` and `chrome.scripting` run the bundled page helper (`__bc`) in Chrome's extension `ISOLATED` world. No `chrome.debugger`, no yellow banner. Because MV3 forbids `eval()`, this tier only executes structured `bc_call` steps.
- **Debugger tier (on-demand CDP).** `chrome.debugger` attaches per tab only when needed, immediately enables `Emulation.setFocusEmulationEnabled({ enabled: true })` so background tabs do not throttle, forwards child OOPIF `sessionId` events/commands, and auto-detaches after 30 seconds idle (unless held by a long operation via `hold_debugger`).

Which tier each command uses:

- **Silent:** `tabs`, `nav`, `snap`, `text`, `form`, `query`, `read-urls`, `value`, `verdict`, `health`, `wait`, native `select`, typed inputs, `handoff` card UI, and a plain viewport `shot` of the active tab.
- **Debugger:** `click`, `hover`, `type`, `key`, `drag`, `upload`, `dialog`, `emulate`, `styles`, `issues`, `perf`, `capture_pdf`, `snap --ax`, `eval`, `call`, `flow record`, `ocr`, and `shot` with `--full`, `--ref`, `--marks`, or on a background tab.

### Repository layout

```text
browser-control/   (v2 branch)
├── PLAN.md
├── AGENTS.md, README.md, LICENSE (MIT + anomalyco/browse MIT notice)
├── package.json, tsconfig.json, bunfig.toml, bun.lock
├── capability.json
├── cli.ts                        # CLI and --serve entry
├── mcp.ts                        # Standalone MCP server
├── daemon.ts                     # Unix-socket daemon, untrusted-content wrapper, relay startup
├── extension/
│   ├── manifest.json             # MV3; tabs, tabGroups, scripting, debugger, storage, alarms, webNavigation, notifications; fixed `key`
│   ├── background.js             # Service worker entry + wiring
│   ├── lib/
│   │   ├── pairing.js            # Mutual HMAC + ephemeral P-256 ECDH code exchange (Web Crypto)
│   │   ├── debugger-hub.js       # Attach/detach, SW-restart restore, ownedByUs, foreign-frame eviction, sessionId
│   │   ├── window-groups.js      # Background non-minimized window placement, collapsed tabGroups, popup adoption
│   │   ├── tab-cleanup.js        # autoDiscardable:false, optional mute, leaveLastWindowOpen, optional idle cleanup
│   │   └── ring-log.js           # Bounded diagnostics ring buffer
│   ├── content-overlay.js        # Injected on demand only (agent tabs): closed-shadow-root handoff card + foreign-frame eviction
│   ├── popup.html, popup.js      # Status, connected browsers/daemons, All/Lent toggle, lend tab, detach, settings, manual pair, Copy Diagnostics
│   ├── onboarding.html           # Optional link pairing (`onboarding.html#code=...&port=...`) for Store/remote installs
│   ├── page-helpers.js           # Build output, copied from src/page-helpers.js.txt
│   └── pairing.json              # Local only, 0600, gitignored; written by `extension setup`
├── src/
│   ├── index.ts                  # Capability operations
│   ├── session.ts                # Direct CDP connection, browser discovery, crash and close guards
│   ├── events.ts                 # Bounded event buffer, wait_for_event
│   ├── safety.ts                 # Boundaries, escaping, masking, remedies
│   ├── challenges.ts             # NEW: bot-challenge & block-page classifier (MIT-adapted)
│   ├── page-helpers.ts           # Loads the helper, version, locator parser, step renderer
│   ├── page-helpers.js.txt       # Single source of truth for the in-page `__bc` helper
│   ├── page-runner.ts            # /page/* commands (incl. handoff, dialog, hover, emulate)
│   ├── typing.ts                 # Human-like typing planner
│   ├── picture.ts, ocr.ts, ocr.swift.txt, marks.ts, marks.swift.txt
│   ├── devtools.ts, notes.ts, flows.ts, script.ts, text.d.ts
│   └── backends/
│       ├── types.ts, registry.ts, router.ts
│       ├── extension.ts          # NEW: loopback relay server, mutual HMAC/ECDH pairing, BrowserLinks, tab routing
│       └── browse.ts             # Optional OpenCode adapter (kept)
├── tests/
│   ├── setup.ts
│   ├── manifest, session, operations, backends, daemon-page, ardia-upgrades, standalone (ported)
│   ├── helper-steps.test.ts      # NEW: golden strings for every structured helper step
│   ├── challenges.test.ts        # NEW: challenge/block classification fixtures
│   ├── extension-backend.test.ts # NEW: mutual auth, ECDH pairing, multi-browser IDs, routing, events, failures
│   └── e2e/                      # NEW: real Chrome for Testing run against local fixture page
└── .agents/skills/browser-control/
    ├── SKILL.md, agents/openai.yaml, references/
    ├── scripts/                  # browser-control, browser-control-mcp, browser-control-daemon
    ├── extension/                # Packaged copy, without pairing.json
    └── runtime/                  # Built by `bun run build:skill`
```

---

## 5. The relay (`src/backends/extension.ts`) & pairing security

### Transport & multi-daemon port range

- Listens on `127.0.0.1` only (unless user explicitly opts into `--remote` / host binding later). Starts only when `extension` is in the backend order, so `cdp`-only users open no port.
- **Several daemons at once** (e.g. multiple agent sandboxes): each daemon binds the first free port in `49222–49229` and exposes an unauthenticated `GET /version` returning `{ app: "browser-control", version, instanceId, protocolVersion }` (zero credentials).
- The extension probes candidate ports via `/version` (rate-limited, 800 ms timeout) before opening a WebSocket, so it **never** sends a handshake or token to an unrelated local server. It keeps one authenticated socket per live `browser-control` daemon in `49222–49229`. A ninth daemon gets `BACKEND_UNAVAILABLE: no free relay port` and falls back to `cdp`.
- Each daemon keeps its own selected tab, as today. Agents do not share tab state.

### Multi-browser & multi-profile identity (`BrowserLinks`)

- Each extension instance generates and persists a random `profileId` in `chrome.storage.local`, detects its browser brand (`Chrome`, `Brave`, `Edge`, `Opera`, `Chromium` via `navigator.userAgentData`), and supports an optional user-chosen name in the popup.
- The daemon assigns each connected browser a stable slug (e.g. `chrome-macbook`, `brave-macbook`), stored in `~/.config/browser-control/extension-browsers.json` (`0600`).
- **Collision-free tab IDs:** Chrome numbers tabs per browser, so Chrome and Brave can both have tab `42`. The relay maps `(profileId, tabId)` cleanly to target IDs (`extension:<tabId>` when one browser is connected; `extension:<browserSlug>:<tabId>` or relay-mapped IDs when multiple browsers are connected), and `--browser <slug>` picks which connected browser opens new tabs.

### Mutual authentication & pairing (MIT-adapted from `anomalyco/browse`)

- **Origin check:** reject any WebSocket upgrade whose `Origin` does not match the extension's fixed ID (`403`), derived from the pinned `key` in `manifest.json`.
- **Pre-auth guards:** cap pre-auth messages at **64 KB** and close sockets that do not complete the handshake within **10 seconds**.
- **Two pairing paths (both end in a per-browser 32-byte secret token):**
  1. **Zero-click unpacked (`pairing.json`):** `extension setup` writes a shared bootstrap token (or one-time code) + port hint to `~/.config/browser-control/extension-relay.json` (`0600`) and `extension/pairing.json` (`0600`, gitignored). `pairing.json` wins over stale stored tokens so re-running setup rotates cleanly.
  2. **One-time 8-char Crockford code (`extension pair` / `onboarding.html#code=...`):** For Chrome Web Store builds, second browsers, or remote machines. The extension and daemon run ephemeral P-256 ECDH (`crypto.subtle` / `node:crypto`) + PBKDF2-derived code proof; the daemon mints and wraps a per-browser token, and the code is spent on first use (rate-limited on failures).
- **Mutual challenge-response on every connect (never plaintext token on the wire):**
  1. Extension sends `hello` with `{ profileId, browser, name?, version, helpersVersion, protocolVersion, nonce }`.
  2. Daemon replies `auth.challenge` with `{ nonce: relayNonce, proof: HMAC(token, "bc-v2|relay|127.0.0.1:<port>/extension|<extNonce>|<relayNonce>") }`.
  3. Extension verifies the daemon's proof first (so a rogue local process cannot impersonate the daemon), then replies `auth.response` with its own HMAC proof.
  4. Daemon verifies with `crypto.timingSafeEqual` and sends `welcome`. Failures close with structured codes (`4001` replaced, `4002` bad hello, `4003` protocol/helpers mismatch, `4006` pairing refused).

### Wire protocol & keepalive

- `{ type: "req", id, op, params }` from daemon; `{ type: "res", id, ok, result | error }` back.
- `{ type: "event", tabId, sessionId?, method, params }` for CDP events (including child OOPIF `sessionId`).
- **Size guard on both ends:** 64 MB post-auth frame limit. The extension checks serialized JSON length *before* `ws.send()` and returns a clean per-request error (`Result too large...`) instead of letting an oversized screenshot drop the WebSocket and kill other in-flight calls.
- **Keepalive that actually keeps MV3 awake:** Every 20 seconds, `ping` invokes `await chrome.runtime.getPlatformInfo()` inside the service worker, which resets Chromium's 30-second MV3 service worker idle timer.
- **Reconnect backoff:** Jittered exponential backoff (`500 ms` base, `3 s` cap when no daemon is listening, `15 s` cap after a drop, reset after 5 seconds healthy) plus Chrome's 30-second `chrome.alarms` wakeup while asleep.

### Relay operations

`list_tabs`, `open_tab` (background by default, non-minimized window placement, optional `newWindow` / `keepOpen`), `activate_tab`, `close_tab` (with `leaveLastWindowOpen`), `navigate` (with hash-only short-circuit and `about:blank#` crash guard), `reload`, `list_frames`, `bc_call` (steps, optional `frameId`, `timeoutMs`), `resolve_bc_node`, `screenshot`, `cdp` (supports optional `sessionId` for OOPIFs), `eval`, `hold_debugger`, `handoff_start`, `handoff_clear`, `detach_all`, `diagnostics`.

### Shared tabs across daemons

- The extension tracks which daemon sockets have used each tab.
- CDP events route only to sockets that touched that tab.
- `chrome.debugger` detaches only when no socket holds the tab and the 30-second idle timer expires.

### Cold start

- Chrome's 30-second alarm floor means a sleeping service worker may take up to 30 seconds to wake after a fresh daemon starts.
- The daemon waits up to 35 seconds on the first extension call and prints why; once connected, the 20-second `getPlatformInfo()` keepalive holds the socket open so subsequent calls are instant.
- No separate always-on relay process unless Phase 0 shows cold starts hurt real workflows.

### Debugger lifetime & recovery

- Idle detach at 30 seconds; long work (`wait_for_event` > 30 s, `flow record`, `perf`) calls `hold_debugger` (up to 10 minutes).
- **Domain replay:** detaching drops enabled CDP domains; `extension.ts` tracks enabled domains per tab and re-enables them after any re-attach.
- **Focus emulation:** immediately sends `Emulation.setFocusEmulationEnabled({ enabled: true })` on every attach/re-attach so background tabs stay unthrottled.

---

## 6. Hard-won Chrome MV3 behaviors (from `anomalyco/browse` audit)

These real-world Chromium edge cases must be built into the extension from day one, not discovered after cutover:

1. **Service worker restart survival (`lib/debugger-hub.js`):** Chrome keeps `chrome.debugger` attachments alive even after killing and restarting the MV3 worker, while worker JS memory is wiped. On startup, restore stored attached tab IDs + URLs, probe ownership with `Target.getTargetInfo` (`ownedByUs` — distinguishes our attachment from DevTools/other extensions), and do a clean detach+re-attach so any hung dialog or paused child target from the dead worker is cleared. Persist attached-tab writes through a serial queue so out-of-order writes never clobber newer tabs. Clear stored IDs on `chrome.runtime.onStartup` (tab IDs recycle across browser restarts).
2. **Foreign extension frame eviction (1Password, LastPass, Bitwarden):** Another extension's injected frame causes Chrome to reject `chrome.debugger.sendCommand` (`Cannot access a chrome-extension:// URL`) or fire `onDetach(reason="target_closed")` on a still-open tab. Detect this pattern, evict foreign extension frames (`com-1password-*`, `data-onepassword-extension`, `data-lastpass-root`, `bitwarden-*`, foreign `chrome-extension://` iframes) via `content-overlay.js` (only while an agent command is running — **never** during a `handoff`, so password managers work normally when the user signs in!), re-attach, and retry up to twice (falling back to `chrome.tabs.update` for `Page.navigate`).
3. **Child OOPIF debugger sessions:** Forward `source.sessionId` on `chrome.debugger.onEvent` and `onDetach`, and pass `{ tabId, sessionId }` in `chrome.debugger.sendCommand` when targeting cross-origin iframes (needed for `upload` and CDP inside cross-origin frames).
4. **Tab replacement (`chrome.tabs.onReplaced`):** Discards and prerenders swap tab IDs without firing `onRemoved`. Handle `onReplaced` identically to `onRemoved` so stale tab IDs are purged immediately.
5. **Memory Saver & audio hygiene (`lib/tab-cleanup.js`):** Mark agent-opened tabs `autoDiscardable: false` (never discarded mid-task). Optional setting to mute agent-opened tabs (`muted: true`), restoring unmute on release/user-claim *only* if `mutedInfo.reason === "extension" && mutedInfo.extensionId === chrome.runtime.id` (never override a user's own mute).
6. **Never accidentally close the user's browser (`leaveLastWindowOpen`):** Before closing any tab via `chrome.tabs.remove`, check if it is the last tab of the last normal window; if so, create a blank replacement tab (or normal window if closing a popup) first, and ungroup before removing so Chrome does not leave orphaned saved tab groups.
7. **Background tab placement & minimized window trap (`lib/window-groups.js`):** Open agent tabs with `active: false` in the user's last-focused **non-minimized** normal window (minimized windows hang `Page.captureScreenshot` forever and throttle timers even with focus emulation), or in an optional unfocused `"separate"` agent window placed beside the user's window. Wait for newly created `about:blank` tabs to leave `status === "loading"` (fixes Vivaldi attach hang). Strip `#fragment` from `about:blank#...` before `Page.navigate` (fixes Chrome/Vivaldi crash).
8. **Popup adoption (`chrome.webNavigation.onCreatedNavigationTarget`):** When an agent-opened tab triggers `target="_blank"` or `window.open`, immediately restore the user's previous active tab (or unfocus the popup window) so it never steals focus, mark the popup `autoDiscardable: false`, move it into the opener's tab group/agent window, track it as an agent tab, and notify the daemon.
9. **Optional collapsed Agent Tab Group (`chrome.tabGroups`):** Put agent-opened tabs in a shared `"Agents · N"` group placed right after pinned tabs, auto-collapsed whenever the user switches to another tab, and auto-expanded during `handoff`. User dragging a tab out of the group or pinning it claims it as theirs (stops idle cleanup and unmutes it). Configurable in the popup (`Shared group` / `None`, `Auto-collapse` on/off, `Idle cleanup` minutes or `Never`).
10. **Human handoff overlay (`content-overlay.js`):** Injected *only* on tabs agents touch (never on user browsing). Adds **zero DOM** until `handoff` is active. When waiting for the user, renders a subtle blue edge + closed-shadow-root top-layer popover ("Your turn" + page origin + message + `event.isTrusted`-gated "Continue" button) with a MutationObserver/top-layer guard so page modals can't hide it, while leaving password-manager popovers unobstructed. Also supports completing the handoff via the toolbar button or Chrome notification.
11. **Device metrics clear race:** `emulate --reset` sends `Emulation.clearDeviceMetricsOverride` twice, 100 ms apart (Chrome silently drops ~25% of single clears while layout settles).

---

## 7. Changes inside the runtime (`src/`)

### Structured helper calls (`bc_call`)

Today `page-runner.ts` builds 60+ strings like `` `__bc.locate(${js(a)}, ${js(b)})` `` and sends them through `evalHelper`.

- `evalHelper` accepts structured steps: `[{ kind: "bc", method: "locate", args: [a, b] }]` (plus `{ kind: "href" | "readyState" | "origin" | "host" | "title" }`), with an optional `join`.
- Direct CDP renders steps to the exact same JS string it sends today.
- Extension tabs send steps unchanged via `bc_call`. Zero string parsing.
- Golden test (`tests/helper-steps.test.ts`) proves every call site renders identically on CDP before any relay code is wired in.

### One script world on extension tabs

Refs (`e12`) live inside whichever JS world loaded `__bc`. Two worlds would desync refs.

- Every helper call on an extension tab goes through `bc_call`. No fallback.
- **Tripwire:** `extension.ts` rejects any `evaluate` expression referencing `__bc` with an `INTERNAL` error.
- Non-helper `eval --isolated` still uses a CDP isolated world.

### Element handles for `upload` and `styles`

The debugger needs a CDP `nodeId` / `objectId` for a ref minted in the extension's silent world:

- **Primary:** After attach, enable `Runtime`, locate the extension's content-script execution context from `Runtime.executionContextCreated` (matching our extension's `origin`), and run `Runtime.evaluate` with `returnByValue: false` (`__bc.el(ref)`). Works inside shadow roots without touching the DOM.
- **Fallback:** One-shot `data-bc-resolve` attribute stamp + `DOM.querySelector` (already implemented in `extension/background.js`). Does not pierce closed/open shadow roots.
- Phase 0 test #2 verifies the primary path.

### Frames, dialogs, navigation, screenshots, and CDP fallback

- **Frames:** `list_frames` returns Chrome's `webNavigation.getAllFrames` list; `bc_call` accepts `frameId`. Map frame index (`f1:e3`) by URL + order (tested with duplicate-URL iframes). Top-level trusted clicks reach child frames by coordinate; cross-origin `upload` uses child debugger `sessionId` (`Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true })`).
- **Dialogs:** Open `alert`/`confirm`/`beforeunload` freezes `chrome.scripting`. On `bc_call` timeout (30 s), attach the debugger, check for an open dialog, and report it with a `remedy: run dialog accept|dismiss` hint. First-class `dialog` command calls `Page.handleJavaScriptDialog`.
- **Navigation:** Compare URLs ignoring `#hash` so hash-only navigations return immediately instead of waiting for a `complete` status that never fires. Strip `#hash` on `about:blank#...`. After navigation settles, run the lightweight `src/challenges.ts` probe on short/suspicious pages to auto-wait brief non-interactive interstitials or report `CHALLENGE:` / `BLOCKED:`.
- **Screenshots:** `captureVisibleTab` returns device pixels (~2 calls/s Chrome quota). Phase 0 measures Retina pixel scale vs `Page.captureScreenshot`; if scales differ, return `dpr` with the image or route `--marks`/`--xy`/`ocr` to `Page.captureScreenshot`. Full-page capture computes explicit `Page.getLayoutMetrics` clip as v1 does.
- **Fallback to direct CDP:** `RESTRICTED_PAGE` from the extension maps to `BackendUnavailable`, letting the router fall back to `cdp`. Raw `call` with an unsupported CDP domain (e.g. `Browser.*`) routes to `cdp` if connected, else fails with a clear reason.

---

## 8. Setup experience

The prompt anyone pastes into a coding agent:

```text
Read https://github.com/TheSethRose/browser-control and install its browser-control skill for yourself (including Bun if missing). Then run `browser-control-daemon extension setup` and walk me through loading the Chrome extension (or turning on remote debugging if I prefer). Test it by listing my open tabs.
```

`browser-control-daemon extension setup` does this:

1. Creates or reuses the secret in `~/.config/browser-control/extension-relay.json` (`0600`).
2. Writes `extension/pairing.json` (`0600`, gitignored) with the token/code and port hint.
3. Sets `~/.config/browser-control/backends` to `extension,cdp`.
4. Prints the three clicks with the exact path to `extension/`.
5. Waits for the extension to connect (up to 60 s), then runs `tabs` to confirm.

Additional subcommands:
- `extension pair` — prints a one-time 8-char Crockford code (for a second browser, remote machine, or Store build) and waits for it to pair.
- `extension browsers` / `extension revoke <slug>` — list paired/connected browsers and revoke one individually.
- `extension status` — port, connected browsers, protocol/helper versions, pairing state.
- `extension diagnostics` — pulls the extension's ring-buffer log + daemon relay state for bug reports.
- `extension enable` / `extension disable` — toggle `extension,cdp` vs `cdp`.

---

## 9. Build phases

Each phase ends with a concrete gate. Do not start the next phase until the gate passes.

### Phase 0 — Prove the risky assumptions (half a day)

Small throwaway checks. Seth loads the extension once for items 2–5 (reload from final path after cutover).

1. **Sandbox:** From inside an agent sandbox, bind a loopback port in `49222–49229` and read `~/.config/browser-control/extension-relay.json`. If either fails, switch from port-range to a single host hub relay.
2. **Element handle:** With `chrome.debugger` attached, locate the extension's isolated world via `Runtime.executionContextCreated` and resolve a `__bc` ref inside a shadow root. Pass/fail picks the primary vs fallback path in section 7.
3. **Cold start & keepalive:** Confirm first-call wakeup under 35 s from a sleeping worker, and confirm 20 s `ping` + `chrome.runtime.getPlatformInfo()` keeps the worker alive past 2 minutes without dropping the socket.
4. **Screenshot scale:** Compare `captureVisibleTab` and `Page.captureScreenshot` dimensions on Retina.
5. **Background tab timing:** Time `snap` on a background tab (silent tier vs attached + `Emulation.setFocusEmulationEnabled`). Confirm whether silent reads stay under 2 s or need focus emulation on heavy SPAs.
6. **Automated browser:** Confirm Chrome for Testing accepts `--load-extension` for `tests/e2e/`.

Done when: all 6 results are recorded and sections 5–7 are adjusted for any surprise.

### Phase 1 — Scaffold, structured helper calls, and challenge detector (CDP only)

- The `v2` branch already holds v1 `HEAD` (configs, `capability.json`, `cli.ts`, `mcp.ts`, `daemon.ts`, `src/`, `tests/`, `.agents/skills/browser-control/`); no copy step.
- Convert `evalHelper` and all call sites in `page-runner.ts` to structured steps; add `tests/helper-steps.test.ts`.
- Add `src/challenges.ts` + `tests/challenges.test.ts` (MIT-adapted from `anomalyco/browse`).
- Add first-class `hover`, `dialog`, and `emulate` (with double-clear race fix) in `page-runner.ts` (working on CDP immediately).
- No extension relay wired yet.

Done when: `bun install`, `bun run typecheck`, and `bun test` pass with every v1 test green plus `helper-steps.test.ts` and `challenges.test.ts`.

### Phase 2 — Relay backend and hardened MV3 extension

- Build `src/backends/extension.ts`: port range `49222–49229`, `/version` endpoint, `Origin` check, mutual HMAC + ephemeral P-256 ECDH code exchange, pre-auth 64 KB / 10 s guards, `BrowserLinks` multi-browser slug & tab mapping, `hold_debugger`, domain re-enable, `sessionId` event routing, `__bc` tripwire, `RESTRICTED_PAGE` → `BackendUnavailable`, `handoff` waiter registry.
- Register `extension` in `src/backends/registry.ts`; update `src/backends/router.ts` to route `execute_cdp`, `capture_pdf`, `read_events`, `wait_for_event` to `extension` tabs; start/dispose relay in `daemon.ts`.
- Modularize and finish `extension/`: `lib/pairing.js`, `lib/debugger-hub.js` (SW-restart restore, `ownedByUs`, foreign-frame eviction, `sessionId`, `Emulation.setFocusEmulationEnabled`), `lib/window-groups.js` (background non-minimized window placement, collapsed `"Agents · N"` groups, popup adoption), `lib/tab-cleanup.js` (`autoDiscardable: false`, optional mute, `leaveLastWindowOpen`, optional idle cleanup), `lib/ring-log.js`, `content-overlay.js` (closed-shadow-root handoff card + foreign-frame eviction), `onboarding.html`, fixed `key` + `tabGroups`/`notifications` in `manifest.json`, and updated `popup.html`/`popup.js`.
- Write `tests/extension-backend.test.ts` with a mock extension client: wrong origin (`403`), failed mutual HMAC (`4006`), ECDH code exchange & single-use spend, protocol/helper mismatch (`4003`), `/version` probe, multi-browser tab ID isolation, `bc_call`, `__bc` tripwire, `sessionId` event delivery to the right socket only, oversized message error without dropping socket, handoff completion, and second daemon on next port.

Done when: all unit/integration tests pass and the real extension pairs with two daemons (and two browser profiles if available) simultaneously.

### Phase 3 — Full command parity on extension tabs

- Wire `page-runner.ts` for full extension support: element handles for `upload` and `styles`, cross-origin frames (`list_frames` + child `sessionId`), dialog timeout detection + `dialog` command, `handoff` command + `page.handoff()` in `script`, `challenges.ts` integration on `nav`/`snap`/`do`, Retina-safe screenshots, long-wait `hold_debugger`.
- Update `build:skill` to copy `src/page-helpers.js.txt` → `extension/page-helpers.js`, bundle `cli.js` and `mcp.js` (under 500 KB), and copy `extension/` (excluding `pairing.json`) into `.agents/skills/browser-control/extension/`.

Done when: every command in section 3 runs cleanly on an extension tab against the fixture page.

### Phase 4 — Wrapper, docs, automated E2E, and live verification

- Add `extension setup|pair|status|browsers|revoke|diagnostics|enable|disable`, `handoff`, `dialog`, `hover`, `emulate`, and `--browser` to `scripts/browser-control-daemon`.
- Update `SKILL.md`, the reference guides, `README.md`, `AGENTS.md`, and `LICENSE` (including MIT attribution notice for `anomalyco/browse`).
- Add `tests/e2e/`: Chrome for Testing run against a local fixture page with shadow DOM, two duplicate-URL cross-origin iframes, a file input, a `target="_blank"` popup, an `alert`/`confirm`, a hash link, a simulated Cloudflare/Turnstile challenge page, and a `handoff` flow.
- Live verification with Seth in his real browser:
  1. 3-click unpacked install pairs automatically with zero typing.
  2. `snap`, `text`, `form`, `query`, `read-urls` show **zero** yellow banner.
  3. `click`, `hover`, `type`, `upload`, `drag`, `styles`, `perf`, `emulate` attach and auto-detach after 30 s.
  4. New agent tabs open in the background without stealing focus, group cleanly, and popups don't yank focus.
  5. `handoff` expands the group, shows the "Your turn" card, lets 1Password/typing work, and resumes immediately on Continue.
  6. "Lent only" refuses other tabs until lent; `chrome://` tabs fall back to `cdp`.

Done when: `bun run build:skill`, `typecheck`, `bun test`, `tests/e2e/`, and all 6 live checks pass.

### Phase 5 — Cutover (only on Seth's explicit go-ahead)

- **Never rename `/Users/sethrose/Developer/tools/browser-control`.** `~/.claude/skills/browser-control` and `~/.agents/skills/browser-control` symlink into it, and running daemons load `runtime/cli.js` from it.
- Diff v1 `main` wrapper commands/flags against `v2` one final time to confirm zero regressions. Merge or rebase any v1 commits that landed on `main` since `7ee11c9` into `v2` first.
- Tag `main` as `v1-final`.
- Open a PR from `v2` into `main`; merge it only on Seth's go-ahead, after CI (`bun install`, `typecheck`, `bun test`) and `build:skill` pass.
- Running v1 daemons stay alive in memory until agents restart them (wrapper stale-check prompts gently; no `stop --force`).
- Remove the staging unpacked extension from Chrome and load `browser-control/extension` instead; run `extension setup` once.
- Release as `v2.0.0` only on Seth's go-ahead. Delete the `browser-control-v2/` staging folder and its worktrees after a week of clean use.

---

## 10. Chrome's hard limits (what stays true)

These are Chromium platform boundaries, not design flaws:

- **Yellow banner while debugger is attached:** Reads avoid it completely; the 30-second idle detach clears it after writes/DevTools.
- **Restricted pages:** `chrome://`, Chrome Web Store, other extensions' pages, built-in PDF viewer, and `file://` (unless "Allow access to file URLs" is enabled) cannot be scripted by extensions. These fall back to `cdp`.
- **Allowed CDP domains for extensions:** Accessibility, Audits, CacheStorage, Console, CSS, Database, Debugger, DOM, DOMDebugger, DOMSnapshot, Emulation, Fetch, IO, Input, Inspector, Log, Network, Overlay, Page, Performance, Runtime, Storage, Target, Tracing, WebAudio, WebAuthn. (`Browser.*` is excluded; every built-in command uses allowed domains only.)
- **Minimized windows:** `Page.captureScreenshot` hangs and timers throttle in minimized windows; agent tabs always open in a non-minimized window.
- **Cold-start ceiling:** Up to 30 seconds if the MV3 service worker is asleep when a daemon first starts (Chrome's minimum `chrome.alarms` period).
- **Chrome Web Store review:** Extensions requesting `debugger` and `<all_urls>` face slow or rejected CWS review. Unpacked 3-click install is the primary path; `extension pair` keeps a Store build feasible later.

---

## 11. Current state of `extension/`

Scaffolded and syntax-verified (v0 prototype before Phase 2 modularization):

- Two-tier service worker (`background.js`), popup (`popup.html`/`popup.js`), manifest (`manifest.json`), and bundled `page-helpers.js` (`VERSION = 7`).
- `pairing.json` precedence, `chrome.storage.session` tab sets, `bc_call` timeout + `frameId`, `reload`, `list_frames`, `hold_debugger`, `RESTRICTED_PAGE` error mapping, 30 s reconnect alarm, `minimum_chrome_version: "125"`.

To be upgraded/modularized in Phase 2: mutual HMAC + ECDH pairing (`lib/pairing.js`), `/version` probe + multi-daemon port scan, `chrome.runtime.getPlatformInfo()` keepalive + jittered backoff, `lib/debugger-hub.js` (SW-restart restore, `ownedByUs`, foreign-frame eviction, `sessionId`, focus emulation), `lib/window-groups.js` (background non-minimized window placement, collapsed tab groups, popup adoption), `lib/tab-cleanup.js` (`autoDiscardable: false`, mute hygiene, `leaveLastWindowOpen`), `content-overlay.js` (handoff card + foreign-frame eviction), `lib/ring-log.js`, `chrome.tabs.onReplaced`, hash-only & `about:blank#` navigation fixes, extension-world element handle, and fixed manifest `key`.
