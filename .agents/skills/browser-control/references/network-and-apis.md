# Network, Site APIs, Downloads, and Cookies

Observe or mock traffic, query a site's own JSON API, manage downloads, and inspect cookies.

## 1. Network observation and mocking

Action receipts (`click`, `type`, `select`, `do`) automatically append passive same-origin 4xx/5xx HTTP errors and uncaught JS exceptions (status and path only — no headers, bodies, or cookies). Enable CDP `Network` or `Fetch` only when you need full bodies, headers, timing, or mocking.

1. **Arm before the action:** `call execute_cdp '{"method":"Network.enable"}'`. Drain stale events first: `call read_events '{"method":"Network.responseReceived"}' >/dev/null`.
2. **Wait for a response:**
   ```bash
   $BCD call wait_for_event '{"method":"Network.responseReceived","match":{"type":"Fetch"},"timeoutMs":15000}' > /tmp/resp.json &
   $BCD click e9; wait
   ```
   Match on `type` (`XHR`/`Fetch`), status, or URL substring. `wait_for_event` returns `found:false` on timeout.
3. **Read a body immediately** (before eviction):
   `call execute_cdp '{"method":"Network.getResponseBody","params":{"requestId":"<id>"}}'` (decode base64 if `base64Encoded:true`).
4. **Trace requests / POST payloads:** `read_events { "method": "Network.requestWillBeSent", "limit": 20 }` → `params.request.postData` (or `Network.getRequestPostData` for large bodies).
5. **Intercept / mock (test targets or user-owned sites only):**
   - `Fetch.enable { "patterns": [{ "urlPattern": "*/api/*", "requestStage": "Response" }] }`
   - Poll `read_events { "method": "Fetch.requestPaused" }`.
   - Answer with `Fetch.fulfillRequest`, `Fetch.continueRequest`, or `Fetch.failRequest`.
   - Always call `Fetch.disable` afterwards (interception disables HTTP cache for matched URLs). Note any mocked responses in your report.
- **Traps:** Domains and `requestId`s are per target (re-enable on OOPIFs). Mask tokens/passwords in headers and bodies before printing. Replaying an authenticated request carries the user's cookies and needs the same approval as a click.

## 2. Use the site's own JSON API (bulk reads)

When extracting structured data from a signed-in tab, one `fetch` in `eval` beats paginating the UI:

```bash
$BCD eval - <<'JS'
const r = await fetch('/api/items?limit=50', { headers: { Accept: 'application/json' } });
const j = await r.json();
JSON.stringify(j.items.map(({ id, name }) => ({ id, name })))
JS
```

- Read-only (`GET`) unless the user approved a mutation (`POST`/`PUT`/`PATCH`/`DELETE` need the same approval as clicking a submit button).
- Cap pagination loops and pause on rate-limited sites. Spot-check one row against the visible page.

### ServiceNow Table API

Works from any signed-in ServiceNow tab using `window.g_ck`:

```bash
$BCD eval - <<'JS'
const q = new URLSearchParams({
  sysparm_query: 'active=true^assigned_to=javascript:gs.getUserID()',
  sysparm_fields: 'number,short_description,state,sys_updated_on',
  sysparm_display_value: 'true',
  sysparm_limit: '50',
});
const r = await fetch(`/api/now/table/incident?${q}`, { headers: { Accept: 'application/json', 'X-UserToken': window.g_ck } });
r.ok ? JSON.stringify((await r.json()).result) : `HTTP ${r.status}`
JS
```

- Always set `sysparm_fields` and `sysparm_limit`.
- In classic UI, forms live in `gsft_main`, but `/api/now/…` is same-origin from the top page. If `g_ck` is undefined in a workspace, read it from `gsft_main` or open a classic list first.
- Never print `g_ck`, tokens, or cookies. On 401/403, tell the user and stop.

## 3. Downloads

1. Ensure the absolute destination folder exists first (Chrome silently drops downloads into missing folders).
2. Set browser-scoped download routing once:
   `call execute_cdp '{"method":"Browser.setDownloadBehavior","params":{"behavior":"allow","downloadPath":"/abs/dir","eventsEnabled":true}}'`
3. Trigger the download, then wait for start and completion:
   - `wait_for_event { "method": "Browser.downloadWillBegin", "timeoutMs": 10000 }` → `guid`, `suggestedFilename`.
   - `wait_for_event { "method": "Browser.downloadProgress", "match": { "state": "completed" }, "timeoutMs": 60000 }`.
4. Wait for `completed` (a file on disk may still be partial). Never execute untrusted downloads. For an in-page PDF viewer, there is no download event — use `capture_pdf` (`visual-and-picture.md`).

## 4. Cookies

- **Read (origin-scoped preferred):** `Network.getCookies { "urls": ["https://example.com/"] }`. Avoid `Storage.getCookies` unless truly needed (it exposes every signed-in site).
- **Write:** `Network.setCookie` / `Network.setCookies` (`expires` is Unix **seconds**; `sameSite:"None"` requires `secure:true`; verify with `getCookies` since domain mismatches silently no-op).
- **Delete:** `Network.deleteCookies` by exact name, domain, and path. Ask before broad `Storage.clearDataForOrigin` (signs the user out).
- **Security:** Cookies are credentials — report names and flags, never values.
