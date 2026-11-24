# Browser Input

Synthesize input at the compositor level and through the DOM.

## Prerequisites

- An active connection and selected target. Coordinates are **CSS pixels** relative to the
  target's viewport; obtain them via `DOM.getBoxModel` or `getBoundingClientRect` (see
  `inspect.md`).

## By ref or label (preferred)

```bash
$BCD snap                                   # - textbox "Email" [e3] [required]   - button "Save" [e9]
$BCD fill '{"Email":"ada@example.com","Name":"Ada"}'   # click, replace, read back, each field
$BCD key Tab                                # blur the last field so the form validates
$BCD click e9                               # only after approval if e9 commits anything (references/safety.md)
$BCD verdict                                # confirmed / rejected / unverified
```

- A control is named by a ref (`e9`, `f2:e5` inside iframe 2, `a41` from `snap --ax`) or by its
  visible label in quotes. A label must fit exactly one control: `AMBIGUOUS` lists the
  candidates with their refs, `NO_MATCH` lists the closest names. Use the ref it gives you.
- `click` and `type` check the element first on DevTools tabs: visible, enabled, not moving,
  and not covered (the error names what covers it, often a cookie banner or modal). Nothing
  is dispatched when a check fails.
- Every action prints what changed about 0.1 to 0.4 s later: `+` a new control, `-` a removed
  one, `~` a changed value or flag, `# url: a -> b`, and `# new page:` after a navigation. A
  ref on a `+` line is ready to use. `# no visible change yet` means nothing moved in that
  window: a slow request may still be pending, so `snap` or `verdict` before deciding it failed.
- A ref stays valid while its element is in the page. A typeahead or re-render that replaces
  the element returns `STALE_REF`: snap again.
- `do '[…]'` runs several steps in one call and stops at the first one that fails, is not
  read back as typed, leaves the site, or lands on a wall. Put a committing click in its own
  call, after approval.
- `type` uses `Input.insertText`, which fires the `input` events React and Vue listen to. For
  a widget that only listens to keydown, use `type --keys`.
- A click that opens a JavaScript dialog returns within 10 s with a note; see `dialogs.md`.
- On a `browse:<n>` tab, the daemon routes `snap`, `click`, `type`, and `key` through the
  `browse` CLI automatically (`references/backends.md`); labels and `--xy` need a DevTools tab.

## Fill and submit a form

1. `snap`. Leave `trap` fields empty and stop at `payment` fields. Don't fill sensitive
   fields (SKILL.md).
2. `type` each field. Read the disposition: `delivered` means the read-back matched.
   `delivered_unverified` with a different read-back means the field reformatted or rejected
   the text: look before retyping.
3. `key Tab` after the last field. Many forms validate on blur and keep the submit button
   `disabled` until then; `snap` shows whether it is still `[disabled]`.
4. Get approval for the submit (SKILL.md, the save test).
5. Arm the response wait **before** the click, then click, then collect. `wait_for_event`
   matches buffered events first, so drain old responses before arming it:
   ```bash
   $BCD call execute_cdp '{"method":"Network.enable"}'
   $BCD call read_events '{"method":"Network.responseReceived"}' >/dev/null
   $BCD call wait_for_event '{"method":"Network.responseReceived","match":{"type":"XHR"},"timeoutMs":15000}' > /tmp/submit.json &
   $BCD click e9; wait
   ```
   Use `"Fetch"` for fetch-based forms, or match on part of the URL if the page is busy.
6. Decide from four signals, strongest first: the submit's HTTP status (4xx/5xx is
   `rejected` even when the page shows nothing), a URL change away from the form, then
   `verdict` (success text, or a `[role=alert]` / `aria-invalid` / `.error` surface). If no
   signal is seen, report `unverified`. Never report a confirmation you didn't see, and
   never re-submit to find out.

## Raw CDP

1. Click an element:
   - `execute_cdp { "method": "Input.dispatchMouseEvent", "params": { "type": "mousePressed", "x": X, "y": Y, "button": "left", "clickCount": 1 } }`
   - `execute_cdp { "method": "Input.dispatchMouseEvent", "params": { "type": "mouseReleased", "x": X, "y": Y, "button": "left", "clickCount": 1 } }`
2. Type: click to focus, then
   `execute_cdp { "method": "Input.insertText", "params": { "text": "hello" } }`.
   For special keys use `Input.dispatchKeyEvent` (`keyDown`/`keyUp`).
3. Native `<select>`: do **not** open it (it draws an OS menu CDP cannot close). Instead
   `Runtime.evaluate` to set the value and dispatch a change event:
   `s.value = 'DE'; s.dispatchEvent(new Event('change', { bubbles: true }))`.
4. Custom dropdown: click the trigger, then **re-measure** the options (they often mount
   late in a portal), find the option by visible text via `Runtime.evaluate`, and
   coordinate-click it. For searchable comboboxes, type then use ArrowDown/Enter.
5. Pointer drag (canvas, sliders, maps): `mousePressed`, a loop of `mouseMoved`, then
   `mouseReleased`. Intermediate moves matter for velocity-based handlers.
6. HTML5 drag-and-drop: `Input.setInterceptDrags { "enabled": true }`, `mousePressed` at the
   source, `wait_for_event` for `Input.dragIntercepted`, then
   `Input.dispatchDragEvent` for `dragEnter`/`dragOver`/`drop` using the intercepted data,
   `mouseReleased` at the destination, and `setInterceptDrags { "enabled": false }`.
7. Upload: find the `<input type="file">` and use
   `execute_cdp { "method": "DOM.setFileInputFiles", "params": { "nodeId": <id>, "files": ["/absolute/path"] } }`.
   Never click a file input — it opens an OS picker. Upload only the file the user named.
8. Read-only or JS date picker that rejects typing: set the value through the native setter
   (a plain `el.value =` is ignored by React) and fire the events:
   ```js
   const el = document.querySelector('#start');
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '2026-03-01');
   el.dispatchEvent(new Event('input', { bubbles: true }));
   el.dispatchEvent(new Event('change', { bubbles: true }));
   ```
   Read it back with `value`. If the widget still shows the old date, it only accepts clicks:
   pick the day by clicking, or ask the user to.

## Operations used

- `execute_cdp` (`Input.*`, `DOM.setFileInputFiles`),
  `wait_for_event`, `capture_screenshot`.

## Traps

- Coordinates are invalidated by scrolling, resizing, or opening a menu — re-measure.
- File paths must be absolute; visibility and `display:none` do not matter for
  `setFileInputFiles`.
- Native selects and the file picker are OS surfaces; avoid triggering them.
- A controlled React/Vue input set with `el.value = …` looks filled but submits empty. Type
  into it (`type`, `Input.insertText`), or use the native setter above.
- Typing into a field that already has text appends to it. `type` selects the old text
  first; with raw CDP, select it (`el.select()`) before `Input.insertText`.
- A click that seems to do nothing is often covered (cookie banner, sticky header,
  transparent overlay) or landed on a `disabled` button. `click` reports both.
- A page that suddenly stops answering after a click has probably opened a native dialog
  (`references/dialogs.md`).

## Verification

Screenshot after the action and confirm the expected visual or value change, or `value` /
`snap` for a field; for submits, `verdict` plus the response status; for uploads, watch
`Network.requestWillBeSent` via `read_events`.
