/**
 * Engine side of native agent messaging: maps MCP owners to agent ids, keeps subagent registrations
 * in the bus, and turns bus operations into the text the MCP tools return.
 *
 * The extension owns top-level chat agents (id = chat id). It binds each chat's MCP owner with
 * bindChatAgentOwner(), so a delegate task started from that chat can find its parent. Subagents are
 * registered here by runSubagentCore(), through registerSubagentAgent() / unregisterSubagentAgent().
 */
import { agentBus } from '../unify/agentBusImpl';
import type { AgentInfo } from '../unify/agentBus';
import { getUnifyFeature } from '../unify/settings';
import { formatAgentMessages, LIST_AGENTS_TOOL, READ_MESSAGES_TOOL, SEND_MESSAGE_TOOL } from './messagingProtocol';

export interface AgentToolResult {
    text: string;
    isError?: boolean;
}

export interface SubagentAgentRegistration {
    /** Delegate task id (background tasks) or the child run's owner id. */
    id: string;
    /** The MCP bridge owner id this subagent's tools report. */
    owner: string;
    /** Subagent profile (e.g. "explorer"); the agent's own name comes from the name pool. */
    profile: string;
    task: string;
    chatId: string;
    parentId: string;
}

/** MCP owner id (chat owner or subagent owner) to the agent id registered in the bus. */
const agentIdByOwner = new Map<string, string>();

/**
 * Messages the user typed to a subagent whose runtime cannot take mid-turn input. They ride on its next
 * Unify tool result like bus mail, but work with agents.messaging off and are not bounced to a sender.
 */
const userInboxes = new Map<string, string[]>();

export function queueUserMessage(agentId: string, text: string): void {
    const inbox = userInboxes.get(agentId) ?? [];
    inbox.push(text);
    userInboxes.set(agentId, inbox);
}

/** Drains the user's messages for an agent (also used to find the ones it never read). */
export function takeUserMessages(agentId: string): string[] {
    const inbox = userInboxes.get(agentId) ?? [];
    userInboxes.delete(agentId);
    return inbox;
}

function userMessagesBlock(agentId: string): string {
    const messages = takeUserMessages(agentId);
    return messages.length ? `Messages from the user:\n${messages.map(text => `- ${text}`).join('\n')}` : '';
}

export function messagingEnabled(): boolean {
    return getUnifyFeature('agents.messaging');
}

/** The first line of a brief, short enough for a roster row. */
export function summarizeTask(brief: string): string {
    const firstLine = (brief.split(/\r?\n/).find(line => line.trim()) || '').trim().replace(/\s+/g, ' ');
    return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
}

export function bindChatAgentOwner(ownerId: string, agentId: string): void {
    if (!ownerId || !agentId) return;
    agentIdByOwner.set(ownerId, agentId);
}

export function unbindChatAgentOwner(ownerId: string): void {
    agentIdByOwner.delete(ownerId);
}

export function agentIdForOwner(ownerId: string): string | undefined {
    return agentIdByOwner.get(ownerId);
}

/** Registers a delegate task as a running subagent, binds its MCP owner and returns the exclusive name it got. */
export function registerSubagentAgent(registration: SubagentAgentRegistration): string {
    const name = agentBus.register({
        id: registration.id,
        role: registration.profile,
        task: summarizeTask(registration.task),
        chatId: registration.chatId,
        parentId: registration.parentId,
        state: 'running',
    });
    bindChatAgentOwner(registration.owner, registration.id);
    return name;
}

export function setSubagentState(agentId: string, state: AgentInfo['state']): void {
    agentBus.update(agentId, { state });
}

/** Removes a finished subagent; the owner binding is dropped only when it still points at it. */
export function unregisterSubagentAgent(agentId: string): void {
    agentBus.unregister(agentId);
    for (const [ownerId, boundId] of [...agentIdByOwner]) {
        if (boundId === agentId) agentIdByOwner.delete(ownerId);
    }
}

/** "Kernel (id abc)", or just the id when that agent has stopped. */
function agentLabel(agentId: string): string {
    const name = agentBus.nameOf(agentId);
    return name ? `${name} (id ${agentId})` : agentId;
}

