/** Instructions, knowledge and memory: roots, watchers, syncing and sharing them. */
import type { Host as ExtensionHost } from '../extension';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { OAuthCliAccount } from '../accounts/oauthCli';
import { InstructionItem, InstructionRoots, listInstructions, removeInstruction, saveInstruction } from '../instructions/store';
import { shareInstructions } from '../instructions/share';
import { MEDIA_INSTRUCTIONS, SHOW_YOUR_WORK_INSTRUCTIONS } from '../runtime/media';
import { IMAGE_INSTRUCTIONS } from '../runtime/imageGen';
import { delegationInstructions } from '../runtime/delegation';
import { SUMMARY_INSTRUCTIONS } from '../summaries/store';
import { BACKGROUND_CLEANUP, shellInstructions } from '../runtime/agentShell';
import { globalMemoryFolder, memoryInstructions, syncGlobalMemory } from '../runtime/memory';
import { chatStorageInstructions } from '../runtime/chatStorage';
import { BATCH_INSTRUCTIONS } from '../runtime/batch';
import { SidebarWebviewMessage } from '../sidebar/provider';
import { getUnifyFeature, unifyHome } from '../unify/settings';
import type { Chat } from './types';
import { SYNC_OFFER_KEY } from './constants';
import { runtimeLabel, countFiles } from './helpers';

export function instructionRoots(this: ExtensionHost): InstructionRoots {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return {
    workspace: folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined,
    unifyHome: unifyHome(),
    agentsHome: process.env.UNIFY_AGENTS_HOME || join(homedir(), '.agents'),
  };
}

/** Global rules and skills edited outside the sidebar still trigger a sync upload. */
export function watchGlobalInstructions(this: ExtensionHost): vscode.Disposable[] {
  const { unifyHome, agentsHome } = this.instructionRoots();
  return ([[unifyHome, '{AGENTS.md,skills/**}'], [agentsHome, 'skills/**']] as const).flatMap(([base, pattern]) => {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), pattern));
    const schedule = (): void => this.sync.schedule();
    return [watcher, watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule)];
  });
}

/**
 * Rules, skills and memory notes changed on disk (by an agent, another window or an editor) refresh the
 * Knowledge screen. Bases are folders that already exist (the shim cannot watch a missing folder), so the
 * memory folder is watched through its parent.
 */
export function watchKnowledge(this: ExtensionHost): vscode.Disposable[] {
  const { unifyHome, agentsHome, workspace } = this.instructionRoots();
  const targets: [string, string][] = [];
  if (unifyHome) targets.push([unifyHome, '{AGENTS.md,skills/**,memory/**}']);
  if (agentsHome) targets.push([agentsHome, 'skills/**']);
  if (workspace) targets.push([workspace, '{AGENTS.md,.unify/memory/**,.agents/skills/**}']);
  return targets.flatMap(([base, pattern]) => {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), pattern));
    const push = (): void => this.pushKnowledge();
    return [watcher, watcher.onDidCreate(push), watcher.onDidChange(push), watcher.onDidDelete(push)];
  });
}

/** Sends a fresh Knowledge list (debounced), so the screen shows new or removed items without a restart. */
export function pushKnowledge(this: ExtensionHost): void {
  if (this.knowledgeTimer) clearTimeout(this.knowledgeTimer);
  this.knowledgeTimer = setTimeout(() => {
    this.knowledgeTimer = undefined;
    void this.handleUnhandledSidebarMessage({ type: 'knowledgeList' } as unknown as SidebarWebviewMessage)
      .catch(error => this.output.appendLine(`Knowledge refresh failed: ${error instanceof Error ? error.message : String(error)}`));
  }, 250);
}

export async function syncAction(this: ExtensionHost, action: Extract<SidebarWebviewMessage, { type: 'syncAction' }>['action']): Promise<void> {
  if (action === 'connect') await this.connectSync();
  else if (action === 'upload') await this.sync.uploadNow();
  else if (action === 'download') await this.sync.downloadNow();
  else if (action === 'disconnect') await this.sync.disconnect();
  else if (action === 'keepRemote' || action === 'keepLocal') await this.sync.resolve(action === 'keepLocal' ? 'local' : 'remote');
  else if (action === 'openRepo' && this.sync.repoUrl?.startsWith('https://github.com/')) await vscode.env.openExternal(vscode.Uri.parse(this.sync.repoUrl));
}

