/** Agent messaging: bus events, messages to subagents, and waking idle chats for incoming messages. */
import type { Host as ExtensionHost } from '../extension';
import { randomUUID } from 'node:crypto';
import { queueUserMessage } from '../delegate/messaging';
import { SidebarImage } from '../sidebar/view';
import { getUnifyFeature } from '../unify/settings';
import { agentBus } from '../unify/agentBusImpl';
import type { AgentBusEvent, AgentMessage } from '../unify/agentBus';
import type { Chat } from './types';
import { MAX_MESSAGE_WAKES } from './constants';
import { isCodexCliChat } from './helpers';

/** Forwards agent messaging events to the UI and keeps the roster used to find a message's chat. */
export function onAgentBusEvent(this: ExtensionHost, event: AgentBusEvent): void {
  if (event.kind === 'roster') {
    this.agentRoster.clear();
    for (const agent of event.agents) this.agentRoster.set(agent.id, agent);
    this.sidebar.postMessage({ type: 'agentRoster', agents: event.agents });
    return;
  }
  const message: AgentMessage = event.message;
  const chatId = this.agentRoster.get(message.toId)?.chatId ?? this.agentRoster.get(message.fromId)?.chatId ?? message.toId;
  this.sidebar.postMessage({ type: 'agentMessage', chatId, message });
  // The sender's chat shows what it sent too, when that is a different chat (e.g. a message to another chat's agent).
  const senderChatId = this.agentRoster.get(message.fromId)?.chatId;
  if (senderChatId && senderChatId !== chatId) this.sidebar.postMessage({ type: 'agentMessage', chatId: senderChatId, message });
  // A message from a subagent lands in that subagent's own feed as an outgoing row.
  const sender = [...this.childRuns].find(run => run.agentId === message.fromId);
  if (sender) {
    this.sidebar.postMessage({
      type: 'subagentEvent',
      sessionId: sender.parent.record.id,
      agentId: sender.agentId,
      messageId: `agentMessage:${message.id}:sent`,
      role: 'assistant',
      text: message.text,
      to: message.toName,
    });
  }
  // A message to an idle main chat starts a turn for it; a running one reads it next turn or with read_messages.
  // Deferred so the sender's send_message call returns before the recipient's turn starts.
  const recipientChat = this.chats.get(message.toId);
  if (recipientChat) setImmediate(() => this.wakeForMessages(recipientChat));
  // A message to a subagent also lands in that subagent's own feed, as an incoming bubble.
  const recipient = [...this.childRuns].find(run => run.agentId === message.toId);
  if (recipient) {
    this.sidebar.postMessage({
      type: 'subagentEvent',
      sessionId: recipient.parent.record.id,
      agentId: recipient.agentId,
      messageId: `agentMessage:${message.id}`,
      role: 'user',
      text: message.text,
      ...(message.fromId === recipient.parent.record.id ? {} : { from: message.fromName }),
    });
  }
}

/**
 * The composer's "Send to subagent": the user's message goes into that subagent's running turn and shows
 * in its feed as an incoming bubble. A finished subagent has no session left to continue.
 */
export function messageSubagent(this: ExtensionHost, chatId: string | undefined, agentId: string, text: string, images?: SidebarImage[]): void {
  const run = [...this.childRuns].find(item => item.agentId === agentId && (!chatId || item.parent.record.id === chatId));
  if (!run) {
    this.sidebar.postMessage({ type: 'error', message: 'That subagent has finished, so it cannot take messages. Go back to the main chat to send this.' });
    return;
  }
  const body = text.trim();
  if (!body) return;
  if (images?.length) this.sidebar.postMessage({ type: 'error', message: 'Attachments are not sent to subagents; only the text was sent.' });
  this.sidebar.postMessage({
    type: 'subagentEvent',
    sessionId: run.parent.record.id,
    agentId: run.agentId,
    messageId: `user:${randomUUID()}`,
    role: 'user',
    text: body,
  });
  if (!run.say?.(`Message from the user, sent while you work: ${body}`)) queueUserMessage(run.agentId, body);
}

/** Undelivered messages from other agents, formatted to lead the chat's next turn. */
export function takeAgentMessages(this: ExtensionHost, chatId: string): string {
  if (!getUnifyFeature('agents.messaging')) return '';
  return agentBus.takeInbox(chatId)
    .map(message => `From ${message.fromName} (${message.fromId}): ${message.text}`)
    .join('\n\n');
}

/**
 * Starts a turn for an idle chat whose agent has unread messages from other agents; the turn's prompt
 * takes the inbox. A Claude chat that finished its reply but waits on background tasks gets the messages
 * in that live process instead, so they are answered now rather than when the tasks end.
 * Wakes without a user message in between are capped, so two agents cannot answer each other forever.
 */
export function wakeForMessages(this: ExtensionHost, chat: Chat): void {
  const id = chat.record.id;
  if (!getUnifyFeature('agents.messaging') || !agentBus.hasInbox(id)) return;
  if (this.deletedSessions.has(id) || this.chats.get(id) !== chat || chat.jobActive || this.promptStarts.has(id)) return;
  // A running reply reads its mail with its next Unify tool result; only a reply parked on background tasks needs a nudge.
  const waiting = chat.running && chat.record.provider === 'claude-cli' && !isCodexCliChat(chat.record) && chat.cli.waitingOnBackground();
  if (chat.running && !waiting) return;
  const wakes = this.messageWakes.get(id) ?? 0;
  if (wakes >= MAX_MESSAGE_WAKES) {
    this.output.appendLine(`Not waking ${chat.record.name} for agent messages: ${MAX_MESSAGE_WAKES} wakes since the user's last message. They wait for the next one.`);
    return;
  }
  if (waiting) {
    const text = `Messages from other agents arrived while you waited on background tasks (they keep running). Act on them, and answer with send_message if a reply is needed.\n\n${this.takeAgentMessages(id)}`;
    if (this.sayWhileWaiting(chat, text, { internal: true })) this.messageWakes.set(id, wakes + 1);
    return;
  }
  this.messageWakes.set(id, wakes + 1);
  void this.guarded(() => this.sendPrompt('Another agent messaged you while you were idle (see above). Act on it, and answer with send_message if a reply is needed.',
    undefined, [], id, 'queue', { internal: true }));
}
