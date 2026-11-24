import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OAuthCliAccount, cliCommand, cliEnv } from '../accounts/oauthCli';
import { canDelegate, delegationInstructions, isNativeSubagentTool } from './delegation';
import { terminateProcessTree } from './cancellation';
import { claudeSpeedSettings } from './models';
import { isLimitNotice, isUsageLimitText, UsageLimitError } from './limits';
import { agentEnv } from './agentShell';
import { applyAgentPriority } from './priority';
import { CLAUDE_MULTI_AGENT_TOOLS, CLAUDE_NATIVE_AGENT_TOOLS, nativeAgentsBlocked } from './nativeAgents';
import { errorText as toolErrorText, isEditTool, parsePartialJson } from './editPreview';

/** Streamed edit input is parsed and reported at most this often per call. */
const TOOL_INPUT_INTERVAL_MS = 50;

export interface CliTurn {
  account: OAuthCliAccount;
  cwd: string;
  backend: string;
  effort?: string;
  speed?: string;
  fullAccess?: boolean;
  readOnly?: boolean;
  delegate?: { command: string; args: string[]; env: Record<string, string> };
  prompt: string;
  /** Fixed instructions sent as system text on every run, instead of the default delegation note. */
  system?: string;
  images?: { path: string; mimeType: string }[];
  sessionId?: string;
  /** A one-shot helper call: no Claude Code system prompt, tools, MCP servers, rules or session. */
  lean?: boolean;
  /** Prompt cache lifetime for this run. Lean turns default to 5m, since a one-shot never reads its cache back. */
  cacheTtl?: '5m' | '1h';
  /** Reports Claude rate limit updates. */
  onRateLimit?: (info: unknown) => void;
  /** Drop built-in Claude tools that cannot work inside Unify or that Unify replaces (TRIMMED_CLAUDE_TOOLS). */
  trimTools?: boolean;
  /**
   * A read-only explorer: a short system prompt instead of Claude Code's, only Read / Grep / Glob plus the Unify
   * bridge, and no skills, slash commands, CLAUDE.md, auto-memory or other MCP servers. Unify's brief already
   * carries the memory and summary notes, so a cold start costs a few thousand tokens instead of tens of thousands.
   */
  explorer?: boolean;
  /** Reports token usage once per Claude result event. Errors thrown here are ignored. */
  onUsage?(usage: TurnUsage): void;
  /** Prompt size of each main-conversation request as it is made (input + cached). Errors thrown here are ignored. */
  onContext?(tokens: number): void;
  /**
   * Claude answered but keeps the turn open for background tasks it started (their results may continue the turn).
   * Called with the tasks' descriptions when that wait starts, and with an empty list when Claude resumes. Errors thrown here are ignored.
   */
  onBackgroundWait?(tasks: string[]): void;
  /**
   * The background tasks Claude Code is running, reported whenever the list changes (not only while the turn waits),
   * and once with an empty list when the CLI exits. `command` is set when the task is a Bash command run in the background.
   * Claude Code exposes no way to stop a task over stdin that Unify can rely on, so these tasks cannot be stopped from Unify.
   */
  onBackgroundTasks?(tasks: { id: string; description: string; command?: string }[]): void;
  /** Reports the tool names Claude Code loaded for this run (its system init event). Errors thrown here are ignored. */
  onInit?(info: { tools: string[]; model?: string }): void;
  onText(text: string): void;
  /** The model started a new message; text after this must not be joined to earlier text. */
  onMessageBreak?(): void;
  /** `error` is the tool's error text when state is 'error' (Claude's tool_result content). */
  onTool(id: string, title: string, detail: string | undefined, state: 'running' | 'complete' | 'error', error?: string): void;
  /**
   * A finished tool call of the agent itself returned images (Read of an image file, screenshots): `content` is the
   * tool_result's raw content array. Errors thrown here are ignored.
   */
  onToolImages?(id: string, title: string, content: unknown[]): void;
  /**
   * Live edit preview: an edit call's input while it streams (`streaming`, parsed from the partial JSON, at most every
   * TOOL_INPUT_INTERVAL_MS) and once more when it is complete, before onTool reports it running. Only edit tools
   * (editPreview.isEditTool) of the agent itself, not of Claude's own subagents. Errors thrown here are ignored.
   */
  onToolInput?(event: { id: string; name: string; input: Record<string, unknown>; streaming: boolean }): void;
  onSubagent?(event: { id: string; title?: string; model?: string; prompt?: string; state?: 'running' | 'complete' | 'error'; text?: string; messageId?: string; role?: 'assistant' | 'tool' }): void;
  onApproval?(description: string, info?: { tool: string; input: Record<string, unknown>; autoAllowEdits?: boolean }): Promise<boolean | string>;
  /** Shows Claude's AskUserQuestion in the chat. Resolves to answers keyed by question text, or a message explaining why there are none. */
  onQuestions?(input: Record<string, unknown>): Promise<Record<string, string> | string>;
  /** Files the agent finished editing, reported even when the sandbox allowed the write without an approval. */
  onFileChange?(paths: string[]): void;
}