/** Roster text for list_agents, already limited to the caller's scope by the bus. Starts with the caller's own name. */
export function visibleAgentsText(fromAgentId: string): string {
    const ownName = agentBus.nameOf(fromAgentId);
    const self = ownName ? `You are ${ownName} (id ${fromAgentId}).\n` : '';
    const agents = agentBus.listVisible(fromAgentId);
    if (!agents.length) return `${self}No other agents are visible right now.`;
    const lines = agents.map(agent => {
        const where = [agent.parentId ? `child of ${agentLabel(agent.parentId)}` : '', agent.chatId ? `chat ${agent.chatId}` : '']
            .filter(Boolean).join(', ');
        const role = agent.role ? `, ${agent.role}` : '';
        return `- ${agent.name} (id ${agent.id}${role}) — ${agent.state}${where ? `, ${where}` : ''}: ${agent.task || '(no task)'}`;
    });
    return `${self}${agents.length} other agent${agents.length === 1 ? '' : 's'} visible under the current scope:\n${lines.join('\n')}`;
}

function messageText(target: AgentInfo): string {
    return `Message sent to "${target.name}" (${target.id}).`;
}

/** send_message: sends with the bus and returns a short confirmation. */
export function sendAgentMessage(fromAgentId: string, args: Record<string, unknown>): string {
    const to = typeof args.to === 'string' ? args.to.trim() : '';
    const text = typeof args.text === 'string' ? args.text : '';
    const replyTo = typeof args.reply_to === 'string' && args.reply_to.trim() ? args.reply_to.trim() : undefined;
    if (!to) throw new Error('"to" is required: use the agent\'s name, e.g. from delegate_task or list_agents.');
    if (!text.trim()) throw new Error('"text" is required.');
    const message = agentBus.send(fromAgentId, to, text, replyTo);
    const target = agentBus.listVisible(fromAgentId).find(agent => agent.id === message.toId);
    return target ? messageText(target) : `Message sent to ${message.toName} (${message.toId}).`;
}

/** read_messages: drains the caller's inbox and formats it. */
export function readAgentInbox(agentId: string): string {
    const user = userMessagesBlock(agentId);
    const messages = agentBus.takeInbox(agentId);
    if (!messages.length) return user || 'No new messages.';
    const agents = `Messages from other agents:\n${formatAgentMessages(messages)}`;
    return user ? `${user}\n\n${agents}` : agents;
}

/**
 * Inbox messages for a tool result or the start of a turn; empty when there are none.
 * Used for the automatic delivery path, so messages never sit unread between tool calls.
 */
export function takeInboxBlock(agentId: string): string {
    const user = userMessagesBlock(agentId);
    if (!messagingEnabled()) return user;
    const messages = agentBus.takeInbox(agentId);
    if (!messages.length) return user;
    const agents = `Messages from other agents:\n${formatAgentMessages(messages)}\n\nReply with send_message { "to": "...", "text": "...", "reply_to": "<message id>" }, or call read_messages later.`;
    return user ? `${user}\n\n${agents}` : agents;
}

export function takeOwnerInboxBlock(ownerId: string): string {
    const agentId = agentIdByOwner.get(ownerId);
    return agentId ? takeInboxBlock(agentId) : '';
}

/** Runs one of the messaging MCP tools for a bridge owner and returns a tool result. */
export function handleAgentMessagingTool(ownerId: string, tool: string, args: Record<string, unknown>): AgentToolResult {
    if (!messagingEnabled()) return { text: 'Agent-to-agent messaging is turned off in Settings (agents.messaging).', isError: true };
    const agentId = agentIdByOwner.get(ownerId);
    if (!agentId) {
        return { text: 'This agent is not registered for agent messaging. Start a new chat or subagent to use it.', isError: true };
    }
    try {
        if (tool === LIST_AGENTS_TOOL) return { text: visibleAgentsText(agentId) };
        if (tool === SEND_MESSAGE_TOOL) return { text: sendAgentMessage(agentId, args) };
        if (tool === READ_MESSAGES_TOOL) return { text: readAgentInbox(agentId) };
        return { text: `Unknown agent messaging tool "${tool}".`, isError: true };
    } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
}
