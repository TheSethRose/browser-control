# End-to-end run

`bun run test:e2e` drives headless Chrome for Testing with the unpacked `extension/`, through the real
skill wrapper (`.agents/skills/browser-control/scripts/browser-control-daemon`) and daemon, against
local fixture pages in `fixtures/`.

It covers shadow DOM, two cross-origin iframes with the same URL (each input typed and read back),
a file input, a `target="_blank"` popup, `alert` and `confirm` (accept and dismiss), a hash link, a
simulated Cloudflare/Turnstile challenge (`CHALLENGE:` output), `handoff` (timeout clears the card;
a person can still focus and type into a page input while the card is showing, then a trusted click
on Continue returns `handoff: done`), restricted `chrome://` pages (refuses with `EXTENSION_ONLY`
without touching CDP, and closes any newly created tab so the tab count stays unchanged), `close`
(closes an agent-opened tab), `extension disable`/`enable`, and stale extension handshake reporting.

- Finds Chrome for Testing in `~/.cache/puppeteer`, `~/.cache/browser-control/cft`, or
  `~/.cache/ms-playwright`; set `BC_E2E_CHROME=<binary>` to choose one. If none is found it prints
  `SKIP` and exits 0.
- Every launch uses `--use-mock-keychain --password-store=basic` and a throwaway profile. Fixture
  servers use free ports; the daemon, config and profile live in one temp dir that is removed after.
- Uses the committed skill runtime. Run `bun run build:skill` first if `src/` changed.
- Not part of `bun test` or CI: `run.ts` is not a `*.test.ts` file.
- Prints `PASS`/`FAIL` per check and a `SUMMARY` line; exits nonzero on any failure.
