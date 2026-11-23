# Unify — open work (as of 2026-11-23, night)

Pick-up notes for the next session, started **inside this Unify folder**.

## User decisions (2026-11-23, final session; user is away, don't re-ask)
- **Delegation caps:** Deepseek for scoped grunt work (max 8 at once); all Deepseek work gets reviewed at the end by Opus Low. Opus for anything user-facing: GUI, animation (max 3). Sol writes tests (max 1).
- **Git:** commit on `master`, a first commit once it typechecks, then a checkpoint commit after each phase. Local only, never push the Unify repo.
- **Allowed unattended:** real provider chat tests via `run.cmd`; deleting the `%TEMP%` unify folders; deleting the old DSH mockups (`DSH/.dsh/briefs-tmp/`, `DSH/.dsh/mockups/unify-a…e`, `unify-logo/tmp`, `usage/`). **Real shutdown test: no.** The user will test it with you afterwards.
- **GitHub sign-in:** make it work through `gh auth token` when the GitHub CLI is signed in, with a pasted personal access token in Settings as the fallback. No device flow.
- **VSIX self-updater:** drop it. It has no purpose in Unify. The agent-runtime package updater stays.
- **Editor stubs:** back them with the Files editor. `vscode.diff` opens a Monaco diff in the Files editor; `activeTextEditor` / `tabGroups` mirror the file open there, so agents get current-file context.
- **Packaging:** Windows only for now (NSIS + portable). Keep the mac config working and mac-ready (no Windows-only assumptions in paths, menus or shortcuts), but leave it untested.
- **Hub repo:** create the public `raisinhvh/unify-hub` and publish the toolpacks installed on this PC. Scan each one first for secrets, tokens, emails and absolute user paths, and leave out (and list) anything flagged. Only the user's GitHub account (`raisinhvh`) may publish to it: branch protection or a CODEOWNERS/allowlist check, plus a Hub-side publisher allowlist.
- **"Red notification at the top" = the Unify app's DSH-style rounded-pill notice at the top of the UI.** It looks horrendous. Restyle it in Unify's style (no pill, square-cornered toast/banner), Figma first, spring motion.
- **Loaders:**
  - In Figma's "01 · subagents" loaders, replace the "running" status glyph with one that matches better; the user thinks of the **02 loader glyph**.
  - **Very important:** all loaders must blend into each other seamlessly. When the action changes, the current loader morphs into the next one. No hard cuts and no plain crossfade-swap.

## Read first
- `docs/UNIFY_SPEC.md`: the product spec and all decisions. It was copied from `DSH/.dsh/mockups/UNIFY_SPEC.md`; this copy is now the one to keep up to date.
- `ARCHITECTURE.md`: engine / shim / main / preload / renderer contract.
- `.dsh/memory/unify.md`: project rules (fonts, contracts, who builds what).
- `docs/briefs/`: the full subagent briefs. `b2`–`b6` are the original Opus briefs. `ds-*.md` are the split briefs that the Deepseek and Cursor agents got.
- **Path mapping:** the briefs were written from the DSH working copy, so translate their paths:
  - `unify/X` → `X` (repo root)
  - `unify-renderer/X` → `src/renderer/X`
  - `.dsh/mockups/UNIFY_SPEC.md` → `docs/UNIFY_SPEC.md`
  - `.dsh/briefs-tmp/` → `docs/briefs/`
  - `.dsh/tools/` → `.dsh/tools/` (copied here)
- Run tsc and vite for the renderer from `src/renderer`. The only expected tsc error is `../engine/runtime/dependencies.ts(71,33)`.
- Nothing is committed yet: this repo has no commits on `master`. Make a first commit once things typecheck. Ask the user first.

