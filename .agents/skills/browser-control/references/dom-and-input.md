# DOM, Input, Frames, Dialogs, and Scrolling

Interact with controls, forms, iframes, shadow DOM, native dialogs, and scroll containers.

## 1. Ref and label input (preferred)

```bash
$BCD snap                                   # auto-scopes to an open modal (--within body to widen)
$BCD fill '{"Email":"ada@example.com","Name":"Ada"}'
$BCD select "Country" "United States"       # native <select> or custom ARIA combobox
$BCD upload "Resume" /abs/path/resume.pdf   # never opens OS picker
$BCD key Tab                                # blur last field so validation runs
$BCD click e9                               # only after approval if e9 commits anything (safety.md)
$BCD wait --text "Saved" --timeout 10000
$BCD verdict                                # confirmed / rejected / unverified
```

- **Locators:** `e9` (page ref), `f2:e5` (ref `e5` inside iframe 2, including cross-origin iframes), `a41` (`snap --ax`, reaches closed shadow roots), or exact visible label in quotes. Multiple label matches return `AMBIGUOUS` with candidate refs.
- **Actionability:** `click` and `type` verify visible, enabled, still, and not covered before dispatching. Nothing fires when a check fails.
- **Receipts:** Every action prints DOM diffs (`+`, `-`, `~`, `# url:`) plus any passive 4xx/5xx HTTP responses or uncaught JS errors captured since the action started. Refs on `+` lines work immediately. `# no visible change yet` means nothing moved in the settle window — run `snap` or `wait` before assuming failure.
- **Typing:** `type` defaults to natural human typing (per-character `keyDown`/`keyUp` with realistic hold times, variable cadence, and occasional QWERTY-neighbor typos corrected with `Backspace`). Pass `--fast` for instant `Input.insertText` (+ real last key), or `--keys` for zero-delay raw key events. `fill --fast` and `do` step `{"type":[ref, text, "fast"]}` opt into fast mode in batches.
- **Batching:** `do '[…]'` runs steps in order (`click`, `type`, `select`, `upload`, `wait`, `key`) and stops on the first failure, read-back mismatch, host change, or `# WALL:`. Keep committing clicks in their own approved call.
- **Hover:** `hover <ref|label>` or `hover --xy <x,y>` moves the pointer without pressing. It reports what is under the pointer and any new tooltip text. Use it for menus that open on hover.
- **`browse:<n>` tabs:** `snap`, `click`, `type`, `key`, `wait`, `fill`, and `do` work on `browse:<n>` tabs with label resolution, trap/payment refusal, and wall/host checks. `--xy`, `select`, `upload`, and iframe/AX refs require a DevTools tab.

## 2. Fill and submit a form

1. `snap`. Leave `trap` fields empty; stop at `payment` and sensitive fields (`safety.md`).
2. `type` / `fill` / `select` / `upload`. On `delivered_unverified` (read-back differs), inspect before retyping.
3. `key Tab` after the last field so on-blur validation enables the submit button.
4. Get explicit approval before committing (`safety.md`, the save test).
5. Click submit. Passive receipts automatically surface same-origin 4xx/5xx HTTP errors and JS exceptions. If you also need full response bodies or cross-origin XHR status, arm `Network.enable` + `wait_for_event` before clicking (`network-and-apis.md`).
6. Judge by four signals, strongest first: HTTP status (4xx/5xx is `rejected`), URL change, `verdict` (`confirmed`/`rejected`), else `unverified`. Never re-submit to check.

## 3. Advanced input (drag and custom date pickers)

- **Pointer drag (canvas, sliders, maps):** `Input.dispatchMouseEvent` with `mousePressed`, a sequence of `mouseMoved` steps (velocity matters), then `mouseReleased`.
- **HTML5 drag-and-drop:** `Input.setInterceptDrags { "enabled": true }`, `mousePressed` on source, `wait_for_event` for `Input.dragIntercepted`, dispatch `Input.dispatchDragEvent` (`dragEnter`/`dragOver`/`drop` with intercepted data), `mouseReleased` at target, then `setInterceptDrags { "enabled": false }`.
- **Read-only / JS date picker that ignores typing:** set via the native prototype setter (plain `el.value =` is ignored by React) and dispatch events:
  ```js
  const el = document.querySelector('#start');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '2026-03-01');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  ```
  Verify with `value`. If unchanged, click the calendar day or ask the user.
