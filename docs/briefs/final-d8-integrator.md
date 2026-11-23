# D8: extension.ts integrator (Deepseek)

Read `docs/briefs/final-common.md` first and follow it. Then read `TODO.md` §3 "Wiring" and `docs/briefs/hooks-wave1.md` (every hook there is yours unless it says otherwise).

## You own (edit only these)
- `src/engine/extension.ts`
- `src/engine/sidebar/provider.ts`
- `src/engine/delegate/`
- `src/engine/mcp/`
- `src/engine/unify/requests/`
- `src/engine/unify/power.ts`, `src/engine/unify/power/`
- delete `src/engine/update/extensionUpdate.ts` and `test/extension-update.test.mjs`

Don't rename DSH names in this pass (another agent does that later), except where you delete code anyway.

## Task
1. Apply every hook in `docs/briefs/hooks-wave1.md` (D3 labels/internal rows, D2 explorer ranges, D4 requests context, D1 media leftovers, O2/O3 screen backends).
2. **Messaging:** `bindChatAgentOwner(chat.ownerId, chatId)` when a top-level agent registers; in `runSubagentCore`, `registerSubagentAgent({ id: agentId, owner, name, task, chatId: chat.record.id, parentId: chat.record.id })`, then `setSubagentState` at its state changes and `unregisterSubagentAgent(agentId)` in its `finally`. Helpers are in `src/engine/delegate/messaging.ts`. Check first whether some of this already exists.
3. **Power:** create the shutdown controller once on activation (see the wiring comment at the top of `src/engine/unify/power.ts`), dispose it via subscriptions. Activity counts from chats, subagents, approvals, questions and processes; `saveState`; `notify` through `vscode.env.notify` (check the shim for the exact API). Route `cancelShutdown` and the arm toggle. Post `shutdownArmed`, `shutdownCountdown`, `shutdownCancelled`, `shutdownWaiting`, `shutdownFailed { error }`, and put `getStatus()` in `viewState.shutdown`.
4. **Notifications:** wherever the engine imports or requires `electron` for notifications, switch to `vscode.env.notify` so the engine stays host-agnostic.
5. **Native agents:** at the native-agent refusal (~3708 before edits), only refuse when `agents.blockNativeAgents` is on.
6. **Remove the VSIX self-updater:** delete `update/extensionUpdate.ts`, its import and all its uses in `extension.ts` (~614–740), and its test. The `$(hubot)` status bar item goes too (`this.status`, ~362 and ~537), with everything that only fed it. The agent-runtime package updater (`update/dshUpdate.ts`) stays.
7. **GitHub:** handle `githubRefresh` / `githubSetToken` / `githubSignOut` and set `viewState.github` (see hooks file).
8. **Editor bridge:** the platform agent (D5) is adding `editorState` / `editorOpen` / `editorDiff` support in the shim. Look in `src/shim/` for what it exposes. If the shim needs the engine to forward `editorState` from the webview, or the engine to post `editorOpen`/`editorDiff`, wire that here. If D5's side isn't there yet, report exactly what is missing.

## Reference for style
`extension.ts` itself (2-space indent there; match each file you edit).

## Verify
- `npm run build` prints BUILD_OK.
- `npm test`: report the totals and every failing test name. Fix failures caused by your files. Leave test-file fixes to the test agent, but list them.
- `rg -n "extensionUpdate|hubot" src test` returns nothing.
- Report: what you wired (file:line), what you couldn't, hooks for other owners (package.json `build:test` entries go there).
