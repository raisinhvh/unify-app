/**
 * Wire names, tool schemas and text formatting for native agent messaging.
 *
 * This module has no engine imports so the stdio MCP server (a separate process) can share the
 * exact tool definitions the engine side uses, without bundling a second copy of the bus.
 */
import type { AgentMessage } from '../unify/agentBus';

export const LIST_AGENTS_TOOL = 'list_agents';
export const SEND_MESSAGE_TOOL = 'send_message';
export const READ_MESSAGES_TOOL = 'read_messages';

/** Every MCP tool that belongs to agent-to-agent messaging. */
export function isAgentMessagingTool(tool: string): boolean {
    return tool === LIST_AGENTS_TOOL || tool === SEND_MESSAGE_TOOL || tool === READ_MESSAGES_TOOL;
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/** Tool definitions in the same shape as the rest of delegateServer's tools. */
export function agentMessagingTools(): Record<string, unknown>[] {
    return [
        {
            name: LIST_AGENTS_TOOL,
            description: 'List the other agents running in Unify right now (id, name, task, chat, parent, state). Use an id from here with send_message. Which agents you can see depends on the agents.messaging.scope setting.',
            annotations: readOnly,
            inputSchema: { type: 'object', properties: {} },
        },
        {
            name: SEND_MESSAGE_TOOL,
            description: 'Send a message to another running agent: your parent, a child subagent, a sibling, or an agent in another chat. Messages are delivered with the recipient\'s next tool result or when it calls read_messages. Use it for questions, replies and short hand-offs; put longer work in your final report.',
            annotations: readOnly,
            inputSchema: {
                type: 'object',
                properties: {
                    to: { type: 'string', description: 'Agent id from list_agents.' },
                    text: { type: 'string', description: 'The message.' },
                    reply_to: { type: 'string', description: 'Id of the message this answers.' },
                },
                required: ['to', 'text'],
            },
        },
        {
            name: READ_MESSAGES_TOOL,
            description: 'Read messages other agents sent you that you have not seen yet. Each message shows who sent it and its id, for replying with send_message { to, text, reply_to }.',
            annotations: readOnly,
            inputSchema: { type: 'object', properties: {} },
        },
    ];
}

/** One message per line, with its sender and id so the reader can reply to it. */
export function formatAgentMessages(messages: AgentMessage[]): string {
    return messages.map(message => {
        const when = new Date(message.sentAt).toISOString();
        const reply = message.replyToId ? `, replying to ${message.replyToId}` : '';
        return `- message ${message.id} from "${message.fromName}" (${message.fromId}) at ${when}${reply}:\n${message.text}`;
    }).join('\n');
}