/** Token counts of one Claude request or turn. */
export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Part of cacheWrite stored for one hour. */
  cacheWrite1h: number;
  /** Part of cacheWrite stored for five minutes. */
  cacheWrite5m: number;
  output: number;
}

export interface TurnUsage {
  /** The whole turn, summed by Claude Code over all of its requests. */
  total: TokenUsage;
  /** Prompt size of the turn's last main-conversation request (input + cache read + cache write): the context the next turn starts from. */
  context?: number;
}

/**
 * Claude Code tools that cannot work inside Unify or that Unify replaces, apart from the native agent tools
 * (nativeAgents.ts). Removing them takes their definitions out of every request; names a Claude Code version does
 * not have are ignored.
 */
export const TRIMMED_CLAUDE_TOOLS = [
  // Prompts scheduled into the session later; the claude process exits after every Unify turn, so they never fire.
  'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList',
  // Worktrees would move work out of the working copy Unify reviews.
  'EnterWorktree', 'ExitWorktree',
  // Cards and pages that only claude.ai shows; Unify's chat cannot display them (it has send_media for files).
  'SendUserFile', 'ReportFindings', 'ShowOnboardingRolePicker', 'ReadNotifications', 'Artifact', 'ArtifactComments', 'ArtifactData', 'DesignSync',
  'SuggestConnectors', 'SuggestPluginInstall', 'SuggestSkills',
  // Phone notifications, cloud triggers and messages to other projects reach outside the Unify chat.
  'PushNotification', 'RemoteTrigger', 'SendToProject', 'SendToProjectContext',
];

/** Built-in tools a lean explorer keeps (CliTurn.explorer). */
export const EXPLORER_CLAUDE_TOOLS = ['Read', 'Grep', 'Glob'];

/** System text for a lean explorer, which replaces Claude Code's whole system prompt. */
export function explorerSystem(cwd: string, extra?: string): string {
  return [
    `You are a read-only code explorer. You work in ${cwd} (${process.platform}). Never modify, create or delete files.`,
    'Use Read, Grep and Glob, and the Unify tools when they fit (batch several reads or searches into one call; file summaries before whole files).',
    'Answer exactly what the task asks, concisely, with file:line references. Do not guess: say what you could not find.',
    extra?.trim() ?? '',
  ].filter(Boolean).join('\n');
}

/** System text for lean one-shots, which replaces Claude Code's whole system prompt. */
export const LEAN_SYSTEM = 'Reply with only what the request asks for. Do not use tools.';

/** Reads a Claude `usage` object; undefined when it has no token counts. */
export function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (typeof usage.input_tokens !== 'number' && typeof usage.cache_read_input_tokens !== 'number') return undefined;
  const creation = (usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : {}) as Record<string, unknown>;
  return {
    input: count(usage.input_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    cacheWrite1h: count(creation.ephemeral_1h_input_tokens),
    cacheWrite5m: count(creation.ephemeral_5m_input_tokens),
    output: count(usage.output_tokens),
  };
}

