# Sessions, Tabs, Backends, and Raw Operations

Set up and pick a backend, manage browsers and tabs, call raw CDP operations, and set up MCP.

## 1. Backends

A backend is the path a command takes to the browser. There are three:

- `extension` is the first backend by default once paired (when `~/.config/browser-control/extension-relay.json` exists and is valid). The Browser Control extension in the user's own Chrome talks to the daemon over a local relay (a WebSocket on `127.0.0.1`, ports `49222`-`49229`). It needs no remote-debugging setting and no "Allow" click. The default order is `extension,cdp`: when the extension can't do the work, the command falls back to `cdp` and prints exactly one `# used remote debugging: <cause> (Chrome may ask you to Allow)` line. Fallback is never silent.
- `cdp` is direct DevTools, the v1 way. It is the default when the extension is not paired, and it always runs when asked for by name (`start <browser>`, a DevTools targetId). It reaches pages the extension can't run on, such as `chrome://` tabs, the Chrome Web Store, other extensions' pages, and the built-in PDF viewer.
- `browse` is the optional [opencode browse](https://github.com/anomalyco/browse) adapter (section 7).

The daemon reads the backend order from `<daemon dir>/backends` first (default `$TMPDIR/browser-control-daemon/backends`), then `BROWSER_CONTROL_BACKENDS`, then `~/.config/browser-control/backends`. When none is set, a paired extension defaults to `extension,cdp`; without pairing, the default is `cdp`. `extension disable` writes `cdp` to `<daemon dir>/backends`; `extension enable` clears that file, and `extension setup` clears it too and backs up then rewrites a `~/.config/browser-control/backends` that leaves the extension out — so the default, `BROWSER_CONTROL_BACKENDS`, or the global file applies again. `status` and `extension status` report the effective order, its source, and a label such as `extension,cdp (default)` (`orderLabel`). The daemon reads the order on every call, so a change needs no restart.

Routing rules:

- A target id with a backend prefix always goes to that backend: `extension:<tabId>` (or `extension:<slug>:<tabId>` when more than one browser is connected) and `browse:<n>`.
- Explicit CDP requests (`start <browser>`, a DevTools targetId with no backend prefix, or `select_target` of a DevTools target) always run on `cdp`, even when the order is `extension`. After an explicit `start` or `select_target`, untargeted calls stay on that CDP tab and `tabs` includes CDP targets; `clear_target` or `nav --browser <slug>` returns to the extension.
- Otherwise backends are tried in order. The default (`extension,cdp`) falls back to `cdp` on a disconnected extension, a restricted page (`chrome://`, Chrome Web Store, PDF viewer), an unhandled op, or a browser-level CDP method. Each command that fell back prints one `# used remote debugging: <cause> (Chrome may ask you to Allow)` line, even if several of its operations fell back.
- An explicit order is honored exactly. With `extension` alone (env, daemon file, or global file), nothing reaches `cdp` implicitly: those same failures refuse with `EXTENSION_ONLY` naming the cause and how to opt into `cdp`. The hint names the explicit setting as the reason for strict mode.
- Fallback to `cdp` happens only when the effective order lists `cdp` (for example the default, `BROWSER_CONTROL_BACKENDS=extension,cdp`, or `browse,cdp`).
- While a backend's tab is selected, a tab operation that backend lacks fails with a clear message. It never runs on a different tab instead.

## 2. One-time extension setup

The user does this once per browser profile. It takes three clicks and no typing.

1. Run `$BCD extension setup` (optionally `$BCD extension setup <extensionDir>`). It creates the shared secret in `~/.config/browser-control/extension-relay.json` (mode `0600`, which makes the default backend order `extension,cdp`), writes `extension/pairing.json` beside the extension, and prints the exact path of the `extension/` folder. If `~/.config/browser-control/backends` exists and leaves the extension out, it is saved as `backends.bak-<date>` and rewritten to `extension`; if `BROWSER_CONTROL_BACKENDS` overrides it, the JSON reports `overriddenBy` and nothing is changed for the env.
2. Tell the user the three clicks: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the printed folder.
3. `extension setup` returns right away. After the user loads the extension, run `$BCD extension browsers` (or `tabs`) to confirm it connected.

Pairing is automatic. The extension reads `pairing.json` and proves it holds the same secret. The secret never crosses the wire in plain text. Never print, copy, or commit `pairing.json` or `extension-relay.json`.

Other `extension` subcommands:

| Command | What it does |
| --- | --- |
| `extension status` | Relay port, connected browsers, protocol and helper versions, pairing state, and any pending/rejected handshakes with a fix line. |
| `extension browsers` | Connected browsers and their slugs (for `--browser`). |
| `extension diagnostics` | The extension's recent log plus the daemon's relay state (including pending/rejected handshakes and fix line). Use it for bug reports. |
| `extension enable` | Clear `<daemon dir>/backends` (including any older `extension,cdp` or `cdp` override) so the default (`extension,cdp` when paired), `BROWSER_CONTROL_BACKENDS`, or `~/.config/browser-control/backends` applies. |
| `extension disable` | Write `cdp` to `<daemon dir>/backends` (DevTools only). |
| `extension pair`, `extension revoke` | Not built yet. They wait for a later Web Store build and return an error saying so. |

If the extension doesn't connect:

- The first call after a fresh daemon start can wait up to 35 s while Chrome wakes the extension. The daemon prints why it is waiting. Later calls are instant.
- Run `extension status`. If no browser is connected, check its `fix` line (for example a helper version mismatch from your paired extension, or a rejected handshake from another client); otherwise ask the user to check that the extension is loaded and turned on in `chrome://extensions`.
- In Claude Code's sandbox, the relay needs `allowLocalBinding: true`. The daemon socket folder needs `allowUnixSockets`. Without them the relay can't open its port.

## 3. Browsers and profiles

- Each connected browser profile has a stable slug, such as `chrome-3a00d5` or `brave-91c2e4`. `extension browsers` lists them.
- `nav <url> --browser <slug>` opens the new tab in that browser. Tab ids are bound to the browser that issued them. If that browser disconnects, its ids fail with `NO_ACTIVE_TARGET` instead of reaching another browser.
- On `cdp`, `$BCD start beta`, `$BCD start chrome`, or `$BCD start brave` switches browsers and opens one if it is closed. The old connection stays parked, so switching back needs no new Allow click. Set a lasting default with `$BCD default <name>`.

## 4. Extension tabs

- **Background tabs.** Agent tabs open in the background, in the user's last focused window that is not minimized. They don't steal focus. Popups from `target="_blank"` or `window.open` are adopted the same way.
- **Tab group.** Agent tabs can sit in one collapsed tab group named `Agents · N` after the pinned tabs. It collapses when the user switches away and expands during a `handoff`. Dragging a tab out of the group, or pinning it, gives it back to the user.
- **`nav --new-window`** opens the tab in a new window. **`nav --keep-open`** keeps the tab past idle cleanup. Both work on extension tabs only.
- **Session tab reuse.** A `nav` with no targetId reuses this agent session's last agent tab while it is still open, unclaimed, unpinned, not in a handoff and not busy; otherwise it opens a new tab. The session comes from `BROWSER_CONTROL_SESSION`, else `CLAUDE_CODE_SESSION_ID`, `T3CODE_THREAD_ID`, `CODEX_THREAD_ID` or `CODEX_SESSION_ID`, sent only as a short hash. Sessions never share a tab. `nav --new-tab` forces a new tab; an explicit targetId always wins and becomes the session's tab. With no session id, every tab-less nav behaves as before.
- **Tab sharing.** The popup has `All tabs` and `Only tabs I share` modes. In `Only tabs I share`, the extension refuses any tab you haven't shared (`REFUSED: tab <id> isn't shared with Browser Control. Click the Browser Control icon on that tab, then Share this tab.`). Ask the user to click the Browser Control icon on that tab, then **Share this tab**. Don't switch to `cdp` to get around it.
- **Two tiers.** Reads (`tabs`, `nav`, `snap`, `text`, `form`, `query`, `read-urls`, `value`, `verdict`, `health`, `wait`, native `select`, typed inputs, a plain `shot` of the active tab) run without the debugger, so Chrome shows no yellow banner. Commands that need trusted input or DevTools (`click`, `hover`, `type`, `key`, `drag`, `upload`, `dialog`, `emulate`, `styles`, `issues`, `perf`, `capture_pdf`, `snap --ax`, `eval`, `call`, `flow record`, `ocr`, `shot --full|--ref|--marks`) attach the debugger. Chrome then shows a yellow "started debugging" banner.
- **Auto-detach.** The debugger detaches after 30 s idle and the banner goes away. Long work such as `perf`, `flow record`, or a long `wait_for_event` holds it up to 10 minutes.
- **Raw `call`.** On extension tabs, `execute_cdp` covers the CDP domains Chrome allows extensions. `Browser.*` is not one of them. With the default `extension,cdp` order, browser-level calls fall back to `cdp` with the `# used remote debugging:` line; with an explicit `extension` order they refuse with `EXTENSION_ONLY`. Opt into CDP explicitly with `start <browser>` or `BROWSER_CONTROL_BACKENDS=extension,cdp`.

## 5. Sessions on `cdp`

- The user turns on remote debugging once: open `chrome://inspect/#remote-debugging` and check **Allow remote debugging for this browser instance**. It lasts across restarts. Only the port changes.
- `$BCD tabs` starts the daemon if needed and connects to the default browser. The first line names the browser. It waits up to 60 s for the user's **Allow** click.
- **Never** pass a port, stop, disconnect, or restart the daemon to fix an error. If the browser restarts, the daemon reconnects on the next call, but the old selected tab is gone. Run `tabs` again.
- Check with `$BCD status` (`connected: true`, the expected `browser`, `version`, `build`, `activeTargetId`).

## 6. Tabs

- **List:** `$BCD tabs` (or `call list_targets '{"types":["page"]}'` for full detail). CDP target order is **not** the order of the tab strip. Always match by URL or title.
- **Route calls:** pass `targetId` or `--match <text>` on each command. Use `call select_target '{"targetId":"<id>"}'` only when routing must persist. `select_target` changes shared state, so run dependent steps one after another.
- **Create:** on the extension, `nav <url>` with no tab opens a background tab. On `cdp`, run `call execute_cdp '{"method":"Target.createTarget","params":{"url":"about:blank","background":true}}'`, then `nav <url> <targetId>` (a real URL in `createTarget` can return before navigation starts).
- **Foreground:** `select_target` does not switch the visible tab. On `cdp`, call `execute_cdp { "method": "Target.activateTarget", "params": { "targetId": "<id>" } }` when the user should see it. On the extension, `handoff` brings the tab forward.
- **Close:** on the extension, run `$BCD close [targetId]` (closes only tabs Browser Control opened, and never closes the last tab of the last window — it opens a blank tab first). On `cdp`, run `execute_cdp { "method": "Target.closeTarget", "params": { "targetId": "<id>" } }`, then `call clear_target` if it was selected.

## 7. The optional `browse` backend

`browse` ([opencode browse](https://github.com/anomalyco/browse)) runs only when its CLI is installed, its extension is connected, and the backend order lists it, for example `browse,cdp`. Otherwise calls go to the next backend.

- `browse:<n>` target ids always go to `browse`. Plain ids go to DevTools.
- With `browse,cdp` and no DevTools tab selected, a `nav <url>` with no tab opens a background `browse` tab (no Allow click). `clear_target` resets both backends.
- Operations `browse` lacks (`execute_cdp` on a tab, `capture_pdf`, `select`, `upload`, `ocr`, `click --xy`) fail with `INPUT_INVALID` instead of hitting a different DevTools tab. Browser-level CDP methods still work.
- `snap`, `click`, `type`, `key`, `wait`, `fill`, and `do` route to `browse` on `browse:<n>` tabs, with label lookup, trap and payment refusal, and wall and host checks. For a handoff on a `browse:<n>` tab, call `browse handoff '<message>' <n>` directly.
- Refs go stale when typeaheads or navigations replace elements. Run `snap` again.

## 8. Raw CDP operations and MCP / CLI delivery

All 15 capability operations. Call them with `$BCD call <op> '<json>'`. Check exact schemas with `$BCD ops` or `runtime/capability.json`.

- **Connection and routing:** `list_browsers`, `connect_browser`, `get_browser_status`, `list_targets`, `select_target`, `clear_target`, `close_target`, `disconnect_browser` (the daemon refuses it).
- **Page and events:** `evaluate`, `navigate`, `capture_screenshot`, `capture_pdf` (both take an optional `path`), `execute_cdp` (any `Domain.command`), `read_events`, `wait_for_event`.
- **MCP server** (the 15 raw operations only, not the `/page/*` helpers):
  `claude mcp add browser-control -- <skill-dir>/scripts/browser-control-mcp`
- **Plain CLI wrapper:** `<skill-dir>/scripts/browser-control <op> '<json>'` sends operation calls through the same daemon.
