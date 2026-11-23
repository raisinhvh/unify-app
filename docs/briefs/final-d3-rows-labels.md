# D3: friendly internal tool rows + engine labels without dot separators (Deepseek)

Read `docs/briefs/final-common.md` first and follow it.

## Task A: internal row classifier (TODO 2f2)
Read the spec first: `docs/UNIFY_SPEC.md` → Non-negotiables → "A generic file tool used on app data says what it's really doing".

1. Create a new pure module, `src/engine/unify/internalRows.ts`:
   ```ts
   classifyInternalTool(
     call: { tool: string; input: unknown },
     places: { dataHome: string; projectRoots: string[]; globalVault?: string },
   ): SidebarInternalTool | undefined
   ```
   - It covers only these generic file tools:
     - Read, Grep, Glob, Write, Edit, MultiEdit;
     - the Codex and other providers' equivalent names (check `runtime/toolDisplay.ts` for the names it already maps);
     - batch `read_file`, `search` and `list_dir`.
   - Match the call's path against:
     - `dataHome` (= `unifyHome()`);
     - `<projectRoot>/.unify/`;
     - their `transcripts/` and `memory/` folders;
     - the global vault (the `global-memory` link inside a project, and `<dataHome>/memory`).
   - Results:
     - reading a transcript part → `{ kind: 'history.refresh', label: 'Refreshing earlier conversation' }`;
     - reading memory or the memory index → `{ kind: 'memory.read', label: 'Checking memory' }`;
     - writing or editing memory → `{ kind: 'memory.write', label: 'Saving to memory' }`.
   - `detail` is the note's file name without its extension, when there is a single note.
   - Everything else returns `undefined`.
   - Handle both path separators and case on Windows.
   - Batch calls are classified per child.
   - Also export `isFriendlyRowsEnabled()`, which reads `getUnifyFeature('chat.friendlyInternalRows')`.
   - While the `.dsh` → `.unify` rename is pending, also accept `.dsh/` project folders and `~/.dsh` as data locations. Mark that code with `// rename-pass: drop .dsh` so the rename pass removes it.
2. Call the classifier where tool events are built:
   - In `runtime/toolDisplay.ts`, if the display builder there is the single place that builds tool events, set `internal` on the event and on batch `children`.
   - If events are built in `extension.ts` instead, export a helper from `toolDisplay.ts` and put the exact `extension.ts` call under "Hooks for other owners".
   - Dedicated tools (`read_chat_history`, `checkpoint`, `load_toolpack`, `wait_for_subagents`, `read_file_summaries`) are never classified.

## Task B: engine labels (TODO 2f, Engine)
The UI must never get labels joined with `·`, `•` or `∙` (spec → Visual rules → "No dot separators"). Fix these:
- `accounts/claudeUsage.ts` 14 and 80
- `accounts/codexUsage.ts` 72
- `modelRegistry.ts` 70 (find its folder)
- `goal/runner.ts` 54–99 (`/job` labels)

Run `rg -n "·|•|∙" src/engine` to find the current lines.

How to fix a label:
- Where a label has two parts, return them as separate fields (`{ label, detail }`, or add a `detail` field next to the existing one) and update every engine consumer.
- Where plain words read naturally, use words instead ("Weekly limit for Opus").

Some sites are in `extension.ts`, which you don't own:
- 874–885 (tooltips)
- ~2923 (Smart Auto note)
- ~3301 (model label: send model, effort and speed as separate fields)
- ~3497

For each of these, write the exact replacement under "Hooks for other owners".

If a label type is in `view.ts`, don't edit it. Report the field you need, and keep the old field filled until the contract changes.

## Files you own
- `src/engine/unify/internalRows.ts` (new)
- `src/engine/runtime/toolDisplay.ts`
- `src/engine/accounts/`
- the folder that holds `modelRegistry.ts`
- `src/engine/goal/`

## Reference for style
`src/engine/runtime/toolDisplay.ts`.

## Extra checks
- `npm run build` prints BUILD_OK.
- `npm test` still passes: `tool-display`, `claude-usage`, `codex-usage` and `job`. Update expected strings in those tests only where you changed the label on purpose.
- In your report, list the classifier cases for the test agent.
