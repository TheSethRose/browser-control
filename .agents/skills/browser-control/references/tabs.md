# Browser Tabs

Manage browser targets (tabs) and control which one receives calls.

## Prerequisites

- An active `browser-control` connection and a selected target (see `session.md`).

## Workflow

1. Inspect: `tabs` (or `list_targets` with `{ "types": ["page"] }` for full detail).
2. Switch routing to an existing tab: `select_target { "targetId": "<id>" }`.
3. Create a tab:
   - `execute_cdp { "method": "Target.createTarget", "params": { "url": "about:blank", "background": true } }`,
     then `nav <url> <targetId>` (operation `navigate`), which waits for the load event.
     `select_target` it if later calls should go there by default.
   - Passing a real `url` to `createTarget` can resolve before navigation starts; prefer
     `about:blank` plus `nav`.
4. Bring a tab to the foreground (routing alone is invisible):
   `execute_cdp { "method": "Target.activateTarget", "params": { "targetId": "<id>" } }`.
5. Close a tab: `execute_cdp { "method": "Target.closeTarget", "params": { "targetId": "<id>" } }`.
   If it was the active route, call `clear_target`.

## Operations used

- `list_targets`, `select_target`,
  `clear_target`, `execute_cdp`
  (`Target.createTarget`, `Target.activateTarget`, `Target.closeTarget`, `Page.navigate`),
  `wait_for_event`.

## Traps

- `select_target` is CDP routing; `Target.activateTarget` is visible focus. They are
  independent — call both when the user expects to see a change.
- A new tab may open behind the active one.
- After closing the selected tab, calls fail with `NO_ACTIVE_TARGET`; select another.

## Verification

After creating a tab, `list_targets` shows it; after `select_target`, a `Runtime.evaluate`
of `location.href` reflects the intended tab.
