# D2: range-scoped reading/editing and explorer ranges (Deepseek)

Read `docs/briefs/final-common.md` first and follow it.

Spec: `docs/UNIFY_SPEC.md` → Decisions → "Range-scoped reading and editing" and "Explorer is not shown as a subagent". TODO 2b.

## Task
1. **Explorer ranges** (`agents.explorerRanges`, read with `getUnifyFeature` from `src/engine/unify/settings.ts`):
   - When the toggle is on, the explorer's prompt in `runtime/explorer.ts` asks it to end its answer with a fenced block:
     ````
     ```ranges
     path:startLine-endLine why
     ```
     ````
     Use one line per range.
   - Export `parseExplorerRanges(answer: string): { text: string; ranges: SidebarExplorerRange[] }`. `text` is the answer with the block removed. The function:
     - merges overlapping or touching ranges in the same file;
     - keeps the first `why`;
     - caps the list at 12;
     - drops malformed lines.

     `SidebarExplorerRange` is in `src/engine/sidebar/view.ts`.
   - Export `formatExplorerRanges(ranges)`. It returns the compact text block that goes into the `delegate_task` result for the main agent, so the main agent can read exactly those ranges next.
   - The call site is in `extension.ts`, which you don't own. Write the hook in your report. It must:
     - put the formatted ranges into the explorer's `delegate_task` result;
     - post `subagentEvent` with `profile: 'explorer'` from the start of the run;
     - post `ranges` and `tokens` when it completes.
2. **`read_file` ranges** (`tools.rangeEdits`):
   - `read_file` keeps `offset` / `limit` and also accepts `ranges: [{ startLine, endLine }]`.
   - It adds 2 lines of context around each range and merges overlaps.
   - It labels each part with its line numbers, and each part carries a short content hash: the first 12 hex characters of the sha256 of the exact lines in the range. `edit_range` can accept that hash as `expected`.
   - Do this for batch `read_file` (`runtime/batch.ts`) and for the MCP read_file tool, wherever it's defined (find it under `src/engine/mcp/` or `src/engine/delegate/`; report if it's in a file you don't own).
3. **`edit_range`** (new tool, `tools.rangeEdits`):
   - Signature: `edit_range { path, startLine, endLine, expected?, replacement }`.
   - Put the logic in a new pure module `src/engine/runtime/rangeEdit.ts`: `applyRangeEdit(fileText, request) → { ok: true; text; startLine; endLine } | { ok: false; error }`.
   - `expected` is either the exact current text of those lines or the 12-hex hash from the read.
   - If it doesn't match, re-anchor once: search the file for the expected text (exact match only; with a hash, check nearby windows of the same length) and apply there if there's exactly one match. Otherwise fail loudly with a clear error that shows the current lines.
   - Register the tool next to the other Unify tools (`mcp/delegateServer.ts`). It writes through the same path the existing edit tools use, so edits still show up for review.
   - When the toggle is off, the tool isn't listed.
4. **Delegation prompt text** (`runtime/delegation.ts`):
   - Explain to the main agent that the explorer returns ranges.
   - Tell it to read and edit those ranges with `read_file ranges` / `edit_range`.
   - Change the rule "read a file natively right before editing it" so that reading the range you're editing counts.
   - Keep the wording style that's already in that file.

## Files you own
- `src/engine/runtime/explorer.ts`
- `src/engine/runtime/batch.ts`
- `src/engine/runtime/delegation.ts`
- `src/engine/runtime/rangeEdit.ts` (new)
- `src/engine/mcp/`

## Reference for style
`src/engine/runtime/batch.ts`.

## Extra checks
- `npm run build` prints BUILD_OK.
- `npm test` must still pass, especially `explorer`, `batch` and `delegation`; update expected prompt strings in those tests only if you changed the prompt on purpose.
- In your report, list the cases the test agent must cover:
  - a stale `expected` fails;
  - moved lines re-anchor;
  - overlapping ranges merge;
  - the cap of 12;
  - a malformed block;
  - a toggle off.
