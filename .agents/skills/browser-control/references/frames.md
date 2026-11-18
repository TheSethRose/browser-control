# Browser Frames and Shadow DOM

Find and act on content that lives behind frame or shadow-root boundaries.

## Prerequisites

- An active connection and selected target (see `session.md`).

## Workflow

1. **Try coordinate clicks first.** Compositor-level `Input.dispatchMouseEvent` passes
   through iframes and shadow roots transparently. If you can see it in a screenshot, click
   its page coordinates.
2. Same-origin iframe (DOM access works):
   `Runtime.evaluate` with `document.querySelector('iframe#inner').contentDocument.querySelector('h1').textContent`.
3. Cross-origin OOPIF (stripe, recaptcha, Salesforce): find it with
   `list_targets` (it appears as a separate `iframe` target), then
   `select_target { "targetId": "<iframe-target>" }`, enable the needed
   domain, and run `Runtime.evaluate`/`DOM.*` inside it. Switch back to the parent target
   when done.
4. Frame-local coordinates: `getBoundingClientRect()` inside an iframe is iframe-local.
   Add the iframe's own rect to get page coordinates for a click.
5. Shadow DOM:
   - Prefer coordinate clicks.
   - DOM path: `DOM.querySelector` with the `>>>` shadow-piercing combinator, or
     `Runtime.evaluate` with a recursive `shadowRoot` walk returning the element center.
   - Setting a value inside a shadow input: set `.value` and dispatch
     `new Event('input', { bubbles: true, composed: true })`.

## Operations used

- `list_targets`, `select_target`,
  `execute_cdp` (`Runtime.evaluate`, `DOM.*`, `Input.dispatchMouseEvent`).

## Traps

- OOPIFs are often lazy-mounted until you interact with the outer element; re-query
  `list_targets` after focusing.
- OOPIF targets disappear when the parent navigates — cached target ids go stale.
- Always switch back to the parent target after using an iframe target, or your next
  navigation goes into the frame.
- Closed shadow roots cannot be walked from JavaScript; fall back to coordinate clicks.

## Verification

The value or screenshot obtained inside the frame/shadow root matches the visible page,
and `get_browser_status` shows the parent as the active target when finished.
