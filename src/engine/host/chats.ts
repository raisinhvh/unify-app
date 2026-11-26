/** Chat lifecycle: creating, loading, continuing, renaming and replaying chats, transcripts, reviews and diffs. */
import type { Host as ExtensionHost } from '../extension';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import * as vscode from 'vscode';
import { ModelEntry } from '../accounts';
import { OAuthCliProvider } from '../accounts/oauthCli';
import { ReviewController, ReviewProposal } from '../review/controller';
import { bindChatAgentOwner } from '../delegate/messaging';
import { chatTitlePrompt, parseChatName, uniqueChatIcon } from '../runtime/naming';
import { accountForModel } from '../sync/configSync';
import { AcpRuntime } from '../runtime/acp';
import { OAuthCliRuntime } from '../runtime/oauthCli';
import { CodexCliRuntime } from '../runtime/codexCli';
import { MirrorChange, WorkspaceMirror } from '../runtime/shadow';
import { partsDir } from '../runtime/transcriptParts';
import { SidebarNameModel, SidebarProject } from '../sidebar/view';
import { getUnifyFeature } from '../unify/settings';
import { agentBus } from '../unify/agentBusImpl';
import { SMART_AUTO } from '../runtime/smartAuto';
import type { SessionRecord, ResolvedRoute, TranscriptItem, Chat } from './types';
import { ACTIVE_SESSION_KEY, TRANSCRIPTS_KEY, TIMELINES_KEY } from './constants';
import { isOAuthProvider, isCodexCliChat, lowestEffort } from './helpers';

/** The chat a UI message concerns: the named one, else the active chat. */
export function chatForMessage(this: ExtensionHost, chatId?: string): Chat | undefined {
  return chatId ? this.chats.get(chatId) : this.chat;
}

/** The first workspace folder, as the project chats are grouped under. */
export function currentProject(this: ExtensionHost): SidebarProject | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') return undefined;
  return { name: folder.name || basename(folder.uri.fsPath), path: folder.uri.fsPath };
}

/** Reopens the chat that was open when VS Code closed, as selecting its tab would, so its history is shown on startup. */
export function resumeLastChat(this: ExtensionHost): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file' || !vscode.workspace.isTrusted) return;
  const id = this.context.workspaceState.get<string>(ACTIVE_SESSION_KEY);
  if (id && this.sessions().some(item => item.id === id)) void this.guarded(() => this.continueChat(id));
}

export function syncActiveView(this: ExtensionHost): void {
  const chat = this.chat;
  this.sidebar.postMessage({ type: 'toolState', tools: [] });
  this.sidebar.postMessage({ type: 'diffState', diffs: chat ? this.diffItems(chat.review.list()) : [] });
}

export function postRun(this: ExtensionHost, chatId: string, state: 'idle' | 'thinking' | 'tool' | 'cancelling', label: string): void {
  this.sidebar.postMessage({ type: 'runState', sessionId: chatId, state, label });
  // Keep the agent roster's state in step with the chat's turn.
  if (this.chats.has(chatId)) agentBus.update(chatId, { state: state === 'idle' ? 'idle' : 'running' });
  // A turn may have written rules or notes the watchers missed (e.g. a folder created mid-turn).
  if (state === 'idle') this.pushKnowledge();
}

export function rid(this: ExtensionHost, record: SessionRecord): string { return record.runtimeId || record.id; }