## Shared contracts (one owner each, written by the main agent)
- `src/renderer/store/features.ts`: every feature toggle. The renderer posts `{ type: 'setUnifyFeature', id, value }`, and the engine mirrors the values as `viewState.unifyFeatures`. These are deliberately separate from DSH's own `setFeature` / `viewState.features`.
- `src/engine/unify/settings.ts`: the engine reads and writes toggles here, persisted in `~/.unify/settings.json` (moved from `~/.dsh/unify/` in 2g; the code still uses the old path until then).
- `src/engine/unify/agentBus.ts`: the `AgentBus` interface for agent-to-agent messaging. The implementation goes in `agentBusImpl.ts`.
- `src/engine/unify/requests/index.ts`: the `handleUnifyRequest(message, reply, context)` dispatcher for screen data requests.

## 1. Collect the last subagent round
These ran from the DSH IDE. All of them finished and their reports are summarised below; nothing is still running. Results are on disk here:

| Area | Agent | Brief | Owns |
|---|---|---|---|
| Backend core: multi-chat `chatId`, `session.project`, `usage.plan`, always-allow, `setUnifyFeature`, bus wiring, `handleUnifyRequest` wiring, askInChat timeout, mockBridge | Deepseek | ds-backend-core | `src/engine/extension.ts`, `src/engine/sidebar/`, `src/renderer/dev/mockBridge.ts`, `ARCHITECTURE.md` |
| Platform verification: engine diff vs DSH, shim gaps, main/preload security, `window.unify.notify`, build, tests, real launch | Deepseek | ds-platform-verification | `src/shim/`, `src/main/`, `src/preload/`, package.json, run.cmd/sh, electron-builder.yml, build/, scripts/{build,dev,make-package,after-pack} |
| Organic motion primitives + gallery | Deepseek | ds-organic-motion (b3) | `src/renderer/motion/organic/`, `src/renderer/organic-gallery.html` |
| Native agent messaging (`list_agents` / `send_message` / `read_messages`, `agents.maxParallel`, delegateServer fetch timeouts) | Deepseek | ds-native-agent-messaging | `src/engine/unify/agentBusImpl.ts`, `src/engine/mcp/`, `src/engine/runtime/delegation.ts`, `src/engine/delegate/`, `test/agent-bus.test.mjs` |
| Screen data requests + Hub backend (fake registry only) | Deepseek | ds-screen-data-requests-hub-backend | `src/engine/unify/requests/`, `src/engine/hub/`, `test/hub.test.mjs`, `test/unify-requests.test.mjs` |
| Providers screen | Deepseek | ds-providers | `src/renderer/screens/providers/` |
| Shut down when all tasks finish (engine module) | Cursor | (inline; spec bullet "Shut down when done") | `src/engine/unify/power.ts`, `src/engine/unify/power/`, `test/power.test.mjs` |
| Block providers' own agent systems + acp/summaries stall fixes | Cursor | ds-provider-native-agent-blocking-stall-fixes | `src/engine/runtime/{oauthCli,acp,codex,cursor,opencode,nativeAgents}.ts`, `src/engine/summaries/` |
| Files + Monaco editor screen | Cursor | ds-files-editor | `src/renderer/screens/files/`, renderer package.json/lock, DEPENDENCIES.md |

**Reported done, NOT reviewed yet.** Only the agents' own reports have been read. No one has read this code on disk. Before anything here is wired in or built on, the main agent or Opus must review every Deepseek diff (messaging, backend core, platform, requests + Hub, organic motion). Only the Providers screen has been reviewed so far.
- **Messaging:** agentBusImpl, `delegate/messaging.ts`, `delegate/messagingProtocol.ts`, `delegate/limits.ts`, host.ts `/inbox`, delegateServer tools + fetch watchdog. 9/9 tests pass.
  - Inbox mail is appended to the next tool result.
  - `test/features.test.mjs` fails at line 151; the agent said that's unrelated. Check it.
- **Power:** `src/engine/unify/power.ts`, with 14/14 tests passing.
  - Extra UI message `shutdownWaiting`, sent when work resumes during the countdown.
  - New UI → engine message `cancelShutdown`.
  - It does NOT shut down if `saveState()` fails.

