/** Chat session storage and folder layout: roots, scratch folders, saving, deleting and pruning chats. */
import type { Host as ExtensionHost } from '../extension';
import { realpathSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { WorkspaceMirror } from '../runtime/shadow';
import type { InternalToolPlaces } from '../unify/internalRows';
import { partsDir } from '../runtime/transcriptParts';
import { removeChatStorage } from '../runtime/chatStorage';
import { unifyHome } from '../unify/settings';
import type { SessionRecord, Chat } from './types';
import { SESSIONS_KEY, MAX_CHATS_PER_PROJECT, ACTIVE_SESSION_KEY } from './constants';

/** Where this chat's agent may touch app data: its shadow working copy, the real project, and every open folder. */
export function internalPlaces(this: ExtensionHost, chat: Chat): InternalToolPlaces {
  const cached = this.placesByChat.get(chat.record.id);
  if (cached) return cached;
  const roots = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value) return;
    try { roots.add(realpathSync(value)); } catch { roots.add(value); }
  };
  add(chat.mirror.cwd);
  add(chat.record.project?.path);
  if (!chat.record.noFolder) for (const folder of vscode.workspace.workspaceFolders || []) if (folder.uri.scheme === 'file') add(folder.uri.fsPath);
  const vault = this.memorySettings().global;
  let dataHome = unifyHome();
  try { dataHome = realpathSync(dataHome); } catch { /* the data folder may not exist yet */ }
  let globalVault = vault;
  if (vault) { try { globalVault = realpathSync(vault); } catch { /* keep the configured path */ } }
  const places: InternalToolPlaces = { dataHome, projectRoots: [...roots], ...(globalVault ? { globalVault } : {}) };
  this.placesByChat.set(chat.record.id, places);
  return places;
}

export function root(this: ExtensionHost): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') throw new Error('Open a local workspace folder to use Unify.');
  if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace to run Unify tools.');
  return folder;
}

/** The empty folder a no-folder chat works in, kept in extension storage. */
export function scratchPath(this: ExtensionHost, id: string): string { return join(this.context.globalStorageUri.fsPath, 'scratch', id); }

/**
 * The project folder a chat works on. Once its working copy exists that is the folder it was made from
 * (`rootPath`; older chats: the workspace). Before that, the folder it was started in (Home's project picker,
 * "New chat in"), falling back to the workspace when there is none or it is gone.
 */
export function projectRoot(this: ExtensionHost, record: SessionRecord): { uri: vscode.Uri; name: string } {
  if (!record.pendingMirror) {
    if (!record.rootPath) return this.root();
    const name = record.project?.path === record.rootPath && record.project.name ? record.project.name : basename(record.rootPath);
    return { uri: vscode.Uri.file(record.rootPath), name };
  }
  const path = record.project?.path;
  if (path) {
    let isFolder = false;
    try { isFolder = statSync(path).isDirectory(); } catch { isFolder = false; }
    if (isFolder) return { uri: vscode.Uri.file(path), name: record.project?.name || basename(path) };
  }
  return this.root();
}

/** The folder a chat's agent works on: its project folder, or a no-folder chat's scratch folder (created on demand). */
export async function chatRoot(this: ExtensionHost, record: SessionRecord): Promise<vscode.Uri> {
  if (!record.noFolder) return this.projectRoot(record).uri;
  const path = this.scratchPath(record.id);
  await mkdir(path, { recursive: true });
  return vscode.Uri.file(path);
}

export function sessions(this: ExtensionHost): SessionRecord[] { return this.context.workspaceState.get<SessionRecord[]>(SESSIONS_KEY, []); }

export async function saveSession(this: ExtensionHost, record: SessionRecord, setActive = true): Promise<void> {
  if (this.deletedSessions.has(record.id)) return;
  await this.context.workspaceState.update(SESSIONS_KEY, [record, ...this.sessions().filter(item => item.id !== record.id)].slice(0, 100));
  if (setActive && this.active?.id === record.id) await this.context.workspaceState.update(ACTIVE_SESSION_KEY, record.id);
  this.refreshSessions();
}

