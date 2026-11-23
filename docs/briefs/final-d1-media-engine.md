# D1: media engine and "show your work" (Deepseek)

Read `docs/briefs/final-common.md` first and follow it.

## Task
1. Build everything in `docs/briefs/ds-media-engine.md`, with these changes:
   - The protocol types in `src/engine/sidebar/view.ts` are already added (`media`, `sentToParent`, and `subagentEvent.media` / `sentToParent`). Don't edit view.ts; emit those fields.
   - The renderer store already merges them.
   - Store path: `path.join(unifyHome(), 'media')`. `unifyHome()` is exported from `src/engine/unify/settings.ts`.
   - Electron protocol: create `src/main/mediaProtocol.ts` exporting:
     - `registerMediaSchemes(): void`, which calls `protocol.registerSchemesAsPrivileged`. It must run before `app.whenReady`.
     - `installMediaProtocol(): void`, which installs the handler after ready.
     - Don't edit `src/main/index.ts`; another agent wires these two calls in.
   - Don't write `test/media-store.test.mjs` and don't touch `test/run.mjs`. The test agent writes tests. In your report, list the behaviours that need tests.
   - `runtime/batch.ts` belongs to another agent. If batch `read_file` images need a change there, add it under "Hooks for other owners".
2. TODO 2e "Show your work, no duplicate visuals" (spec: Non-negotiables → "User-friendly and transparent", the Show and No duplicate bullets):
   - When `getUnifyFeature('chats.showYourWork')` is on, add a short rule to the agent prompt where the other default prompt lines live (`runtime/media.ts`, next to the send_media lines): show your work visually (screenshots of UI changes, renders, before/after pairs, images of generated assets), text-only only when there's nothing to look at, and never re-send an image the user has already seen; refer to it instead ("the screenshot above").
   - Duplicate tracking is always on, whatever the toggle says. For each chat, keep the set of media sha256 values already shown in that chat: the chat's own send_media, tool images on its rows, its subagents' send_media and tool images that reached it as image blocks.
   - `send_media` with an image already in that set skips displaying it. The tool returns a note instead: `Already shown in this chat by <agent name>; refer to it instead of sending it again.`
   - The subagent's `sentToParent` strip leaves out images that are already inline in the parent chat.
   - Export a pure helper so this can be unit-tested: `createShownMediaTracker()` with `has(chatId, hash)`, `add(chatId, hash, shownBy)`, `shownBy(chatId, hash)` and `forget(chatId)`, in `src/engine/unify/media/shown.ts`.

## Files you own
- `src/engine/unify/media/`
- `src/main/mediaProtocol.ts`
- `src/engine/extension.ts`
- `src/engine/sidebar/provider.ts`
- `src/engine/runtime/media.ts`
- `src/engine/delegate/host.ts`
- `src/engine/delegate/messaging.ts`

## Reference for style
`src/engine/unify/power.ts` (2-space indent, descriptive names, doc comments).

## Extra checks
- `npm run build` prints BUILD_OK.
- `npm test`: report the totals, and note anything you broke.
- In your report, list the fields you actually emit, with the line where each is emitted.