export async function newChat(this: ExtensionHost, project?: SidebarProject, noFolder = false): Promise<void> {
  if (!noFolder) this.root();
  // A Smart Auto chat starts on its smartest model; the decider replaces it when the first message is sent.
  const auto = this.selectedModel === SMART_AUTO;
  const first = auto ? this.smartAutoCandidates()[0] : undefined;
  const selected = auto ? first?.entry : this.selectedEntry();
  if (!selected) throw new Error(auto ? 'Smart Auto has no available ranked models. Set them in Customize.' : 'Turn on a model in Accounts first.');
  const model = auto ? selected : this.effectiveModel(selected);
  const account = isOAuthProvider(model.provider) ? accountForModel(this.oauthAccounts, model) : accountForModel(this.accounts, model);
  if (model.provider !== 'cursor-acp' && !account) throw this.missingAccountError(model);
  // Creating a chat is a local navigation operation. Copy files and start the
  // provider only when the chat is used, rather than blocking the New button.
  const record: SessionRecord = {
    id: randomUUID(), mirrorId: randomUUID(), pendingMirror: true, name: 'New chat',
    project: noFolder ? undefined : project || this.currentProject(),
    // Fixed per chat: the provider session is tied to its working directory.
    // A no-folder chat's scratch folder has nothing to protect, so it is edited directly.
    direct: noFolder || !vscode.workspace.getConfiguration('unify').get<boolean>('runtime.mirror', true) ? true : undefined,
    ...(noFolder ? { noFolder: true } : {}),
    modelName: model.name, provider: model.provider, backend: model.backend,
    codexRuntime: getUnifyFeature('agents.codexRuntime'),
    effort: auto ? first?.effort : this.choiceFor(selected).effort, accountId: account?.id || 'cursor-login', updatedAt: Date.now(),
    ...(auto ? { smartAuto: true } : {}),
  };
  this.active = record;
  this.postJob(record);
  const saved = this.saveSession(record);
  this.refreshSessions(); this.syncActiveView();
  this.postRun(record.id, 'idle', 'Ready');
  this.trimChats();
  await saved;
  await this.pruneProjectChats(record);
}

export function addChat(this: ExtensionHost, record: SessionRecord, mirror: WorkspaceMirror, review: ReviewController, ownerId: string, slot?: { runtime: AcpRuntime; key: string }): Chat {
  const chat: Chat = {
    record, mirror, review, cli: new OAuthCliRuntime(), codexCli: new CodexCliRuntime(), running: false, cancelRequested: false, jobActive: false, jobCancelled: false, jobNotes: [], jobInterrupted: false, queue: [], turnEntryId: '',
    segment: 0, startedTools: new Set(), subagentIds: new Set(), delegationToolIds: new Set(), subagentText: new Map(), turnReply: '', turnTools: [], handoffPending: !!record.checkpoint,
    ownerId, runtime: slot?.runtime, runtimeKey: slot?.key, locks: new Map(), children: new Set(), background: new Map(),
  };
  this.chats.set(record.id, chat);
  // The chat keeps its agent name across restarts while it is free; it is saved with the record on the next save.
  record.agentName = agentBus.register({ id: record.id, name: record.agentName, role: 'main', task: record.name, chatId: record.id, state: 'idle' });
  bindChatAgentOwner(ownerId, record.id);
  return chat;
}

/** Direct-mode chats treat files the user saves during a turn as the user's edits. */
export function adoptSave(this: ExtensionHost, document: vscode.TextDocument): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (document.uri.scheme !== 'file' || !folder) return;
  const path = relative(folder.uri.fsPath, document.uri.fsPath);
  if (!path || path.startsWith('..') || isAbsolute(path)) return;
  for (const chat of this.chats.values()) void chat.mirror.adopt(path, document.getText()).catch(() => undefined);
}

export function createReview(this: ExtensionHost, root: vscode.Uri, mirror: WorkspaceMirror, chatId: string): ReviewController {
  const review = new ReviewController(root, (path, text) => mirror.acknowledge(path, text), 'unify-review', (path, text) => mirror.restore(path, text), mirror.direct);
  this.disposables.push(review.onProposalsChanged(items => this.onProposalsChanged(chatId, items)));
  return review;
}

export async function continueChat(this: ExtensionHost, id?: string): Promise<void> {
  this.root();
  const record = this.sessions().find(item => item.id === (id || this.context.workspaceState.get<string>(ACTIVE_SESSION_KEY))) || this.sessions()[0];
  if (!record) { await this.newChat(); return; }
  if (this.active?.id === record.id) { this.restoreJob(this.active); this.postJob(this.active); return; }
  this.active = this.chats.get(record.id)?.record || record;
  this.restoreJob(this.active);
  const warm = this.chat;
  if (warm) { this.chats.delete(record.id); this.chats.set(record.id, warm); }
  await this.afterActivate(this.active, !this.chat?.running);
  this.trimChats();
  // Restore pending review edits after painting the saved conversation. Warm
  // chats keep their mirror and backend, so repeated switches are immediate.
  if (!record.pendingMirror && !this.chats.has(record.id)) {
    try { await this.loadChat(record); }
    catch (error) { if (this.deletedSessions.has(record.id)) return; throw error; }
    if (this.active?.id === record.id) { this.syncActiveView(); }
  }
}

