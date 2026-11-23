# Wave-1 hooks for the extension.ts integrator

Hooks reported by wave-1 agents that touch files they did not own. Apply all of them. Line numbers are approximate; they come from before D1 edited `extension.ts`.

## D3: internal rows and labels

Import `internalToolOf` from `./runtime/toolDisplay` and `unifyHome` from `./unify/settings`.

Places object, reused at every site:

```ts
const places = {
	dataHome: unifyHome(),
	projectRoots: [chat.mirror.cwd],
	globalVault: this.memorySettings().global,
};
```

- **postTool (~1991):** add `internal: internalToolOf({ tool: title, input: detail }, places)` to the posted tool event.
- **runBatch children (~2644):** each child gets `internal: internalToolOf({ tool: call.tool, input: call.args }, places)`.
- **Runtime tool update (~3729):** `internal: internalToolOf({ tool: title, input: update.rawInput ?? detail }, places)`.
- **Subagent tool (~3345):** `tool: { ...displayTool(title, detail), internal: internalToolOf({ tool: title, input: detail }, places) }`.
- **postSubagent tool (~2000):** same pattern on `split[1]` / `split[2]`.

Dot-free labels:

- **874:** `` `${model.name} with ${this.cursorAccount.label}` ``
- **880:** `` `${model.name} with ${account?.label || 'no account'}` ``
- **885:** `` `${model.name} with ${account?.label || 'no account'} on ${model.provider}` ``
- **2923:** `` `Smart Auto picked ${rankLabel(pick)}${decision.reason ? ` because ${decision.reason}` : ''}` ``
- **3301:** `model: entry.name` (plain), plus `effort: profile.effort` and `speed` as separate fields. `SidebarSubagent.effort` and `speed` now exist in `view.ts`; also pass them through `subagentEvent` and the store merge.
- **3497:** `label: model.name, description: model.provider, detail: model.backend`
- **3656:** `` summary: item.fromPath ? `Rename from ${item.fromPath}` : item.base === undefined ? 'Create' : item.proposed === undefined ? 'Delete' : `${item.hunks.length} hunk${item.hunks.length === 1 ? '' : 's'}` ``

## D2: explorer ranges (line numbers from after D1)

1. Import `SidebarExplorerRange` from `./sidebar/view`, and `{ explorerPromptNote, parseExplorerRanges, formatExplorerRanges }` from `./runtime/explorer`.
2. Add `profile?`, `ranges?` and `tokens?` to the type of `post` (~3485).
3. `const explorerNote = explorer ? explorerPromptNote() : ''` (~3503), appended to the explorer's prompt.
4. The running post gets `...(explorer ? { profile: 'explorer' } : {})`.
5. `let explorerTokens = 0` (~3510). Add the usage sum in the explorer `onUsage` branch.
6. At completion (~3650):
   ```ts
   const parsed = explorer
   	? parseExplorerRanges(reply.slice(reportStart).trim())
   	: { text: reply.slice(reportStart).trim(), ranges: [] };
   post({ state: 'complete', ...(explorer ? { ranges: parsed.ranges, tokens: explorerTokens } : {}) });
   ```
   Use `parsed.text` as the report and append `formatExplorerRanges(parsed.ranges)` to the `delegate_task` result.
7. `package.json` `build:test`: add `src/engine/runtime/rangeEdit.ts` (package.json belongs to D5; the main agent applies this one).

## D4: requests context (`handleUnifyRequest`, ~4249)

```ts
{
	workspaceRoot: folder?.uri.fsPath,
	workspaceRoots: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath),
	refreshModelState: () => this.refreshModels(),
	refreshUsageState: id => this.refreshUsage(true, id),
	refreshToolpacks: () => this.postToolpacks(),
	openExternal: url => vscode.env.openExternal(vscode.Uri.parse(url)),
	getGithubAuth, // from './unify/github'
}
```

Check that each method exists under that name; adapt to the real one. `ToolpackRegistry` has no rescan API, so after a Hub install, reload or add the installed pack before `postToolpacks()` so it shows up.

## D1: media leftovers

