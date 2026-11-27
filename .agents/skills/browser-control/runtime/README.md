# browser-control

browser-control drives the Chromium browser you already use. It can pick a tab, read the
DOM, run JavaScript, click, type and hover, handle iframes and dialogs, watch network traffic,
scroll, download files and save screenshots and PDFs.

Version 2 adds the Browser Control extension. With it, agents reach your real Chrome without
the remote-debugging setting and without an "Allow" click after each browser restart. Direct
[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) (CDP), the v1
way, stays unchanged when the extension isn't paired and works whenever you ask for it by name.
Every v1 command still works.

It works in your real browser, with your logins, extensions and open tabs. It doesn't use a
headless browser or a throwaway profile. Chrome, Chromium, Edge, Brave, Arc, Vivaldi, Opera,
Comet and Canary all work.

The same code runs three ways:

- A shared daemon, the default for agents. One long-running process holds the connections.
  On CDP, Chrome asks "Allow remote debugging?" once per browser instead of once per call.
- A standalone MCP server with plain tool names, for any MCP client.
- A command-line tool that starts one process per call, for scripts and shells.

## Set it up with your agent

Paste this into Claude Code, Codex, opencode or another coding agent:

```text
Read https://github.com/TheSethRose/browser-control and install its browser-control skill for yourself (including Bun if missing). Then run `browser-control-daemon extension setup` and walk me through loading the Chrome extension (or turning on remote debugging if I prefer). Test it by listing my open tabs.
```

`extension setup` pairs the extension and prints the path of its `extension/` folder. Then you
make three clicks:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the printed folder.

Setup returns right away. After you load the extension, `extension browsers` shows it connected.
Pairing needs no typing. `extension setup` writes a shared secret to
`~/.config/browser-control/extension-relay.json` and `extension/pairing.json` (both `0600`).
Neither file belongs in a commit.

If you choose remote debugging instead, your browser asks you to allow the connection once.
Click Allow.

## Requirements

To use the skill you need only Bun and a browser. The skill ships a prebuilt runtime, so it
works from a fresh clone.

