# Browser Session

Open a retained CDP connection and route calls to the right target. Do this before any
other browser workflow.

## Prerequisites

- The browser has remote debugging on: `chrome://inspect/#remote-debugging`, tick **Allow
  remote debugging for this browser instance**. Only the user can do this. It stays on
  across restarts; only the port changes.

## Workflow

1. Run `browser-control-daemon tabs`. That is the whole connect step: the command re-uses
   the shared daemon, starts it if needed, and connects to the user's default browser. The
   first output line names the browser. The user may need to click **Allow** once; the
   command waits 60 seconds for it.
2. Wrong browser, or the tab isn't listed: `start <name>` (`chrome`, `beta`, `brave`, …)
   switches and opens that browser if needed. Never pass a port. Never stop or restart the
   daemon; that only forces the user to click Allow again.
   - With MCP, the same thing is `connect_browser` with `{}` or `{ "browser": "beta" }`.
3. `call select_target '{"targetId":"<id>"}'`. Or skip selecting and pass the `targetId` to
   `eval`, `nav` and most operations.
4. Enable the domains whose events you need **before** triggering activity:
   `call execute_cdp '{"method":"Network.enable"}'`. (`nav` enables `Page` itself.)
5. To make the tab visible (routing alone does not):
   `execute_cdp { "method": "Target.activateTarget", "params": { "targetId": "<id>" } }`.

## Operations used

- `list_browsers`, `connect_browser`,
  `get_browser_status`, `list_targets`,
  `select_target`, `disconnect_browser`,
  `execute_cdp`.

## Traps

- CDP target order is **not** visible tab-strip order; identify a tab by title, URL, or a
  screenshot before acting.
- `select_target` changes one shared active route. Serialize routing-sensitive flows.
- If the browser restarts, the daemon reconnects on the next call (one more Allow click),
  but the selected tab is gone: run `tabs` and select again.
- Two browsers can be running at once. Check `status` for which one you are connected to.

## Verification

`status` reports `connected: true`, the expected `browser` and `activeTargetId`, and
`eval 'document.title'` returns the tab's title.
