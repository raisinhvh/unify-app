/** Sending prompts: turn start, runtime routing, context accounting, batching, usage logging and cancelling. */
import type { Host as ExtensionHost } from '../extension';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import * as vscode from 'vscode';
import { OAuthCliAccount } from '../accounts/oauthCli';
import { DelegateResult } from '../delegate/host';
import { firstMessageTitle } from '../runtime/naming';
import { isUsageLimit } from '../runtime/limits';
import { accountForModel } from '../sync/configSync';
import { promptPrefix } from '../runtime/promptPrefix';
import { isDelegationTool, messageAgentsByNameNote, takeMessageByNameHint } from '../runtime/delegation';
import { editorContextDiff } from '../runtime/editorContext';
import { RuntimeEvent } from '../runtime/acp';
import { CliTurn, OAuthCliRuntime, TurnUsage } from '../runtime/oauthCli';
import { codexBackend } from '../runtime/models';
import { CodexCliRuntime } from '../runtime/codexCli';
import { readToolPath } from '../summaries/store';
import { setPowershellSpeedups } from '../runtime/agentShell';
import { activateRustTools, deactivateRustTools, ensureRustTools } from '../runtime/rustTools';
import { checkpointHandoff } from '../runtime/checkpoint';
import { displayTool, internalToolOf } from '../runtime/toolDisplay';
import { LiveEdits } from '../unify/liveEdits';
import { chatCompactRequest, compactStep, CONTINUE_AFTER_CHECKPOINT, sendCompactRequest, takeFollowUp, TurnChannel } from '../runtime/midTurnCompact';
import { trimSessionImages } from '../runtime/imageTrim';
import { buildHandoff, ChatMessage, handoffSummaryPrompt, KEEP_WITH_TOOL, MAX_TURN_TOOLS, toolLine } from '../runtime/handoff';
import { buildPartsHandoff, parsePartsReply, partsPrompt, partWindows, unsummarizedPart, writeTranscriptParts } from '../runtime/transcriptParts';
import { memorySyncNeeded } from '../runtime/memory';
import { BatchCall, BatchOutcome, callLabel, executeBatch, formatBatchResult, isBatchFileTool, isBatchTool, outsideWorkingCopy, parseBatchCalls, runBatchFileTool, uniqueBatchCalls } from '../runtime/batch';
import { LOAD_TOOLPACK } from '../toolpacks/access';
import { SidebarImage, SidebarToolEvent, normalizeCompactTokens } from '../sidebar/view';
import { getUnifyFeature } from '../unify/settings';
import { agentBus } from '../unify/agentBusImpl';
import { SMART_AUTO } from '../runtime/smartAuto';
import type { SessionRecord, MediaItem, TurnOptions, Chat } from './types';
import { RESUME_NOTES, IMAGE_TYPES, PARENT, DELEGATE_SERVER, CODEX_AUTH_ERROR } from './constants';
import { isRiskyAction, isOAuthProvider, isCliProvider, isCodexCliChat, usesCliChat, runtimeLabel } from './helpers';

export async function sendPrompt(this: ExtensionHost, prompt: string, images?: SidebarImage[], queued?: { path: string; mimeType: string; data: string; name: string }[], queuedChatId?: string, mode: 'interrupt' | 'queue' = 'interrupt', options: TurnOptions = {}): Promise<void> {
  if (!prompt.trim() && !images?.length && !queued?.length) return;
  let created: Promise<void> | undefined;
  if (!queuedChatId && !this.active) {
    created = this.newChat();
    // newChat publishes its local record synchronously, before persistence.
    if (!this.active) await created;
  }
  const recordToLoad = options.chatId ? this.sessions().find(item => item.id === options.chatId) : queuedChatId ? this.sessions().find(item => item.id === queuedChatId) : this.active;
  if (!recordToLoad || this.deletedSessions.has(recordToLoad.id)) return;
  // Reserve startup so rapid sends cannot race model/attachment setup. Release
  // as soon as the turn starts; later sends retain queue/interrupt semantics.
  while (this.promptStarts.has(recordToLoad.id)) await this.promptStarts.get(recordToLoad.id);
  if (this.deletedSessions.has(recordToLoad.id)) return;
  let release!: () => void;
  const starting = new Promise<void>(resolve => { release = resolve; });
  this.promptStarts.set(recordToLoad.id, starting);
  const started = (): void => {
    if (this.promptStarts.get(recordToLoad.id) === starting) this.promptStarts.delete(recordToLoad.id);
    release();
  };
  try {
    await this.startPrompt(recordToLoad, prompt, images, queued, !!queuedChatId, mode, started, created, options);
  } finally { started(); }
}

/**
 * Hands a message to a Claude chat whose reply is done but whose process is kept alive for background tasks, so it is
 * answered now and the tasks keep running. False (and nothing changes) when the chat is not in that state.
 */
export function sayWhileWaiting(this: ExtensionHost, chat: Chat, text: string, entry: { displayText?: string; internal?: boolean } = {}): boolean {
  if (chat.record.provider !== 'claude-cli' || isCodexCliChat(chat.record) || !chat.cli.waitingOnBackground() || !chat.cli.say(text)) return false;
  const history = this.transcripts.get(chat.record.id) || [];
  this.transcripts.set(chat.record.id, history);
  if (chat.turnReply.trim() || chat.turnTools.length) history.push({ role: 'assistant', text: chat.turnReply.trim(), ...(chat.turnTools.length ? { tools: chat.turnTools } : {}) });
  chat.turnReply = '';
  chat.turnTools = [];
  history.push({ role: 'user', text, ...(entry.displayText !== undefined ? { displayText: entry.displayText } : {}), ...(entry.internal ? { internal: true } : {}) });
  chat.breakMessage?.();
  this.postRun(chat.record.id, 'thinking', 'Thinking…');
  return true;
}

