YOUR FILE LOCKS: ["unify/src/engine/extension.ts","unify/src/engine/sidebar/","unify-renderer/dev/mockBridge.ts","unify/ARCHITECTURE.md"]

Path note: `unify/` in this working copy is a junction to ../Unify — the same files. Edit through `unify/...` paths (your locks are on those); `../Unify/...` below means the same files.

You ARE the implementation subagent: Unify BACKEND CORE owner.

Working copy: DSH (C:/Users/User/Documents/Projects/AI Stuff/Programs/DSH). Unify repo: ../Unify. The renderer folder `unify-renderer/` is a junction to ../Unify/src/renderer. Read the original backend brief at `.dsh/briefs-tmp/b2.md` for context, plus `../Unify/ARCHITECTURE.md` and `.dsh/mockups/UNIFY_SPEC.md`. That backend work is now split across 5 parallel agents; YOU own only: `src/engine/extension.ts`, `src/engine/sidebar/` (view.ts protocol, provider.ts), `unify-renderer/dev/mockBridge.ts`, `ARCHITECTURE.md`.

Shared contracts (written by the main agent, read-only for you): `src/engine/unify/settings.ts` (getUnifyFeature / setUnifyFeature / allUnifyFeatures / onUnifyFeatureChange) and `src/engine/unify/agentBus.ts` (AgentBus interface, AgentInfo, AgentMessage). Another agent implements the bus in `src/engine/unify/agentBusImpl.ts` exporting `export const agentBus: AgentBus`. Another implements screen data requests in `src/engine/unify/requests/index.ts` exporting `export async function handleUnifyRequest(message: { type: string; [key: string]: unknown }, reply: (message: unknown) => void, context: { workspaceRoot: string | undefined }): Promise<boolean>` (true = handled). Import both; if their files don't exist yet when you typecheck, that's expected — keep your import paths and signatures exact.

Your items (keep message shapes backward-compatible, additive only; DSH's agent behaviour must not change):
1. Multi-chat: honour optional `chatId` on UI→engine messages so each pane talks to its own chat; several chats run at once (one runtime per chat). Engine→UI messages that concern a chat carry its chatId/sessionId.
2. Send `session.project` (project folder per session, to group chats) and `usage.plan` (what DSH's usage maths reads); accept `newSession.project`.
3. 'Always allow' on approval rows: new reply option that persists an allow rule per command prefix per project (store under ~/.dsh/unify/), and auto-approves matching later requests.
4. Feature toggles: handle `{ type: 'setUnifyFeature'; id: string; value: boolean | number | string }` via setUnifyFeature, and mirror allUnifyFeatures() into the view state as `unifyFeatures` (NOT `features` — that name is DSH's own toggles and stays as is). Make notifications.desktop real (another agent adds `window.unify.notify` / main-process Notification IPC; from the engine use whatever the shim exposes, else document the needed hook in ARCHITECTURE.md). Make knowledge.agentWrites real where agent memory/skill writes are approved in extension.ts.
5. Agent messaging UI side: register each top-level chat agent with agentBus (id = chatId, name 'Main', task = chat title), update state on run/idle, unregister on close; subscribe agentBus.onEvent and post `{ type: 'agentMessage'; chatId; message }` and `{ type: 'agentRoster'; agents }` to the UI. When a top-level agent has inbox messages at the start of its next turn, prepend them to its prompt as a clearly marked block.
6. Route every unknown UI message through handleUnifyRequest before the existing 'unknown message' fallback.
7. Stall fix: add a timeout to askInChat (spec lists it) so a lost reply can't hang a turn forever.
8. Update `unify-renderer/dev/mockBridge.ts` so the renderer dev mock supports chatId, unifyFeatures + setUnifyFeature, agentMessage/agentRoster, approvals 'always allow'.
9. Document every protocol addition (exact TS types) in ARCHITECTURE.md.

Verify: typecheck the engine the way ../Unify/package.json does; run the DSH tests under ../Unify/test that touch your files. Style: copy extension.ts's existing style, descriptive names, no compressed one-liners in NEW code. No git commits. Stop every process you start. Don't write memory.

Report: per item done/partial/blocked with file:line, the exact protocol TS types added, test/typecheck output.