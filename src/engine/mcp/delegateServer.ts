import { createInterface } from 'node:readline';
import { CANCEL_SUBAGENT, TOOLPACK_SCOPE, WAIT_SUBAGENTS } from '../runtime/delegation';
import { normalizeToolpackResult } from '../toolpacks/result';
import { LOAD_TOOLPACK } from '../toolpacks/access';
import { CHAT_HISTORY_TOOL } from '../runtime/handoff';
import { BATCH_TOOL_SCHEMA } from '../runtime/batch';
import { getUnifyFeature } from '../unify/settings';
import { agentMessagingTools, isAgentMessagingTool, READ_MESSAGES_TOOL } from '../delegate/messagingProtocol';

const url = process.env.UNIFY_DELEGATE_URL || '';
const token = process.env.UNIFY_DELEGATE_TOKEN || '';
const owner = process.env.UNIFY_DELEGATE_OWNER || '';
const toolpacksOnly = process.env.UNIFY_DELEGATE_SCOPE === TOOLPACK_SCOPE;

/** A bridge that never answers must not hang an agent turn forever. */
const FIRST_BYTE_TIMEOUT_MS = 30_000;
/** The bridge writes a space every 20s while a subagent runs, so silence this long means it stalled. */
const IDLE_TIMEOUT_MS = 60_000;
/** How often the Settings toggle for agent messaging is checked, so hiding its tools needs no restart. */
const MESSAGING_TOGGLE_POLL_MS = 15_000;

type Json = Record<string, unknown>;

/**
 * Posts to the engine bridge and reads the reply as a stream. A watchdog aborts the request when the
 * connection stalls: either before the first byte or between keep-alive chunks.
 */
async function post(path: string, body: Json): Promise<Json> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let timedOut: string | undefined;
    const armWatchdog = (delayMs: number, message: string): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timedOut = message; controller.abort(); }, delayMs);
    };
    armWatchdog(FIRST_BYTE_TIMEOUT_MS, `The Unify bridge did not answer ${path} within ${FIRST_BYTE_TIMEOUT_MS / 1000}s.`);
    try {
        const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-unify-token': token }, body: JSON.stringify({ owner, ...body }), signal: controller.signal });
        let text = '';
        if (response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
                armWatchdog(IDLE_TIMEOUT_MS, `The Unify bridge stopped responding on ${path} for ${IDLE_TIMEOUT_MS / 1000}s.`);
                const chunk = await reader.read();
                if (chunk.done) break;
                text += decoder.decode(chunk.value, { stream: true });
            }
            text += decoder.decode();
        } else {
            text = await response.text();
        }
        return JSON.parse(text) as Json;
    } catch (error) {
        if (timedOut) throw new Error(timedOut);
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

const reply = (id: unknown, result: Json): void => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); };
const fail = (id: unknown, code: number, message: string): void => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); };

/**
 * Messages waiting in this agent's inbox. They ride along with the next tool result, so an agent
 * sees another agent's message without waiting for its turn to end. Failures are ignored: a bridge
 * that is gone must not turn every tool call into an error.
 */
async function inboxBlock(): Promise<string> {
    try {
        const inbox = await post('/inbox', {});
        return typeof inbox.text === 'string' ? inbox.text : '';
    } catch {
        return '';
    }
}

/** Whether the last tools/list included the messaging tools; used to announce a toggle change. */
let messagingToolsShown: boolean | undefined;

/** Tells the client to fetch the tool list again after agents.messaging was switched. */
function noteMessagingTools(messaging: boolean): void {
    if (messagingToolsShown === undefined || messagingToolsShown === messaging) {
        messagingToolsShown = messaging;
        return;
    }
    messagingToolsShown = messaging;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n');
}

/** Range edit: the guarded counterpart of read_file ranges. Routing happens in the engine (extension edit path). */
const EDIT_RANGE_TOOL = {
    name: 'edit_range',
    description: 'Replace exactly lines startLine-endLine of one file. Pass expected (the hash from a read_file ranges result, or the exact current text of those lines) so a stale edit fails instead of landing in the wrong place; if the lines moved, it re-anchors once on the expected text. Use read_file ranges first. An empty replacement removes the lines.',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    _meta: { 'anthropic/alwaysLoad': true },
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File to edit, relative to the working copy.' },
            startLine: { type: 'integer', minimum: 1 },
            endLine: { type: 'integer', minimum: 1 },
            expected: { type: 'string', description: 'The 12-hex hash from the read, or the exact current text of those lines.' },
            replacement: { type: 'string', description: 'Text for those lines; may include newlines; empty removes them.' },
        },
        required: ['path', 'startLine', 'endLine', 'replacement'],
    },
};