export function loadChat(this: ExtensionHost, record: SessionRecord): Promise<Chat> {
  if (this.deletedSessions.has(record.id)) return Promise.reject(new Error('This chat was deleted.'));
  const existing = this.chats.get(record.id);
  if (existing) return Promise.resolve(existing);
  const pending = this.chatLoads.get(record.id);
  if (pending) return pending;
  const load = this.prepareChat(record).finally(() => this.chatLoads.delete(record.id));
  this.chatLoads.set(record.id, load);
  return load;
}

export async function prepareChat(this: ExtensionHost, record: SessionRecord): Promise<Chat> {
  this.restoreJob(record);
  const root = { uri: await this.chatRoot(record) };
  let route: ResolvedRoute;
  if (record.provider === 'cursor-acp') {
    route = { model: { name: record.modelName, provider: record.provider, backend: record.backend, enabled: true } };
  } else if (isOAuthProvider(record.provider)) {
    const provider = record.provider as OAuthCliProvider;
    const oauthAccount = await this.chatAccount(record, () => this.oauthAccounts.get(record.accountId), () => this.oauthAccounts.getDefault(provider));
    route = { model: { name: record.modelName, provider: record.provider, backend: record.backend, enabled: true }, oauthAccount };
  } else {
    const account = await this.chatAccount(record, () => this.accounts.get(record.accountId), () => this.accounts.getDefault(record.provider));
    const secret = account && await this.accounts.getSecret(account.id);
    if (!account || !secret) throw new Error(`No account for ${record.modelName} (${record.provider}). Sign in to a provider in Providers.`);
    const model: ModelEntry = { name: record.modelName, provider: record.provider, backend: record.backend, enabled: true };
    route = { model, account, secret };
  }
  if (this.deletedSessions.has(record.id)) throw new Error('This chat was deleted.');
  const holder: { review?: ReviewController; changes?: MirrorChange[] } = {};
  const onChanges = (changes: MirrorChange[]): void => {
    if (!holder.review) { holder.changes = changes; return; }
    holder.review.update(changes);
  };
  const fresh = !!record.pendingMirror;
  const mirror = fresh
    ? await WorkspaceMirror.create(root.uri, this.context.globalStorageUri.fsPath, onChanges, record.mirrorId, !!record.direct)
    : await WorkspaceMirror.reopen(root.uri, this.context.globalStorageUri.fsPath, record.mirrorId, onChanges, !!record.direct);
  holder.review = this.createReview(root.uri, mirror, record.id);
  if (holder.changes) holder.review.update(holder.changes);
  const ownerId = randomUUID();
  let slot: { runtime: AcpRuntime; key: string } | undefined;
  let needsHandoff = false;
  try {
    if (this.deletedSessions.has(record.id)) throw new Error('This chat was deleted.');
    slot = await this.ensureRuntime(route, mirror.cwd, ownerId, { kind: 'main' }, isCodexCliChat(record));
    let runtimeId = fresh && slot ? await slot.runtime.newSession(mirror.cwd, this.mcpServers(ownerId)) : this.rid(record);
    if (slot && !fresh) {
      try {
        await slot.runtime.resumeSession(runtimeId, mirror.cwd, this.mcpServers(ownerId));
      } catch (error) {
        // A ChatGPT (Codex) chat from the old Codex CLI route has no Unify session yet; it continues in a new one from a handoff.
        if (record.provider !== 'codex-cli') throw error;
        runtimeId = await slot.runtime.newSession(mirror.cwd, this.mcpServers(ownerId));
        record.runtimeId = runtimeId;
        record.cliSessionId = undefined;
        record.explorerTokens = 0;
        this.freshSessions?.add(runtimeId);
        needsHandoff = true;
      }
    }
    if (fresh) record.runtimeId = slot ? runtimeId : undefined;
    if (fresh && slot) this.freshSessions?.add(runtimeId);
    if (slot && record.provider === 'cursor-acp') {
      await this.refreshCursorModels(slot.runtime, runtimeId);
      if (record.backend !== 'auto' || slot.runtime.models(runtimeId).some(option => option.value === 'auto')) {
        await slot.runtime.setModel(runtimeId, record.backend);
      }
    }
    if (slot && record.effort) await slot.runtime.setConfigOption(runtimeId, 'reasoning_effort', record.effort);
  } catch (error) {
    holder.review.dispose(); mirror.dispose();
    if (slot) await this.releaseRuntime(slot.key);
    if (fresh) await WorkspaceMirror.remove(root.uri, this.context.globalStorageUri.fsPath, mirror.id).catch(() => undefined);
    throw error;
  }
  if (this.deletedSessions.has(record.id)) {
    holder.review.dispose(); mirror.dispose();
    if (slot) { await slot.runtime.closeSession(this.rid(record)).catch(() => undefined); await this.releaseRuntime(slot.key); }
    await WorkspaceMirror.remove(root.uri, this.context.globalStorageUri.fsPath, mirror.id);
    throw new Error('This chat was deleted.');
  }
  if (fresh) {
    record.mirrorId = mirror.id;
    record.pendingMirror = undefined;
    if (!record.noFolder) record.rootPath = root.uri.fsPath;
  }
  const chat = this.addChat(record, mirror, holder.review, ownerId, slot);
  if (needsHandoff) chat.handoffPending = true;
  await this.saveSession(record, false);
  this.trimChats();
  return chat;
}

