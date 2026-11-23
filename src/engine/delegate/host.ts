import { randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ToolpackResult } from '../toolpacks/types';
import { getUnifyFeature } from '../unify/settings';
import { DelegateTaskQueue } from './limits';
import { handleAgentMessagingTool, messagingEnabled, takeOwnerInboxBlock } from './messaging';
import { isAgentMessagingTool } from './messagingProtocol';

export interface DelegateAgentInfo { name: string; description?: string; mode: 'read-only' | 'edit'; model: string }
export interface DelegateResult extends ToolpackResult { skipListChanged?: boolean }
export interface DelegateToolInfo { name: string; description: string; inputSchema: Record<string, unknown>; _meta?: Record<string, unknown> }

export interface DelegateHandlers {
    describe(owner: string): DelegateAgentInfo[];
    /** Extra tools from enabled custom toolpacks. */
    tools(owner: string): DelegateToolInfo[];
    call(owner: string, tool: string, args: Record<string, unknown>): Promise<DelegateResult>;
    /** Whether this owner's bridge offers the batch tool. */
    batching?(owner: string): boolean;
}

/** Loopback HTTP bridge between the stdio MCP server that agents spawn and the extension host. */
export class DelegateHost {
    public readonly token = randomBytes(24).toString('hex');
    private server?: Server;
    private port = 0;
    /** Runs delegate tasks one at a time up to agents.maxParallel; extra tasks wait instead of failing. */
    private readonly delegateTasks = new DelegateTaskQueue(() => getUnifyFeature('agents.maxParallel'));

    public get url(): string | undefined { return this.port ? `http://127.0.0.1:${this.port}` : undefined; }

    public start(handlers: DelegateHandlers): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = createServer((req, res) => { void this.handle(handlers, req, res); });
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                this.port = (server.address() as { port: number }).port;
                this.server = server;
                resolve();
            });
        });
    }

    public dispose(): void {
        this.server?.close();
        this.server = undefined;
        this.port = 0;
    }

    private async handle(handlers: DelegateHandlers, req: IncomingMessage, res: ServerResponse): Promise<void> {
        const send = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.method !== 'POST' || req.headers['x-unify-token'] !== this.token) { send(403, { error: 'forbidden' }); return; }
        let raw = '';
        for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 1_000_000) { send(413, { error: 'too large' }); return; }
        }
        let body: { owner?: string; tool?: string; args?: Record<string, unknown> };
        try { body = JSON.parse(raw) as typeof body; } catch { send(400, { error: 'bad json' }); return; }
        const owner = typeof body.owner === 'string' ? body.owner : '';
        try {
            if (req.url === '/describe') send(200, { agents: handlers.describe(owner), tools: handlers.tools(owner), batching: handlers.batching?.(owner) === true, messaging: messagingEnabled() });
            // Mail waiting for this bridge's agent, appended to its next tool result by the MCP server.
            else if (req.url === '/inbox') send(200, { text: takeOwnerInboxBlock(owner) });
            else if (req.url === '/call' && typeof body.tool === 'string') {
                // Subagents can run for minutes; whitespace keeps the client's fetch from hitting its header/body timeouts.
                res.writeHead(200, { 'content-type': 'application/json' });
                res.flushHeaders();
                const keepAlive = setInterval(() => res.write(' '), 20_000);
                try {
                    const args = body.args && typeof body.args === 'object' ? body.args : {};
                    // Messaging answers in the bridge, before the extension's tool router, so every agent can use it.
                    const result = isAgentMessagingTool(body.tool)
                        ? handleAgentMessagingTool(owner, body.tool, args)
                        : await this.callHandler(handlers, owner, body.tool, args);
                    res.end(JSON.stringify(result));
                }
                catch (error) { res.end(JSON.stringify({ text: error instanceof Error ? error.message : String(error), isError: true })); }
                finally { clearInterval(keepAlive); }
            }
            else send(404, { error: 'not found' });
        } catch (error) {
            send(200, { text: error instanceof Error ? error.message : String(error), isError: true });
        }
    }

    /** Delegate tasks wait for a free slot; every other tool goes straight to the extension. */
    private callHandler(handlers: DelegateHandlers, owner: string, tool: string, args: Record<string, unknown>): Promise<DelegateResult> {
        if (tool !== 'delegate_task') return handlers.call(owner, tool, args);
        return this.delegateTasks.run(() => handlers.call(owner, tool, args));
    }
}
