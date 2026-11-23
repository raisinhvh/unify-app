import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { OAuthCliAccount } from '../accounts/oauthCli';
import type { TurnUsage } from './oauthCli';
import { terminateProcessTree } from './cancellation';
import { isUsageLimitText, UsageLimitError } from './limits';
import { agentEnv } from './agentShell';
import { applyAgentPriority } from './priority';
import { codexNativeAgentArgs } from './nativeAgents';

/** One ChatGPT (Codex) account turn run by the native `codex` CLI. */
export interface CodexTurn {
  account: OAuthCliAccount;
  cwd: string;
  backend: string;
  effort?: string;
  /** Instructions sent as Codex's developer instructions on every run. */
  system?: string;
  prompt: string;
  images?: { path: string; mimeType: string }[];
  /** Resumes this Codex thread instead of starting a new one. */
  sessionId?: string;
  /** Unify's MCP bridge, registered for this run as the `unify` MCP server. */
  delegate?: { command: string; args: string[]; env: Record<string, string> };
  readOnly?: boolean;
  fullAccess?: boolean;
  /** Codex executable for this turn; overrides the configured/detected command. */
  command?: string;
  onText(text: string): void;
  /** Codex started another assistant message; text after this must not be joined to earlier text. */
  onMessageBreak?(): void;
  onTool(id: string, title: string, detail: string | undefined, state: 'running' | 'complete' | 'error'): void;
  /** Reports token usage once per completed Codex turn. Errors thrown here are ignored. */
  onUsage?(usage: TurnUsage): void;
  /**
   * Accepted for parity with the other CLI runtimes, but `codex exec` never asks for approval:
   * it runs non-interactively with approvals disabled, so this callback is never called.
   */
  onApproval?(description: string, info?: { tool: string; input: Record<string, unknown>; autoAllowEdits?: boolean }): Promise<boolean | string>;
}

let detectedCommand: string | undefined;

/** Sets the Codex CLI path found by account detection or the extension. */
export function setCodexCommand(command: string | undefined): void {
  detectedCommand = command?.trim() || undefined;
}

/**
 * The Codex CLI command: the `unify.runtime.codexPath` setting, then `UNIFY_CODEX_PATH`, then a command
 * found by detection, then the usual install locations, and finally `codex` on PATH.
 */
export function codexCliCommand(): string {
  const setting = vscode.workspace.getConfiguration('unify').get<string>('runtime.codexPath')?.trim();
  if (setting) return setting;
  const fromEnv = process.env.UNIFY_CODEX_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (detectedCommand) return detectedCommand;
  const candidates = process.platform === 'win32'
    ? [
        join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
        join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.exe'),
        join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
      ]
    : [
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        join(homedir(), '.local', 'bin', 'codex'),
        join(homedir(), '.cargo', 'bin', 'codex'),
      ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return 'codex';
}

/**
 * Environment for a Codex child. The account's own CODEX_HOME holds its auth.json, and API-key variables
 * are removed so the CLI cannot silently switch away from the signed-in ChatGPT account.
 */
export function codexEnv(account: OAuthCliAccount): NodeJS.ProcessEnv {
  const env = agentEnv({ ...process.env });
  env.CODEX_HOME = account.directory;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.CODEX_API_KEY;
  return env;
}

/** A TOML basic string for a `-c key=value` override. */
function tomlString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '\\') out += '\\\\';
    else if (character === '"') out += '\\"';
    else if (character === '\n') out += '\\n';
    else if (character === '\r') out += '\\r';
    else if (character === '\t') out += '\\t';
    else if (character === '\b') out += '\\b';
    else if (character === '\f') out += '\\f';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += character;
  }
  return `${out}"`;
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function tomlInlineTable(entries: [string, string][]): string {
  return `{ ${entries.map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(', ')} }`;
}

/** Codex's sandbox mode for a turn. A full-access turn wins over a read-only one. */
export function codexSandboxMode(turn: Pick<CodexTurn, 'readOnly' | 'fullAccess'>): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (turn.fullAccess) return 'danger-full-access';
  return turn.readOnly ? 'read-only' : 'workspace-write';
}

function isImage(image: { mimeType?: string }): boolean {
  return typeof image.mimeType === 'string' && image.mimeType.toLowerCase().startsWith('image/');
}