/**
 * `/clearcontext` (`/mib`): the chat's agent starts over in a new backend session with no handoff, summary or
 * transcript. The feed is cleared down to a note marking the fresh session. The system prompt and
 * tools are the same as before, so the next turn reuses their cached prefix.
 */
export async function clearContext(this: ExtensionHost, chatId?: string): Promise<void> {
  const chat = this.chatForMessage(chatId);
  if (!chat) return;
  if (chat.running || chat.jobActive) throw new Error('Stop this chat or wait for it to finish before clearing its context.');
  const record = chat.record;
  await this.freshBackendSession(chat, 'clearing context');
  // Nothing from the old session may be carried over: not its summary, checkpoint or resume id.
  record.previousCliSessionId = undefined;
  record.checkpoint = undefined;
  record.idleHandoff = undefined;
  record.resumeNotice = undefined;
  record.contextTokens = undefined;
  // Archived parts belong to the cleared conversation; the fresh one writes its own if it compacts.
  if (record.parts) await rm(join(chat.mirror.cwd, ...partsDir(record.id).split('/')), { recursive: true, force: true }).catch(() => undefined);
  record.parts = undefined;
  chat.pendingCheckpoint = undefined;
  chat.handoffPending = false;
  chat.sent = undefined;
  this.transcripts.set(record.id, []);
  // The feed is wiped too: only the note marking the fresh session remains.
  this.sidebar.postMessage({
    type: 'timelineState',
    sessionId: record.id,
    timeline: [{ id: `clear:${Date.now()}`, kind: 'note', icon: 'restart_alt', text: 'Neuralyzed, fresh session' }],
    subagents: {},
    reset: true,
  });
  await this.saveSession(record);
  await this.saveTranscripts();
  this.refreshSessions();
}

export async function saveTranscripts(this: ExtensionHost): Promise<void> {
  const keep = new Set(this.sessions().map(item => item.id));
  const data: Record<string, TranscriptItem[]> = {};
  for (const [id, items] of this.transcripts) if (keep.has(id)) data[id] = items;
  await this.context.workspaceState.update(TRANSCRIPTS_KEY, data);
  for (const id of Object.keys(this.timelines)) if (!keep.has(id)) delete this.timelines[id];
  await this.context.workspaceState.update(TIMELINES_KEY, this.timelines);
}