- **Traps:** Never click a native `<select>` or `<input type="file">` (both open OS surfaces CDP cannot close — use `select` and `upload`). Coordinates go stale after scrolling, resizing, or opening menus.

## 4. Iframes and shadow DOM

- `snap` traverses open shadow roots, same-origin iframes, and reachable cross-origin iframes (`[f1:e5]`). `click`, `type`, `select`, `upload`, and `value` accept `f<n>:e<m>` directly and translate coordinates.
- **Extension tabs:** the extension reaches cross-origin iframes too, so `f<n>:e<m>` refs work for label lookup, `type`, and `upload` there. Frames are numbered by URL and page order, so two iframes with the same URL get different numbers.
- **Closed shadow roots:** `snap --ax` lists controls as `[a41]` (auto-used when DOM shows no controls). Manual CDP fallback: `DOM.getDocument { "depth": -1, "pierce": true }`.
- **Unreachable OOPIF (Stripe, Salesforce):** find the `iframe` target via `call list_targets`, run `call select_target '{"targetId":"<id>"}'`, operate inside it, then **re-select the parent tab** so later navigations don't target the frame. Note: OOPIFs often lazy-mount after outer focus and their targetIds expire on navigation.
- **Coordinate fallback:** compositor-level `click --xy` pierces iframes and shadow roots transparently. Frame-local `getBoundingClientRect()` needs the iframe's own rect added.

## 5. Native JavaScript dialogs

Native `alert`, `confirm`, `prompt`, and `beforeunload` freeze JS and block input until handled (input calls return `delivered_unverified` after 10 s instead of waiting 120 s).

Use the `dialog` command first:

- `$BCD dialog accept` clicks OK. `$BCD dialog accept 'text'` also fills a `prompt`.
- `$BCD dialog dismiss` clicks Cancel.
- Both take a targetId last (`dialog accept 'text' extension:42`, `dialog dismiss extension:42`). A trailing token that looks like a targetId (`extension:<n>`, `browse:<n>`, 32-hex) is the target, never prompt text; to send text that looks like one, pass it before an explicit targetId.
- On extension tabs, a stuck helper call reports the open dialog with `remedy: run dialog accept|dismiss`.

The manual CDP steps still work:

1. Enable `Page` first: `call execute_cdp '{"method":"Page.enable"}'`.
2. Detect: `call wait_for_event '{"method":"Page.javascriptDialogOpening","timeoutMs":10000}'` (or drain with `read_events`).
3. Handle: `call execute_cdp '{"method":"Page.handleJavaScriptDialog","params":{"accept":true}}'` (add `"promptText":"..."` for prompts).
4. `beforeunload`: accept inside a tolerant try after navigating, or clear beforehand via `eval 'window.onbeforeunload = null'`.
5. Never try to click a native dialog (it is browser chrome, not DOM). Avoid stubbing `window.alert`/`confirm` on anti-bot sites; stubs also reset on navigation and skip `beforeunload`.

## 6. Scrolling and viewport emulation

- **Wheel scroll (real user; required for virtualized lists like `react-window`/TanStack Virtual):**
  `call execute_cdp '{"method":"Input.dispatchMouseEvent","params":{"type":"mouseWheel","x":600,"y":400,"deltaX":0,"deltaY":300}}'`
  Aim over the actual scroller (sticky headers/sidebars swallow wheel events).
- **DOM scroll:** `eval "document.querySelector('[data-row-id=\"42\"]')?.scrollIntoView({block:'center',behavior:'instant'})"` (avoid `smooth` scrolling, which shifts coordinates mid-click).
- **`emulate` command (preferred):** `$BCD emulate --viewport 390x844@3 --mobile`, `--color-scheme dark`, `--reduced-motion`, `--offline`, or `--ua '<string>'`. `$BCD emulate --reset` clears all of it (it sends the clear twice, because Chrome sometimes drops one). Apply it **before** navigation so load-time breakpoints match.
- **Pin viewport / mobile emulation by hand:** apply **before** navigation so load-time breakpoints match:
  - Desktop: `Emulation.setDeviceMetricsOverride { "width": 1280, "height": 800, "deviceScaleFactor": 1, "mobile": false }`
  - Mobile: `{ "width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": true }` plus `Emulation.setTouchEmulationEnabled { "enabled": true }`.
  - Restore with `Emulation.clearDeviceMetricsOverride` when done. Re-measure coordinates after any scroll or resize.
