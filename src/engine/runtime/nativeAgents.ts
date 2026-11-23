import { getUnifyFeature } from '../unify/settings';

/**
 * Providers' own agent systems, turned off so Unify's delegation is the only one (feature agents.blockNativeAgents).
 * Where a provider has no switch, Unify's delegation prompt rule and native-agent detector (delegation.ts) still apply.
 */
export function nativeAgentsBlocked(): boolean {
  return getUnifyFeature('agents.blockNativeAgents');
}

/** Claude Code's native subagent tools, which Unify replaces with delegate_task. */
export const CLAUDE_NATIVE_AGENT_TOOLS = ['Agent', 'Task'];

/** Claude Code's native multi-agent tools; Unify runs subagents and their messages through delegate_task. */
export const CLAUDE_MULTI_AGENT_TOOLS = ['Workflow', 'SendMessage', 'ListAgents'];

/**
 * Codex CLI features that give the model spawn_agent and the other multi-agent tools. `codex --disable <feature>`
 * is the same as `-c features.<feature>=false`. Unify runs ChatGPT accounts through its agent runtime, not the Codex
 * CLI, so these are for any runtime that launches `codex` directly.
 */
export const CODEX_MULTI_AGENT_FEATURES = ['multi_agent', 'multi_agent_v2'];

/** Codex CLI arguments that turn off its multi-agent tools, or none while native agents are allowed. */
export function codexNativeAgentArgs(): string[] {
  if (!nativeAgentsBlocked()) return [];
  return CODEX_MULTI_AGENT_FEATURES.flatMap(feature => ['--disable', feature]);
}