- **Native-agent blocking + stalls:** `runtime/nativeAgents.ts`, `oauthCli.ts`, `acp.ts` (one shared 30 s startup deadline), `summaries/store.ts` (10 s wait). 44/44 of its tests pass. Only Claude needed a flag change. Cursor subagents are already off (Unify sends no `subagents` capability). Codex/OpenCode run through DSH's runtime, so `codexNativeAgentArgs()` is unused.
  - Follow-up (Deepseek): `extension.ts:3708` still refuses native agent tools when `agents.blockNativeAgents` is off.
  - Follow-up (Deepseek): the claude-args test reads the real `~/.dsh/unify/settings.json`; make it use a temp settings file.

- **Backend core:** done; 301/301 tests and build passed at the time. New `sidebar/allowRules.ts` (`~/.dsh/unify/approvals.json`). Engine notifications import `electron` directly (`extension.ts` ~525); switch to `vscode.env.notify` so it stays host-agnostic (Deepseek). The renderer store doesn't handle `unifyFeaturesState` / `agentMessage` / `agentRoster` yet, and `src/renderer/protocol.ts` must export `SidebarDependency` for `screens/setup/adapters.ts`.
- **Platform:** shim `context.extension` fixed, notification chain (`window.unify.notify`), sandboxed main window, `unify:ui-request`. Its "requests.ts missing" blocker is now resolved (`unify/requests/index.ts` exists): rerun `npm test` + `npm run build`. Open decisions it raised: GitHub auth returns `undefined` (no sync), VSIX self-update is a no-op (set `updates.repository` empty or use electron-updater), `activeTextEditor`/`tabGroups` empty, `vscode.diff` no-op. Leftover temp folders in `%TEMP%` (`unify-work`, `unify-dump`, `unify-npm-cache`, `unify-electron-cache`, `unify-shot-edge-profile`, `dsh-*\unify-work`) and `scripts/{dump-state,inspect-state,set-font}.mjs` (keep `set-font`, check the other two).
- **Requests + Hub backend:** all screen requests handled in `unify/requests/`; 6/6 + 5/5 tests. Gaps: `setModelEnabled` can't rebuild `modelState`, `signOutAccount` can't push `usageState`, `openProviderUsage` unhandled, hub install's final `toolpacksState` must come from the extension, knowledge import counts instead of copying, file watcher is single-root and ignores `.gitignore`.
- **Files editor:** done; screenshots in `screens/files/__screens__/`. Wire `FilesPanel` into the side-panel slot and `FilesEditor` into the content card. Not tested with `editor.enabled` off.

- **Organic motion:** done (`motion/organic/`, gallery, screenshots in `motion/organic/__screens__/`). Wire as its report says (ChatsPanel/ChatPane titles, FilesPanel rows, UsagePage counters, FilesEditor + Timeline code blocks). Needed in `store/index.ts` so toggles gate live: `case 'unifyFeaturesState': setViewState('unifyFeatures', message.features || {}); break;`. Audit leftovers: shared `Button` hover background snaps (13).

**Not started — images (cancelled before any edits so the user could sleep; just rerun both briefs, they can run in parallel). See spec "Images are first-class" and `docs/contracts/media.md`:**
| Media engine: content-addressed store, `unify-media://` protocol, subagent images to parent | Deepseek | ds-media-engine | `src/engine/unify/media/`, extension.ts, sidebar/{view,provider}.ts, runtime/{media,batch}.ts, delegate/, src/main/, test/media-store.test.mjs, test/run.mjs |
|---|---|---|---|
| Media chat UI: tool-row thumbnails, subagent image strip, full viewer | Opus | ds-media-chat-ui | renderer protocol.ts, screens/chats/Timeline.tsx + timeline.css, components/Media*, dev/, tools/fixtures |

**Providers screen (Deepseek): done and reviewed (2026-11-23).** tsc is clean for the folder, and the screenshots match Figma. The main agent fixed the plan column, which was wrapping onto two lines. Still open:
- wire `ProvidersScreen` into `screens/index.tsx`;
- implement the 5 messages in `screens/providers/protocol-requests.md` (`setModelEnabled`, `renameAccount`, `setAccountDefaultModel`, `signOutAccount`, `openProviderUsage`);
- the add dialog lists Cursor and is centred, both on purpose;
- delete `__screens__/` once the screen is wired.

