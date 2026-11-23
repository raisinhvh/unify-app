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
- [x] **Knowledge screen** (`docs/briefs/ds-knowledge.md`): `src/renderer/screens/knowledge/KnowledgeScreen.tsx` built and wired.
- [x] **Toolpacks screen** (`ds-toolpacks.md`): `ToolpacksScreen.tsx` built, tsc-clean, and wired.
- [x] **Toolpack Hub screen** (`ds-toolpack-hub.md`): `HubScreen.tsx` built and wired.
- [x] **Settings screen** (`ds-settings.md`): `SettingsScreen.tsx` built with Power group, wired, and `screens/settings/__ref_tmp__/` deleted.
- [x] **Setup wizard** (`ds-setup-wizard.md`): `SetupWizard.tsx` built, tsc-clean, and mounted in Shell.

## 2b. New, not briefed yet (spec: "Range-scoped reading and editing" and "Explorer is not shown as a subagent")
- [x] **Engine (Deepseek):** explorer ranges block (`runtime/explorer.ts`), `read_file` ranges (`runtime/batch.ts`), guarded `edit_range` (`runtime/rangeEdit.ts`), delegation prompt text (`runtime/delegation.ts`), `tools.rangeEdits` and `agents.explorerRanges` toggles + tests.
- [x] **Chat UI (Opus):** explorer runs render inline via `ExplorerRow` / `profile === 'explorer'` without subagent tab/strip/roster badge.

## 2c. Reusable model picker (spec: "One reusable model picker"), not briefed yet
- [x] **Renderer (Opus):** `components/ModelPicker.tsx` built and wired in Composer, ChatPane, AccountPage, and Settings.

## 2d. Provider logo redraw (spec: "Provider logos look like the real brand"), not briefed yet
- [x] **Opus (visual):** `components/ProviderGlyph.tsx` built and used by Providers and Toolpacks.

## 2e. Show your work, no duplicate visuals (spec: Non-negotiables, "User-friendly and transparent"), not briefed yet
- [x] **Engine (Deepseek):** `chats.showYourWork` toggle, `unify/media/shown.ts` sha256 dedup tracking across chat/subagent media, and unit tests.

## 2f. Remove dot separators (spec: Visual rules, "No dot separators"), not briefed yet
Rework each case with layout (muted second part, separate cells, label/value rows, spacing), not another glyph. Ignore code comments and Figma frame names.
- [x] **Figma (Opus):** dot separators replaced in code/UI.
- [x] **Renderer (Opus, after Figma; spec: frontend is never Sol):** dot separators removed across Providers, Usage, Toolpacks, Settings, UsageMeter, organic gallery, and fixtures.
- [x] **Engine (Deepseek):** engine UI labels updated to structured/non-dot formatting.
- [x] **Verify:** `rg "·|•|∙" src` hits only comments; screenshots of Providers, Usage, Toolpacks and Settings checked in Walnut Dark and Walnut Light.

## 2f2. Generic file tools on app data say what they're really doing (spec: "A generic file tool used on app data says what it's really doing"), not briefed yet
- [x] **Contract (main agent, first):** `chat.friendlyInternalRows` toggle and tool-row friendly metadata added to `protocol.ts`, `store/features.ts`, `unify/settings.ts`.
- [x] **Engine (Deepseek):** `src/engine/unify/internalRows.ts` + `toolDisplay.ts` classifier and unit tests.
- [x] **Renderer (Opus):** friendly row rendering wired in Timeline.
- [ ] **Verify (main agent):** in a real chat with a full-capability provider, verify an agent recalling memory and reading old transcripts renders friendly rows instead of raw `Read …/memory/…`.

## 2g. Remove every trace of DSH (spec: Non-negotiables, "Unify is its own thing"), not briefed yet
A full rename with no compatibility with DSH. The user migrates old data themselves. Run `rg -n -i "dsh" src` first (~250 hits on 2026-11-23). Everything goes except the `@deepseek-ai/dsh` runtime adapter (see the spec exception). Do it as one engine pass so the shared names (`~/.unify`, `UNIFY_*`, `mcp__unify__`) land together.
- [x] **Engine (Deepseek) — owns the contract renames first:** `~/.unify`, `UNIFY_*`, `unify` MCP/sync/identifiers, `unify.subagents`, and `src/main/index.ts` `UNIFY_HOME` support; only allowed `@deepseek-ai/dsh` package/env/`dshHome` runtime adapter keys remain.
- [x] **Renderer (Opus, after the engine pass):** Setup, Settings (`~/.unify`), Files, Knowledge, fixtures updated; only allowed "port of DSH …" provenance comments remain.
- [x] **Main/preload (Deepseek):** updated to Unify naming and `UNIFY_HOME`.
- [ ] **Figma (Opus):** `figma_find` text containing "DSH" (sample projects, import step, data folder) and replace it (verify in Figma if any remain).
- [x] **Docs:** `docs/UNIFY_SPEC.md`, `docs/briefs/`, `src/renderer/screens/hub/protocol-requests.md`, and `.dsh/memory/unify.md` updated to Unify paths/names.
- [x] **Verify:** `rg -n -i "dsh" src` hits only allowed runtime adapter / `DSH_HOME` / `dshHome` / provenance comments; `npm test` passes.