export async function startPrompt(this: ExtensionHost, recordToLoad: SessionRecord, prompt: string, images: SidebarImage[] | undefined,
  queued: { path: string; mimeType: string; data: string; name: string }[] | undefined,
  fromQueue: boolean, mode: 'interrupt' | 'queue', started: () => void, created?: Promise<void>, options: TurnOptions = {}): Promise<void> {
  const files = queued || images;
  const nonImageFiles = files?.filter(file => !String(file.mimeType || '').startsWith('image/')) || [];
  const fileLabel = (items: { name: string }[]): string => items.length ? `[Files: ${items.map(file => String(file.name || 'file').slice(0, 200)).join(', ')}]` : '';
  // Keep the full attachment list in model history, but show only non-image filenames in the UI.
  const historyPrompt = [prompt.trim(), fileLabel(files || [])].filter(Boolean).join('\n\n');
  const shown = options.shown ?? [prompt.trim(), fileLabel(nonImageFiles)].filter(Boolean).join('\n\n');
  let attachmentMedia: MediaItem[] = [];
  // A user message resets the cap on turns other agents' messages may start on their own.
  if (!options.internal && !options.job) this.messageWakes.delete(recordToLoad.id);
  const turnEntryId = randomUUID();
  let displayed = false;
  const echo = (): void => {
    this.replayTranscript(recordToLoad.id);
    if (!options.internal && (shown || !!files?.length)) {
      this.sidebar.postMessage({ type: 'userMessage', sessionId: recordToLoad.id, entryId: `user:${turnEntryId}`, text: shown });
    }
    displayed = true;
  };
  const displayMedia = (): void => {
    if (!options.internal && attachmentMedia.length) {
      this.sidebar.postMessage({ type: 'mediaMessage', sessionId: recordToLoad.id, entryId: `user-media:${turnEntryId}`, items: attachmentMedia });
    }
  };
  const canEcho = (): boolean => !this.chats.get(recordToLoad.id)?.running && (!this.chats.get(recordToLoad.id)?.jobActive || !!options.job);
  // Echo the text immediately; attachment persistence can take time, and their resolvable media URLs arrive afterwards.
  // Running-chat submissions remain in the queue until their turn begins.
  if (canEcho()) echo();
  if (created) await created;
  const attachments = queued ?? await this.saveImages(images, recordToLoad.id);
  attachmentMedia = attachments.filter(file => file.mimeType.startsWith('image/')).flatMap(file => {
    const hash = file.path.split(/[\\/]/).pop()?.split('.')[0];
    const record = hash ? this.media.recordOf(hash) : undefined;
    return record ? [this.mediaItem(record, file.name)] : [];
  });
  if (!displayed && canEcho()) echo();
  if (displayed) displayMedia();
  let target: Chat;
  try { target = await this.loadChat(recordToLoad); }
  catch (error) { if (this.deletedSessions.has(recordToLoad.id)) return; throw error; }
  if (this.deletedSessions.has(recordToLoad.id)) return;
  if (target.ping) { target.cli.cancel(); await target.ping; }
  if (target.jobActive && !options.job) {
    // A message sent during a job joins the job's decisions log. Sending (not queueing) ends the current step so it reruns with the message.
    if (!displayed) { echo(); displayMedia(); }
    target.jobNotes.push({ prompt: prompt.trim(), images: attachments });
    if (mode === 'interrupt') { target.jobInterrupted = true; this.cancel(false, target.record.id); }
    return;
  }
  if (target.running) {
    // The reply is done and Claude only waits on background tasks: hand the message to that live process, so it is
    // answered now and the background tasks keep running (queueing would wait on them, interrupting would kill them).
    if (!attachments.length && !options.internal && this.sayWhileWaiting(target, prompt.trim(), { displayText: shown })) {
      if (!displayed) echo();
      return;
    }
    const message = { prompt: prompt.trim(), images: attachments };
    if (mode === 'queue') { target.queue.push(message); this.postQueue(target); return; }
    target.queue.unshift(message);
    this.postQueue(target);
    if (target.jobActive) target.jobCancelled = true;
    this.cancel(false, target.record.id);
    return;
  }
  if (fromQueue && !target) return;
  if (!displayed) { echo(); displayMedia(); }
  const active = this.active;
  const picking = !fromQueue && (active?.id === target.record.id || options.chatId === target.record.id);
  // Smart Auto picks the model for messages the user sent, not for job steps or Unify's own prompts.
  const autoChat = picking ? this.selectedModel === SMART_AUTO : !!target.record.smartAuto;
  const auto = autoChat && !options.job && !options.internal;
  if (active && picking && !autoChat) {
    target.record.smartAuto = undefined;
    const selected = this.availableModel(this.selectedModel);
    const effective = selected && this.effectiveModel(selected);
    const effort = this.choiceFor(selected).effort;
    const account = selected && (isOAuthProvider(selected.provider) ? accountForModel(this.oauthAccounts, selected) : accountForModel(this.accounts, selected));
    // Claude and Codex accounts form one pool per provider, so a chat that failed over to another account stays on it.
    const pooled = !!effective && isOAuthProvider(effective.provider) && this.oauthAccounts.get(active.accountId)?.provider === effective.provider;
    if (effective && (active.provider !== effective.provider || active.backend !== effective.backend || active.effort !== effort ||
      (effective.provider !== 'cursor-acp' && account && active.accountId !== account.id && !pooled))) await this.switchModel(target);
  }
  const chat = target;
  const record = chat.record;
  const imageAttachments = attachments.filter(file => !!IMAGE_TYPES[file.mimeType]);
  const fileContext: string[] = [];
  for (const file of attachments) {
    const contextPath = join(chat.mirror.cwd, '.unify', 'context', file.path.split(/[\\/]/).pop()!);
    await mkdir(dirname(contextPath), { recursive: true });
    await writeFile(contextPath, await readFile(file.path));
    fileContext.push(`${JSON.stringify(file.name)}: ${JSON.stringify(relative(chat.mirror.cwd, contextPath))} (${file.mimeType})`);
  }
  if (this.deletedSessions.has(record.id)) return;
  chat.cancelRequested = false;
  chat.turnEntryId = turnEntryId;
  chat.segment = 0;
  chat.startedTools.clear();
  chat.subagentIds.clear();
  chat.delegationToolIds.clear();
  chat.subagentText.clear();
  chat.turnTools = [];
  let segment = 0;
  let segmentHasText = false;
  const postText = (text: string): void => { if (!text) return; chat.turnReply += text; segmentHasText = true; this.sidebar.postMessage({ type: 'assistantDelta', sessionId: record.id, entryId: `assistant:${turnEntryId}:${segment}`, text }); };
  const breakMessage = (): void => { if (segmentHasText) { segment++; segmentHasText = false; } };
  const loggedTools = new Set<string>();
  const places = this.internalPlaces(chat);
  const liveEdits = chat.liveEdits = new LiveEdits(chat.mirror.cwd);
  const postTool =(id: string, title: string, detail: string | undefined, state: 'running' | 'complete' | 'error', error?: string): void => {
    const batch = isBatchTool(title) || (title === 'MCP tool' && isBatchTool(detail || ''));
    // Batch sub-calls are logged one by one by runBatch.
    if (!batch && !loggedTools.has(id)) { loggedTools.add(id); this.logTool(chat, title, detail); }
    if (batch || isDelegationTool(title) || (title === 'MCP tool' && isDelegationTool(detail || ''))) { if (!chat.delegationToolIds.has(id)) breakMessage(); chat.delegationToolIds.add(id); }
    if (chat.delegationToolIds.has(id)) return;
    if (state === 'running') this.noteRead(chat.mirror.cwd, readToolPath(title, detail));
    const shown = displayTool(title, detail);
    const edit = state === 'running' ? liveEdits.current(id) : liveEdits.finish(id, state === 'error' ? error || 'The edit failed.' : undefined);
    const progress = this.toolProgressFor(`${record.id}:${id}`, shown.kind, shown.full ?? postedTools.get(id)?.full, state, chat.mirror.cwd);
    const event: SidebarToolEvent = {
      id, kind: shown.kind, title: shown.title, detail: shown.detail, full: shown.full, state,
      internal: internalToolOf({ tool: title, input: detail }, places),
      ...(edit ? { edit } : {}),
      ...(progress ? { progress } : {}),
    };
    // A finished call reports no detail; the copy kept for the image repost keeps the one it started with.
    const previous = postedTools.get(id);
    postedTools.set(id, { ...event, detail: event.detail ?? previous?.detail, full: event.full ?? previous?.full, internal: event.internal ?? previous?.internal });
    this.sidebar.postMessage({ type: 'toolEvent', sessionId: record.id, entryId: `tool:${turnEntryId}:${id}`, event });
    if (state === 'running') { segment++; segmentHasText = false; }
  };
  const postedTools = new Map<string, SidebarToolEvent>();
  // Images a tool returned (Read of a screenshot) go on the same row once stored, as on the ACP path.
  const postToolImages = (id: string, _title: string, content: unknown[]): void => {
    if (chat.delegationToolIds.has(id)) return;
    const images = this.incomingImages(content);
    if (!images.length) return;
    void this.storeIncomingImages(record.id, images, 'the main agent').then(items => {
      const event = postedTools.get(id);
      if (!items.length || !event || this.deletedSessions.has(record.id)) return;
      this.sidebar.postMessage({ type: 'toolEvent', sessionId: record.id, entryId: `tool:${turnEntryId}:${id}`, event: { ...event, media: items } });
    });
  };
  // Live edit preview: the edit row appears and its diff grows while the call's input is still streaming.
  const postToolInput = (event: { id: string; name: string; input: Record<string, unknown>; streaming: boolean }): void => {
    const edit = liveEdits.update(event.id, event.name, event.input, event.streaming);
    if (!edit || this.deletedSessions.has(record.id)) return;
    const shown = displayTool(event.name, JSON.stringify(event.input).slice(0, 500));
    this.sidebar.postMessage({ type: 'toolEvent', sessionId: record.id, entryId: `tool:${turnEntryId}:${event.id}`, event: {
      id: event.id, kind: 'edit', title: shown.title, detail: shown.detail, full: shown.full, state: 'running', edit,
    } });
  };
  const postSubagent = (event: { id: string; title?: string; model?: string; prompt?: string; state?: 'running' | 'complete' | 'error'; text?: string; messageId?: string; role?: 'assistant' | 'tool' }): void => {
    // Harnesses report a subagent's tool call as "Title: detail" or "Title detail". A lazy title keeps a
    // Windows drive colon ("C:\src\file.ts") inside the detail instead of splitting the path.
    const split = event.role === 'tool' && event.text
      ? event.text.match(/^(\S+?)(?::\s*|\s+)([\s\S]*)$/) ?? event.text.trim().match(/^(\S+)$/)
      : null;
    const tool = split ? { ...displayTool(split[1], split[2]), internal: internalToolOf({ tool: split[1], input: split[2] }, places) } : undefined;
    this.sidebar.postMessage({ type: 'subagentEvent', sessionId: record.id, agentId: `${turnEntryId}:${event.id}`, ...event, ...(tool ? { tool } : {}), model: event.model === 'default' ? record.modelName : event.model || record.modelName });
  };
  chat.running = true;
  started();
  this.postRun(record.id, 'thinking', 'Thinking…');
  const firstTurn = record.name === 'New chat' && !record.renamed;
  if (firstTurn) record.name = firstMessageTitle(prompt);
  if (firstTurn) agentBus.update(record.id, { task: record.name });
  record.updatedAt = Date.now();
  if (firstTurn && prompt.trim()) void this.autoName(record.id, prompt, chat.mirror.cwd);
  let completed = false;
  try {
    await this.saveSession(record);
    await chat.mirror.beginTurn();
    if (memorySyncNeeded(this.memorySettings().global, chat.mirror.cwd)) await this.syncMemory(chat);
    if (chat.cancelRequested) return;
    if (auto) {
      await this.smartAutoPick(chat, prompt, turnEntryId);
      if (chat.cancelRequested) return;
    }
    if (!usesCliChat(record)) {
      if (!chat.runtime?.isRunning) {
        const configured = this.availableModel(record.modelName);
        if (!configured) throw new Error('The model for this chat is no longer configured.');
        await this.switchModel(chat, { ...configured, provider: record.provider, backend: record.backend }, undefined, record.accountId);
      }
      if (record.provider === 'codex-cli' && !(await this.refreshCodexRuntime(chat))) chat.handoffPending = true;
    }
    if (chat.cancelRequested) return;
    const hint = vscode.workspace.getConfiguration('unify').get<number>('checkpointHint', 80000);
    const lastActivity = Math.max(record.lastTurnAt || 0, record.lastPingAt || 0);
    if (!options.internal && record.resumeNotice) {
      // The notice only covers the turn that started the new session.
      record.resumeNotice = undefined;
      // A checkpoint taken during that turn already moved the session it ended into previousCliSessionId.
      if (!record.checkpoint) record.previousCliSessionId = undefined;
      this.refreshSessions();
    }
    if (!options.internal && record.provider === 'claude-cli') {
      record.pingsSent = 0;
      if (!chat.handoffPending && record.cliSessionId && lastActivity && Date.now() - lastActivity > 60 * 60_000 && (record.contextTokens || 0) >= hint) {
        record.previousCliSessionId = record.cliSessionId;
        record.cliSessionId = undefined;
        record.explorerTokens = 0;
        record.idleHandoff = true;
        chat.handoffPending = true;
        record.resumeNotice = record.checkpoint ? 'checkpoint' : 'idle';
      }
    }
    // Auto compaction: past the threshold, this message starts a fresh session from a summary. Nothing is dropped
    // from the transcript, which the agent can still read and search.
    const compactAt = this.autoCompactAt();
    const conversation = (record.contextTokens || 0) - (record.baseTokens || 0);
    const live = usesCliChat(record) ? !!record.cliSessionId : !!chat.sent;
    if (!options.internal && compactAt && !chat.handoffPending && live && conversation >= compactAt) {
      this.output.appendLine(`Auto compaction: "${record.name}" reached about ${Math.round(conversation / 1000)}k tokens of conversation; continuing in a fresh session from a summary.`);
      await this.freshBackendSession(chat, 'auto compaction');
      record.contextTokens = undefined;
      record.resumeNotice = 'compact';
      chat.handoffPending = true;
      this.postRun(record.id, 'tool', 'Compacting context…');
    }
    const history = this.transcripts.get(record.id) || [];
    this.transcripts.set(record.id, history);
    const bridged = !!this.delegateConfig(chat.ownerId);
    const handoff = chat.handoffPending
      ? record.checkpoint ? checkpointHandoff(history, record.checkpoint, bridged) : record.idleHandoff ? buildHandoff(history, undefined, bridged)
        : await this.handoffText(record, history, bridged, chat.mirror.cwd, record.resumeNotice === 'compact' ? record.modelName : undefined)
      : '';
    if (chat.cancelRequested) return;
    // The summary is written; the label must not read "Compacting context…" for the rest of the turn.
    if (chat.handoffPending) this.postRun(record.id, 'thinking', 'Thinking…');
    if (chat.handoffPending && record.checkpoint) record.resumeNotice = 'checkpoint';
    // The feed marks where the new session starts; the note scrolls away with the conversation.
    if (chat.handoffPending && record.resumeNotice) {
      const notice = RESUME_NOTES[record.resumeNotice];
      this.sidebar.postMessage({ type: 'noteMessage', sessionId: record.id, entryId: `resume:${turnEntryId}`, icon: notice.icon, text: notice.text });
    }
    chat.handoffPending = false;
    record.idleHandoff = undefined;
    this.refreshSessions();
    if (record.checkpoint) {
      record.checkpoint = undefined;
      await this.saveSession(record);
    }
    history.push({ role: 'user', text: historyPrompt + (fileContext.length ? '\nContext files:\n' + fileContext.join('\n') : ''), displayText: shown, ...(attachmentMedia.length ? { media: attachmentMedia } : {}), ...(options.internal ? { internal: true } : {}) });
    chat.turnReply = '';
    const packsOn = this.turnOnPacks(chat, prompt);
    // Claude takes the fixed instructions as system text on every run, so they never enter the conversation. Other
    // runtimes get them once per session. Editor context is only resent when it changed.
    const oauth = usesCliChat(record);
    const instructions = this.agentInstructions(chat, bridged);
    const context = this.editorContext();
    const session = oauth ? record.cliSessionId : this.rid(record);
    const fresh = !session || chat.sent?.session !== session;
    let sendInstructions = !oauth && (fresh || chat.sent?.instructions !== instructions);
    const contextUpdate = editorContextDiff(fresh ? undefined : chat.sent?.context, context);
    // Background subagents that finished since the last turn ("hold" ones, or "resume" ones overtaken by this message).
    const background = this.takeBackgroundResults(chat);
    // Messages other agents sent this chat's agent; taken once, so retries cannot repeat them.
    const agentMessages = this.takeAgentMessages(record.id);
    const tokens = record.contextTokens;
    const nudge = bridged && !fresh && !options.internal && record.provider === 'claude-cli' && tokens !== undefined && tokens >= hint && (record.nudgedAt === undefined || tokens >= record.nudgedAt + 20000)
      ? `Context is about ${Math.round(tokens / 1000)}k tokens. Do the request below in this turn first. Once it is finished, call checkpoint with a summary as your last step. Never checkpoint instead of doing the work: nothing continues it afterwards.` : '';
    if (nudge) record.nudgedAt = tokens;
    const buildPrompt = (opening: string, withContext: boolean, fullContext = false): string => [
      nudge,
      opening.trim(),
      sendInstructions ? instructions : '',
      withContext ? (fullContext ? context : contextUpdate) : '',
      packsOn.length ? `The user turned on toolpacks: ${packsOn.join(', ')}. Use their tools directly if they are in your tool list; otherwise call ${LOAD_TOOLPACK} to see them.` : '',
      fileContext.length ? 'Attached context files (read as needed):\n' + fileContext.join('\n') : '',
      background ? `Results from background subagents you started earlier:\n\n${background}` : '',
      agentMessages ? `Messages from other agents (answer with the send_message tool if a reply is needed):\n\n${agentMessages}` : '',
      `User request:\n${prompt}`,
    ].filter(Boolean).join('\n\n');
    const prefix = record.provider === 'claude-cli' ? promptPrefix(instructions, !!record.cliSessionId, record.sessionInstructions, record.lastInstructions) : undefined;
    if (prefix) {
      if (!record.cliSessionId) {
        record.sessionInstructions = prefix.system;
        record.explorerTokens = 0;
        record.initTools = undefined;
        record.prefixHash = undefined;
      }
      record.lastInstructions = prefix.last;
    }
    const fullPrompt = [prefix?.note, buildPrompt(handoff, !!contextUpdate)].filter(Boolean).join('\n\n');
    // The first context report of a fresh session, less this prompt, is the session's fixed overhead.
    const freshBackend = oauth ? !record.cliSessionId : !!this.freshSessions?.delete(this.rid(record));
    chat.measureBase = freshBackend ? Math.ceil(fullPrompt.length / 4) : undefined;
    // A job step must end on its own, so jobs keep compacting between turns only.
    chat.compactWatch = compactAt && bridged && !chat.jobActive && !isCodexCliChat(record) ? { threshold: compactAt } : undefined;
    if (isCodexCliChat(record)) {
      const account = this.oauthAccounts.get(record.accountId);
      if (!account) throw new Error('The ChatGPT account for this chat is missing. Connect it again.');
      record.cliSessionId = await chat.codexCli.prompt({ account, cwd: chat.mirror.cwd, backend: codexBackend(record.backend),
        system: instructions, prompt: fullPrompt, sessionId: record.cliSessionId, effort: record.effort,
        images: imageAttachments.map(file => ({ path: file.path, mimeType: file.mimeType })),
        readOnly: this.jobReadOnly(chat), fullAccess: this.approvalMode === 'full' && !this.jobReadOnly(chat),
        delegate: this.delegateConfig(chat.ownerId), onText: postText, onMessageBreak: breakMessage, onTool: postTool,
        onToolOutput: ({ id, chunk }) => {
          // Live output that reports a percentage or a counter moves the bar past the time estimate.
          const progress = this.toolProgress.output(`${record.id}:${id}`, chunk);
          const event = postedTools.get(id);
          if (!progress || !event || event.state !== 'running' || this.deletedSessions.has(record.id)) return;
          postedTools.set(id, { ...event, progress });
          this.sidebar.postMessage({ type: 'toolEvent', sessionId: record.id, entryId: `tool:${turnEntryId}:${id}`, event: { ...event, progress } });
        },
        onUsage: usage => { this.logUsage(record.id, 'main', record.modelName, usage); this.noteContext(chat, usage.context ?? usage.total.input + usage.total.cacheRead); } });
      record.lastTurnAt = Date.now();
      await this.saveSession(record);
    } else if (oauth) {
      const account = this.oauthAccounts.get(record.accountId);
      if (!account) throw new Error('The selected OAuth account is missing. Connect it again.');
      await this.shareGlobalInstructions(account);
      if (chat.cancelRequested) return;
      // Dropping old images re-caches the conversation from the first one, so it only happens once the cache has expired anyway.
      const cacheLife = (record.shortCache ? 5 : 60) * 60_000;
      if (record.provider === 'claude-cli' && record.cliSessionId && lastActivity && Date.now() - lastActivity > cacheLife) {
        const removed = await trimSessionImages(account.directory, record.cliSessionId)
          .catch(error => { this.output.appendLine(`Trimming old images failed: ${error instanceof Error ? error.message : String(error)}`); return 0; });
        if (removed) this.output.appendLine(`Removed ${removed} old image${removed === 1 ? '' : 's'} from "${record.name}" while its prompt cache was cold.`);
      }
      record.cliSessionId = await this.promptPooled(chat.cli, { account, cwd: chat.mirror.cwd, backend: record.backend, system: prefix?.system ?? instructions,
        prompt: fullPrompt, sessionId: record.cliSessionId, effort: record.effort, readOnly: this.jobReadOnly(chat), fullAccess: this.approvalMode === 'full' && !this.jobReadOnly(chat),
        speed: record.smartAuto ? undefined : this.choiceFor(this.availableModel(record.modelName)).speed,
        onInit: info => {
          record.initTools = info.tools;
          const hash = createHash('sha256').update(JSON.stringify([prefix?.system ?? instructions, info.tools])).digest('hex').slice(0, 16);
          if (record.prefixHash && record.prefixHash !== hash && record.cliSessionId) {
            this.output.appendLine(`Prompt prefix changed within Claude session ${record.cliSessionId}; the next turn re-reads the conversation uncached.`);
          }
          record.prefixHash = hash;
        },
        onContext: tokens => this.noteContext(chat, tokens),
        onUsage: usage => {
          this.logUsage(record.id, 'main', record.modelName, usage);
          record.contextTokens = usage.context ?? usage.total.input + usage.total.cacheRead + usage.total.cacheWrite;
          record.lastTurnAt = Date.now();
          if (usage.total.cacheWrite1h > 0) record.shortCache = false;
          else if (usage.total.cacheWrite5m > 0) record.shortCache = true;
          this.refreshSessions();
        },
        onBackgroundWait: tasks => {
          if (!tasks.length) this.postRun(record.id, 'thinking', 'Thinking…');
          else {
            this.postRun(record.id, 'tool', tasks.length === 1 ? `Waiting for background task: ${tasks[0]}` : `Waiting for ${tasks.length} background tasks…`);
            // Messages that arrived during the reply and were not read are handed over now, not after the tasks end.
            setImmediate(() => this.wakeForMessages(chat));
          }
        },
        onBackgroundTasks: tasks => this.backgroundProcesses.sync(record.id, 'claude', tasks.map(task => ({
          id: `claude:${task.id}`,
          kind: task.command ? 'shell' : 'task',
          title: task.command ?? task.description,
          ...(task.command && task.description ? { detail: task.description } : {}),
        }))),
        onText: postText,
        onMessageBreak: breakMessage,
        onTool: postTool,
        onToolImages: postToolImages,
        onToolInput: postToolInput,
        onSubagent: postSubagent,
        images: imageAttachments,
        delegate: this.delegateConfig(chat.ownerId),
        onApproval: (description, info) => this.decideApproval(chat, PARENT, description, info),
        onQuestions: input => this.askNativeQuestions(chat, input),
      }, () => chat.cancelRequested, async (next, failed) => {
        // The new account has none of this chat's session, so it gets the conversation so far as a handoff.
        record.accountId = next.id; record.cliSessionId = undefined; record.explorerTokens = 0;
        await this.saveSession(record, false);
        breakMessage();
        postTool(`account:${randomUUID()}`, 'Account switch', `${failed.label} hit its usage limit; continuing on ${next.label}.`, 'complete');
        return { prompt: buildPrompt(await this.handoffText(record, history.slice(0, -1), bridged, chat.mirror.cwd), !!context, true) };
      });
      await this.saveSession(record);
    } else {
      if (!chat.runtime) throw new Error('This chat has no running agent. Use "Unify: Restart Runtime" and try again.');
      try {
        if (record.provider === 'codex-cli') {
          await this.promptCodex(chat, fullPrompt, imageAttachments, async limited => {
            // A new session has none of this chat's conversation, so it gets the conversation so far as a handoff.
            chat.handoffPending = false;
            sendInstructions = true;
            if (limited) {
              breakMessage();
              postTool(`account:${randomUUID()}`, 'Account switch', `${limited.failed.label} hit its usage limit; continuing on ${limited.next.label}.`, 'complete');
            }
            return buildPrompt(await this.handoffText(record, history.slice(0, -1), bridged, chat.mirror.cwd), !!context, true);
          });
        } else {
          await chat.runtime.prompt(this.rid(record), fullPrompt, imageAttachments);
        }
        // Mid-turn compaction stopped the prompt to ask for a checkpoint; the request is this turn's next prompt.
        for (let ask = takeFollowUp(chat.compactWatch); ask && !chat.cancelRequested; ask = takeFollowUp(chat.compactWatch)) await chat.runtime.prompt(this.rid(record), ask);
      }
      finally { const accountId = record.accountId; if (accountId) setTimeout(() => this.refreshUsage(true, accountId), 1500); }
    }
    // A ChatGPT turn that changed accounts or refreshed its runtime may have ended on a new session.
    const sentTo = oauth ? record.cliSessionId : this.rid(record);
    if (sentTo) chat.sent = { session: sentTo, instructions, context };
    completed = !chat.cancelRequested;
  } catch (error) {
    if (!chat.cancelRequested) throw error;
  } finally {
    this.settleChatApprovals(record.id, true);
    for (const task of [...chat.background.values()]) if (!task.done && task.afterTurn === 'cancel') { chat.background.delete(task.id); task.run?.cancel(); }
    // Claude's background tasks end with its process, which ends with the turn.
    this.backgroundProcesses.sync(record.id, 'claude', []);
    if (chat.turnReply.trim() || chat.turnTools.length) this.transcripts.get(record.id)?.push({ role: 'assistant', text: chat.turnReply.trim(), ...(chat.turnTools.length ? { tools: chat.turnTools } : {}) });
    chat.turnTools = [];
    // A checkpoint Unify asked for mid-turn continues the task right away instead of waiting for the user's next message.
    const continueTask = completed && !!chat.pendingCheckpoint && chat.compactWatch?.askedAt !== undefined;
    chat.compactWatch = undefined;
    if (completed) {
      if (record.provider !== 'claude-cli') record.lastTurnAt = Date.now();
      if (chat.pendingCheckpoint) {
        await this.freshBackendSession(chat, 'the checkpoint');
        record.checkpoint = chat.pendingCheckpoint;
        chat.pendingCheckpoint = undefined;
        chat.handoffPending = true;
      }
      await this.saveSession(record);
    }
    const reply = chat.turnReply;
    const cancelled = chat.cancelRequested;
    chat.turnReply = '';
    if (!cancelled && reply) await this.showLinkedImages(chat, reply).catch(error => this.output.appendLine(`Linked images failed: ${String(error)}`));
    await this.saveTranscripts();
    // The agent is done; a slow scan of the working copy should not read as the agent still thinking.
    const scanStarted = Date.now();
    const scanLabel = setTimeout(() => this.postRun(record.id, 'tool', 'Checking changes…'), 500);
    await chat.mirror.endTurn().catch(error => this.output.appendLine(`Mirror scan failed: ${String(error)}`));
    if (memorySyncNeeded(this.memorySettings().global, chat.mirror.cwd)) await this.syncMemory(chat, true);
    clearTimeout(scanLabel);
    if (Date.now() - scanStarted > 5_000) this.output.appendLine(`End-of-turn change scan took ${((Date.now() - scanStarted) / 1000).toFixed(1)} s.`);
    chat.running = false;
    this.postRun(record.id, 'idle', 'Ready');
    options.onFinish?.(reply, cancelled);
    if (!options.internal && !options.job) this.notifyDesktop(record.name, cancelled ? 'Turn cancelled.' : reply.trim() ? reply.trim().slice(0, 300) : 'Turn finished.');
    const next = chat.jobActive ? undefined : chat.queue.shift();
    if (next) this.postQueue(chat);
    // A queued message carries the checkpoint handoff itself; background results join the continued turn.
    if (next && this.chats.get(record.id) === chat) void this.guarded(() => this.sendPrompt(next.prompt, undefined, next.images, record.id));
    else if (!next && continueTask && this.chats.get(record.id) === chat) void this.guarded(() => this.sendPrompt(CONTINUE_AFTER_CHECKPOINT, undefined, [], record.id, 'queue', { internal: true }));
    else if (!next) this.backgroundSettled(chat);
  }
}

