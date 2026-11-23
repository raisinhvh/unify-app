YOUR FILE LOCKS: ["unify/src/engine/runtime/oauthCli.ts","unify/src/engine/runtime/acp.ts","unify/src/engine/runtime/codex.ts","unify/src/engine/runtime/cursor.ts","unify/src/engine/runtime/opencode.ts","unify/src/engine/runtime/nativeAgents.ts","unify/src/engine/summaries/"]

Path note: `unify/` in this working copy is a junction to ../Unify — the same files. Edit through `unify/...` paths (your locks are on those).

You ARE the implementation subagent: Unify PROVIDER NATIVE-AGENT BLOCKING + STALL FIXES owner.

Working copy: DSH (C:/Users/User/Documents/Projects/AI Stuff/Programs/DSH). Unify repo: `unify/`; `unify/src/engine/` is a copy of DSH's `src/`. Read `docs/UNIFY_SPEC.md` (Decisions: disable providers' own agent systems; the list of ~30s tool-call stalls) and `docs/briefs/b2.md` items 6 and 7 for context. Backend work is split across 5 parallel agents; YOU own only: `unify/src/engine/runtime/oauthCli.ts`, `runtime/acp.ts`, the Codex / Cursor / OpenCode runtime files if they exist under `runtime/` with the names codex.ts / cursor.ts / opencode.ts (list the folder first; if the code lives in files with other names, tell me in the report instead of editing them — except you may create `runtime/nativeAgents.ts`), and `unify/src/engine/summaries/`. Do NOT edit runtime/delegation.ts, extension.ts, sidebar/, mcp/.

Shared contract (read-only): `unify/src/engine/unify/settings.ts` — use getUnifyFeature('agents.blockNativeAgents').

1. Native agent blocking, gated on agents.blockNativeAgents (default true): Claude Code already passes --disallowedTools for Agent/Task/SendMessage/etc. in oauthCli.ts — make that list come from one place (`runtime/nativeAgents.ts`) and skip it when the feature is off. For Codex: find the real CLI config/feature flag that disables its multi-agent / spawn_agent tools (check on this machine: `codex --help`, `codex features list` if available, codex config docs) and pass it. Same research for Cursor agent CLI and OpenCode. Only use flags you verified exist; record what you verified and how. Keep DSH's prompt rule + native-agent detector as the fallback.
2. Stall fixes: acp.ts 30s init wait (resolve as soon as the process is ready, with a sane overall timeout), summaries/store.ts around line 151 (the spec names it — add a timeout so a slow summary can't block a tool call). Check the spec for any other listed stall in your files.

Typecheck the engine as unify/package.json does; run the existing tests in unify/test touching your files (e.g. claude-args.test.mjs). DSH behaviour must otherwise be unchanged. Style: match the surrounding file, descriptive names, no compressed one-liners in new code. No git commits. Stop processes you start. Don't write memory.

Report: per provider what flag/config you verified (with evidence), file:line changes, test + typecheck output.