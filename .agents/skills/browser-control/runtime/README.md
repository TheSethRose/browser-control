# browser-control

Drive a real, signed-in Chromium browser over the [Chrome DevTools
Protocol](https://chromedevtools.github.io/devtools-protocol/) — connect, pick a tab,
inspect the DOM, run JavaScript, click and type, handle iframes and dialogs, watch network
traffic, scroll, download, and capture screenshots and PDFs.

It talks to the browser you are already using, with your logins, extensions, and open tabs.
There is no headless bundle and no throwaway profile. Chrome, Chromium, Edge, Brave, Arc,
Vivaldi, Opera, Comet, and Canary all work.

One implementation ships three ways:

- **Shared daemon** (default for agents) — one long-lived process holds the connection, so
  Chrome's "Allow remote debugging?" prompt appears once per browser instead of once per call.
- **Standalone MCP server** — plain tool names, for any MCP client.
- **Named CLI** — one process per call, for scripts and shells.

## Requirements

- [Bun](https://bun.sh) — the only runtime dependency.
- A sibling checkout of the private `agent-software` repository (same GitHub owner as this one), which provides `@agent-software/core`
  (`"@agent-software/core": "file:../agent-software/core"`).
- A Chromium-based browser with remote debugging allowed. In current Chrome, open
  `chrome://inspect/#remote-debugging` and check **"Allow remote debugging for this browser
  instance"**. Other Chromium browsers expose the same switch, or accept a
  `--remote-debugging-port` launch flag.
- Optional: [opencode browse](https://opencode.ai/product/browse)
  ([GitHub](https://github.com/anomalyco/browse)), a browser extension plus the `browse` CLI.
  browser-control uses it only when it is installed, the extension is connected to its relay,
  and `browse` is listed in the [backend order](#backends). Otherwise everything runs over
  DevTools as usual.

No API keys, accounts, or config files. Optional environment overrides are listed under
[Configuration](#configuration).

## Install

Private repository — clone both, side by side, so the sibling dependency resolves:

```bash
# <owner> is the GitHub account that hosts both repositories
gh repo clone <owner>/agent-software
gh repo clone <owner>/browser-control
cd browser-control
bun install
```

That is enough to run `bun ./cli.ts` and `bun ./mcp.ts`. To get the `browser-control` command
on your `PATH`:

```bash
bun link
```

## Quick start

The daemon starts itself on the first command that needs it, connects on demand, and
rediscovers the port if the browser restarts. You never manage the connection.

```bash
BCD=./.agents/skills/browser-control/scripts/browser-control-daemon

$BCD tabs                                  # header names the browser; then targetId url | title (* = selected)
$BCD call select_target '{"targetId":"<id>"}'
$BCD eval 'document.title'                 # run JavaScript, print the value
$BCD nav https://example.com               # navigate and wait for the load event
$BCD call execute_cdp '{"method":"Network.enable"}'
$BCD ops                                   # every operation with its input names
```

Then compose procedures from the skill references — tabs, frames, input, dialogs, network,
scrolling, downloads, cookies, artifacts. Those are workflows over `call`, not extra
operations.

**Every new connection costs the user a click.** Chrome prompts the person at the keyboard
to approve remote debugging for each new connection. The daemon already holds an approved
one, so don't restart it, don't stop it, don't disconnect, and never pass a port. If a
command waits and then reports a timeout, the user has not clicked Allow yet — ask them to,
then run the same command again.

## Operations

`execute_cdp` is the general primitive. The rest exist where a raw protocol call is
insufficient (binary artifacts, cross-call event state) or where writing it by hand is
disproportionate (`evaluate`, `navigate`).

| Operation | Purpose |
| --- | --- |
| `list_browsers` | List running Chromium browsers with remote debugging and their live ports. |
| `connect_browser` | Open and retain the browser-level CDP WebSocket. Finds the live port itself; `browser` picks one by name and opens it if needed. |
| `disconnect_browser` | Close the socket and clear route/buffer. |
| `get_browser_status` | Connection, active route, buffered event count, artifact dir. |
| `list_targets` | Enumerate targets (pages, OOPIFs, workers); hides `chrome://`/`devtools://`. |
| `select_target` | Attach (flattened) and route target-scoped calls to one target. |
| `clear_target` | Detach routing. |
| `execute_cdp` | Call any `Domain.command` and return its raw result. |
| `evaluate` | Run JavaScript and return its value (top-level await, promises awaited). |
| `navigate` | Navigate and wait for the load event. |
| `capture_screenshot` | Write a page screenshot to a file; return path/MIME/bytes. |
| `capture_pdf` | Write the page as a PDF file; return path/bytes. |
| `read_events` | Drain buffered CDP events across operations. |
| `wait_for_event` | Wait for the next matching event, or time out (`found:false`). |

Typical flow:

```text
connect_browser -> list_targets -> select_target
 -> navigate -> capture_screenshot -> evaluate
 -> execute_cdp(Network.enable) -> read_events
```

## Delivery surfaces

- **Daemon** (`cli.ts --serve <socket>`, implemented in `daemon.ts`; client
  `.agents/skills/browser-control/scripts/browser-control-daemon`). One long-lived process
  serves requests over a Unix socket. The client is a thin `curl` wrapper with `start`, `eval`,
  `nav`, `tabs`, `call`, `ops`, `default`, `status`, and `stop --force`. Every command starts
  the daemon if it is not running, and the daemon connects on the first call that needs a
  browser. It keeps one connection per browser, rediscovers the port after a browser restart,
  and refuses `disconnect_browser` and a bare `stop`, because each new connection costs the
  user an Allow click. This is the default for agents.
- **Standalone MCP** (`mcp.ts`) — one server, plain tool names (`list_browsers`,
  `connect_browser`, `execute_cdp`): `bun ./mcp.ts`. Register it with any MCP client, e.g.

  ```json
  {
    "mcpServers": {
      "browser-control": { "command": "bun", "args": ["/absolute/path/to/browser-control/mcp.ts"] }
    }
  }
  ```

- **Named standalone CLI** (`cli.ts`, package `bin: browser-control`) — one process per call,
  so use `--init` to connect first or `--session` for many operations in one process:

  ```bash
  browser-control --init connect_browser '{"port":9222}' list_targets '{"types":["page"]}'
  printf '%s\n' '{"operation":"execute_cdp","input":{"method":"Runtime.evaluate","params":{"expression":"document.title"}}}' \
    | browser-control --init connect_browser '{"port":9222}' --session
  ```

  Without linking, run `bun ./cli.ts …`.

All three call the same `src/` implementation.

## Skill

`.agents/skills/browser-control/` is a ready-made agent skill: `SKILL.md` for routing,
`references/` for one workflow each (tabs, frames, input, dialogs, network, scrolling,
downloads, artifacts, inspection, sessions), and `scripts/` for the daemon client. Copy or
symlink that folder into your agent's skill root:

```bash
ln -s "$PWD/.agents/skills/browser-control" ~/.agents/skills/browser-control
```

`runtime/` inside it is a prebuilt bundle of this repository, so the skill works from a bare
clone. It is generated by `bun run build:skill`; don't edit it by hand (see
[AGENTS.md](AGENTS.md)).

## Configuration

Optional environment overrides (no credentials):

| Variable | Purpose |
| --- | --- |
| `BROWSER_CONTROL_BROWSER` | Preferred browser name (`beta`, `chrome`, …) for a connect with no input. Overrides the one-line file `~/.config/browser-control/default-browser`. |
| `BROWSER_CONTROL_BACKENDS` | Backend order, for example `browse,cdp`. Overrides the one-line file `~/.config/browser-control/backends`. Default `cdp` (DevTools only). See "Backends" below. |
| `BROWSER_CDP_CALL_TIMEOUT_MS` | Reply timeout for a CDP call that sets none. Default 120000. |
| `BROWSER_CONTROL_MAX_OUTPUT` | Daemon only: character cap on `eval`/`nav`/`tabs` text output. Default 50000. |
| `BROWSER_CDP_WS_URL` | Explicit browser endpoint when auto-detect is wrong. |
| `BROWSER_PROFILE_DIR` | Explicit profile directory to read `DevToolsActivePort`. |
| `BROWSER_CDP_TIMEOUT_MS` | Socket-open timeout; raise for the browser's "Allow" prompt. Default 5000. |
| `BROWSER_ARTIFACT_DIR` | Absolute directory for screenshots/PDFs. Default OS temp. |
| `BROWSER_EVENT_BUFFER_SIZE` | Event ring-buffer capacity. Default 1000. |

Ports change on every browser restart, so callers should not pass one. `connect_browser`
finds running browsers two ways and merges the results:

1. `DevToolsActivePort` in each known profile folder. macOS privacy (TCC) often blocks
   reading it, and it can be stale.
2. The OS process table: `lsof` lists loopback listeners, `ps` names the owning process, and
   Chromium browsers are kept. This needs no file access and is always the live port.

`browser` selects by name (exact name first, then substring) and, on macOS, opens the app when
it is not running. Chrome launched with `--remote-debugging-port` exposes `/json/version`;
the user-enabled server exposes only a raw WebSocket; the port form handles both.

## Backends

DevTools (`cdp`) is built in and runs every operation. Extra backends live in `src/backends/`,
one file each, listed in `src/backends/registry.ts`; removing one means deleting its file and
its line. `src/backends/router.ts` picks a backend per call from the order above:

- A target id with a backend prefix (`browse:12`) always goes to that backend.
- Otherwise backends are tried in order; one that lacks the operation, or isn't available
  (not installed, no browser paired), passes it to the next.
- While a backend's tab is selected, a tab operation it lacks fails with a clear message
  rather than acting on a different DevTools tab.

`browse` ([opencode browse](https://opencode.ai/product/browse),
[GitHub](https://github.com/anomalyco/browse)) is optional. It is used only when its `browse` CLI
is installed, its extension is connected, and the order lists it (for example `browse,cdp`); if
the CLI is missing or the extension isn't connected, calls fall back to DevTools. It runs `navigate`, `evaluate`, `capture_screenshot` and tab selection with no debugging
port and no Allow click. Its tabs open in the background and it only sees tabs it opened or
the user lent it. Everything else (`execute_cdp`, `capture_pdf`, events) stays on DevTools.
The order is read on every call, so changing it needs no restart.


`state.kind` is `external-service`: durable browser state (tabs, cookies, storage) lives in
the browser. In-process state — the connection, single active target route, and bounded
event buffer — is allocated by `initialize()` and released by `dispose()`, which closes the
socket and rejects pending calls on reload/shutdown. The active route is shared mutable
state; serialize routing-sensitive flows.

## Errors

Operation handlers surface stable message prefixes (in the `EXECUTION_FAILED` envelope
message): `NOT_CONNECTED`, `NO_ACTIVE_TARGET`, `CDP_TIMEOUT`, `JS_EXCEPTION`,
`NAVIGATION_FAILED`, `INPUT_INVALID`, `ARTIFACT_WRITE_FAILED`. A session Chrome has dropped
is re-attached once and the call retried. Raw CDP errors are surfaced verbatim as
`CDP <code>: <message>`. A `wait_for_event` timeout is a normal `found:false` result, not an
error.

## Development

```bash
bun test            # 41 tests
bun run typecheck
bun run build:skill # after changing src/, cli.ts, daemon.ts, or capability.json
```

`@agent-software/core` resolves from the sibling `agent-software` checkout, which stays the
single source of truth for the runtime — there is no vendored copy here. Work conventions are
in [AGENTS.md](AGENTS.md). This repository is private and not licensed for distribution.
