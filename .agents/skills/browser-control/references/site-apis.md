# Use the Site's Own API

When the task is "get the data", clicking through pages is the slow way. A signed-in tab can
call the site's JSON API with the user's session from `eval`: one call returns what many
page loads would.

## Prerequisites

- A selected tab on the site, already signed in. Read-only requests (`GET`) only, unless the
  user approved a specific change (`safety.md`).

## Workflow

1. Find the endpoint. Either you know it (below), or watch one page load:
   `Network.enable`, do the action once, then `read_events` for `Network.requestWillBeSent`
   and look for `fetch`/`XHR` requests that return JSON (`network.md`).
2. Call it from the page, so cookies and origin are right, and return only what you need:
   ```bash
   $BCD eval - <<'JS'
   const r = await fetch('/api/…?limit=50', { headers: { Accept: 'application/json' } });
   const j = await r.json();
   JSON.stringify(j.items.map(({ id, name }) => ({ id, name })))
   JS
   ```
3. Page through results in the same `eval` (a loop over offsets) and stop at a sane cap.
   Pause between pages on rate-limited sites.

## ServiceNow

The Table API works from any signed-in instance tab. The session token is `window.g_ck`:

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

- Always pass `sysparm_fields` and `sysparm_limit`; a bare table read can return megabytes.
- In the classic UI the form lives in the `gsft_main` iframe, but `/api/now/…` is same-origin
  and can be called from the top page.
- `g_ck` is undefined on some workspace pages: read it from the `gsft_main` frame, or open
  any classic list in the tab first.
- A 401 or 403 means the session expired or the user lacks the role. Tell the user; do not
  try other accounts or endpoints.

## Traps

- Never print or store tokens, cookies or `g_ck`. Use them inside the `eval` only.
- An API can change data as easily as read it. `POST`, `PUT`, `PATCH` and `DELETE` are
  mutations and need the same approval as the button they replace.
- Internal endpoints change without notice. If a call starts failing, fall back to the UI.

## Verification

Spot-check one returned row against what the page shows.