export async function refreshInstructions(this: ExtensionHost): Promise<void> {
  this.sidebar.postMessage({ type: 'instructionsState', items: await listInstructions(this.instructionRoots()) });
}

/** Keeps the active chat's private copy in step so the agent sees the change without it showing up as an edit to review. */
export async function syncInstructionMirror(this: ExtensionHost, item: InstructionItem, file: string, text?: string): Promise<void> {
  const workspace = this.instructionRoots().workspace;
  if (item.scope === 'workspace' && workspace && this.chat) await this.chat.mirror.restore(relative(workspace, file), text);
}

export async function saveInstructionRequest(this: ExtensionHost, message: Extract<SidebarWebviewMessage, { type: 'saveInstruction' }>): Promise<void> {
  const saved = await saveInstruction(this.instructionRoots(), {
    id: message.id, kind: message.kind, scope: message.scope, file: message.file, name: message.name, description: message.description, content: message.content,
  });
  await this.syncInstructionMirror(saved.item, saved.file, await readFile(saved.file, 'utf8'));
  if (saved.item.scope === 'global') this.sync.schedule();
  await this.refreshInstructions();
  this.sidebar.postMessage({ type: 'instructionSaved' });
}

export async function removeInstructionRequest(this: ExtensionHost, id: string): Promise<void> {
  const removed = await removeInstruction(this.instructionRoots(), id);
  await this.syncInstructionMirror(removed.item, removed.file, undefined);
  if (removed.item.scope === 'global') this.sync.schedule();
  await this.refreshInstructions();
}

export function agentInstructions(this: ExtensionHost, chat: Chat, bridged: boolean): string {
  const scope = chat.mirror.direct
    ? 'You edit the user\'s files directly; they and other agents may change files between turns, so re-read before editing.'
    : 'Edits stay in this working copy until the user reviews them.';
  return [
    chat.record.noFolder
      ? `Unify IDE, no project folder: this chat works in its own empty scratch folder (${chat.mirror.cwd}). Write any files there.`
      : `Unify IDE, workspace ${this.projectRoot(chat.record).name}. ${scope}`,
    'End a turn only when everything the user asked for is done, or you are blocked on a question only they can answer. Answering the latest message, a checkpoint, a compaction or a resumed session is not a stopping point: carry on with any unfinished requests in the same turn.',
    BACKGROUND_CLEANUP,
    shellInstructions(),
    memoryInstructions(chat.mirror.cwd, this.memorySettings().enabled),
    chatStorageInstructions(chat.mirror.cwd, chat.record.id),
    delegationInstructions(bridged, { explorer: this.delegationProfiles().some(profile => profile.name === 'explorer') }),
    bridged && this.feature('batching') ? BATCH_INSTRUCTIONS : '',
    bridged && this.summariesOn() ? SUMMARY_INSTRUCTIONS : '',
    bridged ? MEDIA_INSTRUCTIONS : '',
    bridged && getUnifyFeature('chats.showYourWork') ? SHOW_YOUR_WORK_INSTRUCTIONS : '',
    bridged && this.oauthAccounts.list('codex-cli').length ? IMAGE_INSTRUCTIONS : '',
  ].filter(Boolean).join('\n');
}

/** Connect from the popup or the Sync page: Git first (installing it if needed), then GitHub. */
export async function connectSync(this: ExtensionHost): Promise<void> {
  if (!await this.ensureGit()) return;
  await this.sync.connect();
  if (this.sync.connected) await this.context.globalState.update(SYNC_OFFER_KEY, 'connected');
}

/** Asks once (and again a week after "Not now") whether to sync settings and memory through GitHub. */
export async function offerSync(this: ExtensionHost): Promise<void> {
  const offer = this.context.globalState.get<string | number>(SYNC_OFFER_KEY);
  if (this.sync.connected || offer === 'never' || offer === 'connected' || (typeof offer === 'number' && Date.now() < offer)) return;
  if (!vscode.workspace.isTrusted) return;
  const choice = await vscode.window.showInformationMessage('Sync memories and settings to GitHub for work across multiple computers?', 'Sync with GitHub', 'Not now', 'Don\'t ask again');
  if (choice === 'Sync with GitHub') await this.connectSync();
  else if (choice === 'Don\'t ask again') await this.context.globalState.update(SYNC_OFFER_KEY, 'never');
  else await this.context.globalState.update(SYNC_OFFER_KEY, Date.now() + 7 * 24 * 60 * 60_000);
}