/**
 * Runs a ChatGPT (Codex) turn on the chat's Unify runtime. An auth error forces a token refresh, relaunches the runtime
 * and retries once; a usage limit moves the chat to the next ChatGPT account (a new runtime and session) and retries
 * there. `reopen` rebuilds the prompt as a handoff for a new session, after `limited` changed accounts when given.
 */
export async function promptCodex(this: ExtensionHost, chat: Chat, prompt: string, images: { mimeType: string; data: string }[],
  reopen: (limited?: { failed: OAuthCliAccount; next: OAuthCliAccount }) => Promise<string>): Promise<void> {
  const record = chat.record;
  const first = this.oauthAccounts.get(record.accountId);
  if (!first) throw new Error('The ChatGPT account for this chat is missing. Connect it again in Accounts.');
  const pool = this.accountPool(first);
  const tried = new Set<string>();
  let text = prompt;
  let authRetried = false;
  for (;;) {
    const account = this.oauthAccounts.get(record.accountId) || first;
    const runtime = chat.runtime;
    if (!runtime) throw new Error('This chat has no running agent. Use "Unify: Restart Runtime" and try again.');
    try {
      await runtime.prompt(this.rid(record), text, images);
      return;
    } catch (error) {
      if (chat.cancelRequested) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (isUsageLimit(error)) {
        tried.add(account.id);
        this.limitedAt.set(account.id, Date.now());
        setTimeout(() => this.refreshUsage(true, account.id), 1500);
        this.output.appendLine(`ChatGPT account "${account.label}" hit its usage limit: ${message}`);
        const next = pool.find(candidate => !tried.has(candidate.id));
        if (!next) throw new Error(pool.length > 1 ? `All ${pool.length} ChatGPT accounts have hit their usage limits. ${message}` : message);
        await this.switchModel(chat, { name: record.modelName, provider: record.provider, backend: record.backend, enabled: true }, undefined, next.id);
        if (chat.cancelRequested) throw error;
        text = await reopen({ failed: account, next });
        authRetried = false;
        continue;
      }
      if (authRetried || !CODEX_AUTH_ERROR.test(message)) throw error;
      authRetried = true;
      this.output.appendLine(`ChatGPT rejected the access token of "${account.label}"; refreshing it and retrying: ${message}`);
      if (!(await this.refreshCodexRuntime(chat, true))) text = await reopen();
      if (chat.cancelRequested) throw error;
    }
  }
}

