# Final round: rules every agent follows

You ARE the implementation subagent. Build what your brief asks, follow the project's conventions, and don't redesign. If the brief is unclear or wrong, stop and report it instead of guessing. Don't write memory files; put lessons in your final report.

## Read first
- `docs/UNIFY_SPEC.md`: the product spec. Read the sections your brief names.
- `ARCHITECTURE.md`: engine / shim / main / preload / renderer contract.
- `TODO.md` → "User decisions (2026-11-23, final session)". These are final.
- Older briefs in `docs/briefs/` were written from another working copy. Translate their paths:
  - `unify/X` → `X`
  - `unify-renderer/X` → `src/renderer/X`
  - `.dsh/mockups/UNIFY_SPEC.md` → `docs/UNIFY_SPEC.md`
  - `.dsh/briefs-tmp/` → `docs/briefs/`

## Shared contracts (owned by the main agent; read them, don't change them)
- `src/engine/sidebar/view.ts`: all engine ↔ UI message and state types. Unify additions are marked `Unify`:
  - `SidebarInternalTool`
  - `SidebarExplorerRange`
  - `SidebarSubagent.profile` / `ranges` / `tokens` / `sentToParent`
  - the `media` fields
  - the `shutdown*` messages
  - `editorOpen` / `editorDiff` / `editorState`
  - `github*` messages and `viewState.github`
  - `viewState.shutdown`
  - the `agentMessage` timeline item
- `src/renderer/protocol.ts`: re-exports those types for the renderer.
- `src/renderer/store/features.ts` and `src/engine/unify/settings.ts`: every feature toggle.
- `src/renderer/store/index.ts`: the renderer store. It already handles the new messages.
- `docs/contracts/media.md`: the media store.

If you need a contract change, stop and report the exact change you need.

## File ownership
- Edit only the files your brief lists. Other agents are editing other files right now.
- If you need a change in a file you don't own, write the exact change (file, place, code) under "Hooks for other owners" in your report, and don't make it yourself.

## Code style
- Copy the style of the reference file your brief names: tabs or spaces as that file uses them, descriptive names, one statement per line, no compressed one-liners.
- Don't invent APIs. Check that an API exists (in the code, `node_modules` types or the docs) before you call it.
- No silent no-ops: if something can't work, make it fail visibly with a clear message.
- Data folder `~/.unify` (not `~/.dsh`), project folder `.unify/`. Don't add new "DSH" names. A rename pass runs at the end.

## Checks
- Renderer: `cd src/renderer && npx tsc --noEmit -p .`. Your files must be clean. The only error that may stay is `../engine/runtime/dependencies.ts(71,33)`; errors in other agents' files aren't yours.
- Engine: `npm run build` must print BUILD_OK. Run `npm test` if your brief touches tested code, and report the pass/fail lines.
- Don't add test files unless your brief asks for them. A separate test agent writes them.
- Clean up: stop every vite, electron and node process you started, and delete temporary screenshots and folders you made (unless your brief says to keep them).

## Report
- What you built, with file:line references.
- Anything you couldn't do and why.
- "Hooks for other owners": exact code for files you don't own.
- The check output.
