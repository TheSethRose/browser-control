# Browser Network

Use `Network.*` to observe traffic; use `Fetch.*` to intercept and rewrite it.

## Prerequisites

- An active connection and selected target. Enable the domain **before** the action that
  triggers traffic: `execute_cdp { "method": "Network.enable" }`.

## Workflow

1. Wait for a specific response:
   `wait_for_event { "method": "Network.responseReceived", "match": { "response": { "status": 200 } }, "timeoutMs": 10000 }`,
   triggering the action concurrently. The event carries `requestId`.
2. Read a body (only right after the response):
   `execute_cdp { "method": "Network.getResponseBody", "params": { "requestId": "<id>" } }`
   → decode `body` if `base64Encoded`.
3. Trace requests after the fact: run the action, then
   `read_events { "method": "Network.requestWillBeSent" }`.
4. Capture a POST body: `params.request.postData`, or
   `Network.getRequestPostData` for large bodies.
5. Intercept/modify/mock:
   - `execute_cdp { "method": "Fetch.enable", "params": { "patterns": [{ "urlPattern": "*/api/*", "requestStage": "Response" }] } }`
   - Detect `Fetch.requestPaused` with `read_events`.
   - Respond with `Fetch.fulfillRequest` (mock), `Fetch.continueRequest` (pass/modify), or
     `Fetch.failRequest` (simulate error).
   - Disable with `Fetch.disable` when done; it disables the HTTP cache for matched URLs.

## Operations used

- `execute_cdp` (`Network.*`, `Fetch.*`),
  `wait_for_event`, `read_events`.

## Traps

- `Network.enable` must precede the request; enabling after the click misses it.
- Domains are per-target; after switching to an OOPIF target, enable again.
- Request ids are per target — do not reuse one across targets.
- Response bodies may be unavailable (redirects, cache, evicted); read immediately.
- `wait_for_event` rejects only on connection loss; a non-matching state yields
  `found: false`.
- Network events are large. Pass `method` and a small `limit` to `read_events`.
- `wait_for_event` checks the buffer first, so an old event can satisfy it. Drain the method
  with `read_events` before arming the wait, and match on something specific (`type`, the
  status, or part of the URL), not "the next response".
- Interception turns off the HTTP cache for matched URLs, which changes timing. Always
  `Fetch.disable` afterwards, and say in the report which responses were mocked: a mocked
  result tests the page, not the real service.
- Mock only on pages the user owns or a test target.
- Replaying a captured request carries the user's cookies, so it is an authenticated action.
  It needs the same approval as a click, and anti-abuse systems watch for it.
- Headers and bodies can hold tokens or passwords. Mask them before they reach output.

## Verification

The event log contains the expected method/status, or the mocked response is reflected in
the page.