**Cursor did two backend jobs** (power module, native-agent blocking + stalls) before the "Opus-family = front-facing only" rule. Both are kept.

**No more Cursor subagent** (user, 2026-11-23). Anything listed for Cursor (in this file or in a brief) now goes to Opus for front-facing work, or to the main agent for reviews. Cursor (user, 2026-11-23) was dropped only because it costs a lot of tokens, not because of quality. Its work (power module, native-agent blocking + stalls, Files editor) is trusted: don't review it diff by diff. Any problems get caught in the final pass (section 4). Only Deepseek's work needs the on-disk review.

**Review direction:** Deepseek's work is what gets reviewed, never the reviewer. The main agent (or Opus) reviews Deepseek diffs; Deepseek never reviews Opus work.

For each one: if its report is missing or it died (Deepseek 429s when more than about 5 run at once), check its files on disk and rerun its brief.

## 2. Not started yet (rerun these briefs)
Earlier Opus attempts left partial work on disk for all of these; the briefs say to continue from it.
- [ ] **Knowledge screen** (`docs/briefs/ds-knowledge.md`): `src/renderer/screens/knowledge/`. There is no `KnowledgeScreen.tsx` yet.
- [ ] **Toolpacks screen** (`ds-toolpacks.md`): `ToolpacksScreen.tsx` fails tsc (`groupTools`, `hasTools` missing, and a `<Show>` typing error).
- [ ] **Toolpack Hub screen** (`ds-toolpack-hub.md`): only the adapter, mock and protocol-requests exist; there is no `HubScreen.tsx`.
- [ ] **Settings screen** (`ds-settings.md`): partly built. Delete `screens/settings/__ref_tmp__/` when done. Needs a **Power** group for the new `power.*` toggles.
- [ ] **Setup wizard** (`ds-setup-wizard.md`): `setupState.ts` fails tsc (`ToolStatus.state` is typed as string). There is no `SetupWizard.tsx` yet.

## 2b. New, not briefed yet (spec: "Range-scoped reading and editing" and "Explorer is not shown as a subagent")
- [ ] **Engine (Deepseek):** explorer ranges block (`runtime/explorer.ts` and the explorer note at `extension.ts` ~3312, plus parsing it into the `delegate_task` result), `read_file` `ranges` (DSH tools + `runtime/batch.ts`), the new guarded `edit_range` tool, and the delegation prompt text in `runtime/delegation.ts`. Add `tools.rangeEdits` and `agents.explorerRanges` to `store/features.ts` + `unify/settings.ts` first (main agent owns them). Tests: stale `expected` fails, moved lines re-anchor, overlapping ranges merge.
- [ ] **Chat UI (Opus):** explorer runs render as an inline "Explored" row (lens loader, question title, `file:line` chips that open the Files editor at the range). No subagent tab, strip or roster badge. Needs a flag on the subagent event (`profile === 'explorer'`) from the engine, so agree on that field in the engine brief.

## 2c. Reusable model picker (spec: "One reusable model picker"), not briefed yet
- [ ] **Renderer (Opus):** build `components/ModelPicker.tsx` (one-line trigger + spring popover with search, Smart Auto, recents, provider groups, effort/speed footer, keyboard nav). Reuse `screens/chats/models.ts` for the options and select calls. Swap it in at `Composer.tsx` ~274 (replacing the model, effort and speed `Select`s), `ChatPane.tsx` ~142 and `AccountPage.tsx` ~229, plus the Settings model fields once that screen lands. Recents need a small store (last ~5 model ids, persisted in renderer settings). Preview the component in every theme, including long names and many providers.

## 2d. Provider logo redraw (spec: "Provider logos look like the real brand"), not briefed yet
- [ ] **Opus (visual):** `screens/providers/` is free now (the Deepseek agent finished). Move the glyphs to `components/ProviderGlyph.tsx`, redraw each mark (Anthropic A\, OpenAI knot, Gemini spark, Mistral M, Cursor cube, OpenCode, self-hosted) in one matched style, and point Providers + Toolpacks at it. Draw them in Figma first, then export the paths. Verify at 12/16/24px in all 7 themes as a single contact sheet, and review that image yourself.