/** Whether memory is on for this PC, and then the global memory folder. */
export function memorySettings(this: ExtensionHost): { enabled: boolean; global?: string } {
  const enabled = vscode.workspace.getConfiguration?.('unify')?.get<boolean>('memory.enabled', true) !== false;
  return { enabled, global: enabled ? globalMemoryFolder(this.instructionRoots().unifyHome) : undefined };
}

/** Brings the global memory folder into the chat's working copy, or (after a turn) saves the agent's notes back to it. */
export async function syncMemory(this: ExtensionHost, chat: Chat, after = false): Promise<void> {
  try {
    const result = await syncGlobalMemory(this.memorySettings().global, chat.mirror.cwd);
    if (result.skipped) this.output.appendLine(`Global memory not synced: ${result.skipped}.`);
    const changed = [...result.saved, ...result.conflicts];
    // Notes agents saved reach GitHub a few seconds later, as one commit.
    if (changed.length) { this.sync.schedule(); this.pushKnowledge(); }
    if (after && changed.length) {
      const conflicts = result.conflicts.length ? `; kept both versions of ${result.conflicts.length} edited elsewhere` : '';
      this.sidebar.postMessage({ type: 'toolEvent', sessionId: chat.record.id, entryId: `tool:${chat.turnEntryId}:memory`, event: {
        id: `memory-${chat.turnEntryId}`, kind: 'other', title: 'Memory saved', detail: `${changed.length} note${changed.length === 1 ? '' : 's'}: ${result.saved.slice(0, 5).join(', ')}${result.saved.length > 5 ? ', …' : ''}${conflicts}`, state: 'complete',
      } });
    }
  } catch (error) {
    this.output.appendLine(`Global memory sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function refreshMemory(this: ExtensionHost): void {
  const { enabled } = this.memorySettings();
  this.placesByChat.clear();
  const folder = globalMemoryFolder(this.instructionRoots().unifyHome);
  if (enabled) void mkdir(folder, { recursive: true }).catch(() => undefined);
  void countFiles(folder).then(notes => this.sidebar.postMessage({ type: 'memoryState', memory: { enabled, folder, notes, synced: this.sync.connected } }));
}

/** Turns memory on, or off after a warning: turning it off deletes the global notes on this PC (GitHub keeps its copy). */
export async function setMemory(this: ExtensionHost, enabled: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration('unify');
  const folder = globalMemoryFolder(this.instructionRoots().unifyHome);
  if (enabled) {
    await mkdir(folder, { recursive: true });
    await config.update('memory.enabled', true, vscode.ConfigurationTarget.Global);
    this.refreshMemory();
    return;
  }
  const notes = await countFiles(folder);
  if (notes) {
    const synced = this.sync.connected;
    const choice = await vscode.window.showWarningMessage(`Turn off memory and delete ${notes === 1 ? 'the 1 global memory file' : `all ${notes} global memory files`} on this PC?`, {
      modal: true,
      detail: synced
        ? 'Your GitHub sync repository keeps its copy, so turning memory back on brings them back. Project memory in .unify/memory is project content and is not touched.'
        : `This cannot be undone: ${folder} is deleted and Sync is not on, so there is no other copy. Project memory in .unify/memory is project content and is not touched.`,
    }, 'Turn off and delete');
    if (choice !== 'Turn off and delete') { this.refreshMemory(); return; }
  }
  await config.update('memory.enabled', false, vscode.ConfigurationTarget.Global);
  await rm(folder, { recursive: true, force: true });
  // Loaded chats drop their copies now; others drop theirs on their next turn.
  for (const chat of this.chats.values()) if (!chat.running) await syncGlobalMemory(undefined, chat.mirror.cwd).catch(() => undefined);
  this.output.appendLine(`Memory turned off; deleted ${folder}.`);
  this.refreshMemory();
}

/** Copies global rules and skills into a Claude account directory, or removes earlier copies when sharing is off. */
export async function shareGlobalInstructions(this: ExtensionHost, account: OAuthCliAccount): Promise<void> {
  try {
    const { unifyHome, agentsHome } = this.instructionRoots();
    await shareInstructions(account.directory, { unifyHome, agentsHome }, this.feature('shareRules'));
  }
  catch (error) { this.output.appendLine(`Could not share global rules with ${runtimeLabel(account.provider)}: ${error instanceof Error ? error.message : String(error)}`); }
}
