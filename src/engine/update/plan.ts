export interface AgentRuntimeOffer { current: string; latest: string }
export interface UpdateOffer { agentRuntime?: AgentRuntimeOffer }
export interface UpdatePlan {
  agentRuntime?: AgentRuntimeOffer;
}

/** One decision for the agent runtime updater. Returns undefined when there is nothing to offer. */
export function planUpdates(
  offer: UpdateOffer,
  options: { promptOptional: boolean; skippedAgentRuntime?: string },
): UpdatePlan | undefined {
  const { agentRuntime } = offer;
  if (!options.promptOptional) return undefined;
  if (agentRuntime && agentRuntime.latest !== options.skippedAgentRuntime) return { agentRuntime };
  return undefined;
}