export async function deleteSession(this: ExtensionHost, id: string): Promise<void> {
  const record = this.sessions().find(item => item.id === id);
  if (!record) return;
  if (this.chats.get(id)?.jobActive) this.cancel(true, id);
  else if (this.chats.get(id)?.background.size && !this.chats.get(id)?.running) this.cancel(true, id);
  else if (this.chats.get(id)?.running) throw new Error('Cancel this chat before deleting it.');
  const wasActive = this.active?.id === id || (!this.active && this.context.workspaceState.get<string>(ACTIVE_SESSION_KEY) === id);
  this.deletedSessions.add(id);
  this.backgroundProcesses.clear(id);
  const liveCwd = this.chats.get(id)?.mirror.cwd;
  const unloaded = this.unloadChat(id);
  const remaining = this.sessions().filter(item => item.id !== id);
  const saved = this.context.workspaceState.update(SESSIONS_KEY, remaining);
  const selected = wasActive ? this.context.workspaceState.update(ACTIVE_SESSION_KEY, remaining[0]?.id) : Promise.resolve();
  if (wasActive) this.active = undefined;
  this.transcripts.delete(id);
  this.sidebar.postMessage({ type: 'sessionDeleted', sessionId: id });
  this.refreshSessions();
  if (wasActive && remaining.length) await this.continueChat(remaining[0].id);
  else if (wasActive) { this.syncActiveView(); }
  await Promise.all([saved, selected, unloaded]);
  await this.saveTranscripts();
  // An in-flight creation must finish disposing its watcher before its files
  // are removed; otherwise copying and recursive deletion can race.
  await this.chatLoads.get(id)?.catch(() => undefined);
  // Deduplicated media is released by ref, so files shared with other chats stay; the shown set
  // and any images still owed to this chat's parent go with it.
  await this.media?.release(id).catch(error => this.output.appendLine(`Releasing chat media failed: ${String(error)}`));
  this.shownMedia?.forget(id);
  this.pendingParentMedia?.delete(id);
  await rm(join(this.context.globalStorageUri.fsPath, 'media', id), { recursive: true, force: true }).catch(() => undefined);
  // Chat storage (.unify/chats/<id>): direct chats write it into the real project, so remove it there and in the live mirror.
  if (!record.noFolder) await removeChatStorage(this.projectRoot(record).uri.fsPath, id).catch(error => this.output.appendLine(`Could not remove chat storage: ${String(error)}`));
  if (liveCwd) await removeChatStorage(liveCwd, id).catch(error => this.output.appendLine(`Could not remove chat storage: ${String(error)}`));
  // A no-folder chat's files are all in its scratch folder.
  if (record.noFolder) { await rm(this.scratchPath(id), { recursive: true, force: true }).catch(() => undefined); return; }
  const folder = vscode.workspace.workspaceFolders?.[0];
  // Direct chats save transcript parts in the real workspace; a mirror's go with the mirror.
  if (folder?.uri.scheme === 'file' && record.parts) await rm(join(folder.uri.fsPath, ...partsDir(id).split('/')), { recursive: true, force: true }).catch(() => undefined);
  if (folder?.uri.scheme === 'file') await WorkspaceMirror.remove(folder.uri, this.context.globalStorageUri.fsPath, record.mirrorId).catch(error => this.output.appendLine(`Could not remove chat files: ${String(error)}`));
}

export function refreshSessions(this: ExtensionHost): void {
  this.sidebar.postMessage({
    type: 'sessionState',
    sessions: this.sessions().map(item => ({ id: item.id, name: item.name, icon: item.icon, project: item.noFolder ? undefined : item.project || this.currentProject(), updatedAt: item.updatedAt, contextTokens: item.contextTokens, explorerTokens: item.explorerTokens })),
    activeSessionId: this.active?.id || this.context.workspaceState.get<string>(ACTIVE_SESSION_KEY),
  });
}

/**
 * Keeps at most MAX_CHATS_PER_PROJECT chats per project folder: a new chat deletes that folder's oldest
 * chats beyond the limit. Chats still working (turn, job, background agents) or open in the workspace
 * (a pane or pop-out window) are never pruned.
 */
export async function pruneProjectChats(this: ExtensionHost, created: SessionRecord): Promise<void> {
  const projectPath = (record: SessionRecord): string | undefined => record.noFolder ? undefined : (record.project || this.currentProject())?.path;
  const path = projectPath(created);
  const busy = (id: string): boolean => {
    const chat = this.chats.get(id);
    return !!chat && (chat.running || chat.jobActive || chat.background.size > 0);
  };
  const inProject = this.sessions()
    .filter(item => projectPath(item) === path)
    .sort((first, second) => (second.updatedAt || 0) - (first.updatedAt || 0));
  const excess = inProject.slice(MAX_CHATS_PER_PROJECT)
    .filter(item => item.id !== created.id && !busy(item.id) && !this.openChatIds.has(item.id));
  for (const item of excess) {
    try { await this.deleteSession(item.id); }
    catch (error) { this.output.appendLine(`Pruning old chat ${item.id} failed: ${String(error)}`); }
  }
}

/** Deletes every chat that is not running. */
export async function deleteAllSessions(this: ExtensionHost): Promise<void> {
  await this.deleteSessions(this.sessions().map(item => item.id));
}

/** Deletes the given chats that are not running. The open chat goes last so earlier deletions never switch to a chat about to be removed. */
export async function deleteSessions(this: ExtensionHost, sessionIds: string[]): Promise<void> {
  const activeId = this.active?.id || this.context.workspaceState.get<string>(ACTIVE_SESSION_KEY);
  const ids = sessionIds.filter(id => !this.chats.get(id)?.running)
    .sort((a, b) => Number(a === activeId) - Number(b === activeId));
  for (const id of ids) await this.deleteSession(id);
}
