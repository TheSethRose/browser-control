# browser-control

browser-control drives the Chromium browser you already use over the [Chrome DevTools
Protocol](https://chromedevtools.github.io/devtools-protocol/) (CDP). It can connect, pick a
tab, read the DOM, run JavaScript, click and type, handle iframes and dialogs, watch network
traffic, scroll, download files and save screenshots and PDFs.

It works in your real browser, with your logins, extensions and open tabs. It doesn't use a
headless browser or a throwaway profile. Chrome, Chromium, Edge, Brave, Arc, Vivaldi, Opera,
Comet and Canary all work.

The same code runs three ways:

- A shared daemon, the default for agents. One long-running process holds the connection,
  so Chrome asks "Allow remote debugging?" once per browser instead of once per call.
- A standalone MCP server with plain tool names, for any MCP client.
- A command-line tool that starts one process per call, for scripts and shells.

## Set it up with your agent

Paste this into Claude Code, Codex, opencode or another coding agent:

```text
Read https://github.com/TheSethRose/browser-control and install its browser-control skill for yourself, including Bun if it's missing. Then help me turn on remote debugging in my browser and test it by listing my open tabs.
```

Your browser will ask you to allow the connection once. Click Allow.

## Requirements

To use the skill you need only Bun and a browser. The skill ships a prebuilt runtime, so it
works from a fresh clone.

- [Bun](https://bun.sh), the only runtime dependency.
- A Chromium-based browser with remote debugging turned on. In current Chrome, open
  `chrome://inspect/#remote-debugging` and check **"Allow remote debugging for this browser
  instance"**. Other Chromium browsers have the same switch, or accept the
  `--remote-debugging-port` launch flag.
- Optional: [opencode browse](https://opencode.ai/product/browse)
  ([GitHub](https://github.com/anomalyco/browse)), a browser extension with a `browse`
  command-line tool. browser-control uses it only when three things are true. The `browse`
  command is installed. The extension is connected to its relay. `browse` is listed in the
  [backend order](#backends). Otherwise everything runs over DevTools.

You need no API keys, accounts or config files. [Configuration](#configuration) lists the
optional environment variables.

## Install

To use the skill, clone this repository and link the skill folder (see [Skill](#skill)):

```bash
git clone https://github.com/TheSethRose/browser-control.git
```

To work on the code, you also need the private `agent-software` repository, cloned into the
same parent folder. It provides `@agent-software/core`
(`"@agent-software/core": "file:../agent-software/core"`). Then run:

```bash
cd browser-control
bun install
```

You can now run `bun ./cli.ts` and `bun ./mcp.ts`. To put the `browser-control` command on
your `PATH`, run:

```bash
bun link
```

## Quick start

The daemon starts on the first command that needs it and connects when a command needs a
browser. If the browser restarts, the daemon finds the new port. You never manage the
connection.

```bash
BCD=./.agents/skills/browser-control/scripts/browser-control-daemon

$BCD tabs                                  # header names the browser; then targetId url | title (* = selected)
$BCD call select_target '{"targetId":"<id>"}'
$BCD eval 'document.title'                 # run JavaScript, print the value
$BCD nav https://example.com               # navigate and wait for the load event
$BCD call execute_cdp '{"method":"Network.enable"}'
$BCD ops                                   # every operation with its input names
```

For longer tasks, follow the skill's reference files for tabs, frames, input, dialogs,
network, scrolling, downloads, cookies and artifacts. Each one is a set of steps built from
`call`. None of them adds an operation.

Each new connection makes the user click Allow. Chrome asks the person at the keyboard to
approve every new remote debugging connection. The daemon already holds an approved one. So
don't restart it, stop it or disconnect it. Never pass a port. If a command waits and
then reports a timeout, the user hasn't clicked Allow yet. Ask them to, then run the same
command again.

## Operations

`execute_cdp` sends any CDP command. The other operations exist for two reasons. Some jobs
need more than one raw call, like writing a binary file or keeping events between calls.
Others, like `evaluate` and `navigate`, would take too much code to write by hand each time.

| Operation | What it does |
| --- | --- |
| `list_browsers` | Lists running Chromium browsers that allow remote debugging, with their live ports. |
| `connect_browser` | Opens the browser's CDP WebSocket and keeps it open. It finds the live port itself. `browser` picks one by name and opens it if needed. |
| `disconnect_browser` | Closes the socket and clears the selected tab and the event buffer. |
| `get_browser_status` | Shows the connection, the selected tab, the number of buffered events and the artifact folder. |
| `list_targets` | Lists targets (pages, out-of-process iframes and workers). It hides `chrome://` and `devtools://` pages. |
| `select_target` | Attaches to one target and sends later tab calls to it. |
| `clear_target` | Stops sending calls to the selected target. |
| `execute_cdp` | Calls any `Domain.command` and returns the raw result. |
| `evaluate` | Runs JavaScript and returns its value. Top-level `await` works and promises are awaited. |
| `navigate` | Navigates and waits for the load event. |
| `capture_screenshot` | Saves a screenshot to a file and returns its path, type and size. |
| `capture_pdf` | Saves the page as a PDF and returns its path and size. |
| `read_events` | Returns and clears the CDP events buffered since the last read. |
| `wait_for_event` | Waits for the next matching event. On timeout it returns `found:false`. |

A typical flow:

```text
connect_browser -> list_targets -> select_target
 -> navigate -> capture_screenshot -> evaluate
 -> execute_cdp(Network.enable) -> read_events
```

## Ways to run it

### Daemon

The daemon is `cli.ts --serve <socket>`, built in `daemon.ts`. Its client is
`.agents/skills/browser-control/scripts/browser-control-daemon`, a small `curl` wrapper with
these commands: `start`, `eval`, `nav`, `tabs`, `call`, `ops`, `default`, `status` and
`stop --force`.

One long-running process answers requests over a Unix socket. Every command starts the
daemon if it isn't running. The daemon connects on the first call that needs a browser. It
keeps one connection per browser and finds the new port after a browser restart. It refuses
`disconnect_browser` and a plain `stop`, because each new connection makes the user click
Allow. Agents use the daemon by default.

### Standalone MCP server

`mcp.ts` is one MCP server with plain tool names like `list_browsers`, `connect_browser` and
`execute_cdp`. Start it with `bun ./mcp.ts`, or register it with any MCP client:

```json
{
  "mcpServers": {
    "browser-control": { "command": "bun", "args": ["/absolute/path/to/browser-control/mcp.ts"] }
  }
}
```

### Command-line tool

`cli.ts` is installed as `browser-control` by `bun link`. Each call is a new process. Use
`--init` to connect first, or `--session` to run many operations in one process:

```bash
browser-control --init connect_browser '{"port":9222}' list_targets '{"types":["page"]}'
printf '%s\n' '{"operation":"execute_cdp","input":{"method":"Runtime.evaluate","params":{"expression":"document.title"}}}' \
  | browser-control --init connect_browser '{"port":9222}' --session
```

Without `bun link`, run `bun ./cli.ts …` instead.

All three run the same code in `src/`.

## Skill

`.agents/skills/browser-control/` is an agent skill you can install as is. It holds:

- `SKILL.md`, which tells the agent when and how to use the tool.
- `references/`, one file per task: tabs, frames, input, dialogs, network, scrolling,
  downloads, artifacts, inspection, sessions and backends.
- `scripts/`, which holds the daemon client.

Copy or symlink the folder into your agent's skills folder. For Claude Code that is
`~/.claude/skills`. Many other agents read `~/.agents/skills`. From the repository folder:

```bash
ln -s "$PWD/.agents/skills/browser-control" ~/.claude/skills/browser-control
```

The `runtime/` folder inside it is a prebuilt copy of this repository, so the skill works
from a fresh clone. `bun run build:skill` generates it. Don't edit it by hand (see
[AGENTS.md](AGENTS.md)).

## Configuration

These environment variables are optional. None of them holds a credential.

| Variable | What it sets |
| --- | --- |
| `BROWSER_CONTROL_BROWSER` | The browser to use when a connect names none (`beta`, `chrome`, …). It overrides the one-line file `~/.config/browser-control/default-browser`. |
| `BROWSER_CONTROL_BACKENDS` | The backend order, for example `browse,cdp`. It overrides the one-line file `~/.config/browser-control/backends`. The default is `cdp` (DevTools only). See [Backends](#backends). |
| `BROWSER_CDP_CALL_TIMEOUT_MS` | How long a CDP call waits for a reply when it sets no timeout. Default 120000. |
| `BROWSER_CONTROL_MAX_OUTPUT` | Daemon only. The most characters `eval`, `nav` and `tabs` print. Default 50000. |
| `BROWSER_CDP_WS_URL` | The browser's WebSocket address, when finding it automatically fails. |
| `BROWSER_PROFILE_DIR` | The profile folder to read `DevToolsActivePort` from. |
| `BROWSER_CDP_TIMEOUT_MS` | How long opening the socket may take. Raise it to leave time for the browser's Allow prompt. Default 5000. |
| `BROWSER_ARTIFACT_DIR` | The absolute folder for screenshots and PDFs. The default is the system temp folder. |
| `BROWSER_EVENT_BUFFER_SIZE` | How many events the buffer keeps. Default 1000. |

The port changes every time the browser restarts, so don't pass one. `connect_browser`
finds running browsers two ways and combines the results:

1. It reads `DevToolsActivePort` in each known profile folder. macOS privacy controls often
   block this file. It can also be out of date.
2. It reads the process table. `lsof` lists local listening ports, `ps` names the process
   behind each one. Only Chromium browsers are kept. This needs no file access and
   always finds the live port.

`browser` matches by name, trying the exact name first and then part of a name. On macOS it
opens the app if it isn't running. Chrome started with `--remote-debugging-port` answers
`/json/version`. The server you turn on in `chrome://inspect` offers only a raw WebSocket.
Connecting by port handles both.

## Backends

DevTools (`cdp`) is built in and runs every operation. Other backends live in
`src/backends/` (one file each) and are listed in `src/backends/registry.ts`. To remove one,
delete its file and its line in the registry. `src/backends/router.ts` picks a backend for
each call using the order from [Configuration](#configuration):

- A target id with a backend prefix, like `browse:12`, always goes to that backend.
- Otherwise the router tries backends in order. If a backend lacks the operation or isn't
  available (not installed, or no browser paired), the next one gets the call.
- While a backend's tab is selected, a tab operation that backend lacks fails with a clear
  message. It never runs on a different DevTools tab instead.

`browse` is [opencode browse](https://opencode.ai/product/browse)
([GitHub](https://github.com/anomalyco/browse)). It is optional. browser-control uses it only
when three things are true. The `browse` command is installed. Its extension is connected.
The order lists it, for example `browse,cdp`. If the command is missing or the extension isn't connected, calls
go to DevTools.

browse runs `navigate`, `evaluate`, `capture_screenshot` and tab selection with no debugging
port and no Allow click. Its tabs open in the background. It sees only tabs it opened or tabs
the user lent it. Everything else, like `execute_cdp`, `capture_pdf` and events, stays on
DevTools. The order is read on every call, so changing it needs no restart.

## State

The browser keeps the lasting state: tabs, cookies and storage (`state.kind` is
`external-service`). The process keeps three things: the connection, the selected tab and a
fixed-size event buffer. `initialize()` creates them. `dispose()` releases them. It also closes the
socket and rejects pending calls on reload or shutdown. All callers share one selected tab,
so run steps that depend on it one after another.

## Errors

Each error message starts with a fixed code, inside the `EXECUTION_FAILED` envelope message.
The codes are `NOT_CONNECTED`, `NO_ACTIVE_TARGET`, `CDP_TIMEOUT`, `JS_EXCEPTION`,
`NAVIGATION_FAILED`, `INPUT_INVALID` and `ARTIFACT_WRITE_FAILED`. If Chrome drops a session,
browser-control attaches again once and retries the call. Raw CDP errors come back unchanged
as `CDP <code>: <message>`. A `wait_for_event` timeout returns `found:false` and isn't an
error.

## Development

```bash
bun test
bun run typecheck
bun run build:skill # after changing src/, cli.ts, daemon.ts or capability.json
```

`@agent-software/core` comes from the `agent-software` copy next to this one. That
repository is the only source for the runtime. This one holds no copy of it. Work
conventions are in [AGENTS.md](AGENTS.md). This repository is not licensed for distribution.