## 2e. Show your work, no duplicate visuals (spec: Non-negotiables, "User-friendly and transparent"), not briefed yet
- [ ] **Engine (Deepseek):** add a "show your work visually" rule (screenshots, renders, before/after) to the default system prompt, gated by `chats.showYourWork`. Track the media sha256 values each chat has already displayed, including subagent `send_media` and tool images that reached the parent. `send_media` skips images already seen and returns a note ("already shown by <agent>"). The image strip on a subagent row leaves out images that are already inline. The main agent adds `chats.showYourWork` to `features.ts` + `settings.ts` first. Tests: a repeated sha256 is skipped, and a new image after a fix is still sent.

## 2f. Remove dot separators (spec: Visual rules, "No dot separators"), not briefed yet
Rework each case with layout (muted second part, separate cells, label/value rows, spacing), not another glyph. Ignore code comments and Figma frame names.
- [ ] **Figma (Opus):** `figma_find` every TEXT node containing `·`, `•` or `∙` across all pages and redraw each one using the spec's alternatives. Note each change, since the code follows Figma. Export before/after for the main frames (Providers, Usage, Toolpacks, Chat tool rows, Settings).
- [ ] **Renderer (Opus, after Figma; spec: frontend is never Sol):** known sites (re-run `rg "·|•|∙" src` first, since this list is from 2026-11-23):
  - `screens/providers/adapter.ts` 182/200 (`accountTitle`, usage account cell), `AccountPage.tsx` 42 (splits on `' · '`, fix together with the adapter) and 137 (`.pv-sep`), `UsagePage.tsx` 61/71/134/172, `preview.tsx` 76.
  - `components/UsageMeter.tsx` 68.
  - `screens/settings/SettingsScreen.tsx` 234/322/326, `ThemePicker.tsx` 16/22.
  - `screens/toolpacks/toolpacks.css` 90 (`content: '·'`) and the meta strip in `ToolpacksScreen.tsx`.
  - `motion/organic/galleryApp.tsx` 105/140/259, and tool-row details in `tools/fixtures/*.json` (`"\"layoutMode\" · 6 hits"`).
- [ ] **Engine (Deepseek):** labels that reach the UI: `accounts/claudeUsage.ts` 14/80, `codexUsage.ts` 72, `modelRegistry.ts` 70, `extension.ts` 874–885 (tooltips), 2923 (Smart Auto), 3301 (model label: send model, effort and speed as separate fields instead of one joined string), 3497, `goal/runner.ts` 54–99 (`/job` labels). If a label needs two parts, return them as separate fields (`{ label, detail }`) so the renderer can style them, rather than a joined string.
- [ ] **Verify:** `rg "·|•|∙" src` hits only comments; screenshots of Providers, Usage, Toolpacks and Settings in 2 themes.

## 2f2. Generic file tools on app data say what they're really doing (spec: "A generic file tool used on app data says what it's really doing"), not briefed yet
- [ ] **Contract (main agent, first):** add `kind` + `label` (+ optional `detail`) to the tool-row event in `src/renderer/protocol.ts`, and add the `chat.friendlyInternalRows` toggle to `store/features.ts` + `unify/settings.ts`. Kinds: `history.refresh`, `memory.read`, `memory.write`. Only generic file tools get a kind; dedicated tools keep their own rows.
- [ ] **Engine (Deepseek):** a classifier module (generic file tool + path → kind/label), called where tool events are built. Tests: each kind, a batch call that mixes app data and project files, user project files staying plain, dedicated tools untouched, and the toggle off.
- [ ] **Renderer (Opus):** a row variant per kind (icon, loader, label) that still expands to the raw call. Preview it with fixtures and check it in 2 themes.
- [ ] **Verify (main agent):** in a real chat, ask an agent to recall memory and read old transcripts. No raw `Read …/memory/…` rows should appear.

