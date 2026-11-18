# Browser Artifacts

Produce binary output as files; the operations return an absolute `path` you can read with
your file tools.

## Prerequisites

- An active connection and selected target (see `session.md`).

## Workflow

1. Viewport screenshot (fastest, matches what the user sees):
   `capture_screenshot` → `{ path, mimeType, bytes }`. Pass `{ "path": "/abs/file.png" }`
   to choose where it is written.
2. Full-page screenshot: `capture_screenshot { "fullPage": true }`
   (sets `captureBeyondViewport`).
3. Smaller output: `{ "format": "jpeg", "quality": 70 }`.
4. Region: `{ "clip": { "x": 0, "y": 0, "width": 800, "height": 600, "scale": 1 } }`,
   or use `DOM.getBoxModel` coordinates for one element.
5. PDF: `capture_pdf { "printBackground": true, "preferCSSPageSize": true }`.
   Add `landscape`, `paperWidth`/`paperHeight`, margins, `pageRanges`, or `scale` as needed.
6. If a page's own "Print" button calls `window.print()`, neutralize it first:
   `Runtime.evaluate` `window.print = () => { window.__printed__ = true; }`, then use
   `capture_pdf` yourself.

## Operations used

- `capture_screenshot`, `capture_pdf`,
  `execute_cdp` (`Runtime.evaluate`, `DOM.getBoxModel`).

## Traps

- `printBackground` defaults to `true` here; without it, design-heavy PDFs look empty.
- PDFs render with print-media CSS; content hidden under `@media print` is omitted.
- `fullPage` re-layouts the page and can duplicate fixed/sticky headers.
- On high-DPI, screenshots are device pixels while input coordinates are CSS pixels.

## Verification

The returned `path` exists, `bytes` is non-zero, and the file opens with the expected
content.
