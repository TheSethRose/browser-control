# Browser Scrolling and Viewport

Move the page and pin its size so coordinates stay stable.

## Prerequisites

- An active connection and selected target (see `session.md`).

## Workflow

1. Wheel scroll (closest to a real user; scrolls whatever is under the point):
   `execute_cdp { "method": "Input.dispatchMouseEvent", "params": { "type": "mouseWheel", "x": 600, "y": 400, "deltaX": 0, "deltaY": 300 } }`.
   Aim over the intended scroller; a sticky header or sidebar swallows the wheel.
2. DOM scroll:
   `Runtime.evaluate` `document.querySelector('[data-row-id="42"]')?.scrollIntoView({ block: 'center', behavior: 'instant' })`,
   or set `el.scrollTop = el.scrollHeight` for blunt jumps.
3. Virtualized lists (`react-window`, TanStack Virtual): wheel the container repeatedly —
   `scrollIntoView` on an unmounted row is a no-op.
4. Pin a viewport before interacting:
   `execute_cdp { "method": "Emulation.setDeviceMetricsOverride", "params": { "width": 1280, "height": 800, "deviceScaleFactor": 1, "mobile": false } }`.
   Clear it with `Emulation.clearDeviceMetricsOverride` when done.
5. Mobile emulation: same override with `{ "width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": true }`
   plus `Emulation.setTouchEmulationEnabled { "enabled": true }` and a user-agent override.

## Operations used

- `execute_cdp` (`Input.dispatchMouseEvent` `mouseWheel`,
  `Runtime.evaluate`, `Emulation.setDeviceMetricsOverride`,
  `Emulation.clearDeviceMetricsOverride`).

## Traps

- `scroll-behavior: smooth` animates; use `behavior: 'instant'` or wait before clicking, or
  your next action lands on stale coordinates.
- Re-read rects after any scroll or resize.
- Apply `setDeviceMetricsOverride` **before** navigation for sites that evaluate
  breakpoints at load.
- Coordinate clicks are wrong after the viewport changes.

## Verification

A screenshot shows the target content in view, and `Runtime.evaluate` of `scrollY` (or the
container's `scrollTop`) matches expectations.
