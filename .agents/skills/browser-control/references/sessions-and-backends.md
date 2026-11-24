# Sessions, Tabs, Backends, and Raw Operations

Manage browser connections, tabs, optional `browse` backend routing, raw CDP calls, and MCP setup.

## 1. Sessions and browser switching

- Remote debugging must be enabled by the user once: open `chrome://inspect/#remote-debugging` and check **Allow remote debugging for this browser instance** (persists across restarts; only the port changes).
- `$BCD tabs` starts the daemon if needed and connects to the default browser (first line names the browser; waits up to 60 s for the user's **Allow** click).
- Wrong browser? `$BCD start beta` / `$BCD start chrome` / `$BCD start brave` switches and opens it if closed, parking the old connection so switching back needs no new Allow click. Set a permanent default with `$BCD default <name>`.
- **Never** pass a port, stop, disconnect, or restart the daemon to fix an error. If the browser itself restarts, the daemon reconnects automatically on the next call, but the old selected tab is gone — run `tabs` again.
- Verify with `$BCD status` (`connected: true`, expected `browser`, `version`, `build`, `activeTargetId`).

## 2. Tabs

- **List:** `$BCD tabs` (or `call list_targets '{"types":["page"]}'` for full detail). CDP target order is **not** visible tab-strip order — always match by URL or title.
- **Route calls:** prefer passing `targetId` or `--match <text>` per command. Use `call select_target '{"targetId":"<id>"}'` only when routing must persist (`select_target` mutates shared active state; serialize dependent flows).
- **Create:** `call execute_cdp '{"method":"Target.createTarget","params":{"url":"about:blank","background":true}}'` then `nav <url> <targetId>` (passing a real URL to `createTarget` can resolve before navigation starts).
- **Foreground:** `select_target` does not switch the visible tab. Call `execute_cdp { "method": "Target.activateTarget", "params": { "targetId": "<id>" } }` when the user should see it.
- **Close:** `execute_cdp { "method": "Target.closeTarget", "params": { "targetId": "<id>" } }`, then `call clear_target` if it was selected.

## 3. Backends: `browse` and DevTools (`cdp`)

Backend order lives in `~/.config/browser-control/backends` (or `BROWSER_CONTROL_BACKENDS`), e.g. `browse,cdp` (default `cdp`), and is read on every call. `browse` ([opencode browse](https://github.com/anomalyco/browse)) is used only when its CLI is installed and its extension is connected; otherwise calls fall back to CDP.

- `browse:<n>` targetIds always route to `browse`; plain IDs route to DevTools.
- With `browse,cdp` and no DevTools tab selected, untargeted `nav <url>` opens a background `browse` tab (no Allow click). `clear_target` resets both backends.
- Operations `browse` lacks (`execute_cdp` on a tab, `capture_pdf`, `select`, `upload`, `ocr`, `click --xy`) fail clearly with `INPUT_INVALID` instead of silently hitting a different DevTools tab. Browser-level CDP methods still work.
- `snap`, `click`, `type`, `key`, `wait`, `fill`, and `do` route to `browse` automatically on `browse:<n>` tabs with label lookup, trap/payment refusal, and wall/host checks. For browse-only handoffs, call `browse handoff '<message>' <n>` directly (uses the extension, not a second CDP connection).
- Refs go stale when typeaheads or navigations replace elements — `snap` again.

## 4. Raw CDP operations and MCP / CLI delivery

All 14 capability operations (use via `$BCD call <op> '<json>'`, or check exact schemas via `$BCD ops` / `runtime/capability.json`):

- **Connection & routing:** `list_browsers`, `connect_browser`, `get_browser_status`, `list_targets`, `select_target`, `clear_target`, `disconnect_browser` (refused by daemon).
- **Page & events:** `evaluate`, `navigate`, `capture_screenshot`, `capture_pdf` (both take optional `path`), `execute_cdp` (any `Domain.command`), `read_events`, `wait_for_event`.
- **MCP server (exposes the 14 raw operations only, not fast `/page/*` helpers):**
  `claude mcp add browser-control -- <skill-dir>/scripts/browser-control-mcp`
- **Plain CLI wrapper:** `<skill-dir>/scripts/browser-control <op> '<json>'` routes operation calls through the same daemon.
