/** Startup, shutdown and background-service plumbing: Node and provider installs, desktop notifications, state saving, commands. */
import type { Host as ExtensionHost } from '../extension';
import * as vscode from 'vscode';
import { setDetectedCliCommand } from '../accounts/oauthCli';
import { setCodexCommand } from '../runtime/codexCli';
import { getUnifyFeature } from '../unify/settings';
import { ShutdownActivity } from '../unify/power';
import { SMART_AUTO } from '../runtime/smartAuto';
import type { SessionRecord } from './types';
import { SELECTED_MODEL_KEY, ACTIVE_SESSION_KEY, MODEL_CHOICES_KEY, TIMELINES_KEY } from './constants';
import { isCliProvider, runtimeLabel } from './helpers';

export function ensureNode(this: ExtensionHost): Promise<string> {
  if (!this.nodeReady) {
    this.nodeReady = Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Unify: checking Node.js and npm…' }, () => this.dependencies.ensureNode())).catch(error => { this.nodeReady = undefined; throw error; });
  }
  return this.nodeReady;
}

export async function refreshDependencies(this: ExtensionHost): Promise<void> {
  const providers = await Promise.all(['claude-cli', 'cursor-acp'].map(async provider => {
    let installed = false;
    try {
      const command = await this.dependencies.providerCommand(provider);
      installed = !!command;
      if (command && isCliProvider(provider)) setDetectedCliCommand(provider, command);
    } catch (error) { this.providerErrors.set(provider, error instanceof Error ? error.message : String(error)); }
    return { provider, installed, installing: this.providerInstalls.has(provider), error: this.providerErrors.get(provider) };
  }));
  setCodexCommand(vscode.workspace.getConfiguration('unify').get<string>('runtime.codexPath')?.trim() || undefined);
  this.sidebar.postMessage({ type: 'dependencyState', providers });
}

export async function installProvider(this: ExtensionHost, provider: string): Promise<void> {
  if (!['claude-cli', 'cursor-acp'].includes(provider)) throw new Error('Unsupported provider installation.');
  if (this.providerInstalls.has(provider)) return;
  this.providerInstalls.add(provider);
  this.providerErrors.delete(provider);
  await this.refreshDependencies();
  try {
    await this.ensureNode();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Unify: installing ${runtimeLabel(provider)}…` }, () => this.dependencies.installProvider(provider));
  } catch (error) {
    this.providerErrors.set(provider, error instanceof Error ? error.message : String(error));
    throw error;
  } finally { this.providerInstalls.delete(provider); await this.refreshDependencies(); }
}

/** Desktop notification for a request or a finished turn, shown only while the window is unfocused. */
export function notifyDesktop(this: ExtensionHost, title: string, body: string): void {
  if (this.windowFocused || !getUnifyFeature('notifications.desktop')) return;
  vscode.env?.notify?.(title, body);
}

/** Everything the shutdown controller treats as work in progress, across every chat and pane. */
export function shutdownActivity(this: ExtensionHost): ShutdownActivity {
  let runningProcesses = 0;
  for (const id of this.chats.keys()) {
    for (const item of this.sidebar.timeline(id)) {
      if (item.kind === 'tool' && item.event.state === 'running') runningProcesses += 1;
    }
  }
  return {
    // Queued messages and background subagents are work still to finish too, even between turns.
    runningChats: [...this.chats.values()].filter(chat => chat.running || chat.jobActive || chat.queue.length > 0 || chat.background.size > 0).length,
    runningSubagents: this.childRuns.size,
    pendingApprovals: this.pendingApprovals.size,
    pendingQuestions: this.pendingQuestions.size,
    runningProcesses,
    // Only this project's prompts: others never fire here, so they must not hold the PC on forever.
    pendingScheduled: this.scheduled?.list().length ?? 0,
  };
}

/** Flushes chats, transcripts and timelines before the PC shuts down; a rejection cancels the shutdown. */
export async function saveAllState(this: ExtensionHost): Promise<void> {
  for (const chat of this.chats.values()) await this.saveSession(chat.record, this.active?.id === chat.record.id);
  await this.saveTranscripts();
  await this.context.workspaceState.update(TIMELINES_KEY, this.timelines);
}

export function registerCommands(this: ExtensionHost): void {
  const command = (name: string, action: () => Promise<void> | void): void => {
    this.disposables.push(vscode.commands.registerCommand(name, () => this.guarded(action)));
  };
  command('unify.newChat', () => this.newChat());
  command('unify.continue', () => this.continueChat());
  command('unify.cancel', () => this.cancel());
  command('unify.pickModel', () => this.pickModel());
  command('unify.manageModels', () => this.manageModels());
  command('unify.manageAccounts', () => this.manageAccounts());
  command('unify.applyAll', () => this.review?.applyAll());
  command('unify.rejectAll', () => this.review?.rejectAll());
  command('unify.openRuntimeLogs', () => { this.output.show(); });
  command('unify.restartRuntime', () => this.restartRuntime());
  command('unify.checkForUpdates', () => this.checkUpdates(true));
  command('unify.reviewNext', () => this.reviewNext());
  command('unify.reviewAll', () => this.review?.openAll());
  command('unify.openWorkingCopyTerminal', () => this.openWorkingCopyTerminal());
  command('unify.applyHunk', () => this.review?.chooseHunk('apply'));
  command('unify.rejectHunk', () => this.review?.chooseHunk('reject'));
}

export async function guarded(this: ExtensionHost, action: () => Promise<void> | void): Promise<void> {
  try { await action(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(message);
    this.sidebar.postMessage({ type: 'error', message });
  }
}

export async function afterActivate(this: ExtensionHost, record: SessionRecord, idle: boolean): Promise<void> {
  this.postJob(record);
  this.replayTranscript(record.id);
  const auto = !!record.smartAuto && this.smartAutoReady();
  this.selectedModel = auto ? SMART_AUTO : record.modelName;
  // Smart Auto's picks are not the user's own speed and effort choices for that model.
  const selected = auto ? undefined : this.availableModel(record.modelName);
  if (selected) {
    this.modelChoices[selected.name] = {
      speed: selected.speedOptions?.find(item => item.backend === record.backend)?.label,
      effort: record.effort || '',
    };
    void this.guarded(async () => { await this.context.workspaceState.update(MODEL_CHOICES_KEY, this.modelChoices); });
  }
  const saved = Promise.all([
    this.context.workspaceState.update(SELECTED_MODEL_KEY, this.selectedModel),
    this.context.workspaceState.update(ACTIVE_SESSION_KEY, record.id),
  ]);
  this.refreshSessions(); this.refreshModels();
  this.syncActiveView();
  if (idle) this.postRun(record.id, 'idle', 'Ready');
  void this.guarded(() => this.refreshAccount());
  await saved;
}
