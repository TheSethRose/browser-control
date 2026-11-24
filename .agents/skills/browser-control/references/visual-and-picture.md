# Visual Inspection, Artifacts, and Picture Pages

Read pages visually, generate screenshots/PDFs, and drive canvas-only pages via OCR.

## 1. Inspect before shooting

- Start with text: `snap` (controls), `text` (readable markdown), `health` (one-pass JSON audit of contrast, tiny text, tap target size, heading skips, unlabeled inputs, duplicate IDs, broken/alt-less images, meta/JSON-LD), or `eval '<js>'` (keep output small with `.slice(0, 2000)`).
- **Verify the page is the page:** a login redirect, error page, or empty shell can look "clean". Confirm the final URL matches expectations and a real app element rendered before trusting measurements.
- If `innerWidth` is `0`, you are attached to a non-window surface — re-list tabs.

## 2. Screenshots and PDFs

```bash
$BCD shot                                   # small JPEG at CSS-pixel scale (matches click --xy)
$BCD shot --ref e12                         # clip to one control
$BCD shot --marks                           # overlay ref numbers (12 -> e12) on controls
$BCD shot --full --png --to /abs/page.png   # full-page PNG (device pixels; not click coords)
$BCD call capture_pdf '{"printBackground":true,"preferCSSPageSize":true,"path":"/abs/page.pdf"}'
```

- **CSS vs device pixels:** `shot` (viewport / `--ref`) is **CSS-pixel scale**, so any point in the image is directly usable with `click --xy`. `shot --full` and raw `capture_screenshot` are **device pixels** (divide by `devicePixelRatio` before clicking).
- **Full-page caveats:** `fullPage` (`captureBeyondViewport`) re-layouts the page and can duplicate fixed/sticky headers.
- **PDF caveats:** `printBackground` defaults to `true`. Pages render with `@media print` CSS. If a site's "Print" button calls `window.print()`, neutralize it first (`eval 'window.print = () => { window.__printed__ = true; }'`) and call `capture_pdf`.
- Read saved artifact paths with your file tools; confirm the file exists and has non-zero bytes.

## 3. Picture pages (Cloudflare Browser Isolation, remote desktops, canvas apps)

When a page renders into one full-viewport `<canvas>`, there is no DOM or AX tree (`snap` prints `# PICTURE PAGE`). Use macOS Vision OCR on a DevTools tab (`xcode-select --install` required once; the recognizer builds in ~5 s and stays warm across calls):

```bash
$BCD ocr --match portal             # 120,160 "New report"   90,70 "Dashboard"   …
$BCD ocr --find "recent items"      # narrow output
$BCD click --xy 120,160             # waits for canvas redraw, prints + / - text changes
$BCD type --focused 'quarterly'     # after clicking a field to focus it
$BCD key Enter
```

- `ocr` returns each text box's center `x,y` in CSS pixels (same coordinates as `click --xy`).
- After `click --xy`, `type --focused`, or `key`, the daemon polls a fast canvas hash until the remote frame redraws (falling back to a short wait if cross-origin tainted), then diffs recognized text (`+` appeared, `-` disappeared).
- `# no visible text change yet` usually means the remote stream is still painting — run `ocr` again before assuming failure; never repeat a risky click blindly.
- Unlabeled icons need `shot` (CSS-pixel scale) to read coordinates.
- Scroll by clicking inside the canvas and sending `key ArrowDown` or `Input.dispatchMouseEvent` (`mouseWheel`, see `dom-and-input.md`).
- **Traps:** First `ocr` after a reboot can take ~30 s while macOS loads the Vision model (warm calls run in ~0.3 s). Confirm risky targets with `shot` if text is small or low-contrast. `type --focused` cannot read values back (`delivered_unverified`) — verify with `ocr`. All account-safety rules (`safety.md`) still apply.
