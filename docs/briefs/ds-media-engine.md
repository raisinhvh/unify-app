You ARE the implementation subagent. Build the engine side of Unify's image handling. Do not redesign; if the contract is wrong, report it.

Repo: the Unify app, reached from this working copy as `unify/` (repo root) and `unify-renderer/` (= `unify/src/renderer`). Use those paths.

## Read first
- `unify/docs/UNIFY_SPEC.md` → Decisions → "Images are first-class".
- `unify/docs/contracts/media.md`: the contract. Build exactly this.
- `unify/src/engine/extension.ts`: `saveImages` (~1714, user attachments → global `attachments/`), `sendMedia` (~3193, copies into `media/<chatId>/` and posts `mediaMessage`; called for subagents at ~3077 with `child.parent`), `generateImage` (~3221), the subagent tool-result path, and how inbox mail is appended to the next tool result (`src/engine/delegate/messaging.ts`).
- `unify/src/engine/unify/settings.ts`: `getUnifyFeature('agents.imagesToParent')`.
- `unify/src/engine/delegate/host.ts`: `DelegateResult extends ToolpackResult`, which already supports `{ type: 'image', data, mimeType }` content.

## Build
1. `src/engine/unify/media/store.ts` (+ `index.ts`): the `MediaStore` from the contract. sha256 dedupe, atomic index writes (tmp + rename), `release` + `sweep`, lazy 256 px webp thumbnails (use whatever image library the engine already has; if none, use Electron `nativeImage` via the shim or ask in your report instead of adding a heavy dependency).
2. `src/main/`: register the `unify-media://` protocol per the contract (privileged + secure, hash regex, 404 for unknown).
3. `extension.ts`:
   - `saveImages`: store user attachments in the MediaStore (ref = chat id) instead of `attachments/`; runtimes that need a path get `pathOf(hash)`.
   - `sendMedia`: store via MediaStore; `file` = `unify-media://<hash>`. For a subagent: add the media to the subagent's own feed message, append to `sentToParent`, and when `agents.imagesToParent` is on, give the parent the images as image content blocks (foreground: in the `delegate_task` result; background: appended to the parent's next tool result, the same path inbox mail uses). Stop posting the `**label:**` `mediaMessage` into the parent chat for subagent media.
   - Tool results with image content (batch `read_file` images, toolpack image blocks, captures), main agent and subagents: store each image and attach `media` to the tool event (`SidebarToolEvent.media` / `SidebarSubagentTool.media`).
   - Chat delete → `release(chatId)`; startup → `sweep()`.
   - Agent copies over 1568 px long side are downscaled; the store keeps the original.
4. `src/engine/sidebar/view.ts` and `sidebar/provider.ts`: the type additions from the contract, and `subagentEvent` merging `media` / `sentToParent` into state.
5. `unify/test/media-store.test.mjs`: dedupe, refs, release + sweep, hash validation. Add it to `unify/test/run.mjs`.

## Rules
- Preserve DSH's agentic behaviour everywhere else. Don't touch `src/renderer/`.
- Style: 2-space indent like the surrounding engine code, descriptive names, no compressed one-liners, no invented APIs.
- Don't write to the user's real `~/.unify` in tests (use a temp home).

## Verify
- `npm test` in `unify/` passes (report counts), `npm run build` passes, tsc clean for your files.
- Report: files changed with line refs, protocol fields actually emitted, anything in the contract you could not do.