/** Built-in tools a Claude Code turn leaves out: native agent tools while they are blocked, plus the trimmed tools when asked. */
function disallowedClaudeTools(turn: CliTurn): string[] {
  const blockAgents = nativeAgentsBlocked();
  const nativeAgentTools = blockAgents ? CLAUDE_NATIVE_AGENT_TOOLS : [];
  const multiAgentTools = blockAgents && turn.trimTools ? CLAUDE_MULTI_AGENT_TOOLS : [];
  const trimmedTools = turn.trimTools ? TRIMMED_CLAUDE_TOOLS : [];
  return [...nativeAgentTools, ...multiAgentTools, ...trimmedTools];
}

/** Command-line arguments for one Claude Code turn. */
export function claudeArgs(turn: CliTurn): string[] {
  const model = turn.backend === 'default' ? [] : ['--model', turn.backend];
  const effort = turn.effort ? ['--effort', turn.effort] : [];
  if (turn.lean) {
    // --safe-mode skips CLAUDE.md, memory, skills, hooks, plugins and MCP servers but keeps the subscription login (--bare would need an API key).
    return [
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--safe-mode',
      '--system-prompt', turn.system ?? LEAN_SYSTEM,
      '--tools', '',
      '--no-session-persistence',
      ...model,
      ...effort,
    ];
  }
  const bridge = turn.delegate ? ['--mcp-config', JSON.stringify({ mcpServers: { unify: turn.delegate } }), '--allowedTools', 'mcp__unify'] : [];
  if (turn.explorer) {
    // Not --safe-mode: it also drops --mcp-config servers, and with them the Unify bridge.
    return [
      '--print', ...claudeSpeedSettings(turn.speed),
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio',
      '--tools', EXPLORER_CLAUDE_TOOLS.join(','),
      '--strict-mcp-config', ...bridge,
      '--disable-slash-commands',
      '--system-prompt', explorerSystem(turn.cwd, turn.system),
      '--include-partial-messages',
      '--permission-mode', 'default',
      ...effort,
      ...model,
      ...(turn.sessionId ? ['--resume', turn.sessionId] : []),
    ];
  }
  const disallowedTools = disallowedClaudeTools(turn);
  return [
    '--print', ...claudeSpeedSettings(turn.speed),
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio',
    ...(disallowedTools.length ? ['--disallowedTools', disallowedTools.join(',')] : []),
    '--append-system-prompt', turn.system ?? delegationInstructions(canDelegate(turn.delegate)),
    ...bridge,
    '--include-partial-messages',
    ...(turn.images?.length ? ['--add-dir', dirname(turn.images[0].path)] : []),
    '--permission-mode', 'default',
    ...effort,
    ...model,
    ...(turn.sessionId ? ['--resume', turn.sessionId] : []),
  ];
}

/**
 * How long Claude Code must stay idle, with nothing left to run, before its input is closed. A queued message or a
 * finished background task turns it back to running within this time.
 */
export const IDLE_CLOSE_MS = 1_500;

/**
 * Longest wait on background tasks Unify tracks before closing input anyway. Claude Code stops a background command
 * after at most 2 hours, so a real task ends before this; the limit only covers a task whose end was never reported.
 */
export const BACKGROUND_WAIT_LIMIT_MS = 130 * 60_000;

/** Claude Code that reports session state, after a result, has not gone idle within this time: input is closed anyway so the turn cannot hang. */
export const NO_IDLE_LIMIT_MS = 10 * 60_000;

