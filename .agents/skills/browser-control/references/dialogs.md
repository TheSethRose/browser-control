# Browser Dialogs

Native dialogs freeze the page's JavaScript thread until handled.

## Prerequisites

- An active connection and selected target. Call
  `execute_cdp { "method": "Page.enable" }` first.

## Workflow

1. Reactive (preferred, undetectable): enable `Page`, then listen for the dialog:
   `wait_for_event { "method": "Page.javascriptDialogOpening", "timeoutMs": 10000 }`
   → `type` (`alert`/`confirm`/`prompt`/`beforeunload`) and `message`.
   Then dismiss or accept:
   `execute_cdp { "method": "Page.handleJavaScriptDialog", "params": { "accept": true } }`;
   for `prompt`, add `"promptText": "..."`.
2. For a flow that may raise several dialogs, run the action and then drain
   `read_events { "method": "Page.javascriptDialogOpening" }`.
3. `beforeunload`: trigger the navigation and then accept the dialog
   (`Page.handleJavaScriptDialog { "accept": true }`) inside a tolerant try — it may not
   appear. Alternatively, before navigating,
   `Runtime.evaluate` `window.onbeforeunload = null`.
4. Proactive stub (only when many dialogs are expected and antibot detection is not a
   concern): replace `window.alert`/`confirm`/`prompt` via `Runtime.evaluate` and read the
   collected messages later. Re-inject after navigation.

## Operations used

- `execute_cdp` (`Page.enable`, `Page.handleJavaScriptDialog`,
  `Runtime.evaluate`), `wait_for_event`, `read_events`.

## Traps

- Do not try to click a dialog — it is browser chrome, not page DOM.
- JS stubs are detectable by antibot and do not handle `beforeunload`.
- Stubs are lost on navigation; re-inject.

## Verification

The action that was blocked by the dialog now completes, and a follow-up
`Runtime.evaluate` or screenshot shows the expected state.
