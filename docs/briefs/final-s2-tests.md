# S2: tests for wave-1 engine work (Sol)

Read `docs/briefs/final-common.md` (checks, style). You write tests only; never change `src/`.

## You own
- `test/` (new and existing `*.test.mjs`, `test/run.mjs`). Don't touch `test/extension-update.test.mjs`; the integrator deletes it.

## Task
1. **Register** in `test/run.mjs` any suite not run yet: `agent-bus`, `power`, `hub`, `unify-requests`, `internal-rows`, plus the new ones below.
2. **Fix stale tests:**
   - `test/hub.test.mjs:80` expects `hubState.error` on publish; publish now replies `{ type: 'hubPublishResult', ok, message }`. Cover: no auth → "Sign in to GitHub to publish.", unlisted login → "Publishing is limited to approved accounts.", approved login.
   - `test/chat-state.test.mjs:514` expects uploads in `<storage>/attachments`; uploads now go to the media store (`docs/contracts/media.md`, `src/engine/unify/media/`). Assert the media store behaviour instead.
   - Fixtures that build the host with `Object.create(ExtensionHost.prototype)` skip class fields (`pendingParentMedia`, `media`): set them in the fixture (`pendingParentMedia: new Map()`, a stub media store) so batch/checkpoint/delete/upload tests pass.
   - `test/claude-args.test.mjs` reads the real settings file; point it at a temp `UNIFY_HOME`.
   - Check `features.test.mjs` (`runSubagents` missing) and `claude-usage.test.mjs`: fix the test if the source changed on purpose; if the source looks wrong, report it instead.
3. **New tests:**
   - `runtime/rangeEdit.ts`: stale `expected` fails with current lines, moved lines re-anchor (unique only), ambiguous fails, overlapping ranges merge, CRLF preserved, past-end.
   - `runtime/explorer.ts`: `parseExplorerRanges` merge, first `why`, cap 12, malformed block dropped, no block = answer unchanged; `formatExplorerRanges`.
   - `runtime/batch.ts` `read_file` with `ranges`: context lines, merged parts, header format, toggle `tools.rangeEdits` off → error; no-range output unchanged.
   - `unify/media/store.ts` (`DiskMediaStore`, in a temp dir): dedupe, refs, release keeps shared file, last release deletes, sweep, `isMediaHash`; `shown.ts` tracker: repeated sha256 skipped, a new image still sent.
   - `unify/github.ts`: token path with a stubbed `fetch` (valid → login, invalid → clear error, token never logged), `gh` missing → fallback. Don't call the real network or real `gh`.
   - `unify/requests/` hub publish allowlist (`fixtures/publishers.json`).
4. Other agents are editing `src/` now; if a test fails because of code mid-edit, rerun later and report what still fails.

## Reference for style
`test/internal-rows.test.mjs`.

## Verify
`npm test` totals, list of every remaining failure with the reason.