- [Bun](https://bun.sh), the only runtime dependency.
- A Chromium-based browser, version 125 or newer, with the Browser Control extension loaded
  (see above).
- Or, for direct CDP (when not using the extension, or when opting into CDP explicitly), a Chromium-based browser with remote debugging turned on. In
  current Chrome, open
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

With remote debugging (cdp), each new connection makes the user click Allow. Chrome asks
the person at the keyboard to approve every new remote debugging connection. The daemon
already holds an approved one. So don't restart it, stop it or disconnect it. Never pass a
port. If a cdp connect waits and then times out while Chrome shows the remote debugging
prompt, ask the user to click Allow, then run the same command again. The extension has no
Allow prompt; on the extension, follow the fix line in the error instead.

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

The daemon is `cli.ts --serve <socket>`, built in `daemon.ts` (with page execution in
`src/page-runner.ts` and OCR/picture tracking in `src/picture.ts`). Its client is
`.agents/skills/browser-control/scripts/browser-control-daemon`, a small `curl` wrapper with
these commands: `start`, `eval`, `nav`, `tabs`, `call`, `ops`, `default`, `status`,
`check-update`, `stop --force` and `extension`. It also exposes page helpers through the
daemon (`snap`, `text`, `form`, `query`, `read-urls`, `ocr`, `shot`, `click`, `hover`, `type`,
`select`, `upload`, `drag`, `wait`, `key`, `fill`, `do`, `dialog`, `emulate`, `handoff`,
`value`, `verdict`, `health`, `styles`, `issues`, `perf`, `notes`, `flow` and `script`). On
CDP tabs they inject `src/page-helpers.js.txt` once per document. On extension tabs the
extension runs the same helper. `browse:<n>` tabs go through the `browse` CLI. They add no
capability operations. `SKILL.md` lists every command and flag.

One long-running process answers requests over a Unix socket. Every command starts the
daemon if it isn't running. The daemon connects on the first call that needs a browser. It
keeps one connection per browser and finds the new port after a browser restart. It refuses
`disconnect_browser` and a plain `stop`, because each new CDP connection makes the user click
Allow. When the backend order lists `extension`, the daemon also opens the extension relay on
the first free port in `127.0.0.1:49222`-`49229`. Up to eight daemons can run at once. Agents
use the daemon by default.

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

- `SKILL.md`, which tells the agent when and how to use the tool and how to check for updates.
- `references/`, five task-shaped guides: `safety.md`, `dom-and-input.md`, `network-and-apis.md`,
  `visual-and-picture.md`, and `sessions-and-backends.md`.
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
| `BROWSER_CONTROL_BACKENDS` | The backend order, for example `extension`, `extension,cdp`, or `browse,cdp`. The daemon reads the order from `<daemon dir>/backends` first (written by `extension disable`, cleared by `extension enable` and `extension setup`), then this variable, then the one-line file `~/.config/browser-control/backends`. With none of them, a paired extension defaults to `extension` alone; otherwise the order is `cdp` (DevTools only). See [Backends](#backends). |
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

There are three backends:

- `extension` is the Browser Control extension in your browser. Once paired, it is the sole
  default backend and never falls back to `cdp` implicitly.
- `cdp` is direct DevTools. It is built in, runs every operation, remains the default when the
  extension isn't paired, and runs whenever asked for by name (`start <browser>`, a DevTools
  targetId, or `BROWSER_CONTROL_BACKENDS=extension,cdp`).
- `browse` is the optional opencode browse adapter.

The extension talks to the daemon over a WebSocket on `127.0.0.1`. Each side proves it holds
the shared secret with a challenge and response, so the secret never crosses the wire. The
daemon also rejects any connection that doesn't come from the extension's fixed ID.

On extension tabs:

- Reads (`tabs`, `nav`, `snap`, `text`, `form`, `query`, `read-urls`, `value`, `wait` and
  others) run without the debugger, so Chrome shows no yellow "started debugging" banner.
- Clicks, typing, hover, uploads and DevTools commands attach the debugger. It detaches after
  30 seconds idle.
- Agent tabs open in the background and don't steal focus. They can sit in a collapsed
  `Agents · N` tab group.
- `handoff <message>` shows a "Your turn" card in the tab and waits for you to click Continue.
  Use it for logins, 2FA, CAPTCHAs and payments.
- `nav --browser <slug>` picks a browser when more than one is connected.
  `extension browsers` lists the slugs.
- The popup can limit the extension to tabs you lend it (`Lent only`).

The `extension` command manages the link: `extension setup [extensionDir]`,
`extension status`, `extension browsers`, `extension diagnostics`, `extension enable` (clears
any old `<daemon dir>/backends` override such as `cdp` or an earlier `extension,cdp` so the
default `extension`, env var, or config file applies) and `extension disable`
(writes `cdp`). `extension pair` and
`extension revoke` wait for a later Web Store build and return an error for now.

The backends other than `cdp` live in `src/backends/` (one file each) and are listed in
`src/backends/registry.ts`. To remove one, delete its file and its line in the registry. `src/backends/router.ts` picks a backend for
each call using the order from [Configuration](#configuration):

- A target id with a backend prefix, like `extension:42` or `browse:12`, always goes to that
  backend.
- Explicit CDP requests (`start <browser>`, a DevTools targetId with no backend prefix, or
  `select_target` of a DevTools target) always run on `cdp`, even when the order is `extension`.
- With order `extension`, nothing reaches `cdp` implicitly: a disconnected extension, a
  restricted page (`RESTRICTED_PAGE`), an unhandled op, or a browser-level CDP op refuses with
  `EXTENSION_ONLY` naming the cause and how to opt into `cdp`.
- Fallback to `cdp` happens only when the effective order explicitly lists `cdp` (for example
  `BROWSER_CONTROL_BACKENDS=extension,cdp` or `browse,cdp`).
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

## Limits

These are limits of Chrome itself:

- Chrome shows a yellow banner while the debugger is attached. Reads never attach it, and it
  detaches 30 seconds after the last command that needed it.
- Extensions can't run on `chrome://` pages, the Chrome Web Store, other extensions' pages, the
  built-in PDF viewer, or `file://` pages (unless "Allow access to file URLs" is on). With the
  default `extension` order they refuse with `EXTENSION_ONLY`; opt into `cdp` with
  `start <browser>`, a DevTools targetId, or `BROWSER_CONTROL_BACKENDS=extension,cdp`.
- Extensions can use only some CDP domains: Accessibility, Audits, CacheStorage, Console, CSS,
  Database, Debugger, DOM, DOMDebugger, DOMSnapshot, Emulation, Fetch, IO, Input, Inspector,
  Log, Network, Overlay, Page, Performance, Runtime, Storage, Target, Tracing, WebAudio and
  WebAuthn. `Browser.*` is not allowed. Every built-in command uses allowed domains only.
- In a minimized window, `Page.captureScreenshot` hangs and timers slow down. Agent tabs always
  open in a window that isn't minimized.
- The first call after a daemon starts can take up to 30 seconds if Chrome has put the
  extension to sleep. The daemon waits up to 35 seconds and says why. Later calls are instant.
- The Chrome Web Store reviews extensions that ask for `debugger` and access to all sites
  slowly, or rejects them. The unpacked install is the supported path for now.

## State

The browser keeps the lasting state: tabs, cookies and storage (`state.kind` is
`external-service`). The process keeps three things: the connection, the selected tab and a
fixed-size event buffer. `initialize()` creates them. `dispose()` releases them. It also closes the
socket and rejects pending calls on reload or shutdown. All callers share one selected tab,
so run steps that depend on it one after another.

## Errors

Each error message starts with a fixed code, inside the `EXECUTION_FAILED` envelope message.
The codes are `EXTENSION_ONLY`, `NOT_CONNECTED`, `NO_ACTIVE_TARGET`, `CDP_TIMEOUT`, `JS_EXCEPTION`,
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

`bun run test:e2e` runs `tests/e2e/` in Chrome for Testing with the extension loaded. CI skips
it. Every browser it starts gets `--use-mock-keychain`, `--password-store=basic` and a new
throwaway `--user-data-dir`, so macOS shows no Keychain prompts.

`@agent-software/core` comes from the `agent-software` copy next to this one. That
repository is the only source for the runtime. This one holds no copy of it. Work
conventions are in [AGENTS.md](AGENTS.md). The code is under the [MIT license](LICENSE).