## 2g. Remove every trace of DSH (spec: Non-negotiables, "Unify is its own thing"), not briefed yet
A full rename with no compatibility with DSH. The user migrates old data themselves. Run `rg -n -i "dsh" src` first (~250 hits on 2026-11-23). Everything goes except the `@deepseek-ai/dsh` runtime adapter (see the spec exception). Do it as one engine pass so the shared names (`~/.unify`, `UNIFY_*`, `mcp__unify__`) land together.
- [ ] **Engine (Deepseek) — owns the contract renames first:**
  - Data and paths: `~/.dsh` → `~/.unify` (`extension.ts` 1637/1638, `unify/requests/state.ts` 34, `runtime/memory.ts`, `acp.ts` 102), `.dsh/` project folder → `.unify/` (`shadow.ts` 15–27/214 and anything else matching `'.dsh'`). The runtime's `DSH_HOME` gets pointed inside `~/.unify`.
  - Env vars and headers: `DSH_*` → `UNIFY_*` (delegate, priority, git, rust, whisper, voice, bash env, `DSH_AGENTS_HOME`), `x-dsh-token` → `x-unify-token`.
  - MCP server: `dsh-delegate` → `unify` (`extension.ts` 185/2610, `oauthCli.ts` 136, `delegateServer.ts` 214, `toolDisplay.ts` 80).
  - Agent-facing text: `batch.ts` 27/31, `delegation.ts` 17/19, `media.ts` 31, `imageGen.ts` 48, `summaries/store.ts` 37, `midTurnCompact.ts` 24/72–104, `imageTrim.ts` 8 (and its `.dsh-trim` suffix), `promptPrefix.ts` 4, `extension.ts` 2450/3096/3780, `oauthCli.ts` 342, `delegateServer.ts` 35/43/187/216.
  - User-facing text: `acp.ts` errors, `extension.ts` notices, `review/*`, `shadow.ts` 106/121, `git.ts` 55, `models.ts` 24, `goal/runner.ts` 67, `usageService.ts` 54, `cursorUsage.ts` 36, `codexAuth.ts` 273/298/310, `instructions/share.ts` 8/98 (`.dsh-shared.json`).
  - Sync: `sync/configSync.ts`, `controller.ts` and `gitRepo.ts` get Unify names for the repo/gist (`unify-sync`), the markers (`unify-config`, `unify-sync`) and the README. No reading of old DSH formats.
  - Identifiers and files: `DshSidebarProvider`, `DshRuntimeRoute`, `DshPriorityJob`, `DshRecorder`, `skippedDshVersion`, the `dsh.*` setting keys, the `dsh-review` scheme, `update/dshUpdate.ts`. Rename the runtime-package parts to `agentRuntime*` and keep the `@deepseek-ai/dsh` names in one adapter module.
  - User-Agent / `clientInfo` `dsh-ide` → `unify` (`codexAuth.ts` 152, `git.ts` 65, `rustTools.ts` 55, `acp.ts` 135).
  - VS Code-only flows: delete the DSH-IDE extension updater (`update/extensionUpdate.ts`, `extension.ts` 614–740) and the `$(hubot) DSH` status item (343). The runtime-package updater stays, worded as "agent runtime". Replace "Reload Window", workspace trust and "DSH: Restart Runtime" text with Unify actions.
  - Remove the DSH data importer `shim/vscode/importer.ts` and its call site. Comments and tests get updated too.
- [ ] **Renderer (Opus, after the engine pass):** remove "Import from DSH" from Setup (`screens/setup/adapters.ts` 127 + the step UI), change the Settings data folder row (`SettingsScreen.tsx` 356) to `~/.unify` with no "Shared with DSH", replace the mock workspace and sample project "DSH" in `screens/files/adapter.ts`, `knowledge/adapter.ts`, `tools/fixtures/*.json` and `Tree.tsx` docs with a neutral sample, and reword the `DSH's …` comments in `store/*`, `protocol.ts` and `components/*`.
- [ ] **Main/preload (Deepseek):** `main/index.ts` and `preload/index.ts` comments, plus the "legacy DSH sidebar" naming (rename it to "legacy sidebar", or remove it if nothing loads it anymore).
- [ ] **Figma (Opus):** `figma_find` text containing "DSH" (sample projects, import step, data folder) and replace it.
- [ ] **Docs:** `docs/briefs/`, `docs/contracts/` and `.dsh/memory/unify.md` point builders at `~/.dsh` paths and use DSH names. Update them so new briefs don't bring them back.
- [ ] **Verify:** `rg -n -i "dsh" src` hits only the runtime adapter. `npm test` passes. Launch Unify on a clean profile: `~/.unify` is created, `~/.dsh` is never touched, and a turn with a subagent and a compaction never shows "DSH" to the agent or the user.