- `delegateServer.ts` `/inbox` is text-only. Background subagent images rely on `withPendingParentMedia`; any non-MCP inbox delivery must append the image blocks too.
- `delegate/messaging.ts` is text-only; agent messages carrying media must pass the image blocks through.
- `runtime/oauthCli.ts`: Claude `tool_result` images have no `onTool` image parameter. (oauthCli belongs to D7 this round; list the exact change for the rename-B agent instead of making it.)
- Test fixtures build the host with `Object.create(ExtensionHost.prototype)`, which skips class fields. Make every new field access (`pendingParentMedia`, `media`, `power`, …) safe on such a host (lazy getter or optional access), so those tests pass.

## O2 / O3: screen backends

- `undoKnowledgeChange { id }` (see `src/renderer/screens/knowledge/protocol-requests.md`): restore the previous version of the item and reply with a fresh `knowledgeState`. Keep one previous version per item when an agent edits it.
- `KnowledgeItem.updatedBy` = the editing agent's display name when an agent writes through the knowledge tools, `'you'` for the user.
- GitHub: `githubRefresh`, `githubSetToken { token }`, `githubSignOut` → call `getGithubAuth` / `setGithubToken` / `clearGithubToken` from `./unify/github`, and set `viewState.github = { signedIn, login, source, error }` (error = the thrown message for a bad token). Subscribe to `onGithubAuthChange` once and dispose it.
- Power: `viewState.shutdown` from `shutdownController.getStatus()`; `shutdownFailed` carries `error`.

## D7 rename A leftovers (for rename pass C)
- build:test must emit `src/engine/unify/media/store.ts` (test/chat-state imports `dist/unify/media/store.mjs`); also `runtime/rangeEdit.ts`.
- `roots.unifyHome`: `extension.ts` ~1661/1665 still passes `dshHome`; switch, then drop aliases in `instructions/store.ts`, `instructions/share.ts`, `sync/configSync.ts`, `runtime/acp.ts`.
- Settings section: `extension.ts` + `package.json` still register/read `dsh.*`; remove dual-read fallbacks (`runtime/shadow.ts:101`, `sync/controller.ts:152`), update `test/config-sync.test.mjs:70` to strip `unify.`.
- MCP server name `unify`: `extension.ts:198`, `extension.ts:2748`, `mcp/delegateServer.ts:287`, `runtime/toolDisplay.ts:82`, `runtime/delegation.ts:20`.
- Review scheme: `extension.ts:1475` passes `'dsh-review'`; default is now `unify-review`.
- ACP route: `extension.ts:1135` passes `dshRoot`; switch to `agentRuntimeRoot`.

## Wave-2 findings (explorers / Sol S2) — queue for Deepseek once locks free
- `runtime/batch.ts` strips tool names like `read_file` to `file` (3 batch tests fail). Fix normalization.
- `unify/media/store.ts`: `release()` removes the last index entry before `sweep()` can delete its file.
- `build:test` entries: `unify/media/store.ts`, `runtime/rangeEdit.ts`; drop `update/extensionUpdate.ts` entry once D8 deletes it.
- Usage: `accounts/usageService.ts:46-53` reads only Claude/Codex/DeepSeek/OpenRouter/Cursor. Add Mistral/self-hosted where possible; OpenCode Go usage via browser sign-in is MISSING.
- Knowledge audience scoping: `instructions/` has no audience filter; delegation/main-only rules must not reach subagents. `knowledge.audiences` is engine-scoped but only renderer reads it.
- `chats.layoutPicker` not read (shell/PaneGrid drag → LayoutPicker). Give to renderer owner after W3a.