/**
 * Runs a Claude turn, moving on to the next Claude account each time one reports a usage limit.
 * `retarget` adjusts the turn for the new account; the session id is always dropped because sessions belong to one account.
 */
export async function promptPooled(this: ExtensionHost, cli: OAuthCliRuntime, turn: CliTurn, cancelled: () => boolean,
  retarget?: (next: OAuthCliAccount, failed: OAuthCliAccount) => Promise<Partial<CliTurn>> | Partial<CliTurn>): Promise<string | undefined> {
  const pool = this.accountPool(turn.account);
  let current = { ...turn, trimTools: turn.trimTools ?? this.feature('trimTools'), account: pool[0] };
  if (current.account.id !== turn.account.id) {
    if (!current.lean) await this.shareGlobalInstructions(current.account);
    current = { ...current, sessionId: undefined, ...(await retarget?.(current.account, turn.account)) };
  }
  for (let index = 0; ; index++) {
    const attempt = current;
    try {
      try { return await cli.prompt({ ...attempt, onRateLimit: info => { this.usage.applyClaudeEvent(attempt.account.id, info); attempt.onRateLimit?.(info); } }); }
      finally { setTimeout(() => this.refreshUsage(true, attempt.account.id), 1500); }
    } catch (error) {
      if (!isUsageLimit(error) || cancelled()) throw error;
      this.limitedAt.set(current.account.id, Date.now());
      const next = pool[index + 1];
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`${runtimeLabel(current.account.provider)} account "${current.account.label}" hit its usage limit: ${message}`);
      if (!next) throw new Error(pool.length > 1 ? `All ${pool.length} ${runtimeLabel(current.account.provider)} accounts have hit their usage limits. ${message}` : message);
      if (!current.lean) await this.shareGlobalInstructions(next);
      if (cancelled()) throw error;
      current = { ...current, account: next, sessionId: undefined, ...(await retarget?.(next, current.account)) };
    }
  }
}