## 3. Wiring (after the screens land)
**Who does it:** engine and backend items (`extension.ts` hooks, power controller, `test/run.mjs`, adapters ↔ engine messages) go to Deepseek. Renderer UI and motion items (screen routing, nav hiding, organic primitives, timeline rows, approval button, shutdown overlay) go to Opus. The main agent briefs and reviews but doesn't write backend code itself.
- [x] `test/run.mjs`: includes `agent-bus.test.mjs`, `power.test.mjs`, `hub.test.mjs`, `unify-requests.test.mjs`, `media-protocol.test.mjs`.
- [x] Messaging hooks in `extension.ts`: `bindChatAgentOwner` / `unbindChatAgentOwner` / `registerSubagentAgent` wired.
- [x] Power in `extension.ts`: `createShutdownController` wired on activation, `cancelShutdown` routed, status exposed in viewState.
- [x] Wire `FilesScreen`, `KnowledgeScreen`, `ToolpacksScreen`, `HubScreen`, `ProvidersScreen` and `SettingsScreen` into `src/renderer/screens/index.tsx` and `router.ts`.
- [x] Hide Hub/Files nav entries and rail usage meter behind feature toggles.
- [x] Mount `SetupWizard` in the Shell over Home, using `shouldShowSetup()`.
- [x] Wire the organic primitives (`RetypeText`, `OrganicList`, `RollingNumber`, `liftMove`, `EditedLines`).
- [x] Shut-down controller wired end-to-end (engine + renderer arm toggle, title-bar indicator, countdown overlay).
- [x] Screen adapters matched to `src/engine/unify/requests/` handlers (mocks kept only for bridge-less dev previews).
- [x] Timeline: render `agentMessage` events via `AgentMessageRow`, behind `agents.messaging.showInChat`.
- [x] Approval rows: "Always allow" button wired and gated by `canAlwaysAllow` so unsafe/compound/interpreter commands never offer it.
- [x] Each chat pane posts its own `chatId`, and chats are grouped by `session.project`.
- [x] Fix the leftover Anonymous Pro mention in `src/renderer/theme/theme.css`. Space Mono is the UI font.

## 4. Verification (don't trust agent reports)
Deepseek may run mechanical checks (typecheck, tests, build) and report the output. Judging code (reading diffs, messaging, blocking, stalls, shutdown logic) goes to the main agent (or Opus), never Deepseek. Visual and motion checks go to the main agent or Opus.
- [x] Audit pass applied: media protocol cache/SVG/fallback, updater initial timer cleanup, allowRules lazy path/atomic tmp/wrapper & combined flags/interpreters, knowledge traversal/rename/attribution/memory root/importSkillFolder pre-validation, unsafe Always allow gating, temp cleanup.
- [ ] Engine vs DSH `src/`: final parity sign-off if desired.
- [x] Renderer `tsc --noEmit -p src/renderer/tsconfig.json` clean (only known `dependencies.ts(71,33)` TS2504).
- [x] `npm test`: all tests pass (including `agent-bus`, `hub`, `unify-requests`, `power`, `media-protocol`, `allow-rules`).
- [ ] `npm run build` passes; full `electron-builder` packaging (NSIS + portable, macOS, Linux) still to run outside sandbox.
- [ ] Launch `run.cmd`: Electron + Vite + engine boot cleanly and live chat send/streaming/tool call (`Read`) verified with local Ollama (`self-hosted`); multi-pane concurrent chat and live subagent delegation with a stronger cloud provider still to test once a cloud account is signed in under `~/.unify`.
- [ ] Agent messaging end to end with a full-capability provider: parent ↔ child, siblings, another chat; each `agents.messaging.scope` value; and turning messaging off hides the tools.
- [ ] Native-agent blocking live check across Claude/Codex/Cursor/OpenCode providers once accounts are signed in.
- [x] The ~30 s tool-call stalls fixed in code/tests (`askInChat`, `summaries/store.ts`, delegateServer fetch, `acp.ts` init).
- [x] Shutdown: unit tests pass (14/14). Real OS shutdown test deferred per user rule.
- [ ] Every setting toggles live and leaves no gaps (manual interactive sweep across all `featureDefinitions`).
- [x] Visuals: all fixtures, `src/renderer/shell/__screens__`, `chat-edits-*`, unsafe approval row, and all 7 app screens shot and visually checked in Walnut Dark and Walnut Light (fixed `chat-edits-2` `.changes-toggle` spacing).
- [x] Motion: ran `.dsh/tools/motion-audit.mjs` on loader morph, springs, `EditedLines`, lift reorder, and create/delete; fixed `EditedLines` delete-sweep spring wobble (`sweepSpring`), caret wrapper pop-out (`Caret` opacity on root), and multi-line removal double-sweep bug (`EditedLines` + `RetypeText`).
- [ ] **Spec coverage pass.** Final check of any remaining spec nuances (e.g. OpenCode Go browser sign-in usage, Hub real repo publish).
- [ ] Old design temp files in the DSH repo (`DSH/.dsh/briefs-tmp/`, etc. — outside this Unify repo).
- [x] Cleanup: stray `%TEMP%\unify-*` and `src/renderer/screens/settings/__ref_tmp__` removed, and all started background processes stopped.

## 5. Still waiting on the user
- [ ] The "red notification at the top": where is it (the Unify app, Figma or the DSH IDE)? Not found yet.
- [ ] Creating the `raisinhvh/unify-hub` GitHub repo: ask before creating or publishing anything.
- [ ] Code-signing cert: later.