## D8 integrator leftovers
- package.json `build:test`: remove `src/engine/update/extensionUpdate.ts`; add `runtime/rangeEdit.ts`, `unify/media/store.ts` (+ new tests' entries). `test/run.mjs`: remove `./extension-update.test.mjs` import. (Locked by D5 until it finishes.)
- Renderer store: merge `effort`/`speed` from subagentEvent; add a host→store `githubState` message for live GitHub updates (`viewState.github` is boot-only now).

## Wave-2 small leftovers
- `unify/requests/providers.ts:55-59` and `setup.ts:109` still read `dsh.*` globalState keys; switch to `unify.*` (test/unify-requests.test.mjs already updated, 2 fails until then). Rename C may cover it.
- O5 hooks: AccountPage ~229 ModelPicker (`<ModelPicker class="pv-default-model" variant="regular" value={defaultModel() ?? ''} onChange={id => setAccountDefaultModel(account().id, id)} smartAuto={false} noneLabel="None" modelIds={models().map(m => m.id)} disabled={!models().length} placement="bottom-start" />`); SettingsScreen decider/rank/subagent selects → ModelPicker (variant="regular", smartAuto={false}, placement="bottom-end"), drop local `modelOptions`. models.ts effort/speed options optional `modelId`. `.composer-send` flex:none. Move `screens/hub/Segmented` to components.
## Review findings (Opus Low) still open
- `edit_range` (mcp/delegateServer.ts:117-150) writes files from the MCP child: must route through the extension's edit path (review, read-only guards, subagent scope) and realpath containment; subagents (toolpacksOnly) must get it too. Needs mcp/ + extension.ts (after rename C).
- `unify/requests/knowledge.ts:669-675` open-skill: look up via listInstructions, only open folders. `:594-600` delete: folder must be strictly inside a root. `:353-359` undo id path check. (after rename C)
- Power monitor (extension.ts:559-571): count process registry, goal runner, batch jobs, queued messages. Shutdown viewState (extension.ts:376,4082): update viewState in the power post callback. (after rename C)
- Hub install script consent: engine returns `needsScriptConsent` + script text; Hub UI must show it and re-send with consent (renderer hook after W3b).
- Platform review (after rename D frees src/main): mediaProtocol.ts:17 NOT_FOUND shared Response → factory; :28/:69 serve non-raster/video as octet-stream + attachment, add nosniff + CSP sandbox; updater.ts:96-100 listeners re-added on restart (one-time flag); skip updater on darwin unsigned. Release repo private + no token → update checks always fail (report to user).
- Rename: NO DSH compatibility (TODO.md §rename: "user migrates old data themselves"). Do not add migration code. Remove any legacy dsh readers that were added (share.ts/sync legacy marker/paths, modelRegistry `dsh.models.v1` migration) after their agents finish.
- extension.ts:531/:624 call `unbindChatAgentOwner(chat.ownerId)` on chat unload; :1438 bus state running/idle per turn.
- Renderer organic (after Cursor2): lift.ts:120-128 claim a new ticket when re-moving after drop; EditedLines.tsx:78 track release timer, release ticket onCleanup.
- Store: handle `agentMessage`, `agentRoster` (check `unifyFeaturesState` done).
- Engine imports `electron` directly (~extension.ts:525) — check if still true.
- Internal rows extension.ts call sites: subagent title split regex `^(\S+)(?::\s*|\s+)(.*)$` (~2113, Windows drive colon); pass raw args not display detail (~2106, ~3514, like ~3928); build `places` once per chat with all roots incl. shadow worktrees, realpath dataHome/roots (~2095, 2756, 3461, 3866). internalRows.ts itself → Deepseek.
- Audience (Deepseek done: unify/knowledgeAudience.ts, instructions/audiences.ts): build:test add both files; run.mjs add `./knowledge-audience.test.mjs`; extension.ts ensureRuntime gets target `{kind:'main'}` / `{kind:'subagent', profile}` (~1057/1110, subagent ~3562), per-owner instruction home (~1107 shared now), call `writeAudienceInstructions({ unifyHome: unifyHome(), workspace: cwd }, target, instructionsHome, { fileName: 'AGENTS.audience.md' })` before runtime.start; runtime/acp.ts:110 agent-instructions → that home with `instructionFileCandidates: ["AGENTS.audience.md"]`, `localInstructionFileCandidates: []`. CLI/OAuth subagents (~3541/3558) share CLAUDE.md: still unscoped (report as limitation).

- Fixture tip: `__unifyMock.emit({ type: 'setupState', complete: true })` dismisses the setup wizard in captures.
