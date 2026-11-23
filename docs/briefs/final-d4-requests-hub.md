# D4: screen request gaps + Hub publishing rules (Deepseek)

Read `docs/briefs/final-common.md` first and follow it.

## Context
`src/engine/unify/requests/` answers the screens' data requests, through the `handleUnifyRequest(message, reply, context)` dispatcher in `index.ts`. `src/engine/hub/` is the Hub backend. Both were built last round. Read `docs/briefs/ds-screen-data-requests-hub-backend.md` for what they were meant to do, and each screen's `protocol-requests.md` under `src/renderer/screens/*/` for the messages the screens send.

## Task
Close the gaps that round's report left open:
1. `setModelEnabled` must rebuild and push `modelState`. Find how `extension.ts` builds it. If you need something from the extension, add it to the `context` object that `handleUnifyRequest` receives, and write the matching `extension.ts` change as a hook.
2. `signOutAccount` must push `usageState`. Same approach as item 1.
3. `openProviderUsage`: handle it. It opens the provider's usage page in the browser (the URLs DSH already knows for `viewProviderUsage`).
4. Check that the other 4 messages in `src/renderer/screens/providers/protocol-requests.md` (`renameAccount`, `setAccountDefaultModel`, and so on) are handled, and fill any gaps.
5. The final `toolpacksState` of a Hub install must come from the extension's real toolpack list. Use a context callback, as in item 1.
6. Knowledge import must copy the files (skill folders included) into the right knowledge location, not just count them.
7. The file watcher must:
   - support several project roots;
   - honour `.gitignore` at each root (use what the engine already has; if there's nothing, a small parser covering the common patterns is fine);
   - always skip `node_modules`, `.git` and the data folder.
8. Hub publishing rules (user decision):
   - Only allowlisted GitHub accounts may publish. For now that's just `raisinhvh`.
   - The registry repo `raisinhvh/unify-hub` will hold a `publishers.json` (`{ "publishers": ["raisinhvh"] }`).
   - `githubRegistry` publish reads that file. It also needs the signed-in login, from the contract below. If the login isn't listed, publish refuses with the message "Publishing is limited to approved accounts."
   - The fake/local registry applies the same check, using a fixture `publishers.json`.
   - Read-only browsing and installing stay open to everyone.
9. GitHub auth contract. Another agent is writing `src/engine/unify/github.ts`; import from it and don't write it yourself:
   ```ts
   export interface GithubAuth { token: string; login: string; source: 'gh' | 'token' }
   export async function getGithubAuth(): Promise<GithubAuth | undefined>;
   ```
   Until it exists, your build will fail on the import. To avoid that, take auth through a `context.getGithubAuth` callback, and put the `extension.ts` wiring under "Hooks for other owners".
10. Paths: Knowledge and Hub data live under `unifyHome()` (from `src/engine/unify/settings.ts`), not `~/.dsh`. Fix any `~/.dsh` paths in your folders (`unify/requests/state.ts` 34, for example).

## Files you own
- `src/engine/unify/requests/`
- `src/engine/hub/`

## Reference for style
`src/engine/unify/requests/index.ts`.

## Extra checks
- `npm run build` prints BUILD_OK.
- `npm test`: the `hub` and `unify-requests` tests still pass. Report the totals.
- In your report, list the new behaviours for the test agent.
