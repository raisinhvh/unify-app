You ARE the implementation subagent. Build the chat UI for Unify's images. Do not redesign; if the contract is wrong, report it.

Repo: the Unify app, reached from this working copy as `unify/` (repo root) and `unify-renderer/` (= `unify/src/renderer`). Use those paths.

## Read first
- `unify/docs/UNIFY_SPEC.md` → Decisions → "Images are first-class", plus Visual rules and Motion.
- `unify/docs/contracts/media.md`: the protocol fields you render (`SidebarToolEvent.media`, `SidebarSubagentTool.media`, subagent `messages[i].media`, `SidebarSubagent.sentToParent`). An engine agent is building the engine side in parallel; until it lands, drive everything from the mock bridge.
- `unify-renderer/screens/chats/Timeline.tsx` (reference for style: tabs, one property per line, descriptive names): `MediaEntry`, `SubagentEntry`, `SubagentFeed`.
- `unify-renderer/store/features.ts`: `chats.toolImages`, `chats.subagentImageStrip`.
- Motion skill: `C:\Users\User\AppData\Roaming\Code\User\globalStorage\dsh-local.dsh-ide\oauth\claude-cli\0ed19977-7119-4a05-86e1-210a0ab6b9c1\skills\apple-design\SKILL.md`. Use the renderer's existing spring engine (`unify-renderer/motion/`), never CSS keyframes or a new animation library.

## Build
1. `unify-renderer/protocol.ts`: mirror the contract's type additions.
2. **Tool-row thumbnails** (main feed and subagent feed): a tool row whose event has `media` shows small thumbnails (about 40 px tall, rounded 4 px, hairline border) after its title. Click expands that image in place under the row (springs open to fit width, max ~360 px tall); click again or Esc collapses. Hidden when `chats.toolImages` is off.
3. **Subagent feed**: a message with `media` renders as an inline media entry at that point in the feed (reuse `MediaEntry`'s look).
4. **Subagent row in the parent chat**: when the subagent has `sentToParent` and is finished, the row grows a compact strip under its title: "N images" label plus up to 4 small thumbnails and "+K". Clicking a thumbnail expands it in place inside the row; an expanded image's own click opens the full viewer. While it runs, thumbnails appear one by one as they arrive (each pops in with a soft spring). Hidden when `chats.subagentImageStrip` is off; the row then looks exactly as it does today.
5. **Full viewer**: one shared overlay component (in `unify-renderer/components/`) layered over the app: the image scales up from its thumbnail's position (shared-element style spring), dark scrim, arrow keys step through the images of that group, Esc / click outside closes back into the thumbnail. Name + sender caption in the UI font at the bottom.
6. Use `media.file` (`unify-media://<hash>`) for originals and `?thumb=1` for thumbnails. In the mock bridge, use data URLs or files under `unify-renderer/dev/` so previews work without the engine.
7. `unify-renderer/dev/mockBridge.ts`: add fixtures: a main tool row with two images, a running subagent that sends images over time, a finished subagent with 6 sent images, and a subagent feed with a send_media message.

## Look and feel
File-system look, Walnut themes, monochrome accent, no pills, no glow, no dots or sparkles. Thumbnails feel like small physical prints: quiet, flat, hairline-edged. Expanding should feel like the image grows out of where it sat, never a jump or fade from nowhere; collapsing returns it to the same place. Interruptible springs (retarget from the current value). Reduced motion → crossfade.

## Verify
- Renderer tsc from `unify-renderer` (only the known `dependencies.ts(71,33)` error allowed besides other agents' folders).
- Screenshots with `unify-renderer/tools/shot.mjs` in Walnut Dark and Walnut Light: main tool row thumbnails, an expanded one, the subagent strip, the subagent feed, the viewer open. Save the finals to `unify-renderer/screens/chats/__screens__/media-*.png`; delete any other temp images.
- Run `unify/.dsh/tools/motion-audit.mjs` on expand/collapse and the viewer open/close; fix snaps or layout jumps.
- Stop vite / Edge / node you started.
- Report: files changed, what each toggle hides, screenshots paths, anything the contract lacked.