/** Child environment for a Claude turn, with the prompt cache lifetime when the turn sets one. */
function claudeEnv(turn: CliTurn): NodeJS.ProcessEnv {
  const ttl = turn.cacheTtl ?? (turn.lean ? '5m' : undefined);
  // Session state events (idle / running / requires_action) tell Unify when closing stdin can no longer cut off a permission request.
  const env: NodeJS.ProcessEnv = {
    ...agentEnv(cliEnv(turn.account)),
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
    // claude.ai connectors (Claude Docs and the like) add their instructions and tool schemas to every request and
    // have no use inside Unify, which brings its own tools over the Unify bridge.
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    // A lean explorer gets its memory and summary notes in Unify's brief; Claude Code's own copies would repeat them.
    ...(turn.explorer ? { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' } : {}),
  };
  return ttl ? { ...env, CLAUDE_CODE_PROMPT_CACHE_TTL: ttl } : env;
}

/** Image types the Claude API accepts as inline image blocks. */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Largest attachment sent inline; the API rejects images over 5 MB. Bigger ones are passed as paths to Read. */
const INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The user message content for a turn. Attached images go inline as base64 image blocks, so the model sees them
 * without first spending a request on Read; an image that cannot go inline is listed as a path instead.
 */
export function userContent(prompt: string, images: CliTurn['images']): unknown[] {
  const blocks: unknown[] = [];
  const inlined: string[] = [];
  const byPath: string[] = [];
  for (const image of images ?? []) {
    const mediaType = image.mimeType === 'image/jpg' ? 'image/jpeg' : image.mimeType;
    let data: Buffer | undefined;
    if (INLINE_IMAGE_TYPES.has(mediaType)) {
      try { data = readFileSync(image.path); } catch { data = undefined; }
    }
    if (data && data.length <= INLINE_IMAGE_BYTES) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } });
      inlined.push(image.path);
    } else byPath.push(image.path);
  }
  const notes = [
    inlined.length ? `Attached images (shown above; saved at):\n${inlined.join('\n')}` : '',
    byPath.length ? `Attached images (view these files):\n${byPath.join('\n')}` : '',
  ].filter(Boolean);
  blocks.push({ type: 'text', text: notes.length ? `${prompt}\n\n${notes.join('\n\n')}` : prompt });
  return blocks;
}