async function tools(): Promise<Json[]> {
    let agents = '';
    let custom: Json[] = [];
    let batching = false;
    let messaging = false;
    try {
        const described = await post('/describe', {});
        const list = Array.isArray(described.agents) ? described.agents as { name: string; description?: string; mode: string; model: string }[] : [];
        agents = list.sort((a, b) => a.name.localeCompare(b.name)).map(agent => `- ${agent.name} (${agent.mode}, ${agent.model})${agent.description ? `: ${agent.description}` : ''}`).join('\n');
        custom = Array.isArray(described.tools) ? described.tools as Json[] : [];
        batching = described.batching === true;
        messaging = described.messaging === true;
        noteMessagingTools(messaging);
    } catch { /* the host may be unavailable; fall back to a generic description */ }
    const customTools = custom.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, ...(tool._meta ? { _meta: tool._meta } : {}) }));
    const messagingTools = messaging ? agentMessagingTools() as Json[] : [];
    const rangeEdits = getUnifyFeature('tools.rangeEdits');
    if (toolpacksOnly) return [...(rangeEdits ? [EDIT_RANGE_TOOL as unknown as Json] : []), ...messagingTools, ...customTools];
    const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    return [
        ...(batching ? [BATCH_TOOL_SCHEMA as unknown as Json] : []),
        ...(rangeEdits ? [EDIT_RANGE_TOOL as unknown as Json] : []),
        {
            name: 'list_subagents',
            description: 'List subagent profiles (exact name, mode, model) for delegate_task.',
            annotations: readOnly,
            inputSchema: { type: 'object', properties: {} },
        },
        {
            name: 'delegate_task',
            description: `Run a task on a configured subagent (possibly another model) in the same working copy. Waits for its answer unless background is true. Without files it is read-only; files lets an edit profile change only those paths (trailing "/" for a folder), locked to it until it finishes.\nProfiles:\n${agents || '(none configured)'}`,
            // Claude Code only runs MCP tools concurrently when they are marked read-only. Edit subagents are still confined to their locked paths.
            annotations: readOnly,
            // Keep it out of Claude Code's tool search: deferred, its params stay hidden and the first call guesses them ("subagent" for agent).
            _meta: { 'anthropic/alwaysLoad': true },
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', description: 'Exact profile name.' },
                    task: { type: 'string', description: 'Complete, self-contained instructions.' },
                    files: { type: 'array', items: { type: 'string' }, description: 'Paths an edit profile may change.' },
                    background: { type: 'boolean', description: `Return a task id at once; collect with ${WAIT_SUBAGENTS}.` },
                    after_turn: { type: 'string', enum: ['resume', 'hold', 'cancel'], description: 'Background only, if your turn ends first: resume (default) sends results in a new turn, hold attaches them to the user\'s next message, cancel stops it.' },
                },
                required: ['agent', 'task'],
            },
        },
        {
            name: WAIT_SUBAGENTS,
            description: 'Wait for background subagents and return their reports (each only once).',
            annotations: readOnly,
            // Loaded with delegate_task, so a background task can always be collected.
            _meta: { 'anthropic/alwaysLoad': true },
            inputSchema: {
                type: 'object',
                properties: {
                    ids: { type: 'array', items: { type: 'string' }, description: 'Default: all of this chat\'s.' },
                    any: { type: 'boolean', description: 'Return when the first finishes.' },
                    timeout_seconds: { type: 'integer', minimum: 0, maximum: 3000, description: 'Default 1800; 0 only checks status.' },
                },
            },
        },
        {
            name: CANCEL_SUBAGENT,
            description: 'Stop a background subagent and return what it did so far.',
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
        ...messagingTools,
        {
            name: 'ask_questions',
            description: 'Ask the user 1-4 multiple-choice questions in the chat and wait for the answers. Only for decisions that are theirs. Put your recommended option first; the user can always type their own answer, so add no "Other".',
            inputSchema: {
                type: 'object',
                properties: {
                    questions: {
                        type: 'array', minItems: 1, maxItems: 4,
                        items: {
                            type: 'object',
                            properties: {
                                question: { type: 'string' },
                                header: { type: 'string', description: 'Max 12 characters.' },
                                options: {
                                    type: 'array', minItems: 2, maxItems: 4,
                                    items: { type: 'object', properties: { label: { type: 'string', description: '1-5 words.' }, description: { type: 'string' } }, required: ['label'] },
                                },
                                multiSelect: { type: 'boolean', description: 'Answers are joined with ", ".' },
                            },
                            required: ['question', 'options'],
                        },
                    },
                },
                required: ['questions'],
            },
        },
        ...customTools,
        {
            name: 'checkpoint',
            description: `Call as the last step of a turn, after the user's request is finished, when most earlier context is no longer needed. It does not hand work on: nothing continues after the turn unless Unify itself asked for the checkpoint, so never call it in place of doing the request. The summary is for you: goal, decisions, files changed, open items. The user's next message starts a fresh session from it; older messages stay in ${CHAT_HISTORY_TOOL}.`,
            inputSchema: { type: 'object', properties: { summary: { type: 'string' }, keep_files: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['summary', 'reason'] },
        },
        {
            name: CHAT_HISTORY_TOOL,
            description: 'Earlier messages of this chat word for word, with the tools each turn used, most recent last.',
            annotations: readOnly,
            inputSchema: { type: 'object', properties: {
                count: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 10.' },
                query: { type: 'string', description: 'Only messages containing all these words.' },
            } },
        },
        {
            name: 'list_locked_files',
            description: 'Files locked by running subagents; do not edit them.',
            annotations: readOnly,
            inputSchema: { type: 'object', properties: {} },
        },
    ];
}

