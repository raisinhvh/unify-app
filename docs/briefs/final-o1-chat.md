# O1: chat timeline — images, Explored rows, internal rows, agent messages, Always allow (Opus)

Read `docs/briefs/final-common.md` and `docs/briefs/final-o-common.md` first. Vite port **5181**.

## Task
1. **Images in chat.** Build everything in `docs/briefs/ds-media-chat-ui.md`, with these changes:
   - The protocol types are already in `src/engine/sidebar/view.ts` and re-exported from `src/renderer/protocol.ts`. Don't edit either; if you need a type, report it.
   - The store (`src/renderer/store/index.ts`) already merges `media`, `sentToParent` and message `media`. Don't edit it.
   - The engine agent is building the engine side right now; drive everything from the mock bridge (`src/renderer/dev/mockBridge.ts`).
   - **Duplicate rule** (spec: "No duplicate visuals"): the subagent image strip leaves out images whose `hash` already shows inline in the parent chat.
2. **Explorer is not a subagent.** Spec: Decisions → "Explorer is not shown as a subagent".
   - A subagent with `profile === 'explorer'` renders as an inline tool-style row titled "Explored", with the question as its title text (`prompt` or `title`). Use the search/lens loader while it runs (the loaders live in `src/renderer/components/loaders/`).
   - When it completes, `ranges` show as compact `file:line–line` chips. Show the file name; the full path goes in a tooltip.
   - Clicking a chip posts `{ type: 'openFile', path, line: startLine }` for now. The editor bridge comes later.
   - Explorer runs get no subagent chat tab, no image strip and no "who → who" label, and they're left out of subagent counts and roster badges (search `screens/chats/` for where subagents are counted).
   - `tokens` shows as muted text on the row once complete.
   - Feature: `agents.explorerRanges` only affects the chips. The row style is always used for explorer runs.
3. **Internal rows.** Spec: Non-negotiables → "A generic file tool used on app data says what it's really doing".
   - A tool event (or batch child, or `SidebarSubagentTool`) with `internal` shows `internal.label`, plus `internal.detail` muted, instead of the raw title.
   - Each kind gets its own icon and loader:
     - `history.refresh`: a history/rewind feel;
     - `memory.read`: a lookup;
     - `memory.write`: a save.
   - The row still expands to the raw call and its result, as other rows do.
   - The engine decides; the renderer has no path rules of its own.
4. **Agent messages.** Timeline items with `kind: 'agentMessage'` render as a quiet row: `fromName → toName` and the text, collapsed to 2 lines, expanding on click. Hidden when `agents.messaging.showInChat` is off. Use `→` (an arrow is fine; it isn't a dot separator).
5. **Always allow.**
   - Pending approval rows get a third action, "Always allow", next to Allow/Reject. It posts `{ type: 'approvalResponse', id, allow: true, always: true }`. Find how Allow posts today and copy it.
   - Text buttons, no pills.
6. **Mock fixtures.** Add to the mock bridge, next to the media fixtures from the old brief:
   - an explorer run, running then complete with 4 ranges;
   - a batch call that mixes an internal memory read with a normal file read;
   - a `memory.write` row;
   - two agent messages;
   - a pending approval.

## Files you own
- `src/renderer/screens/chats/Timeline.tsx` and `src/renderer/screens/chats/timeline.css`
- `src/renderer/screens/chats/QuestionRow.tsx`
- new `src/renderer/screens/chats/*` files you create
- `src/renderer/components/Media*` (new)
- `src/renderer/dev/`
- `src/renderer/tools/fixtures/`

Edit `ChatPane.tsx` and `Composer.tsx` only if you can't avoid it; another agent swaps the model picker into them in the next wave. Don't touch `components/loaders/`; another agent is reworking loaders next wave. Use the loaders as they are.

## Reference for style
`src/renderer/screens/chats/Timeline.tsx` (tabs, one property per line, descriptive names).

## Screenshots
Save the finals to `src/renderer/screens/chats/__screens__/`:
- `media-*.png` (as the old brief lists)
- `explored-*.png`
- `internal-*.png`
- `agent-message-*.png`
- `approval-*.png`

Take each in Walnut Dark and Walnut Light.
