# Browser Inspect

Read what the page actually shows and where things are.

## Prerequisites

- An active `browser-control` connection with a selected target (see `session.md`).

## Workflow

1. Screenshot for discovery: `capture_screenshot` (optionally
   `{ "fullPage": true }`). Read the returned `path` with your file tools.
2. Read values with JavaScript: `eval 'document.title'` (operation `evaluate`). It returns
   the value itself, awaits promises, and allows top-level `await`. Return only what you
   need (`.slice(0, 2000)`, a few fields) to keep output small.
3. Inspect the DOM:
   - `execute_cdp { "method": "DOM.enable" }`
   - `execute_cdp { "method": "DOM.getDocument", "params": { "depth": -1 } }` → `root.nodeId`
   - `execute_cdp { "method": "DOM.querySelector", "params": { "nodeId": <root>, "selector": ".card" } }`
4. Locate an element's box:
   `execute_cdp { "method": "DOM.getBoxModel", "params": { "nodeId": <id> } }` →
   `model.border` is `[x1,y1, x2,y1, x2,y2, x1,y2]`; use the first two as the top-left.
5. Read the viewport:
   `Runtime.evaluate` of `JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, sx: scrollX, sy: scrollY })`.
   `innerWidth`/`innerHeight` are **CSS pixels** (input coordinates); screenshots are
   **device pixels**.
6. Element screenshot: take `DOM.getBoxModel` coordinates and call
   `capture_screenshot { "clip": { "x": ..., "y": ..., "width": ..., "height": ..., "scale": 1 } }`.

## Operations used

- `capture_screenshot`, `execute_cdp`
  (`Runtime.evaluate`, `DOM.enable`, `DOM.getDocument`, `DOM.querySelector`,
  `DOM.querySelectorAll`, `DOM.getBoxModel`).

## Traps

- The DOM can lie about state; a screenshot is the ground truth for "what the user sees".
- `captureBeyondViewport: true` re-layouts the page and can duplicate sticky headers.
- If `innerWidth` is `0`, you are attached to a non-window surface — re-list targets.

## Verification

The value from `Runtime.evaluate` matches what the screenshot shows, and the element box
falls inside the reported viewport.
