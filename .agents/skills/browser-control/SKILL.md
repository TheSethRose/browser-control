---
name: browser-control
description: Drive the user's real Chrome (or any Chromium browser — Edge, Brave, Arc, Canary) over the Chrome DevTools Protocol with the bundled browser-control CLI/MCP — connect, pick a tab, inspect DOM, evaluate JS, click/type/upload, handle iframes, dialogs, network, downloads, cookies, scrolling, screenshots, and PDFs. Use whenever the user wants something done or checked in their own signed-in browser ("I've got it pulled up", "do it in my Chrome", "click through this dashboard"), for browser automation, scraping, form filling, or visual verification, even if they don't name the tool. Also routes work through opencode's browse extension when it is enabled. Replaces chrome-bridge.
---

# Browser Control

Drive the user's real Chromium browser over the Chrome DevTools Protocol (CDP). Everything
needed is in this folder; the only outside requirement is [Bun](https://bun.sh).

## Quick start

One shared daemon holds the browser connections for every agent session. Just run commands;
each one re-uses the daemon and starts it only if it isn't running.

```bash
BCD=<skill-dir>/scripts/browser-control-daemon
$BCD tabs                    # header = which browser; then targetId url | title (* = selected)
$BCD call select_target '{"targetId":"<id>"}'
$BCD eval 'document.title'   # run JavaScript, prints the value
$BCD nav https://example.com # navigate and wait for the load event
```

### Every new connection costs the user a click

Chrome shows the user an **Allow remote debugging?** prompt for each new connection. The
daemon already holds an approved one. Keep it:

- **Don't restart, stop, disconnect or "reset" anything.** It never fixes a problem and it
  throws the approved connections away. `stop` and `disconnect_browser` refuse by design.
- **Don't build your own path to the browser**: no second daemon, no
  `BROWSER_CONTROL_DAEMON_DIR`, no `runtime/cli.js`, no script of your own that opens a
  connection. (The `browse` CLI on `browse:<n>` tabs is fine: it uses the extension,
  not a CDP connection.) If a command fails, read the error, fix the command, or tell the user.
- **Never pass or guess a port.** The port changes when the browser restarts; the daemon
  finds the live one and reconnects by itself.
- If a command waits and then says the connection timed out, the user has not clicked
  Allow yet. Ask them to, then run the **same** command again.

Failure example: an agent got an error, ran `stop`, then `start`, then tried a different
port, then the plain CLI. The user had to click Allow four times and the original error (a
tab in the other browser) was still there.

### Which browser

The daemon connects to the user's default browser (`$BCD default`). The first line of
`tabs` names the browser you are in. If the tab the user means isn't listed, it is probably
in their other browser: `$BCD start chrome` or `$BCD start beta` switches (and opens that
browser if needed). Both connections stay open, so switching back costs nothing.

If a command says remote debugging is off, ask the user to open
`chrome://inspect/#remote-debugging` in that browser and tick **Allow remote debugging for
this browser instance**, then stop. You can't enable it yourself.

### Backends

With `~/.config/browser-control/backends` set to `browse,cdp`, `nav` with no tab selected
opens a background tab through opencode's browse extension (`browse:<n>` ids, no Allow
click). A selected DevTools tab keeps calls on that tab. Before choosing between them, or
before typing and clicking on a `browse:<n>` tab, read `references/backends.md`.

| Command | What it does |
| --- | --- |
| `eval '<js>' [targetId]` | Runs JavaScript and prints the value (strings bare, the rest as JSON). Top-level `await` works and `const` can be re-declared. Pass `-` to read the script from stdin (a heredoc avoids all shell quoting). |
| `nav <url> [targetId]` | Navigates and waits for load. `loaded:false` means still loading after 30 s. |
| `tabs` | Lists page tabs. Full detail: `call list_targets`. |
| `call <op> ['<json>']` | Any operation below. Prints `{"ok":true,"data":…}` or `{"ok":false,"error":…}`. |
| `ops` | Lists every operation with its input names. |
| `start <browser>` | Switch to another browser by name. Not needed otherwise. |
| `status`, `default [browser]` | Show the connection; show or set the default browser. |

`eval`, `nav` and `tabs` print plain text, so there is nothing to unwrap. Any failure prints
the error JSON and exits 1. Don't write shell wrappers or JSON-building helpers around
these; use `eval` for page scripts and `call` for everything else. Don't `sleep` after
navigating: `nav` already waits, and `wait_for_event` waits for anything else.

