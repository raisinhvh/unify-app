# D7: DSH rename, part A (folders no one else owns)

Read `docs/briefs/final-common.md` first, then TODO.md section "2g. Remove every trace of DSH" and the spec non-negotiable "Unify is its own thing" in `docs/UNIFY_SPEC.md`. This is a full rename with no DSH compatibility (the user migrates old data themselves). Exception: the `@deepseek-ai/dsh` runtime package keeps its real package/binary names (see Naming table).

## Naming table (shared by every rename agent; don't deviate)
| DSH | Unify |
|---|---|
| `~/.dsh` (data home) | `unifyHome()` from `src/engine/unify/settings.ts` (`UNIFY_HOME` or `~/.unify`) |
| project folder `.dsh/` | `.unify/` |
| `DSH_*` env vars | `UNIFY_*` (same suffix) |
| `DSH_HOME` given to the runtime package | stays named `DSH_HOME` (the package reads it) but points at `path.join(unifyHome(), 'agent-runtime')` |
| `x-dsh-token` | `x-unify-token` |
| MCP server `dsh-delegate`, tools `mcp__dsh-delegate__*` | `unify`, `mcp__unify__*` |
| sync repo/gist/markers `dsh-sync`, `dsh-config` | `unify-sync`, `unify-config` |
| `.dsh-shared.json`, `.dsh-trim` | `.unify-shared.json`, `.unify-trim` |
| User-Agent / clientInfo `dsh-ide` | `unify` |
| identifiers `Dsh*` / `dsh*` | `Unify*` / `unify*`; the runtime-package parts become `agentRuntime*` |
| "DSH" in user- or agent-facing text | "Unify" (or "the agent runtime" when it means the package) |
| "Reload Window", "DSH: Restart Runtime", workspace trust wording | Unify actions ("Restart Unify", "Restart agent runtime") |

## You own (edit only these)
- `src/engine/sync/`, `src/engine/instructions/`, `src/engine/review/`, `src/engine/summaries/`, `src/engine/voice/`
- `src/engine/sidebar/allowRules.ts`
- `src/engine/runtime/`: `acp.ts`, `dependencies.ts`, `git.ts`, `imageGen.ts`, `imageTrim.ts`, `memory.ts`, `midTurnCompact.ts`, `models.ts`, `nativeAgents.ts`, `oauthCli.ts`, `piAi.ts`, `priority.ts`, `promptPrefix.ts`, `rustTools.ts`, `shadow.ts`, `smartAuto.ts`, `transcriptParts.ts`
- the tests that cover those files (`test/*.test.mjs`) only where a rename breaks an assertion.

## Cross-file names (careful)
Other agents are editing `extension.ts`, `mcp/`, `delegate/`, `accounts/`, `hub/`, `unify/requests/`, `unify/media/` and other runtime files right now. For any name that is **produced in a file you own and consumed in a file you don't** (or the reverse) — env vars, headers, MCP server/tool names, exported identifiers, settings keys — do the rename on your side only when you can keep both sides working: export the new name and keep a temporary alias with the comment `// rename-pass: drop alias`, or read both env names. List every such name in your report with the exact consumer file:line so the integrator finishes it.

Remove legacy-DSH fallbacks in your files (reading `~/.dsh`, old sync formats, `.dsh` project folders); there is no compatibility.

## Verify
- `rg -n -i "dsh" <your files>` hits only the runtime-package adapter names (`@deepseek-ai/dsh`, `DSH_HOME`) and `// rename-pass:` aliases.
- `npm run build` gives BUILD_OK and `npm test` passes (esbuild needs to spawn; if the sandbox blocks it with EPERM, request wider access).
- Report: files changed, cross-file names left for the integrator, and test counts.
