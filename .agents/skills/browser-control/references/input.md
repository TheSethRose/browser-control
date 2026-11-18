# Browser Input

Synthesize input at the compositor level and through the DOM.

## Prerequisites

- An active connection and selected target. Coordinates are **CSS pixels** relative to the
  target's viewport; obtain them via `DOM.getBoxModel` or `getBoundingClientRect` (see
  `inspect.md`).

## Workflow

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
   Never click a file input — it opens an OS picker.

## Operations used

- `execute_cdp` (`Input.*`, `DOM.setFileInputFiles`),
  `wait_for_event`, `capture_screenshot`.

## Traps

- Coordinates are invalidated by scrolling, resizing, or opening a menu — re-measure.
- File paths must be absolute; visibility and `display:none` do not matter for
  `setFileInputFiles`.
- Native selects and the file picker are OS surfaces; avoid triggering them.

## Verification

Screenshot after the action and confirm the expected visual or value change; for uploads,
watch `Network.requestWillBeSent` via `read_events`.