/** Command-line arguments for one native Codex turn. The prompt itself is read from stdin (`-`). */
export function codexArgs(turn: CodexTurn): string[] {
  const args = turn.sessionId ? ['exec', 'resume', turn.sessionId] : ['exec'];
  // `exec resume` does not expose --sandbox/-C/--add-dir, so the sandbox is set through a config override
  // that both forms accept. exec never prompts for approvals, hence no approval flag.
  args.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode=${tomlString(codexSandboxMode(turn))}`);
  if (turn.backend && turn.backend !== 'default') args.push('-m', turn.backend);
  if (turn.effort) args.push('-c', `model_reasoning_effort=${tomlString(turn.effort)}`);
  if (turn.system) args.push('-c', `developer_instructions=${tomlString(turn.system)}`);
  args.push(...codexNativeAgentArgs());
  if (turn.delegate) {
    args.push('-c', `mcp_servers.unify.command=${tomlString(turn.delegate.command)}`);
    args.push('-c', `mcp_servers.unify.args=${tomlArray(turn.delegate.args ?? [])}`);
    const env = Object.entries(turn.delegate.env ?? {}).filter((entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === 'string');
    if (env.length) args.push('-c', `mcp_servers.unify.env=${tomlInlineTable(env)}`);
  }
  for (const image of turn.images ?? []) if (isImage(image)) args.push('-i', image.path);
  args.push('-');
  return args;
}

/** The stdin prompt: attachments Codex cannot take with `-i` are listed as files to read. */
export function codexPrompt(turn: Pick<CodexTurn, 'prompt' | 'images'>): string {
  const files = (turn.images ?? []).filter(image => !isImage(image)).map(image => image.path);
  return files.length ? `${turn.prompt}\n\nAttached files (read these files):\n${files.join('\n')}` : turn.prompt;
}

/** Reads the `usage` object of a Codex `turn.completed` event. */
export function parseCodexUsage(raw: unknown): TurnUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (typeof usage.input_tokens !== 'number' && typeof usage.output_tokens !== 'number') return undefined;
  const promptTokens = count(usage.input_tokens);
  const cacheRead = count(usage.cached_input_tokens);
  const cacheWrite = count(usage.cache_write_input_tokens);
  return {
    total: {
      // Codex counts cached and cache-written tokens in input_tokens; Unify keeps those apart.
      input: Math.max(0, promptTokens - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      output: count(usage.output_tokens),
    },
    context: promptTokens,
  };
}

type ToolState = 'running' | 'complete' | 'error';

function itemToolState(item: Record<string, unknown>, completed: boolean): ToolState {
  const status = typeof item.status === 'string' ? item.status : undefined;
  if (status === 'failed' || status === 'declined' || status === 'error' || item.error) return 'error';
  if (status === 'in_progress' || status === 'pending' || status === 'running') return 'running';
  if (completed) {
    if (item.type === 'command_execution' && typeof item.exit_code === 'number' && item.exit_code !== 0) return 'error';
    return 'complete';
  }
  return 'running';
}

function fileChanges(changes: unknown): string | undefined {
  if (!Array.isArray(changes)) return undefined;
  const lines = changes.flatMap(change => {
    if (!change || typeof change !== 'object') return [];
    const { path, kind } = change as Record<string, unknown>;
    if (typeof path !== 'string') return [];
    return [typeof kind === 'string' ? `${kind} ${path}` : path];
  });
  return lines.length ? lines.join('\n') : undefined;
}

function todoDetail(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  const lines = items.flatMap(entry => {
    if (typeof entry === 'string') return [entry];
    if (!entry || typeof entry !== 'object') return [];
    const { text, completed } = entry as Record<string, unknown>;
    if (typeof text !== 'string') return [];
    return [`${completed === true ? '[x]' : '[ ]'} ${text}`];
  });
  return lines.length ? lines.join('\n') : undefined;
}

/** How one Codex item appears as a Unify tool row, or undefined for text/reasoning items. */
function itemTool(item: Record<string, unknown>): { title: string; detail?: string } | undefined {
  const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
  switch (item.type) {
    case 'command_execution': {
      return { title: 'Command', detail: string(item.command) };
    }
    case 'file_change': {
      return { title: 'Edit', detail: fileChanges(item.changes) };
    }
    case 'mcp_tool_call': {
      const name = [string(item.server), string(item.tool)].filter(Boolean).join('.') || 'MCP tool';
      const input = item.arguments === undefined ? undefined : typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments);
      return { title: name, detail: input?.slice(0, 1500) };
    }
    case 'web_search': {
      return { title: 'Web search', detail: string(item.query) };
    }
    case 'todo_list': {
      return { title: 'Plan', detail: todoDetail(item.items) };
    }
    case 'collab_tool_call': {
      return { title: 'Subagent', detail: JSON.stringify(item).slice(0, 1500) };
    }
    case 'error': {
      return { title: 'Error', detail: string(item.message) };
    }
    default: {
      return undefined;
    }
  }
}

/** Runs one native Codex turn as `codex exec --json` (or `codex exec resume`). */
export class CodexCliRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private cancelled = false;
  private cancelTurn?: () => void;

  /** Stops the running turn. Its promise resolves undefined, like a cancelled Claude turn. */
  cancel(): void {
    this.cancelled = true;
    this.cancelTurn?.();
  }

  async prompt(turn: CodexTurn): Promise<string | undefined> {
    if (this.child) throw new Error('A Codex turn is already running.');
    this.cancelled = false;
    const args = codexArgs(turn);
    const prompt = codexPrompt(turn);
    return new Promise<string | undefined>((resolve, reject) => {
      let buffer = '';
      let errorText = '';
      let sessionId = turn.sessionId;
      let done = false;
      let turnCompleted = false;
      const textById = new Map<string, string>();
      const startedMessages = new Set<string>();
      const toolRows = new Map<string, { state: ToolState; detail: string }>();
      const emitTool = (id: string, title: string, detail: string | undefined, state: ToolState): void => {
        const key = id || title;
        const previous = toolRows.get(key);
        // A completed tool row without a start still gets a running row, so the UI has a segment to finish.
        if (!previous && state !== 'running') turn.onTool(key, title, detail, 'running');
        if (previous && previous.state === state && previous.detail === (detail ?? '')) return;
        // Repeat rows for the same state only refresh their detail.
        if (previous && previous.state === state && state === 'running') { previous.detail = detail ?? ''; return; }
        toolRows.set(key, { state, detail: detail ?? '' });
        turn.onTool(key, title, detail, state);
      };
      const emitItem = (item: Record<string, unknown>, completed: boolean): void => {
        const id = typeof item.id === 'string' ? item.id : '';
        if (item.type === 'agent_message') {
          const messageId = id || 'message';
          if (!startedMessages.has(messageId)) {
            startedMessages.add(messageId);
            turn.onMessageBreak?.();
          }
          if (typeof item.text !== 'string') return;
          const previous = textById.get(messageId) ?? '';
          const text = item.text;
          // Codex normally repeats the whole message on each update; fall back to the whole text if not.
          const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
          textById.set(messageId, text);
          if (delta) turn.onText(delta);
          return;
        }
        if (item.type === 'reasoning') return;
        const tool = itemTool(item);
        if (!tool) return;
        emitTool(id || tool.title, tool.title, tool.detail, itemToolState(item, completed));
      };
      let exitTimer: NodeJS.Timeout | undefined;
      const child = spawn(turn.command?.trim() || codexCliCommand(), args, {
        cwd: turn.cwd, env: codexEnv(turn.account), windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      applyAgentPriority(child.pid);
      const finish = (error?: Error): void => {
        if (done) return;
        done = true;
        clearTimeout(exitTimer);
        this.cancelTurn = undefined;
        if (this.child === child) this.child = undefined;
        if (error) reject(error); else resolve(sessionId);
      };
      this.cancelTurn = () => { terminateProcessTree(child); finish(); };
      const fail = (message: string): void => {
        if (done) return;
        const text = (message || errorText).trim();
        terminateProcessTree(child);
        finish(isUsageLimitText(text)
          ? new UsageLimitError(`Codex usage limit: ${text.slice(0, 300)}`)
          : new Error(`Codex turn failed. ${text ? text.slice(0, 1000) : 'Open the CLI for details.'}`));
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (done || this.cancelled) return;
        buffer += chunk;
        if (buffer.length > 10_000_000) {
          terminateProcessTree(child);
          finish(new Error('Codex CLI output exceeded the size limit.'));
          return;
        }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          let event: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object') continue;
            event = parsed as Record<string, unknown>;
          } catch { continue; }
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
            sessionId = event.thread_id;
            continue;
          }
          if (event.type === 'turn.completed') {
            turnCompleted = true;
            const usage = parseCodexUsage(event.usage);
            if (usage) {
              try { turn.onUsage?.(usage); } catch { /* Callback errors must not interrupt the turn. */ }
            }
            continue;
          }
          if (event.type === 'turn.failed') {
            const error = (event.error && typeof event.error === 'object' ? event.error : {}) as Record<string, unknown>;
            fail(typeof error.message === 'string' ? error.message : JSON.stringify(error));
            return;
          }
          if (event.type === 'error') {
            fail(typeof event.message === 'string' ? event.message : JSON.stringify(event));
            return;
          }
          if ((event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed')
            && event.item && typeof event.item === 'object') {
            emitItem(event.item as Record<string, unknown>, event.type === 'item.completed');
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { errorText = (errorText + chunk).slice(-4000); });
      child.on('error', () => finish(new Error('Codex CLI could not start. Check the configured path.')));
      const closed = (code: number | null): void => {
        if (done) return;
        if (this.cancelled) { finish(); return; }
        if (code === 0) {
          if (!turnCompleted) { fail('Codex exited without completing its turn.'); return; }
          finish(); return;
        }
        if (isUsageLimitText(errorText)) {
          finish(new UsageLimitError(`Codex usage limit: ${errorText.trim().slice(-300)}`));
          return;
        }
        const detail = errorText.trim().slice(-600);
        const signIn = /not logged in|log ?in|sign in|auth(?:entication|\.json)?|unauthorized|401/i.test(errorText);
        finish(new Error(`Codex CLI exited with code ${code ?? 'unknown'}.${signIn ? ' Sign in again from Accounts.' : ''}${detail ? ` ${detail}` : ' Open the CLI for details.'}`));
      };
      child.on('close', closed);
      // 'close' waits for pipes a leftover descendant may hold open; the exit alone ends the turn soon after.
      child.on('exit', code => { exitTimer = setTimeout(() => closed(code), 3_000); exitTimer.unref(); });
      child.stdin.on('error', () => undefined);
      child.stdin.end(prompt);
    });
  }
}
