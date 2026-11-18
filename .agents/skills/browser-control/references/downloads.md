# Browser Downloads and Cookies

Let the browser write downloads to a directory you own, and manage cookies for the
attached session.

## Prerequisites

- An active connection and selected target (see `session.md`).

## Workflow

1. Choose an absolute destination directory and ensure it exists (create it with your file
   tools first — Chrome silently drops downloads otherwise).
2. Route downloads (browser-scoped, set once):
   `execute_cdp { "method": "Browser.setDownloadBehavior", "params": { "behavior": "allow", "downloadPath": "/abs/dir", "eventsEnabled": true } }`.
3. Trigger the download, then detect start and completion:
   - `wait_for_event { "method": "Browser.downloadWillBegin", "timeoutMs": 10000 }`
     → `guid`, `suggestedFilename`, `url`.
   - `wait_for_event { "method": "Browser.downloadProgress", "match": { "state": "completed" }, "timeoutMs": 60000 }`.
4. If the "download" is just an in-page PDF viewer, there is no download event — use
   `capture_pdf` instead.
5. Cookies:
   - Page-scoped: `Runtime`/`Network.getCookies` via `execute_cdp { "method": "Network.getCookies", "params": { "urls": ["https://example.com/"] } }`.
   - Whole browser: `execute_cdp { "method": "Storage.getCookies" }`.
   - Write: `Network.setCookie` / `Network.setCookies`; `expires` is in **seconds**.
   - Delete: `Network.deleteCookies`; `Storage.clearDataForOrigin` for storage beyond cookies.

## Operations used

- `execute_cdp` (`Browser.setDownloadBehavior`, `Network.getCookies`,
  `Network.setCookie`, `Network.setCookies`, `Network.deleteCookies`, `Storage.*`),
  `wait_for_event`, `read_events`.

## Traps

- `setDownloadBehavior` is browser-scoped, not per tab.
- Files arrive under the browser's suggested filename; rename after completion.
- `Network.setCookie` can return success while silently doing nothing if the domain does
  not match; verify with `getCookies`.
- Cookie `sameSite: "None"` requires `secure: true`.

## Verification

The file exists in the destination directory with non-zero size, or the cookie appears in a
follow-up `getCookies` call.