export function replayTranscript(this: ExtensionHost, id: string): void {
  if (this.sidebar.hasTimeline(id)) return;
  const saved = this.timelines[id];
  // Earlier versions could save an empty timeline over a chat's history on reload; its transcript still has the messages.
  if (saved?.timeline.length || (saved && !this.transcripts.get(id)?.length)) {
    for (const entry of saved.timeline) {
      if (entry.kind === 'tool' && entry.event.state === 'running') entry.event.state = 'cancelled';
      if (entry.kind === 'approval' && entry.status === 'pending') entry.status = 'rejected';
      if (entry.kind === 'media' && entry.status === 'pending') entry.status = 'failed';
    }
    for (const agent of Object.values(saved.subagents)) if (agent.state === 'running') agent.state = 'cancelled';
    this.sidebar.postMessage({ type: 'timelineState', sessionId: id, ...saved });
    return;
  }
  (this.transcripts.get(id) || []).forEach((item, index) => {
    if (item.internal) return;
    if (item.role === 'user') {
      if ((item.displayText ?? item.text) || item.media?.length) this.sidebar.postMessage({ type: 'userMessage', sessionId: id, entryId: `history:${index}`, text: item.displayText ?? item.text });
      if (item.media?.length) this.sidebar.postMessage({ type: 'mediaMessage', sessionId: id, entryId: `history-media:${index}`, items: item.media });
    } else this.sidebar.postMessage({ type: 'assistantDelta', sessionId: id, entryId: `history:${index}`, text: item.text });
  });
}

export async function editMessage(this: ExtensionHost, sessionId: string, entryId: string, text: string): Promise<void> {
  const chat = this.chats.get(sessionId);
  if (!chat || this.active?.id !== sessionId || chat.running) throw new Error('Wait for this chat to finish before editing a message.');
  if (!text.trim()) throw new Error('A message cannot be empty.');
  const timeline = this.sidebar.timeline(sessionId);
  const index = timeline.findIndex(entry => entry.id === entryId && entry.kind === 'message' && entry.role === 'user');
  if (index < 0) throw new Error('This message is no longer available.');
  // ACP has no rewind method. A new backend session prevents discarded turns,
  // including their tool results and compacted summaries, from leaking back in.
  if (chat.runtime) {
    const oldId = this.rid(chat.record);
    const newId = await chat.runtime.newSession(chat.mirror.cwd, this.mcpServers(chat.ownerId));
    chat.record.runtimeId = newId;
    this.freshSessions?.add(newId);
    await chat.runtime.closeSession(oldId).catch(() => undefined);
    if (chat.record.provider === 'cursor-acp') {
      await this.refreshCursorModels(chat.runtime, newId);
      if (chat.record.backend !== 'auto' || chat.runtime.models(newId).some(option => option.value === 'auto')) await chat.runtime.setModel(newId, chat.record.backend);
    }
    if (chat.record.effort) await chat.runtime.setConfigOption(newId, 'reasoning_effort', chat.record.effort);
  }
  chat.record.cliSessionId = undefined;
  chat.record.explorerTokens = 0;
  chat.handoffPending = true;
  const retained = timeline.slice(0, index);
  const userIndex = timeline.slice(0, index).filter(entry => entry.kind === 'message' && entry.role === 'user').length;
  const history = this.transcripts.get(sessionId) || [];
  let users = 0;
  const cut = history.findIndex(item => item.role === 'user' && !item.internal && users++ === userIndex);
  this.transcripts.set(sessionId, cut >= 0 ? history.slice(0, cut) : retained.flatMap(entry => entry.kind === 'message' ? [{ role: entry.role, text: entry.text }] : []));
  // Parts that reach past the edited message no longer match the transcript.
  const kept = this.transcripts.get(sessionId)!.length;
  if (chat.record.parts) chat.record.parts = chat.record.parts.filter(part => part.to <= kept);
  const agents = this.sidebar.subagents(sessionId);
  const retainedAgents = Object.fromEntries(retained.flatMap(entry => entry.kind === 'subagent' && agents[entry.agentId] ? [[entry.agentId, agents[entry.agentId]]] : []));
  this.sidebar.postMessage({ type: 'timelineState', sessionId, timeline: retained, subagents: retainedAgents });
  await this.saveSession(chat.record);
  await this.saveTranscripts();
  await this.sendPrompt(text);
}