/**
 * Opening context for a new agent session: earlier messages summarized by the chat-naming model, plus the
 * latest exchange word for word. Without a summary model, or if summarizing fails, more messages are kept instead.
 */
/** `fallbackModel` writes the summary when no name model is set (auto compaction always wants one). */
export async function handoffText(this: ExtensionHost, record: SessionRecord, history: ChatMessage[], bridged: boolean, cwd: string, fallbackModel?: string): Promise<string> {
  if (!history.length) return '';
  let summary: string | undefined;
  const older = history.slice(0, -KEEP_WITH_TOOL);
  const named = this.modelSetting('nameModel');
  const choice = named.model ? named : fallbackModel ? { model: fallbackModel } : named;
  if (this.feature('autoCompact') && older.length && choice.model) {
    try {
      // Parts already archived stay as they are; only the messages since the last one are split and summarized.
      const parts = (record.parts || []).filter(part => part.to <= older.length);
      const covered = parts[parts.length - 1]?.to ?? 0;
      const added = await Promise.all(partWindows(history, covered, older.length).map(async window => {
        try { return parsePartsReply(await this.runOneShot({ ...choice, model: choice.model! }, cwd, partsPrompt(window)), window.from, window.to) ?? [unsummarizedPart(window.from, window.to)]; }
        catch (error) {
          this.output.appendLine(`Summarizing transcript parts failed: ${error instanceof Error ? error.message : String(error)}`);
          return [unsummarizedPart(window.from, window.to)];
        }
      }));
      record.parts = [...parts, ...added.flat()];
      await writeTranscriptParts(cwd, record.id, history, record.parts);
      return buildPartsHandoff(record.id, history, record.parts);
    } catch (error) {
      this.output.appendLine(`Saving transcript parts failed; using one summary instead: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (bridged && older.length && choice.model) {
    try { summary = (await this.runOneShot({ ...choice, model: choice.model }, cwd, handoffSummaryPrompt(older))).trim() || undefined; }
    catch (error) { this.output.appendLine(`Summarizing the chat for a new session failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return buildHandoff(history, summary, bridged);
}

/** Fixed instructions for a chat's agent: where it works, delegation, file summaries and batching. Kept short: they are sent with every request. */
/** Applies unify.runtime.powershellSpeedups and unify.runtime.rustTools to agents started from now on. */
export function applyShellSettings(this: ExtensionHost): void {
  const config = vscode.workspace.getConfiguration('unify');
  setPowershellSpeedups(config.get('runtime.powershellSpeedups'));
  if (config.get<boolean>('runtime.rustTools') === false || process.platform !== 'win32') {
    deactivateRustTools();
    return;
  }
  void ensureRustTools(this.context.globalStorageUri.fsPath).then(bin => {
    // The setting may have been turned off while the download ran.
    if (!bin || vscode.workspace.getConfiguration('unify').get<boolean>('runtime.rustTools') === false) return;
    try {
      activateRustTools(bin);
    } catch (error) {
      this.output.appendLine(`rg/fd/sd unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** Tokens of conversation (beyond the session's fixed overhead) at which a chat is compacted, or undefined when off. */
export function autoCompactAt(this: ExtensionHost): number | undefined {
  if (!this.feature('autoCompact')) return undefined;
  return normalizeCompactTokens(vscode.workspace.getConfiguration('unify').get<unknown>('experimental.autoCompactTokens'));
}

/** Records a context size report; the first one from a fresh session sets that session's baseline. */
export function noteContext(this: ExtensionHost, chat: Chat, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const record = chat.record;
  record.contextTokens = tokens;
  if (chat.measureBase !== undefined) {
    record.baseTokens = Math.max(0, tokens - chat.measureBase);
    chat.measureBase = undefined;
  }
  const watch = chat.running && !isCodexCliChat(record) ? chat.compactWatch : undefined;
  const step = watch && compactStep(watch, tokens - (record.baseTokens || 0));
  if (!watch || !step) return;
  const runtime = usesCliChat(record) ? undefined : chat.runtime;
  const turn: TurnChannel = runtime ? { interrupt: () => runtime.interrupt(this.rid(record)) } : chat.cli;
  if (!sendCompactRequest(watch, turn, chatCompactRequest(tokens, step === 'urge'))) {
    // The turn is already ending; the next message compacts between turns as before.
    if (step === 'ask') watch.askedAt = undefined;
    return;
  }
  this.output.appendLine(`Mid-turn compaction: asked "${record.name}" to checkpoint at about ${Math.round(tokens / 1000)}k tokens${step === 'urge' ? ' (again)' : ''}.`);
  this.postRun(record.id, 'tool', 'Compacting context…');
}

/** One line per tool call of the running turn, kept with the turn's reply in the transcript. */
export function logTool(this: ExtensionHost, chat: Chat, title: string, detail?: string): void {
  if (!chat.running || chat.turnTools.length >= MAX_TURN_TOOLS) return;
  chat.turnTools.push(toolLine(title.replace(/^mcp__unify__/, ''), detail));
}

/** Advanced batching: runs the calls in parallel, chained ones in order, and returns one combined result. The sidebar shows one card with a row per call. */
export async function runBatch(this: ExtensionHost, chat: Chat, args: Record<string, unknown>): Promise<DelegateResult> {
  let calls: BatchCall[];
  let skipped: number;
  try { ({ calls, skipped } = uniqueBatchCalls(parseBatchCalls(args))); } catch (error) { return { text: error instanceof Error ? error.message : String(error), isError: true }; }
  const id = `batch-${randomUUID().slice(0, 8)}`;
  const places = this.internalPlaces(chat);
  const children = calls.map(call => {
    const shown = displayTool(call.tool, callLabel(call).slice(call.tool.length).trim() || undefined);
    return { title: shown.title, detail: shown.detail, full: shown.full, kind: shown.kind, state: 'running' as 'running' | 'complete' | 'error', internal: internalToolOf({ tool: call.tool, input: call.args }, places) };
  });
  const post = (): void => {
    const done = children.every(child => child.state !== 'running');
    this.sidebar.postMessage({ type: 'toolEvent', sessionId: chat.record.id, entryId: `tool:${chat.turnEntryId}:${id}`, event: {
      id, kind: 'other', title: 'Batch', detail: `${calls.length} call${calls.length === 1 ? '' : 's'}`, children: children.map(child => ({ ...child })),
      state: done ? children.some(child => child.state === 'error') && children.every(child => child.state === 'error') ? 'error' : 'complete' : 'running',
    } });
  };
  for (const call of calls) this.logTool(chat, call.tool, callLabel(call).slice(call.tool.length).trim() || undefined);
  post();
  const cwd = chat.mirror.cwd;
  // Outside the working copy the user decides per path, unless Unify has full access. Paths written out in the batch are asked about together, up front.
  const outsideAnswers = new Map<string, Promise<boolean>>();
  const askOutside = (paths: string[]): Promise<boolean> => this.askInChat(chat.record.id, 'Read outside the project', `The batch wants to read:\n${paths.join('\n')}`);
  if (!this.broadAccess()) {
    const written = calls.filter(call => isBatchFileTool(call.tool) && !call.forEach && typeof call.args.path === 'string' && !/\{\{/.test(call.args.path)).map(call => call.args.path as string);
    const outside = [...new Set((await Promise.all(written.map(async path => await outsideWorkingCopy(cwd, path) ? resolvePath(cwd, path.trim()) : ''))).filter(Boolean))];
    if (outside.length) {
      const answer = askOutside(outside);
      for (const path of outside) outsideAnswers.set(path, answer);
    }
  }
  // Calls arrive here with their placeholders filled in; forEach calls arrive once per item.
  const runCall = async (call: BatchCall): Promise<BatchOutcome> => {
    if (!isBatchFileTool(call.tool)) return this.handleDelegateCall(chat.ownerId, call.tool, call.args);
    const path = typeof call.args.path === 'string' ? call.args.path : '';
    const outside = !!path && await outsideWorkingCopy(cwd, path);
    if (outside && !this.broadAccess()) {
      const absolute = resolvePath(cwd, path.trim());
      if (!outsideAnswers.has(absolute)) outsideAnswers.set(absolute, askOutside([absolute]));
      if (!await outsideAnswers.get(absolute)) return { text: `${path} is outside the project and the user declined.`, isError: true };
    }
    // Inside the copy, paths that need approval elsewhere (.env, .ssh, credentials) are not read silently here.
    if (!outside && !this.broadAccess() && path && isRiskyAction(path)) return { text: `${path} needs approval; read it with your own tools.`, isError: true };
    if (call.tool === 'read_file' && !outside) this.noteRead(cwd, path);
    return runBatchFileTool(cwd, call.tool, call.args, { outside });
  };
  const outcomes = await executeBatch(calls, runCall, (index, outcome) => {
    children[index].state = outcome.isError ? 'error' : 'complete';
    post();
  });
  // Several subagents started in one batch share one "message them by name" line instead of one each.
  const startedNames = outcomes.map(outcome => takeMessageByNameHint(outcome)).filter((name): name is string => !!name);
  const result = formatBatchResult(calls, outcomes, skipped);
  if (startedNames.length) result.text += `\n\n${messageAgentsByNameNote(startedNames[0])}`;
  return { text: result.text, ...(result.content.length ? { content: [{ type: 'text', text: result.text }, ...result.content] } : {}) };
}

/** The editor's current state, or nothing when editor context is turned off. */
export function editorContext(this: ExtensionHost): string {
  if (!this.feature('editorContext')) return '';
  const folder = this.root();
  const editor = vscode.window.activeTextEditor;
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => {
    const input = tab.input;
    return input instanceof vscode.TabInputText ? relative(folder.uri.fsPath, input.uri.fsPath) : undefined;
  }).filter((item): item is string => !!item && !item.startsWith('..')).slice(0, 20);
  const parts = [
    'IDE context (paths are relative to the working copy):',
    `Open files: ${tabs.join(', ') || '(none)'}`,
  ];
  if (editor && editor.document.uri.scheme === 'file') {
    const path = relative(folder.uri.fsPath, editor.document.uri.fsPath);
    if (!path.startsWith('..')) {
      parts.push(`Active file: ${path}`, `Cursor: line ${editor.selection.active.line + 1}, column ${editor.selection.active.character + 1}`);
      if (!editor.selection.isEmpty) {
        const selection = editor.document.getText(editor.selection);
        const truncated = selection.length > 4000 ? `\n[selection truncated: ${selection.length} chars]` : '';
        parts.push(`Selected text:\n${selection.slice(0, 4000)}${truncated}`);
      }
      const diagnostics = vscode.languages.getDiagnostics(editor.document.uri).slice(0, 10);
      if (diagnostics.length) parts.push(`Diagnostics: ${diagnostics.map(d => `line ${d.range.start.line + 1}: ${d.message}`).join(' | ')}`);
    }
  }
  return parts.join('\n');
}

export function mcpServers(this: ExtensionHost, ownerId?: string, toolpacksOnly = false): unknown[] {
  const value = vscode.workspace.getConfiguration('unify').get<unknown>('mcpServers', []);
  if (!Array.isArray(value)) throw new Error('unify.mcpServers must be an array.');
  const delegate = ownerId ? this.delegateConfig(ownerId, toolpacksOnly) : undefined;
  return delegate ? [...value, { name: DELEGATE_SERVER, command: delegate.command, args: delegate.args, env: Object.entries(delegate.env).map(([name, envValue]) => ({ name, value: envValue })) }] : value;
}

/** Records usage without delaying or failing the agent turn. */
export function logUsage(this: ExtensionHost, chatId: string, kind: 'main' | 'oneshot' | 'subagent' | 'keepalive' | 'explorer', model: string, usage: TurnUsage): void {
  const file = join(this.context.globalStorageUri.fsPath, 'usage-log.jsonl');
  const line = JSON.stringify({ at: new Date().toISOString(), chatId, kind, model, ...usage.total, context: usage.context ?? (usage.total.input + usage.total.cacheRead + usage.total.cacheWrite) }) + '\n';
  void mkdir(dirname(file), { recursive: true }).then(() => appendFile(file, line)).catch(error => {
    this.output.appendLine(`Usage logging failed: ${String(error)}`);
  });
}

/** Runs one prompt on a configured model with tools denied, and returns the reply text. `onCancel` receives a function that stops the run. */
export async function runOneShot(this: ExtensionHost, choice: { model: string; effort?: string; speed?: string }, cwd: string, prompt: string, timeoutMs = 120_000, onCancel?: (cancel: () => void) => void): Promise<string> {
  const entry = this.availableModel(choice.model);
  if (!entry || entry.enabled === false) throw new Error(`Model "${choice.model}" is not available.`);
  const backend = entry.speedOptions?.find(item => item.label === choice.speed)?.backend || entry.backend;
  const route = await this.resolveRoute({ ...entry, backend });
  let reply = '';
  let timer: NodeJS.Timeout | undefined;
  const limit = (cancel: () => void): void => { timer = setTimeout(cancel, timeoutMs); onCancel?.(cancel); };
  try {
    if ('oauthAccount' in route && route.model.provider === 'codex-cli' && (this.chat?.mirror.cwd === cwd ? isCodexCliChat(this.chat.record) : !getUnifyFeature('agents.codexRuntime'))) {
      const cli = new CodexCliRuntime();
      limit(() => cli.cancel());
      await cli.prompt({ account: route.oauthAccount, cwd, backend: codexBackend(backend), effort: choice.effort,
        prompt, readOnly: true, system: 'Reply with only what the request asks for. Do not use tools.', onText: text => { reply += text; }, onTool: () => undefined });
      return reply;
    }
    if ('oauthAccount' in route && isCliProvider(route.model.provider)) {
      const cli = new OAuthCliRuntime();
      let timedOut = false;
      limit(() => { timedOut = true; cli.cancel(); });
      await this.promptPooled(cli, { account: route.oauthAccount, cwd, backend, effort: choice.effort, speed: choice.speed, readOnly: true, prompt,
        lean: true,
        onUsage: usage => {
          const input = usage.total.input + usage.total.cacheRead + usage.total.cacheWrite;
          this.output.appendLine(`One-shot input: ${input} tokens`);
          const chat = [...this.chats.values()].find(item => item.mirror.cwd === cwd);
          this.logUsage(chat?.record.id || '', 'oneshot', choice.model, usage);
        },
        onText: text => { reply += text; }, onTool: () => undefined, onApproval: async () => 'Tools are not available for this request.' },
      () => timedOut, () => { reply = ''; return {}; });
      return reply;
    }
    const slot = await this.ensureRuntime(route, cwd, `oneshot:${randomUUID()}`);
    if (!slot) throw new Error('No runtime is available for this model.');
    try {
      const sessionId = await slot.runtime.newSession(cwd, []);
      const listener = `${slot.key}\n${sessionId}`;
      this.oneShots.set(listener, update => {
        const content = update.content as Record<string, unknown> | undefined;
        if (update.sessionUpdate === 'agent_message_chunk' && content?.type === 'text' && typeof content.text === 'string') reply += content.text;
      });
      limit(() => slot.runtime.cancel(sessionId));
      try {
        if (route.model.provider === 'cursor-acp') {
          await this.refreshCursorModels(slot.runtime, sessionId);
          if (backend !== 'auto' || slot.runtime.models(sessionId).some(option => option.value === 'auto')) await slot.runtime.setModel(sessionId, backend);
        }
        if (choice.effort) await slot.runtime.setConfigOption(sessionId, 'reasoning_effort', choice.effort);
        await slot.runtime.prompt(sessionId, prompt);
      } finally {
        this.oneShots.delete(listener);
        await slot.runtime.closeSession(sessionId).catch(() => undefined);
      }
    } finally { await this.releaseRuntime(slot.key); }
    return reply;
  } finally { if (timer) clearTimeout(timer); }
}

export function cancel(this: ExtensionHost, clearQueue = true, chatId?: string): void {
  const chat = chatId ? this.chats.get(chatId) : this.chat;
  if (!chat) return;
  if (clearQueue && chat.jobActive) { chat.jobCancelled = true; chat.jobNotes = []; }
  if (chat.jobActive || clearQueue) for (const child of [...chat.children]) child.cancel();
  // Cancel stops background subagents too; a message that interrupts the turn leaves them running.
  if (clearQueue) chat.background.clear();
  if (clearQueue && chat.queue.length) { chat.queue = []; this.postQueue(chat); }
  this.settleChatApprovals(chat.record.id, !clearQueue);
  if (chat.running) {
    chat.cancelRequested = true;
    this.postRun(chat.record.id, 'cancelling', 'Cancelling…');
    chat.stopDecider?.();
    for (const child of [...chat.children]) if (!child.background) child.cancel();
    if (isCodexCliChat(chat.record)) chat.codexCli.cancel();
    else if (isCliProvider(chat.record.provider)) chat.cli.cancel();
    else chat.runtime?.cancel(this.rid(chat.record));
  }
}

export function onRuntimeUpdate(this: ExtensionHost, event: RuntimeEvent, key: string): void {
  const chat = this.chatForRuntime(event.sessionId, key);
  if (!chat) {
    const oneShot = this.oneShots.get(`${key}\n${event.sessionId}`);
    if (oneShot) oneShot(event.update);
    else [...this.childRuns].find(run => run.runtimeKey === key && run.sessionId === event.sessionId)?.onUpdate?.(event.update);
    return;
  }
  const chatId = chat.record.id;
  if (chat.cancelRequested) return;
  const update = event.update;
  const places = this.internalPlaces(chat);
  const kind = String(update.sessionUpdate || '');
  if (kind === 'cursor_task') {
    const id = String(update.toolCallId || update.agentId || Date.now());
    chat.subagentIds.add(id);
    this.sidebar.postMessage({ type: 'subagentEvent', sessionId: chatId, agentId: `${chat.turnEntryId}:${id}`,
      title: typeof update.description === 'string' ? update.description : 'Subagent',
      prompt: typeof update.prompt === 'string' ? update.prompt : undefined,
      model: typeof update.model === 'string' ? update.model : chat.record.modelName,
      state: typeof update.durationMs === 'number' ? 'complete' : 'running' });
    return;
  }
  if (kind === 'usage_update') { if (typeof update.used === 'number') this.noteContext(chat, update.used); return; }
  if (kind === 'config_option_update' && chat.record.provider === 'cursor-acp' && chat.runtime) void this.refreshCursorModels(chat.runtime, event.sessionId);
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    const content = update.content as Record<string, unknown> | undefined;
    if (content?.type === 'text' && typeof content.text === 'string' && kind === 'agent_message_chunk') {
      chat.turnReply += content.text;
      this.sidebar.postMessage({ type: 'assistantDelta', sessionId: chatId, entryId: `assistant:${chat.turnEntryId}:${chat.segment}`, text: content.text });
    }
  } else if (kind.startsWith('tool_call')) {
    const id = String(update.toolCallId || Date.now());
    const title = String(update.title || 'Tool');
    const batch = isBatchTool(title);
    if (kind === 'tool_call' && !batch) {
      const path = (Array.isArray(update.locations) ? update.locations as Record<string, unknown>[] : []).find(item => typeof item.path === 'string')?.path;
      this.logTool(chat, title, typeof path === 'string' ? path : update.rawInput && typeof update.rawInput === 'object' ? JSON.stringify(update.rawInput) : undefined);
    }
    if (batch || isDelegationTool(title)) { if (!chat.delegationToolIds.has(id)) chat.segment++; chat.delegationToolIds.add(id); }
    // Delegation has its own card, posted by runSubagent rather than this MCP call.
    if (chat.delegationToolIds.has(id)) return;
    const alreadyKnown = chat.subagentIds.has(id);
    if (/^(subagent(?: activity)?|task)$/i.test(title)) chat.subagentIds.add(id);
    if (chat.subagentIds.has(id)) {
      const contents = Array.isArray(update.content) ? update.content as Record<string, unknown>[] : [];
      const currentText = contents.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text as string).join('\n');
      const previousText = chat.subagentText.get(id) || '';
      const text = currentText.startsWith(previousText) ? currentText.slice(previousText.length) : currentText === previousText ? '' : currentText;
      if (currentText) chat.subagentText.set(id, currentText);
      this.sidebar.postMessage({ type: 'subagentEvent', sessionId: chatId, agentId: `${chat.turnEntryId}:${id}`,
        title: alreadyKnown ? undefined : title,
        model: chat.record.modelName,
        state: update.status === 'failed' ? 'error' : kind === 'tool_call' || update.status === 'in_progress' ? 'running' : 'complete',
        ...(text ? { text, messageId: `update:${id}` } : {}) });
      return;
    }
    const rawKind = String(update.kind || 'other').toLowerCase();
    const toolKind = /search|grep|glob|web/.test(rawKind + ' ' + title) ? 'search'
      : /edit|write|patch/.test(rawKind + ' ' + title) ? 'edit'
      : /shell|command|bash|powershell/.test(rawKind + ' ' + title) ? 'shell'
      : /read|file/.test(rawKind + ' ' + title) ? 'read' : 'other';
    const locations = Array.isArray(update.locations) ? update.locations as Record<string, unknown>[] : [];
    const location = locations.find(item => typeof item.path === 'string')?.path;
    const detail = typeof location === 'string' ? location : typeof update.status === 'string' ? update.status : undefined;
    if (rawKind === 'read') this.noteRead(chat.mirror.cwd, location);
    if (!chat.startedTools.has(id)) { chat.startedTools.add(id); chat.segment++; }
    const rawInput = update.rawInput && typeof update.rawInput === 'object' ? JSON.stringify(update.rawInput) : undefined;
    const shown = displayTool(title, rawInput || detail);
    const state = update.status === 'failed' ? 'error' : kind === 'tool_call' || update.status === 'in_progress' ? 'running' : 'complete';
    const entryId = `tool:${chat.turnEntryId}:${id}`;
    // Live edit preview: ACP sends an edit's whole input with the call, so the diff shows at once rather than streaming.
    const liveEdits = chat.liveEdits ??= new LiveEdits(chat.mirror.cwd);
    const editInput = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput as Record<string, unknown> : undefined;
    const editName = editInput ? LiveEdits.acpToolName(title, rawKind, editInput) : undefined;
    if (editInput && editName && state === 'running') liveEdits.update(id, editName, editInput, false);
    const contents = Array.isArray(update.content) ? update.content as Record<string, unknown>[] : [];
    const failure = contents.map(item => (item.content as Record<string, unknown> | undefined)?.text ?? item.text).filter(text => typeof text === 'string').join('\n').trim().slice(0, 300);
    const edit = state === 'running' ? liveEdits.current(id) : liveEdits.finish(id, state === 'error' ? failure || 'The edit failed.' : undefined);
    const shownKind = (shown.kind === 'other' ? toolKind : shown.kind) as SidebarToolEvent['kind'];
    const progress = this.toolProgressFor(`${chatId}:${id}`, shownKind, shown.full, state as SidebarToolEvent['state'], chat.mirror.cwd);
    const shownEvent = {
      id, kind: shownKind, title: shown.title, detail: shown.detail, full: shown.full, state: state as SidebarToolEvent['state'],
      internal: internalToolOf({ tool: title, input: update.rawInput ?? detail }, places),
      ...(edit ? { edit } : {}),
      ...(progress ? { progress } : {}),
    };
    this.sidebar.postMessage({ type: 'toolEvent', sessionId: chatId, entryId, event: shownEvent });
    // Images a tool returned (batch read_file, screenshots) go on the same row once stored.
    const images = this.incomingImages(update.content);
    if (images.length) void this.storeIncomingImages(chatId, images, 'the main agent').then(items => {
      if (items.length && !this.deletedSessions.has(chatId)) {
        this.sidebar.postMessage({ type: 'toolEvent', sessionId: chatId, entryId, event: { ...shownEvent, media: items } });
      }
    });
    if (chat.running) this.postRun(chatId, 'tool', 'Using tools…');
  }
}
