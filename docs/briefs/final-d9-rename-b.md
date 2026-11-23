# D9: DSH rename, part B (Deepseek)

Read `docs/briefs/final-common.md` first, then `docs/briefs/final-d7-rename-a.md`. Use its **Naming table** and **Cross-file names** rules exactly; they apply to you too. TODO.md §2g lists known hit sites.

## You own (edit only these)
- `src/engine/accounts/`, `src/engine/hub/`, `src/engine/goal/`, `src/engine/slash/`, `src/engine/toolpacks/`
- `src/engine/update/dshUpdate.ts` (wording becomes "agent runtime"; identifiers `agentRuntime*`; keep the file name, the integrator renames imports later)
- `src/engine/unify/agentBus.ts`, `agentBusImpl.ts`, `internalRows.ts`, `media/`
- `src/engine/runtime/`: `agentShell.ts`, `batch.ts`, `cancellation.ts`, `checkpoint.ts`, `delegation.ts`, `editorContext.ts`, `explorer.ts`, `handoff.ts`, `keepAlive.ts`, `limits.ts`, `media.ts`, `naming.ts`, `rangeEdit.ts`, `selfHosted.ts`, `toolDisplay.ts`
- `docs/contracts/`
- tests in `test/` only where a rename breaks an assertion (a test agent is also editing tests; keep such edits minimal and list them).

Not yours: `extension.ts`, `sidebar/`, `delegate/`, `mcp/`, `unify/requests/`, `unify/power*`, `unify/settings.ts`, `unify/github.ts`, and the runtime files in D7's list. Exported names consumed there get a `// rename-pass: drop alias` alias, and go in your report with the consumer file:line.

## Verify
- `rg -n -i "dsh" <your files>` hits only `@deepseek-ai/dsh`, `DSH_HOME`, the `dshUpdate.ts` file name in imports, and `// rename-pass:` aliases.
- `npm run build` prints BUILD_OK; `npm test` totals (failures in files you don't own: list them, don't fix).
- Report: files changed, cross-file names for the integrator, test counts.