/** Replaces a chat's first-message title with one from the configured name model. Failures keep the provisional title. */
export async function autoName(this: ExtensionHost, sessionId: string, prompt: string, cwd: string): Promise<void> {
  let choice: SidebarNameModel = {};
  try {
    if (!this.feature('autoName')) return;
    choice = this.modelSetting('nameModel');
    if (!choice.model) {
      // No name model configured: name with the chat's own model at its cheapest effort.
      const record = this.chats.get(sessionId)?.record ?? this.sessions().find(item => item.id === sessionId);
      const model = record ? this.availableModel(record.modelName) : undefined;
      if (!model || model.enabled === false) return;
      const effort = lowestEffort(model.effortOptions);
      choice = { model: model.name, ...(effort ? { effort } : {}) };
    }
    // No two chats share a rail icon.
    const taken = (): string[] => this.sessions().flatMap(item => item.id !== sessionId && item.icon ? [item.icon] : []);
    const named = parseChatName(await this.runOneShot({ ...choice, model: choice.model }, cwd, chatTitlePrompt(prompt, taken())));
    const record = this.chats.get(sessionId)?.record ?? this.sessions().find(item => item.id === sessionId);
    if (!named || !record || this.deletedSessions.has(sessionId)) return;
    // A user rename keeps its name, but the chat still gets an icon.
    if (!record.renamed) record.name = named.title;
    // Checked again after the reply, since chats named at the same time may have picked the same icon.
    const icon = named.icon && uniqueChatIcon(named.icon, taken(), sessionId);
    if (icon) record.icon = icon;
    await this.saveSession(record, false);
    agentBus.update(sessionId, { task: record.name });
  } catch (error) {
    this.output.appendLine(`Naming a chat with "${choice.model}" failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function reviewNext(this: ExtensionHost): Promise<void> {
  const item = this.review?.pending()[0];
  if (item) await this.review?.open(item.id);
  else void vscode.window.showInformationMessage('Unify has no pending edits.');
}

export async function openWorkingCopyTerminal(this: ExtensionHost): Promise<void> {
  if (!this.active) await this.newChat();
  if (!this.active) return;
  const chat = await this.loadChat(this.active);
  const terminal = vscode.window.createTerminal({ name: 'Unify Working Copy', cwd: chat.mirror.cwd });
  terminal.show();
}

export function onProposalsChanged(this: ExtensionHost, chatId: string, items: ReviewProposal[]): void {
  const diffs = this.diffItems(items);
  // Every chat pane shows its own edits; the global list (Files tree badges) follows the active chat.
  this.sidebar.postMessage({ type: 'chatDiffState', sessionId: chatId, diffs });
  if (this.active?.id === chatId) this.sidebar.postMessage({ type: 'diffState', diffs });
}

/** Re-sends one loaded chat's edits (a pane or window that just opened asks for its chat). */
export function postChatDiffs(this: ExtensionHost, chatId: string): void {
  const chat = this.chats.get(chatId);
  if (chat) this.sidebar.postMessage({ type: 'chatDiffState', sessionId: chatId, diffs: this.diffItems(chat.review.list()) });
}

export function diffItems(this: ExtensionHost, items: ReviewProposal[]): { id: string; path: string; summary: string; additions: number; deletions: number; state: ReviewProposal['state'] }[] {
  const lineCount = (value?: string): number => value ? value.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(value) ? 1 : 0) : 0;
  return items.map(item => ({
      id: item.id, path: item.path,
      summary: item.fromPath ? `Rename from ${item.fromPath}` : item.base === undefined ? 'Create' : item.proposed === undefined ? 'Delete' : `${item.hunks.length} hunk${item.hunks.length === 1 ? '' : 's'}`,
      additions: item.base === undefined ? lineCount(item.proposed) : item.proposed === undefined ? 0 : item.hunks.reduce((sum, hunk) => sum + hunk.currentLines.length, 0),
      deletions: item.proposed === undefined ? lineCount(item.base) : item.base === undefined ? 0 : item.hunks.reduce((sum, hunk) => sum + hunk.baseLines.length, 0),
      state: item.state,
    }));
}
