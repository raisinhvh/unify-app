/**
 * Native agent messaging — implementation of the shared AgentBus contract.
 *
 * The roster and every agent's inbox live in memory in the engine process. Scope rules are read
 * from the Unify feature settings on every call, so changing 'agents.messaging' or
 * 'agents.messaging.scope' in Settings takes effect immediately.
 */
import { randomUUID } from 'node:crypto';
import type { AgentBus, AgentBusEvent, AgentInfo, AgentMessage, AgentRegistration } from './agentBus';
import { pickAgentName } from './agentNames';
import { getUnifyFeature, type AgentMessagingScope } from './settings';

type AgentBusListener = (event: AgentBusEvent) => void;

/** Each inbox keeps only the newest messages, so a long-running agent cannot grow it forever. */
const MAX_INBOX_MESSAGES = 100;

const roster = new Map<string, AgentInfo>();
const inboxes = new Map<string, AgentMessage[]>();
const listeners = new Set<AgentBusListener>();

function emit(event: AgentBusEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error('agentBus listener failed:', error);
    }
  }
}

function emitRoster(): void {
  emit({ kind: 'roster', agents: [...roster.values()].map(agent => ({ ...agent })) });
}

function messagingEnabled(): boolean {
  return getUnifyFeature('agents.messaging');
}

function assertMessagingEnabled(): void {
  if (!messagingEnabled()) {
    throw new Error('Agent-to-agent messaging is turned off in Settings (agents.messaging).');
  }
}

function currentScope(): AgentMessagingScope {
  const scope = getUnifyFeature('agents.messaging.scope');
  if (scope === 'same-chat' || scope === 'parent-child') return scope;
  return 'everyone';
}

function isDirectParentOrChild(from: AgentInfo, to: AgentInfo): boolean {
  return to.parentId === from.id || from.parentId === to.id;
}

function inScope(from: AgentInfo, to: AgentInfo): boolean {
  switch (currentScope()) {
    case 'same-chat':
      return from.chatId === to.chatId;
    case 'parent-child':
      return isDirectParentOrChild(from, to);
    default:
      return true;
  }
}

function outOfScopeError(from: AgentInfo, to: AgentInfo): string {
  if (currentScope() === 'same-chat') {
    return `"${to.name}" is in a different chat, and agents.messaging.scope is set to "same-chat".`;
  }
  return `"${to.name}" is not your direct parent or child, and agents.messaging.scope is set to "parent-child".`;
}

function requireAgent(agentId: string): AgentInfo {
  const agent = roster.get(agentId);
  if (!agent) throw new Error(`No running agent has id "${agentId}". Call list_agents to see who is available.`);
  return agent;
}

/** Adds a message to an inbox, dropping the oldest when the inbox is full. */
function deliver(toId: string, message: AgentMessage): void {
  const inbox = inboxes.get(toId) ?? [];
  inbox.push(message);
  if (inbox.length > MAX_INBOX_MESSAGES) inbox.splice(0, inbox.length - MAX_INBOX_MESSAGES);
  inboxes.set(toId, inbox);
  emit({ kind: 'message', message: { ...message } });
}

/** Tells each sender that a stopped agent never read their message. */
function returnUndelivered(stopped: AgentInfo, messages: AgentMessage[]): void {
  for (const message of messages) {
    const sender = roster.get(message.fromId);
    if (!sender) continue;
    deliver(sender.id, {
      id: randomUUID(),
      fromId: stopped.id,
      fromName: stopped.name,
      toId: sender.id,
      toName: sender.name,
      text: `Message not delivered: "${stopped.name}" stopped before reading it. Your message was: ${message.text}`,
      sentAt: Date.now(),
      replyToId: message.id,
    });
  }
}

/** Whether a running agent other than `exceptId` already has this name (case-insensitive). */
function nameTaken(name: string, exceptId: string): boolean {
  const wanted = name.toLowerCase();
  for (const agent of roster.values()) {
    if (agent.id !== exceptId && agent.name.toLowerCase() === wanted) return true;
  }
  return false;
}

export const agentBus: AgentBus = {
  register(agent: AgentRegistration): string {
    if (!agent.id) throw new Error('An agent needs an id before it can be registered.');
    // Re-registering keeps the current name; otherwise the preferred name when free, else a fresh one.
    const preferred = roster.get(agent.id)?.name ?? agent.name;
    const name = pickAgentName(candidate => nameTaken(candidate, agent.id), preferred);
    roster.set(agent.id, { ...agent, name });
    if (!inboxes.has(agent.id)) inboxes.set(agent.id, []);
    emitRoster();
    return name;
  },

  update(agentId: string, patch: Partial<Omit<AgentInfo, 'id'>>): void {
    const agent = roster.get(agentId);
    if (!agent) return;
    Object.assign(agent, patch);
    emitRoster();
  },

  unregister(agentId: string): void {
    const agent = roster.get(agentId);
    if (!agent || !roster.delete(agentId)) return;
    const undelivered = inboxes.get(agentId) ?? [];
    inboxes.delete(agentId);
    // Deliver the bounce before the roster event so the roster stays the last thing listeners see.
    returnUndelivered(agent, undelivered);
    emitRoster();
  },

  nameOf(agentId: string): string | undefined {
    return roster.get(agentId)?.name;
  },

  listVisible(fromAgentId: string): AgentInfo[] {
    assertMessagingEnabled();
    const from = requireAgent(fromAgentId);
    return [...roster.values()].filter(agent => agent.id !== from.id && inScope(from, agent)).map(agent => ({ ...agent }));
  },

  send(fromAgentId: string, toAgentId: string, text: string, replyToId?: string): AgentMessage {
    assertMessagingEnabled();
    if (!text || !text.trim()) throw new Error('A message needs some text.');
    if (fromAgentId === toAgentId) throw new Error('An agent cannot message itself.');
    const from = requireAgent(fromAgentId);
    const to = requireAgent(toAgentId);
    if (!inScope(from, to)) throw new Error(outOfScopeError(from, to));
    const message: AgentMessage = {
      id: randomUUID(),
      fromId: from.id,
      fromName: from.name,
      toId: to.id,
      toName: to.name,
      text: text.trim(),
      sentAt: Date.now(),
      ...(replyToId ? { replyToId } : {}),
    };
    deliver(to.id, message);
    return message;
  },

  takeInbox(agentId: string): AgentMessage[] {
    const inbox = inboxes.get(agentId);
    if (!inbox || !inbox.length) return [];
    inboxes.set(agentId, []);
    return inbox.splice(0, inbox.length).map(message => ({ ...message }));
  },

  onEvent(listener: AgentBusListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
