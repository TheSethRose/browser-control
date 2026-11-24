# Picture Pages

Some pages are one `<canvas>`: Cloudflare Browser Isolation
(`<team>.cloudflareaccess.com/browser/<url>`), remote desktops, and canvas apps. The real
page runs somewhere else and only its picture reaches this browser, so there is no DOM and
no accessibility tree to read. `snap` says so with a `# PICTURE PAGE` line.

## Prerequisites

- A DevTools tab (not `browse:<n>`). `ocr` needs macOS with the Swift compiler
  (`xcode-select --install`); it builds its recognizer once, in about five seconds.

## Workflow

```bash
$BCD ocr --match portal             # 120,160 "New report"   90,70 "Dashboard"   …
$BCD ocr --find "recent items"      # just the lines you need
$BCD click --xy 120,160             # prints: hit: canvas…, then + / - text that changed
$BCD type --focused 'quarterly'     # after a click put the cursor in a field
$BCD key Enter
```

1. `ocr` returns each piece of visible text with the `x,y` of its center, in the same CSS
   pixels `click --xy` takes. Use `--find` to keep the output small.
2. Act with `click --xy`, `type --focused` and `key`. After each, the daemon waits 0.7 s,
   reads the picture again and prints the text that appeared (`+`) or went away (`-`) since
   your last `ocr`.
3. `# no visible text change yet` usually means the remote page is still drawing. Run `ocr`
   again before deciding the action failed; don't repeat the action.
4. Icons and unlabeled buttons carry no text. Take a `shot` for those: its picture is
   CSS-pixel scale, so a point in it is the `x,y` to click.

## Traps

- The first `ocr` after a restart can take about 30 s while macOS loads its text model.
  Later calls take about 0.3 s.
- Text recognition can misread small or low-contrast text. Confirm a risky target with a
  `shot` before clicking it.
- The page cannot be scrolled with JavaScript. Click into it, then send `key ArrowDown`, or
  dispatch `Input.dispatchMouseEvent` with `type: "mouseWheel"` (see `scrolling.md`).
- Nothing here can read a field's value back, so `type --focused` is always
  `delivered_unverified`: check with `ocr`.
- The account-safety rules still apply (`safety.md`): approval before anything that sends,
  submits or deletes.

## Verification

A fresh `ocr` (or `shot`) shows the expected text at the expected place.
