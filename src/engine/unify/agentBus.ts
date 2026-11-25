/**
 * Native agent communication — shared contract (owner: main agent; implementation: messaging owner).
 *
 * Every running agent (top-level chat agent or subagent) registers here. Any agent can list the
 * others and message them: parent ↔ child, sibling ↔ sibling, and top-level agents in other chats,
 * limited by the 'agents.messaging.scope' feature (see ./settings.ts). Messages are delivered into
 * the recipient's next turn (or read on demand via MCP read_messages).
 *
 * The extension/sidebar owner subscribes with onAgentBusEvent and forwards each event to the UI as:
 *   engine → UI: { type: 'agentMessage'; chatId: string; message: AgentMessage }
 *   engine → UI: { type: 'agentRoster'; agents: AgentInfo[] }
 */

export interface AgentInfo {
  /** Stable id: the chat id for top-level agents, the delegate task id for subagents. */
  id: string;
  /** Exclusive display name from the name pool, e.g. "Kernel", "Arp" (see agentNames.ts). No two running agents share one. */
  name: string;
  /** What the agent is: "main" for a top-level chat agent, the subagent profile name (e.g. "explorer") otherwise. */
  role?: string;
  /** Short description of the current task. */
  task: string;
  /** Chat the agent belongs to (top-level agents: their own chat id). */
  chatId: string;
  /** Parent agent id; undefined for top-level agents. */
  parentId?: string;
  state: 'running' | 'waiting' | 'idle';
}

export interface AgentMessage {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  text: string;
  /** Set when this message answers another one. */
  replyToId?: string;
  /** Epoch milliseconds. */
  sentAt: number;
}

export type AgentBusEvent =
  | { kind: 'message'; message: AgentMessage }
  | { kind: 'roster'; agents: AgentInfo[] };

/** What register() takes: `name` is only a preference (e.g. the chat's saved name); the bus picks a free one. */
export type AgentRegistration = Omit<AgentInfo, 'name'> & { name?: string };

export interface AgentBus {
  /** Adds (or re-adds) an agent and returns the exclusive name it got. */
  register(agent: AgentRegistration): string;
  update(agentId: string, patch: Partial<Omit<AgentInfo, 'id'>>): void;
  /** Unregistering frees the agent's name for the next agent. */
  unregister(agentId: string): void;
  /** The running agent's name, or undefined once it has stopped. */
  nameOf(agentId: string): string | undefined;
  /** Agents the given agent may see/message under the current scope. */
  listVisible(fromAgentId: string): AgentInfo[];
  /** Throws an Error with a user-readable message when messaging is off or out of scope. */
  send(fromAgentId: string, toAgentId: string, text: string, replyToId?: string): AgentMessage;
  /** Undelivered messages for an agent; marks them delivered. */
  takeInbox(agentId: string): AgentMessage[];
  /** Whether the agent has undelivered messages, without taking them. */
  hasInbox(agentId: string): boolean;
  onEvent(listener: (event: AgentBusEvent) => void): () => void;
}