### Operations (for `call`, or as MCP tools)

- Connection and routing: `list_browsers`, `connect_browser`, `get_browser_status`,
  `list_targets`, `select_target`, `clear_target`, `disconnect_browser`.
- Page: `evaluate`, `navigate`, `capture_screenshot`, `capture_pdf` (both take an optional
  `path`), `execute_cdp` (any CDP method), `read_events`, `wait_for_event`.

Most operations take an optional `targetId`, so you can act on a tab without selecting it.
Don't invent operations. Exact inputs: `$BCD ops` or `runtime/capability.json`.

### Other ways to run it

- **MCP.** If a `browser-control` MCP server is connected, its tools are the operation names
  above and it keeps the connection between calls. Register with
  `claude mcp add browser-control -- <skill-dir>/scripts/browser-control-mcp`.
- **Plain CLI** (`scripts/browser-control <op> '<json>'`) goes through the same daemon.

## Workflows

Read only the reference the task needs.

| Task | Reference |
| --- | --- |
| Connect, choose a browser or target, enable domains | `references/session.md` |
| Create / switch / close / foreground tabs | `references/tabs.md` |
| Screenshot, evaluate JS, query DOM, measure viewport | `references/inspect.md` |
| Click, type, select, drag, upload files | `references/input.md` |
| iframes, OOPIFs, shadow DOM | `references/frames.md` |
| alert / confirm / prompt / beforeunload | `references/dialogs.md` |
| Observe, wait for, intercept, mock network | `references/network.md` |
| Screenshot / PDF written to a file | `references/artifacts.md` |
| Downloads and cookies | `references/downloads.md` |
| Scroll and set an emulated viewport | `references/scrolling.md` |
| Pick browse or DevTools; interact on `browse:<n>` tabs | `references/backends.md` |

## Protect the user's accounts

This is the user's real, signed-in browser. Actions land on their real accounts, and sites
with anti-abuse systems can lock an account that behaves like a bot.

- **Inspect passively first.** Read the current DOM, take a screenshot, or check
  already-loaded data before navigating, reloading, or paginating.
- **Go slowly.** Avoid tight scroll loops, bursts of reloads, repeated clicks, and replaying
  captured authenticated requests. For pagination or infinite scroll, advance one page at a
  time, wait at least 2 seconds, and stop after two pages add nothing new. Then report the
  partial count and ask before continuing.
- **Stop on warning signs:** HTTP 429, rate-limit messages, sign-out or re-auth prompts,
  repeated failures, or a change you didn't make. For CAPTCHAs and account checkpoints,
  capture the visible state and hand control back to the user.
- **Mutations need approval.** Get explicit approval for the exact action and batch size
  before submitting forms, sending messages, following, liking, deleting, or changing
  settings. Default to at most five per approved batch, one at a time, and verify each
  visibly.
- **Secrets stay on screen.** When a page shows a newly created password, API token, or
  recovery code, leave it for the user to copy. Don't read it into the transcript with
  `Runtime.evaluate`, DOM queries, or screenshots of that region.
- **Don't retry blindly.** If a click or navigation times out or the connection drops, first
  check the tab's URL and the relevant page state. Only retry if that shows the action
  didn't happen.

## Rules that apply everywhere

- Enable a CDP domain (`Page`, `Network`, …) before the action whose events you need. The
  daemon keeps enabled domains, the selected tab and the event buffer between calls.
- Coordinates are **CSS pixels**; screenshots are **device pixels**. Re-measure after any
  scroll, resize, or opened menu.
- `select_target` only routes calls. `Target.activateTarget` brings the tab to the front.
  Call both when the user expects to see the change.
- After working inside an iframe target, select the parent tab again.
- A screenshot shows what the user actually sees; the DOM can misreport state.
- Error messages start with a stable code: `NOT_CONNECTED`, `NO_ACTIVE_TARGET` (no tab
  selected, or the selected tab closed), `CDP_TIMEOUT` (no reply in 120 s; often an open
  JavaScript dialog, see `references/dialogs.md`), `JS_EXCEPTION`, `NAVIGATION_FAILED`,
  `INPUT_INVALID`, `ARTIFACT_WRITE_FAILED`. A
  `wait_for_event` timeout returns `found:false` and is not an error.
- Confirm the result before reporting it: a `capture_screenshot` or an `eval` that shows
  the expected state.