async function handle(message: Json): Promise<void> {
    const { id, method } = message;
    if (id === undefined) return;
    try {
        if (method === 'initialize') {
            const params = (message.params || {}) as Json;
            reply(id, { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'unify', version: '1.0.0' }, instructions: toolpacksOnly
                ? 'Tools from toolpacks the user installed, for external apps (for example Blender or Roblox Studio) you cannot see through files.'
                : 'Unify tools. Subagents run only through delegate_task. Other tools come from toolpacks the user installed.' });
        } else if (method === 'ping') reply(id, {});
        else if (method === 'tools/list') reply(id, { tools: await tools() });
        else if (method === 'tools/call') {
            const params = (message.params || {}) as Json;
            const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Json;
            const result = await post('/call', { tool: params.name, args });
            const content: unknown[] = result.content === undefined
                ? [{ type: 'text', text: String(result.text ?? result.error ?? '') }]
                : normalizeToolpackResult(result).content ?? [];
            const isError = result.isError === true || !!result.error;
            // read_messages already drained the inbox; every other result carries what arrived since.
            if (params.name !== READ_MESSAGES_TOOL) {
                const mail = await inboxBlock();
                if (mail) content.push({ type: 'text', text: `---\n${mail}` });
            }
            reply(id, { content, isError });
            // Loaded pack tools join the tool list; clients that follow list changes can call them directly.
            if (params.name === LOAD_TOOLPACK && !isError && result.skipListChanged !== true) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n');
        } else fail(id, -32601, `Method not found: ${String(method)}`);
    } catch (error) {
        reply(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
    }
}

// Settings can turn agent messaging off while a session is open; announce the new tool list then.
let checkingMessaging = false;
const messagingWatch = setInterval(async () => {
    if (checkingMessaging) return;
    checkingMessaging = true;
    try {
        const described = await post('/describe', {});
        noteMessagingTools(described.messaging === true);
    } catch {
        // The bridge is gone; the session is ending.
    } finally {
        checkingMessaging = false;
    }
}, MESSAGING_TOGGLE_POLL_MS);
messagingWatch.unref();

createInterface({ input: process.stdin }).on('line', line => {
    let message: Json;
    try { message = JSON.parse(line) as Json; } catch { return; }
    void handle(message);
});
