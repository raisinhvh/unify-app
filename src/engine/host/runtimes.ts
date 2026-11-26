/** Agent runtime pool: creating, reusing, restarting and releasing the per-chat ACP runtimes, and keeping chats alive. */
import type { Host as ExtensionHost } from '../extension';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ModelEntry } from '../accounts';
import { freshCodexTokens } from '../accounts/codexAuth';
import { unbindChatAgentOwner } from '../delegate/messaging';
import { writeAudienceInstructions } from '../instructions/audiences';
import type { AudienceTarget } from '../unify/knowledgeAudience';
import { SELF_HOSTED } from '../runtime/selfHosted';
import { updatedRoot } from '../update/unifyUpdate';
import { AcpRuntime } from '../runtime/acp';
import type { StuckCommand } from '../runtime/stuckCommands';
import { codexBackend } from '../runtime/models';
import { shouldKeepAlive } from '../runtime/keepAlive';
import { unifyHome } from '../unify/settings';
import { agentBus } from '../unify/agentBusImpl';
import type { ResolvedRoute, Chat } from './types';
import { CODEX_TOKEN_MARGIN_MS } from './constants';
import { isCliProvider, usesCliChat } from './helpers';

export function chatForRuntime(this: ExtensionHost, runtimeId: string, key: string): Chat | undefined {
  return [...this.chats.values()].find(chat => chat.runtimeKey === key && this.rid(chat.record) === runtimeId);
}

export function runtimeFor(this: ExtensionHost, key: string): AcpRuntime {
  const existing = this.runtimes.get(key);
  if (existing) return existing;
  const runtime = new AcpRuntime(this.output, params => this.requestPermission(params, key), (method, params) => this.handleCursorRequest(method, params));
  this.runtimes.set(key, runtime);
  runtime.onUpdate(event => this.onRuntimeUpdate(event, key));
  runtime.onStuckCommand(command => this.onStuckCommand(key, command));
  runtime.onState(state => {
    if (state === 'stopped' && this.runtimes.get(key) === runtime) this.runtimes.delete(key);
  });
  return runtime;
}

/** Reports a stuck shell command stopped by the runtime watchdog to every chat using that runtime. */
export function onStuckCommand(this: ExtensionHost, key: string, command: StuckCommand): void {
  const minutes = Math.max(1, Math.round(command.idleMs / 60_000));
  const suffix = command.command ? `: ${command.command}` : '';
  const text = `Stopped a stuck command after ${minutes} min with no activity${suffix}`;
  const chatIds = new Set<string>();
  for (const chat of this.chats.values()) {
    if (chat.runtimeKey === key) chatIds.add(chat.record.id);
  }
  for (const run of this.childRuns) {
    if (run.runtimeKey === key) chatIds.add(run.parent.record.id);
  }
  for (const sessionId of chatIds) {
    this.sidebar.postMessage({
      type: 'noteMessage',
      sessionId,
      entryId: `stuck:${command.runnerPid}:${Date.now()}`,
      icon: 'timer_off',
      text,
    });
  }
}

export async function releaseRuntime(this: ExtensionHost, key: string | undefined): Promise<void> {
  if (!key) return;
  if ([...this.chats.values()].some(chat => chat.runtimeKey === key) || [...this.childRuns].some(run => run.runtimeKey === key)) return;
  const runtime = this.runtimes.get(key);
  if (!runtime) return;
  this.runtimes.delete(key);
  await runtime.stop();
  runtime.dispose();
}

export async function unloadChat(this: ExtensionHost, id: string): Promise<void> {
  const chat = this.chats.get(id);
  if (!chat) return;
  this.chats.delete(id);
  this.placesByChat.delete(id);
  if (chat.ping) { chat.cli.cancel(); await chat.ping; }
  if (this.active?.id === id) this.active = undefined;
  if (chat.runtime) await chat.runtime.closeSession(this.rid(chat.record)).catch(() => undefined);
  chat.review.dispose(); chat.mirror.dispose();
  agentBus.unregister(id);
  unbindChatAgentOwner(chat.ownerId);
  await this.releaseRuntime(chat.runtimeKey);
}

export function trimChats(this: ExtensionHost): void {
  // Bound retained runtimes/watchers while keeping recent navigation warm.
  const idle = [...this.chats.values()].filter(chat => !chat.running && !chat.jobActive && !chat.background.size && chat.record.id !== this.active?.id && !this.chatLoads.has(chat.record.id));
  for (const chat of idle.slice(0, Math.max(0, idle.length - 2))) void this.guarded(() => this.unloadChat(chat.record.id));
}