/** Runs one Claude Code turn as `claude --print` with stream-json input and output. */
export class ClaudeCliRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private cancelled = false;
  private cancelTurn?: () => void;
  private sayTurn?: (text: string) => boolean;
  private waitTurn?: () => boolean;

  cancel(): void { this.cancelled = true; this.cancelTurn?.(); }

  /**
   * Adds a user message to the running turn; Claude Code reads it before its next request. Also accepted after the
   * reply while the process waits on background tasks, which starts a new reply in the same process. False when no
   * turn can take it.
   */
  say(text: string): boolean { return this.sayTurn?.(text) ?? false; }

  /** True when the reply is finished and the process is only kept alive for background tasks. */
  waitingOnBackground(): boolean { return this.waitTurn?.() ?? false; }

  async prompt(turn: CliTurn): Promise<string | undefined> {
    if (this.child) throw new Error('An account turn is already running.');
    this.cancelled = false;
    const args = claudeArgs(turn);
    return new Promise<string | undefined>((resolve, reject) => {
      let buffer = '';
      let errorText = '';
      let sessionId = turn.sessionId;
      let done = false;
      let emitted = '';
      const currentClaudeMessages = new Map<string, string>();
      const streamedClaudeMessages = new Set<string>();
      const toolNames = new Map<string, string>();
      const subagentTools = new Set<string>();
      const subagentText = new Map<string, string>();
      const subagentMessages = new Map<string, Map<string, string>>();
      // Live edit preview: the agent's own edit calls whose input is streaming, keyed by content block index.
      const streamingEdits = new Map<number, { id: string; name: string; json: string; reportedAt: number }>();
      const reportToolInput = (id: string, name: string, input: Record<string, unknown>, streaming: boolean): void => {
        try { turn.onToolInput?.({ id, name, input, streaming }); } catch { /* Callback errors must not interrupt the turn. */ }
      };
      // Claude asks permission over stdin, and once stdin has ended every request fails with "Stream closed".
      // It can keep working after a result: background tasks finish and continue the turn, and a resumed session
      // can report a result before it reads the new message. So stdin stays open until Claude reports it is idle
      // with no background task left (older CLIs without session state: until the result, or 5 s of quiet).
      // Background task id → description.
      const backgroundTasks = new Map<string, string>();
      // Background task id → the Bash command that started it; Bash tool_use id → command for background Bash calls.
      const backgroundCommands = new Map<string, string>();
      const backgroundToolCommands = new Map<string, string>();
      let lastTaskReport = '[]';
      const reportTasks = (): void => {
        const tasks = [...backgroundTasks].map(([id, description]) => {
          const command = backgroundCommands.get(id);
          return { id, description, ...(command ? { command } : {}) };
        });
        const signature = JSON.stringify(tasks);
        if (signature === lastTaskReport) return;
        lastTaskReport = signature;
        try { turn.onBackgroundTasks?.(tasks); } catch { /* Callback errors must not interrupt the turn. */ }
      };
      // The command of a background task: the event's own `command`, else the Bash call that started it.
      const taskCommand = (task: Record<string, unknown>): string | undefined => {
        if (typeof task.command === 'string' && task.command.trim()) return task.command;
        return typeof task.tool_use_id === 'string' ? backgroundToolCommands.get(task.tool_use_id) : undefined;
      };
      let turnOver = false;
      let waitingForTasks = false;
      let idleTimer: NodeJS.Timeout | undefined;
      // Latest session_state_changed state; undefined while this CLI has reported none.
      let sessionState: string | undefined;
      const reportWait = (tasks: string[]): void => {
        try { turn.onBackgroundWait?.(tasks); } catch { /* Callback errors must not interrupt the turn. */ }
      };
      // A background task that never ends (a dev server, a watcher) keeps Claude alive after its input closes,
      // so the turn would wait forever. Past a grace period the process tree, task included, is stopped.
      let exitTimer: NodeJS.Timeout | undefined;
      let stoppedLingering = false;
      const endInput = (): void => {
        clearTimeout(idleTimer);
        if (!child.stdin.writableEnded) child.stdin.end();
        if (!exitTimer) exitTimer = setTimeout(() => {
          if (done || child.exitCode !== null || !turnOver) return;
          stoppedLingering = true;
          terminateProcessTree(child);
        }, 15_000);
        exitTimer.unref();
      };
      const settleInput = (): void => {
        clearTimeout(idleTimer);
        if (!turnOver || child.stdin.writableEnded) return;
        const wait = backgroundTasks.size ? BACKGROUND_WAIT_LIMIT_MS
          : sessionState === undefined ? 5_000
          : sessionState === 'idle' ? IDLE_CLOSE_MS : NO_IDLE_LIMIT_MS;
        idleTimer = setTimeout(endInput, wait);
      };
      const noteSubagentText = (agent: string, message: string, text: string, append: boolean): void => {
        const messages = subagentMessages.get(agent) || new Map<string, string>();
        subagentMessages.set(agent, messages);
        messages.set(message, append ? (messages.get(message) || '') + text : text);
        subagentText.set(agent, [...messages.values()].join('\n'));
      };
      let contextTokens: number | undefined;
      let lastContextRequest = '';
      const child = spawn(cliCommand('claude-cli'), args, {
        cwd: turn.cwd, env: claudeEnv(turn), windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      applyAgentPriority(child.pid);
      const finish = (error?: Error): void => {
        if (done) return;
        done = true;
        clearTimeout(idleTimer);
        // The CLI is gone, so its background tasks are too (a lingering process tree is stopped soon after input ends).
        backgroundTasks.clear();
        reportTasks();
        this.child = undefined;
        this.cancelTurn = undefined;
        this.sayTurn = undefined;
        this.waitTurn = undefined;
        if (error) reject(error); else resolve(sessionId);
      };
      this.cancelTurn = () => { terminateProcessTree(child); finish(); };
      const open = (): boolean => !done && !this.cancelled && !child.stdin.writableEnded && !child.stdin.destroyed;
      this.waitTurn = () => open() && turnOver && waitingForTasks;
      this.sayTurn = text => {
        // After the reply, only a process kept alive for background tasks takes a message; otherwise input is about to close.
        if (!open() || (turnOver && !waitingForTasks)) return false;
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
        if (turnOver) {
          // A new reply starts; keep input open until it ends.
          turnOver = false;
          waitingForTasks = false;
          clearTimeout(idleTimer);
          reportWait([]);
        }
        return true;
      };
      const emit = (value: string): void => {
        if (!value) return;
        if (value.startsWith(emitted)) { turn.onText(value.slice(emitted.length)); emitted = value; }
        else { turn.onText(value); emitted += value; }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (done || this.cancelled) return;
        buffer += chunk;
        if (buffer.length > 10_000_000) { child.kill(); finish(new Error('CLI output exceeded the size limit.')); return; }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          if (!line) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          if (event.type === 'rate_limit_event') {
            try { turn.onRateLimit?.(event.rate_limit_info); } catch { /* Callback errors must not interrupt the turn. */ }
            continue;
          }
          if (typeof event.session_id === 'string') sessionId = event.session_id;
          if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.tools)) {
            const tools = event.tools.filter((tool): tool is string => typeof tool === 'string');
            try { turn.onInit?.({ tools, model: typeof event.model === 'string' ? event.model : undefined }); } catch { /* Callback errors must not interrupt the turn. */ }
          }
          if (event.type === 'system' && typeof event.task_id === 'string') {
            const status = event.subtype === 'task_updated' ? (event.patch as Record<string, unknown> | undefined)?.status : event.status;
            if (event.subtype === 'task_started') {
              backgroundTasks.set(event.task_id, typeof event.description === 'string' ? event.description : 'Background task');
              const command = taskCommand(event);
              if (command) backgroundCommands.set(event.task_id, command);
            } else if (event.subtype === 'task_notification' || (event.subtype === 'task_updated' && typeof status === 'string')) {
              if (status !== 'running' && status !== 'pending') backgroundTasks.delete(event.task_id);
            }
            reportTasks();
          }
          // The full list of running tasks, so a task whose end was reported some other way is not waited on forever.
          if (event.type === 'system' && event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
            const running = new Set<string>();
            for (const task of event.tasks) {
              if (!task || typeof task !== 'object') continue;
              const { task_id: id, description } = task as Record<string, unknown>;
              if (typeof id !== 'string') continue;
              running.add(id);
              if (!backgroundTasks.has(id)) backgroundTasks.set(id, typeof description === 'string' ? description : 'Background task');
              const command = taskCommand(task as Record<string, unknown>);
              if (command) backgroundCommands.set(id, command);
            }
            for (const id of [...backgroundTasks.keys()]) if (!running.has(id)) backgroundTasks.delete(id);
            reportTasks();
            if (waitingForTasks && backgroundTasks.size) reportWait([...backgroundTasks.values()]);
          }
          const stateChange = event.type === 'system' && event.subtype === 'session_state_changed' && typeof event.state === 'string' ? event.state : undefined;
          if (stateChange) sessionState = stateChange;
          if (event.type === 'assistant' || event.type === 'stream_event' || event.type === 'control_request' || (stateChange && stateChange !== 'idle')) {
            turnOver = false;
            if (waitingForTasks) {
              waitingForTasks = false;
              reportWait([]);
            }
          }
          if (event.type === 'result') {
            turnOver = true;
            // A CLI that reports session state is closed once it goes idle (settleInput); an older one right away.
            if (!backgroundTasks.size) { if (sessionState === undefined) endInput(); }
            else {
              waitingForTasks = true;
              reportWait([...backgroundTasks.values()]);
            }
          }
          settleInput();
          if (event.type === 'control_request') {
            const request = (event.request || {}) as Record<string, unknown>;
            const requestId = String(event.request_id || '');
            const respond = (response: Record<string, unknown>): void => {
              if (!done && !this.cancelled && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n');
            };
            if (request.subtype === 'can_use_tool') {
              if (nativeAgentsBlocked() && isNativeSubagentTool(String(request.tool_name || ''))) {
                respond({ behavior: 'deny', message: 'Use Unify delegate_task with a configured subagent profile.' });
                continue;
              }
              const input = (request.input && typeof request.input === 'object' ? request.input : {}) as Record<string, unknown>;
              // In print mode AskUserQuestion only gets answers through the permission callback; approving it plainly returns none.
              if (request.tool_name === 'AskUserQuestion') {
                void (turn.onQuestions ? turn.onQuestions(input) : Promise.resolve('Asking the user is not available here. Continue with your best judgement.')).then(
                  answers => respond(typeof answers === 'string' ? { behavior: 'deny', message: answers } : { behavior: 'allow', updatedInput: { ...input, answers } }),
                  () => respond({ behavior: 'deny', message: 'Could not show the questions to the user.' }));
                continue;
              }
              const description = `${String(request.tool_name || 'Tool')}: ${typeof input.command === 'string' ? input.command : JSON.stringify(input).slice(0, 1500)}`;
              const info = { tool: String(request.tool_name || ''), input, autoAllowEdits: true };
              void (turn.onApproval ? turn.onApproval(description, info) : Promise.resolve(false)).then(
                allowed => respond(allowed === true ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: typeof allowed === 'string' ? allowed : 'The user rejected this action.' }),
                () => respond({ behavior: 'deny', message: 'Approval failed.' }));
            } else if (requestId) {
              child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'Unsupported request' } }) + '\n');
            }
            continue;
          }
          if (event.type === 'stream_event') {
            const stream = event.event as Record<string, unknown> | undefined;
            const delta = stream?.delta as Record<string, unknown> | undefined;
            const parentToolId = String(event.parent_tool_use_id || stream?.parent_tool_use_id || '');
            const source = parentToolId || 'root';
            if (stream?.type === 'message_start') {
              currentClaudeMessages.set(source, String((stream.message as Record<string, unknown> | undefined)?.id || ''));
              if (!parentToolId) { turn.onMessageBreak?.(); streamingEdits.clear(); }
            }
            if (!parentToolId && turn.onToolInput && typeof stream?.index === 'number') {
              const block = stream.content_block as Record<string, unknown> | undefined;
              if (stream.type === 'content_block_start' && block?.type === 'tool_use' && isEditTool(String(block.name || ''))) {
                streamingEdits.set(stream.index, { id: String(block.id || ''), name: String(block.name), json: '', reportedAt: 0 });
              } else if (stream.type === 'content_block_delta' && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                const edit = streamingEdits.get(stream.index);
                if (edit) {
                  edit.json += delta.partial_json;
                  const now = Date.now();
                  if (now - edit.reportedAt >= TOOL_INPUT_INTERVAL_MS) {
                    const input = parsePartialJson(edit.json);
                    if (input) { edit.reportedAt = now; reportToolInput(edit.id, edit.name, input, true); }
                  }
                }
              } else if (stream.type === 'content_block_stop') {
                streamingEdits.delete(stream.index);
              }
            }
            if (stream?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
              const messageId = currentClaudeMessages.get(source) || 'stream';
              if (parentToolId) { noteSubagentText(parentToolId, messageId, delta.text, true); turn.onSubagent?.({ id: parentToolId, text: delta.text, messageId }); }
              else { turn.onText(delta.text); emitted += delta.text; }
              if (messageId !== 'stream') streamedClaudeMessages.add(messageId);
            }
          }
          if (event.type === 'assistant') {
            const message = event.message as Record<string, unknown> | undefined;
            const blocks = Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];
            const parentToolId = String(event.parent_tool_use_id || message?.parent_tool_use_id || '');
            const requestUsage = parentToolId ? undefined : parseUsage(message?.usage);
            if (requestUsage) {
              contextTokens = requestUsage.input + requestUsage.cacheRead + requestUsage.cacheWrite;
              // Claude Code repeats a request's usage on each of its content events; report each request once.
              const requestId = String(message?.id || '');
              if (requestId !== lastContextRequest) { lastContextRequest = requestId; try { turn.onContext?.(contextTokens); } catch { /* ignored */ } }
            }
            for (const block of blocks) {
              if (block.type === 'text' && typeof block.text === 'string' && !streamedClaudeMessages.has(String(message?.id || ''))) {
                if (parentToolId) { noteSubagentText(parentToolId, String(message?.id || 'message'), block.text, false); turn.onSubagent?.({ id: parentToolId, text: block.text, messageId: String(message?.id || 'message') }); }
                else { turn.onText(block.text); emitted += block.text; }
              }
              if (block.type === 'tool_use') {
                const id = String(block.id || block.name || 'claude-tool');
                const title = String(block.name || 'Claude tool');
                toolNames.set(id, title);
                const input = block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {};
                if (/^Bash$/i.test(title) && input.run_in_background === true && typeof input.command === 'string') backgroundToolCommands.set(id, input.command);
                if (/^(Agent|Task)$/i.test(title)) {
                  subagentTools.add(id);
                  turn.onSubagent?.({ id, title: String(input.description || input.name || 'Subagent'), prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
                    model: typeof input.model === 'string' ? input.model : turn.backend, state: 'running' });
                } else if (parentToolId) turn.onSubagent?.({ id: parentToolId, text: `${title}${Object.keys(input).length ? `: ${JSON.stringify(input).slice(0, 500)}` : ''}`, messageId: `tool:${id}`, role: 'tool' });
                else {
                  if (isEditTool(title)) reportToolInput(id, title, input, false);
                  turn.onTool(id, title, block.input && typeof block.input === 'object' ? JSON.stringify(block.input).slice(0, 500) : undefined, 'running');
                }
              }
            }
          }
          if (event.type === 'user') {
            const message = event.message as Record<string, unknown> | undefined;
            const blocks = Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];
            const parentToolId = String(event.parent_tool_use_id || message?.parent_tool_use_id || '');
            for (const block of blocks) if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              if (subagentTools.has(block.tool_use_id)) {
                const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
                  ? (block.content as Record<string, unknown>[]).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : undefined;
                const cleaned = text?.replace(/\n*agentId: [\s\S]*$/, '').trim();
                const seen = subagentText.get(block.tool_use_id) || '';
                const duplicate = !cleaned || seen.includes(cleaned);
                turn.onSubagent?.({ id: block.tool_use_id, state: block.is_error ? 'error' : 'complete', ...(duplicate ? {} : { text: cleaned, messageId: 'result' }) });
              } else if (!parentToolId) {
                const title = toolNames.get(block.tool_use_id) || 'Claude tool';
                turn.onTool(block.tool_use_id, title, undefined, block.is_error ? 'error' : 'complete',
                  block.is_error ? toolErrorText(block.content) : undefined);
                const content = Array.isArray(block.content) ? block.content as Record<string, unknown>[] : [];
                if (!block.is_error && content.some(item => item?.type === 'image')) {
                  try { turn.onToolImages?.(block.tool_use_id, title, content); } catch { /* Callback errors must not interrupt the turn. */ }
                }
              }
            }
          }
          if (event.type === 'result') {
            const total = parseUsage(event.usage);
            if (total) {
              try { turn.onUsage?.({ total, context: contextTokens }); } catch { /* Callback errors must not interrupt the turn. */ }
            }
            const result = typeof event.result === 'string' ? event.result.trim() : '';
            // A spent plan comes back as a result whose only text is the limit notice.
            if (result && (event.is_error === true ? isUsageLimitText(result) : isLimitNotice(result))) {
              child.kill(); finish(new UsageLimitError(`Claude Code usage limit: ${result.slice(0, 300)}`)); return;
            }
            if (event.is_error === true) { child.kill(); finish(new Error(`Claude Code turn failed.${result ? ` ${result.slice(0, 300)}` : ''} Check the CLI login and model.`)); return; }
          }
          if (event.type === 'result' && !emitted && typeof event.result === 'string') emit(event.result);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { errorText = (errorText + chunk).slice(-4000); });
      child.on('error', () => finish(new Error('Claude Code CLI could not start. Check the configured path.')));
      const closed = (code: number | null): void => finish(code === 0 || this.cancelled || stoppedLingering ? undefined : isUsageLimitText(errorText)
        ? new UsageLimitError(`Claude Code usage limit: ${errorText.trim().slice(-300)}`)
        : new Error(`Claude Code exited with code ${code}. ${errorText.includes('not logged') ? 'Sign in again from Accounts.' : 'Open the CLI for details.'}`));
      child.on('close', closed);
      // 'close' waits for every holder of the output pipes; a process Claude left behind can hold them open, so the exit alone ends the turn soon after.
      child.on('exit', code => { setTimeout(() => closed(code), 3_000).unref(); });
      child.stdin.on('error', () => undefined);
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: userContent(turn.prompt, turn.images) } }) + '\n');
    });
  }
}

/** Runs each Claude subscription turn on the Claude Code CLI in the isolated review workspace. */
export class OAuthCliRuntime extends ClaudeCliRuntime {}
