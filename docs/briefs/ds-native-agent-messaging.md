YOUR FILE LOCKS: ["unify/src/engine/unify/agentBusImpl.ts","unify/src/engine/mcp/","unify/src/engine/runtime/delegation.ts","unify/src/engine/delegate/","unify/test/agent-bus.test.mjs"]

Path note: `unify/` in this working copy is a junction to ../Unify — the same files. Edit through `unify/...` paths (your locks are on those).

You ARE the implementation subagent: Unify NATIVE AGENT MESSAGING owner.

Working copy: DSH (C:/Users/User/Documents/Projects/AI Stuff/Programs/DSH). Unify repo: `unify/` (= ../Unify). `unify/src/engine/` is a copy of DSH's `src/` running inside an Electron app. Read `.dsh/mockups/UNIFY_SPEC.md` (section 'Native agent communication' + Decisions) and the original backend brief `.dsh/briefs-tmp/b2.md` item 5 for context. Backend work is split across 5 parallel agents; YOU own only: `unify/src/engine/unify/agentBusImpl.ts` (new), `unify/src/engine/mcp/` (incl. delegateServer.ts), `unify/src/engine/runtime/delegation.ts`, `unify/src/engine/delegate/`, `unify/test/agent-bus.test.mjs` (new).

Shared contracts (read-only): `unify/src/engine/unify/agentBus.ts` (AgentBus interface — implement it exactly) and `unify/src/engine/unify/settings.ts` (getUnifyFeature('agents.messaging'), getUnifyFeature('agents.messaging.scope') = 'everyone' | 'same-chat' | 'parent-child', getUnifyFeature('agents.maxParallel')).

Build:
1. `agentBusImpl.ts`: `export const agentBus: AgentBus` — in-memory roster + per-agent inbox, scope rules (everyone = any running agent; same-chat = agents with the same chatId; parent-child = only direct parent↔child), clear error messages when messaging is off or the target is out of scope / not running, events for every message and roster change.
2. Register subagents: when a delegate task starts (delegation.ts / delegate host), register it (id = task id, name = profile name, task = first line of the brief, chatId = parent's chat, parentId = parent agent id); update state; unregister when it ends. Top-level chat agents are registered by another agent (extension.ts owner) with id = chatId.
3. MCP tools in delegateServer.ts (same style as existing tools there): `list_agents` (visible agents: id, name, task, chat, parent, state), `send_message` {to, text, reply_to?}, `read_messages` (takes inbox). Also deliver a subagent's inbox automatically at the start of its next turn if the runtime has a hook for injecting text (look at how background task results / ask_questions are delivered and reuse that mechanism). Hide the tools when agents.messaging is off.
4. Enforce agents.maxParallel on concurrent delegate tasks if DSH has a parallel limit already (replace its constant with the feature value); otherwise queue extra tasks.
5. Stall fix from the spec: add a timeout + abort to the fetch calls in delegateServer.ts.
6. Test `unify/test/agent-bus.test.mjs` in the style of the existing tests (check unify/package.json for how tests compile/run): scope rules, inbox, errors.

DSH's existing delegation behaviour must not change. Style: copy delegateServer.ts style, descriptive names, no compressed one-liners in new code. Typecheck the engine as unify/package.json does. No git commits. Stop processes you start. Don't write memory.

Report: files, the MCP tool schemas, how inbox delivery works, test + typecheck output.