export async function ensureRuntime(this: ExtensionHost, route: ResolvedRoute, cwd: string, ownerId: string, target: AudienceTarget = { kind: 'main' }, codexCli = false): Promise<{ runtime: AcpRuntime; key: string } | undefined> {
  if ('oauthAccount' in route && (isCliProvider(route.model.provider) || (route.model.provider === 'codex-cli' && codexCli))) {
    if (isCliProvider(route.model.provider)) await this.refreshDependencies();
    return undefined;
  }
  await this.ensureNode();
  if (route.model.provider === 'cursor-acp') {
    const key = `cursor-acp:${ownerId}`;
    const runtime = this.runtimeFor(key);
    const { command, args } = this.cursorAgentLaunch();
    try { await runtime.start({ kind: 'cursor', command, args, cwd }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not start Cursor Agent CLI. Install it from https://cursor.com/docs/cli/installation, run "agent login", or set unify.runtime.cursorAgentPath. ${message}`);
    }
    await this.refreshAccount();
    return { runtime, key };
  }
  const deepSeekAccount = this.accounts.getDefault('deepseek-official');
  let start: { accountId: string; agentRuntimeProvider: string; model: string; secret: string; envName: string; keyExtra: string; baseURL?: string };
  if ('oauthAccount' in route) {
    // The token is fixed when the runtime launches, so one close to expiry is refreshed first. Its expiry is part of
    // the key: a refreshed token launches a new runtime, which resumes the chat's agent runtime session from the same home.
    const tokens = await freshCodexTokens(route.oauthAccount.directory, { minValidityMs: CODEX_TOKEN_MARGIN_MS });
    start = {
      accountId: route.oauthAccount.id,
      agentRuntimeProvider: 'openai-codex',
      model: codexBackend(route.model.backend),
      secret: tokens.access,
      envName: 'OPENAI_CODEX_ACCESS_TOKEN',
      keyExtra: `:${tokens.expires}`,
    };
  } else if ('account' in route) {
    start = {
      accountId: route.account.id,
      agentRuntimeProvider: route.model.provider,
      model: route.model.backend,
      secret: route.secret,
      envName: this.envName(route.model.provider),
      keyExtra: '',
      ...(route.model.provider === SELF_HOSTED ? { baseURL: this.selfHostedBaseURL(route.account) } : {}),
    };
  } else {
    throw new Error('The selected API provider has no account.');
  }
  // A forced cancellation must not terminate another chat or subagent.
  const key = `${route.model.provider}:${start.accountId}:${start.model}:${deepSeekAccount?.id || ''}${start.keyExtra}${start.baseURL ? `:${start.baseURL}` : ''}:${ownerId}`;
  const runtime = this.runtimeFor(key);
  const accountHash = createHash('sha256').update(start.accountId).digest('hex').slice(0, 16);
  const providerHash = createHash('sha256').update(route.model.provider).digest('hex').slice(0, 16);
  const home = join(this.context.globalStorageUri.fsPath, 'runtime', providerHash, accountHash);
  // Rules are filtered for this agent before the runtime starts; the runtime then reads only this file.
  const instructionsHome = join(home, 'instructions', createHash('sha256').update(ownerId).digest('hex').slice(0, 16));
  await writeAudienceInstructions({ unifyHome: unifyHome(), workspace: cwd }, target, instructionsHome, { fileName: 'AGENTS.audience.md' });
  const nodePath = await this.ensureNode();
  const webSearchKey = deepSeekAccount ? await this.accounts.getSecret(deepSeekAccount.id) : undefined;
  await runtime.start({ kind: 'unify', provider: start.agentRuntimeProvider, model: start.model, apiKey: start.secret,
    webSearchKey, envName: start.envName, efforts: route.model.effortOptions, baseURL: start.baseURL, home, instructionsHome, nodePath, agentRuntimeRoot: await updatedRoot(this.context.globalStorageUri.fsPath) });
  return { runtime, key };
}

/**
 * Moves a ChatGPT (Codex) chat onto a runtime with a valid access token when its token was refreshed (or `force`
 * refreshes it after an auth error), resuming the chat's agent runtime session there. Resolves false when the session could not
 * be resumed: the chat is then on a new session and its next prompt needs a handoff.
 */
export async function refreshCodexRuntime(this: ExtensionHost, chat: Chat, force = false): Promise<boolean> {
  const record = chat.record;
  const account = this.oauthAccounts.get(record.accountId);
  if (!account) throw new Error('The ChatGPT account for this chat is missing. Connect it again in Accounts.');
  if (force) await freshCodexTokens(account.directory, { force: true });
  const model: ModelEntry = { name: record.modelName, provider: record.provider, backend: record.backend, enabled: true };
  const slot = await this.ensureRuntime({ model, oauthAccount: account }, chat.mirror.cwd, chat.ownerId);
  if (!slot) throw new Error('ChatGPT (Codex) could not start.');
  if (slot.key === chat.runtimeKey && slot.runtime === chat.runtime && slot.runtime.isRunning) return true;
  const previous = chat.runtimeKey;
  chat.runtime = slot.runtime;
  chat.runtimeKey = slot.key;
  await this.releaseRuntime(previous);
  let resumed = true;
  try {
    await slot.runtime.resumeSession(this.rid(record), chat.mirror.cwd, this.mcpServers(chat.ownerId));
  } catch (error) {
    this.output.appendLine(`Resuming "${record.name}" on a refreshed ChatGPT runtime failed; continuing in a new session: ${error instanceof Error ? error.message : String(error)}`);
    record.runtimeId = await slot.runtime.newSession(chat.mirror.cwd, this.mcpServers(chat.ownerId));
    this.freshSessions?.add(record.runtimeId);
    record.explorerTokens = 0;
    resumed = false;
  }
  if (record.effort) await slot.runtime.setConfigOption(this.rid(record), 'reasoning_effort', record.effort);
  return resumed;
}

/** Refresh the cache of each loaded, idle Claude chat without adding a visible turn. */
export async function keepAliveChats(this: ExtensionHost): Promise<void> {
  for (const chat of this.chats.values()) {
    const record = chat.record;
    const config = vscode.workspace.getConfiguration('unify');
    // Usage credits are drawn only once a plan window is full; "Extra usage" alone just means credits are enabled.
    const metrics = this.usage.snapshot()[record.accountId]?.metrics || [];
    const extraEnabled = metrics.some(metric => metric.label === 'Extra usage');
    const planFull = metrics.some(metric => metric.label !== 'Extra usage' && (metric.usedPercent ?? 0) >= 100);
    const credits = extraEnabled && planFull;
    if (record.provider !== 'claude-cli' || !record.cliSessionId || chat.handoffPending || credits || !shouldKeepAlive({
      now: Date.now(), lastTurnAt: Math.max(record.lastTurnAt || 0, record.lastPingAt || 0) || undefined,
      contextTokens: record.contextTokens, hint: config.get<number>('checkpointHint', 80000),
      pingsSent: record.pingsSent || 0, max: config.get<number>('keepAliveMax', 3),
      shortCache: record.shortCache, running: chat.running || !!chat.ping, visible: this.active?.id === record.id,
    })) continue;
    const account = this.oauthAccounts.get(record.accountId);
    if (!account) continue;
    record.pingsSent = (record.pingsSent || 0) + 1;
    chat.ping = (async () => {
      try {
        // The same tool list as the chat's turns, or the ping would miss the cache it is meant to keep warm.
        await chat.cli.prompt({ account, cwd: chat.mirror.cwd, backend: record.backend, trimTools: this.feature('trimTools'),
          system: this.agentInstructions(chat, !!this.delegateConfig(chat.ownerId)), prompt: '(keep-alive: reply with OK only)',
          sessionId: record.cliSessionId, effort: 'low', speed: record.smartAuto ? undefined : this.choiceFor(this.availableModel(record.modelName)).speed,
          delegate: this.delegateConfig(chat.ownerId), onText: () => {}, onTool: () => {},
          readOnly: this.jobReadOnly(chat), fullAccess: this.approvalMode === 'full' && !this.jobReadOnly(chat),
          onApproval: async () => false, onUsage: usage => this.logUsage(record.id, 'keepalive', record.modelName, usage),
        });
        record.lastPingAt = Date.now();
      } catch (error) {
        this.output.appendLine(`Keep-alive failed: ${String(error)}`);
      } finally {
        if (this.chats.get(record.id) === chat && !this.deletedSessions.has(record.id)) {
          await this.saveSession(record).catch(error => this.output.appendLine(`Saving keep-alive state failed: ${String(error)}`));
        }
      }
    })();
    void chat.ping.then(() => { chat.ping = undefined; });
  }
}

/** Moves the chat to a new backend session; the caller sets what the next prompt hands over. */
export async function freshBackendSession(this: ExtensionHost, chat: Chat, reason: string): Promise<void> {
  const record = chat.record;
  if (chat.runtime) {
    // A failure here must not stop the caller, or the chat would stay "Thinking…" forever.
    try {
      record.runtimeId = await chat.runtime.newSession(chat.mirror.cwd, this.mcpServers(chat.ownerId));
      this.freshSessions?.add(record.runtimeId);
      if (record.provider === 'cursor-acp') {
        await this.refreshCursorModels(chat.runtime, record.runtimeId);
        if (record.backend !== 'auto' || chat.runtime.models(record.runtimeId).some(option => option.value === 'auto')) {
          await chat.runtime.setModel(record.runtimeId, record.backend);
        }
      }
      if (record.effort) await chat.runtime.setConfigOption(record.runtimeId, 'reasoning_effort', record.effort);
    } catch (error) {
      this.output.appendLine(`Starting a session after ${reason} failed: ${String(error)}`);
    }
  }
  record.previousCliSessionId = record.cliSessionId;
  record.cliSessionId = undefined;
  record.explorerTokens = 0;
  record.nudgedAt = undefined;
}

export async function restartRuntime(this: ExtensionHost): Promise<void> {
  for (const chat of this.chats.values()) this.cancel(true, chat.record.id);
  const id = this.active?.id;
  for (const [key, runtime] of [...this.runtimes]) { this.runtimes.delete(key); await runtime.stop(); runtime.dispose(); }
  for (const chat of [...this.chats.values()]) if (!chat.running || !usesCliChat(chat.record)) { chat.runtime = undefined; chat.runtimeKey = undefined; await this.unloadChat(chat.record.id); }
  if (id) await this.continueChat(id);
}