## 3. Wiring (after the screens land)
**Who does it:** engine and backend items (`extension.ts` hooks, power controller, `test/run.mjs`, adapters ↔ engine messages) go to Deepseek. Renderer UI and motion items (screen routing, nav hiding, organic primitives, timeline rows, approval button, shutdown overlay) go to Opus. The main agent briefs and reviews but doesn't write backend code itself.
- [ ] `test/run.mjs`: add `await import('./agent-bus.test.mjs')`, `./power.test.mjs`, and the hub/unify-requests tests.
- [ ] Messaging hooks in `extension.ts`:
  - `bindChatAgentOwner(chat.ownerId, chatId)` when a top-level agent registers
  - in `runSubagentCore`: `registerSubagentAgent({ id: agentId, owner, name, task, chatId: chat.record.id, parentId: chat.record.id })`, then `setSubagentState` / `unregisterSubagentAgent(agentId)` in its state points and its `finally`

  The helpers are in `src/engine/delegate/messaging.ts`. Check whether the backend-core agent already did this.
- [ ] Power in `extension.ts`: create the controller once on activation (dispose via subscriptions), route `cancelShutdown`, and expose `getStatus()` in viewState for the title-bar indicator. The wiring guide is in the comment at the top of `power.ts`.
- [ ] Wire `FilesScreen`, `KnowledgeScreen`, `ToolpacksScreen`, `HubScreen`, `ProvidersScreen` and `SettingsScreen` into `src/renderer/screens/index.tsx` and `router.ts`, replacing `stubs.tsx`.
- [ ] Hide the Hub nav entry when `toolpacks.hub` is off (`hubEnabled()`). Hide the Files nav entry when `editor.enabled` is off. The rail usage meter follows `usage.railMeter`.
- [ ] Mount `SetupWizard` in the Shell over Home, using `shouldShowSetup()` (see that agent's report).
- [ ] Wire the organic primitives where their report says: `RetypeText` for renames (chats list, file tree, knowledge tree), create/delete in the trees, `RollingNumber` in usage and counters, the lift-move helpers for reorders, and `EditedLines` in the diff and timeline views. Search for `// organic:` comments.
- [ ] Shut-down controller: wire `createShutdownController` in `extension.ts`:
  - activity counts from chats, subagents, approvals, questions and processes
  - `saveState`, `notify` (via `window.unify.notify` / the main-process Notification IPC)
  - UI messages: `shutdownCountdown`, `shutdownArmed`, `shutdownCancelled`, `shutdownFailed`
  - the renderer pieces: arm switch in the usage popover and Settings → Power, an armed indicator in the title bar, a countdown overlay with Cancel
- [ ] Match each screen's adapter to the real engine messages that `src/engine/unify/requests/` now handles, and delete the mocks from the production path; dev mocks may stay.
- [ ] Timeline: render `agentMessage` events as "who → who" rows, behind the `agents.messaging.showInChat` toggle.
- [ ] Approval rows: an "Always allow" button.
- [ ] Each chat pane posts its own `chatId`, and chats are grouped by `session.project`.
- [ ] Fix the leftover Anonymous Pro mention (a comment and a fallback value) in `src/renderer/theme/theme.css`. Space Mono is the UI font.

## 4. Verification (don't trust agent reports)
Deepseek may run mechanical checks (typecheck, tests, build) and report the output. Judging code (reading diffs, messaging, blocking, stalls, shutdown logic) goes to the main agent (or Opus), never Deepseek. Visual and motion checks go to the main agent or Opus.
- [ ] Read every diff on disk against its brief. Expect Deepseek mistakes: check for silent no-ops in the shim, compressed one-liners, invented APIs, and edits outside the agent's lock.
- [ ] Engine vs DSH `src/`: only justified changes (the platform agent's verdict list), and DSH's agentic behaviour is unchanged.
- [ ] `npm run typecheck` (engine) and the renderer tsc, both clean.
- [ ] `npm test`: all DSH tests plus the new `agent-bus`, `hub`, `unify-requests` and `power` tests pass.
- [ ] `npm run build` and electron-builder: NSIS + portable (Windows), dmg (macOS), AppImage (Linux), unsigned.
- [ ] Launch `run.cmd`: the engine activates, a chat round-trips with a real provider, two panes chat at the same time, and the logs are clean.
- [ ] Agent messaging end to end: parent ↔ child, siblings, another chat; each `agents.messaging.scope` value; and turning messaging off hides the tools.
- [ ] Native-agent blocking: confirm each provider's flag really works (Claude `--disallowedTools`; for Codex, Cursor and OpenCode, whatever was verified), and the fallback detector still fires.
- [ ] The ~30 s tool-call stalls are gone (askInChat, `summaries/store.ts`, delegateServer fetch, `acp.ts` init).
- [ ] Shutdown: unit tests only. Do a real shutdown test only if the user explicitly OKs it. Check the countdown, that Cancel works, that it waits on pending approvals, and that it disarms after firing.
- [ ] Every setting toggles live and leaves no gaps (go through each `featureDefinitions` entry).
- [ ] Visuals: screenshot every screen in Walnut Dark and Walnut Light (`src/renderer/tools/shot.mjs`), compare against the Figma frames (page "Unify"), and check for clipped or overflowing text in Space Mono.
- [ ] Motion: run `.dsh/tools/motion-audit.mjs` on the organic gallery and the main screens (snaps, layout jumps, restarts). Animations use springs and follow the apple-design skill.
- [ ] **Spec coverage pass.** These were asked for during the design chat and are in `docs/UNIFY_SPEC.md`, but no brief or TODO item checks them yet. Confirm each one is built, or give it to an agent:
  - Chats tree shows at most 5 chats per project, then a "Show N more" row.
  - Loader icons crossfade or morph when the action changes. The 30 action-specific loaders (Figma boards "Loaders" and "03 · Loaders · by action") are used in the chat in place of a generic spinner.
  - Home composer has the project folder picker (breadcrumb chip, defaults to the last project), so you're not "typing into the abyss".
  - Home is the always-mounted backdrop. The Welcome screen is only that backdrop, the line "The last AI interaction interface you ever install" and Get started.
  - Titles are bold or heavier (`unify/display` on Home).
  - No pill buttons anywhere (the new-chat button especially).
  - Pane layouts: drag a pane header and the layout picker drops down at top centre. Corners, sides and other layouts snap cleanly and animate.
  - Usage: the summary bar is kept (stacked, weighted by plan price), every provider that reports usage has bars, and OpenCode Go reads limits via a browser sign-in.
  - Your own attached images show in your message bubble, not just as file names.
  - Knowledge: skill-folder upload and drag-in. Rules are scoped by audience, so delegation rules don't reach subagents.
  - The Hub install script puts toolpack files in place on download.
- [ ] Old design temp files in the DSH repo: `DSH/.dsh/briefs-tmp/` can go (copies are in `docs/briefs/`). Check `DSH/.dsh/mockups/unify-a…e`, `unify-logo/tmp` and `usage/` with the user before deleting; Figma is the source of truth.
- [ ] Cleanup: stray `__ref_tmp__` and temporary screenshots, and no running electron, vite or node processes.

## 5. Still waiting on the user
- [ ] The "red notification at the top": where is it (the Unify app, Figma or the DSH IDE)? Not found yet.
- [ ] Creating the `raisinhvh/unify-hub` GitHub repo: ask before creating or publishing anything.
- [ ] Code-signing cert: later.
