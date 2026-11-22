# Backends: browse and DevTools

The runtime can reach the browser two ways. DevTools (`cdp`) is the daemon's approved CDP
connection. `browse` is opencode's browse extension
([site](https://opencode.ai/product/browse), [GitHub](https://github.com/anomalyco/browse)),
driven through its `browse` CLI. It is used only when the CLI is installed and the extension
is connected; otherwise calls fall back to DevTools. The
order lives in `~/.config/browser-control/backends` (or `BROWSER_CONTROL_BACKENDS`), for
example `browse,cdp`, and is read on every call. `call get_browser_status` shows the order
and which backend owns the current tab.

## How calls route

- An id like `browse:7` always goes to browse; an id without a prefix goes to DevTools.
- After `select_target` on a DevTools tab, calls with no id stay on that tab.
- With browse first and no DevTools tab selected, `nav <url>` opens a new background tab
  through browse and returns its `browse:<n>` id. `eval` and screenshots then run there.
- `clear_target` clears both, so the next untargeted `nav` opens a browse tab again.
- On a browse tab, operations browse can't run (`execute_cdp` on the tab, PDFs) fail with
  `INPUT_INVALID` instead of silently using another tab. Browser-level CDP methods still work.
- If browse isn't installed or not connected, calls fall through to DevTools.

## Which to use

| Task | Use |
| --- | --- |
| A tab the user already has open | DevTools (browse only sees tabs it opened or was lent) |
| New background tab to read, eval or screenshot | browse (`nav` with no tab) |
| Typing, clicking or filling like a person would | browse CLI, below |
| Hand control to the user (login, 2FA, CAPTCHA) | browse CLI: `browse handoff '<message>' <n>` |
| PDF, cookies, network, dialogs, events, any raw CDP | DevTools |
| Fast scripted form submit (set value, submit in JS) | DevTools |

Measured in Chrome Beta: browse eval about 9 ms against 38 ms for DevTools, navigation and
viewport screenshots about the same, full-page screenshots work in both.

## Interacting on a browse tab

The runtime wraps only `nav`, `eval` and screenshots. For the rest, call the `browse` CLI
directly with the tab number `<n>` from `browse:<n>`. It uses the extension, not a CDP
connection, so it needs no Allow click and doesn't break the "no second path" rule.

```bash
browse snapshot <n> --interactive      # controls with refs, e.g. - button "Save" [ref=e12]
browse fill <n> --json '{"ref":"e5","value":"text"}'
browse click <n> --json '{"ref":"e12"}'
browse press <n> Enter
```

A ref stops working when the page navigates or re-renders that element (typeahead inputs
do), so snapshot again after each step that changes the page. Failure example: filling a
search box, then pressing Enter on a stale ref, did nothing because the typeahead had
replaced the input; clicking the suggestion's ref from a fresh snapshot worked.

The account-safety rules in `SKILL.md` apply to browse tabs too.
