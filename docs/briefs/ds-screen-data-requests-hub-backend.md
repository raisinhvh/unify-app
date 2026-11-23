YOUR FILE LOCKS: ["unify/src/engine/unify/requests/","unify/src/engine/hub/","unify/test/hub.test.mjs","unify/test/unify-requests.test.mjs"]

Path note: `unify/` in this working copy is a junction to ../Unify — the same files. Edit through `unify/...` paths (your locks are on those).

You ARE the implementation subagent: Unify SCREEN DATA REQUESTS + HUB BACKEND owner.

Working copy: DSH (C:/Users/User/Documents/Projects/AI Stuff/Programs/DSH). Unify repo: `unify/` (Electron app; `unify/src/engine/` is DSH's `src/` copied; renderer at unify/src/renderer, also reachable as `unify-renderer/`). Read `unify/ARCHITECTURE.md`, `.dsh/mockups/UNIFY_SPEC.md`, and `.dsh/briefs-tmp/b2.md` item 8 for context.

The renderer screens define the engine requests they need. Read every `protocol-requests.md` and every `adapter.ts` / `adapters.ts` / `hubAdapter.ts` under `unify-renderer/screens/` (files, knowledge, hub, toolpacks, providers, settings, setup). Other agents are still finishing those screens, so re-read them near the end and match the latest message types.

YOU own only `unify/src/engine/unify/requests/` (new), `unify/src/engine/hub/` (new), `unify/test/hub.test.mjs`, `unify/test/unify-requests.test.mjs`. Do not edit any other file; the extension.ts owner calls your dispatcher.

Contract you must export from `unify/src/engine/unify/requests/index.ts`:
`export async function handleUnifyRequest(message: { type: string; [key: string]: unknown }, reply: (message: unknown) => void, context: { workspaceRoot: string | undefined }): Promise<boolean>` — returns true when it handled the message type, false otherwise. Reply messages echo the request's `requestId` if it has one.

Implement, using existing engine modules wherever DSH already has the logic (instructions/, summaries/, toolpacks/, accounts/, runtime/dependencies.ts) instead of rewriting it:
- Files: tree listing (lazy per folder, ignore node_modules/.git), read file, write file, watch notifications if the screens ask for them.
- Knowledge: list/read/create/update/delete rules, skills, memory with audiences (Everyone / Main agent / Subagents / profile), import a skill folder.
- Toolpacks/Providers/Settings/Setup: whatever their protocol-requests ask for that the existing sidebar protocol (unify/src/engine/sidebar/view.ts) doesn't already provide (e.g. tools check + fix actions via runtime/dependencies.ts, per-model enable toggles, account labels, setup-complete flag stored in ~/.unify/).
- Hub (`engine/hub/`): `HubRegistry` interface (list/search packs, pack detail, install = download + run its install script, publish), a GitHub implementation for registry repo `raisinhvh/unify-hub` (index JSON + releases) that is NOT used by default, and a local fake registry (fixtures under engine/hub/fixtures) used in dev. NEVER contact GitHub, create a repo, or publish anything.
- Tests: node tests in the style of unify/test (check unify/package.json for how tests compile/run) for the dispatcher and the fake hub.

Typecheck the engine as unify/package.json does. Style: match engine files (2-space), descriptive names, no compressed one-liners. No git commits. Stop processes you start. Don't write memory.

Report: every message type handled (exact TS request/reply types), which screen asked for it, anything the screens asked for that you could not implement, test + typecheck output.