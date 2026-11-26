/** Subagents: profiles, delegation calls, running them and collecting their results. */
import type { Host as ExtensionHost } from '../extension';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, writeFile, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import * as vscode from 'vscode';
import { ModelEntry } from '../accounts';
import { DelegateAgentInfo, DelegateResult } from '../delegate/host';
import { registerSubagentAgent, setSubagentState, takeUserMessages, unregisterSubagentAgent } from '../delegate/messaging';
import { SEND_MEDIA } from '../runtime/media';
import { GENERATE_IMAGE } from '../runtime/imageGen';
import { withExplorer, explorerPromptNote, formatExplorerRanges, parseExplorerRanges } from '../runtime/explorer';
import { AfterTurn, CANCEL_SUBAGENT, delegationInstructions, messageByNameHint, TOOLPACK_SCOPE, WAIT_SUBAGENTS } from '../runtime/delegation';
import { OAuthCliRuntime } from '../runtime/oauthCli';
import { codexBackend } from '../runtime/models';
import { CodexCliRuntime } from '../runtime/codexCli';
import { readToolPath, SUMMARY_INSTRUCTIONS, SUMMARY_TOOL } from '../summaries/store';
import { BACKGROUND_CLEANUP, shellInstructions } from '../runtime/agentShell';
import { parseCheckpoint } from '../runtime/checkpoint';
import { displayTool, internalToolOf } from '../runtime/toolDisplay';
import { LiveEdits } from '../unify/liveEdits';
import { applyRangeEdit } from '../runtime/rangeEdit';
import { compactStep, CompactWatch, MAX_SUBAGENT_SEGMENTS, PAUSED_NOTE, sendCompactRequest, subagentCheckpoint, subagentCompactRequest, subagentResumeTask, takeFollowUp, TurnChannel } from '../runtime/midTurnCompact';
import { CHAT_HISTORY_TOOL, chatHistoryReply } from '../runtime/handoff';
import { memoryInstructions } from '../runtime/memory';
import { diffSnapshots, snapshotFiles } from '../runtime/changeSnapshot';
import { chatStorageInstructions } from '../runtime/chatStorage';
import { isBatchTool } from '../runtime/batch';
import { SidebarWebviewMessage } from '../sidebar/provider';
import { SidebarExplorerRange, SidebarMedia, SidebarSubagentTool } from '../sidebar/view';
import { getUnifyFeature } from '../unify/settings';
import { agentBus } from '../unify/agentBusImpl';
import type { SubagentProfile, ChildRun, BackgroundTask, Chat } from './types';
import { pathCovers, isCliProvider, isCodexCliChat } from './helpers';

export function subagentProfiles(this: ExtensionHost): SubagentProfile[] {
  const value = vscode.workspace.getConfiguration('unify').get<unknown>('subagents', []);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SubagentProfile => !!item && typeof item === 'object' && typeof item.name === 'string' && !!item.name.trim()
    && typeof item.model === 'string' && item.enabled !== false)
    .map(item => ({ ...item, name: item.name.trim(), mode: item.mode === 'edit' ? 'edit' as const : 'read-only' as const, tools: item.tools !== false }));
}

/** Profiles available to delegation, including the optional built-in explorer. */
export function delegationProfiles(this: ExtensionHost): SubagentProfile[] {
  return withExplorer(this.subagentProfiles(), this.modelSetting('explorerModel')).sort((a, b) => a.name.localeCompare(b.name));
}

export function refreshSubagents(this: ExtensionHost): void {
  this.sidebar.postMessage({ type: 'subagentProfilesState', profiles: this.subagentProfiles().map(({ name, description, model, effort, speed, mode, tools }) => ({ name, description, model, effort, speed, mode, tools })) });
}

export async function writeSubagents(this: ExtensionHost, profiles: SubagentProfile[]): Promise<void> {
  await vscode.workspace.getConfiguration('unify').update('subagents', profiles, vscode.ConfigurationTarget.Global);
  this.refreshSubagents();
}

export async function saveSubagent(this: ExtensionHost, message: Extract<SidebarWebviewMessage, { type: 'saveSubagent' }>): Promise<void> {
  const profile = message.profile;
  const name = String(profile.name || '').trim();
  const model = this.availableModel(String(profile.model || ''));
  if (!name || !model) throw new Error('Subagent needs a name and an available model.');
  if (profile.effort && !model.effortOptions?.includes(profile.effort)) throw new Error(`Effort "${profile.effort}" is not offered by ${model.name}.`);
  if (profile.speed && !model.speedOptions?.some(item => item.label === profile.speed)) throw new Error(`Speed "${profile.speed}" is not offered by ${model.name}.`);
  const next: SubagentProfile = { name, description: profile.description?.trim() || undefined, model: model.name, effort: profile.effort || undefined, speed: profile.speed || undefined, mode: profile.mode === 'edit' ? 'edit' : 'read-only', tools: profile.tools !== false };
  const others = this.subagentProfiles().filter(item => item.name !== name && item.name !== message.originalName);
  await this.writeSubagents([...others, next]);
  this.sidebar.postMessage({ type: 'subagentSaved' });
}

export function subagentInfos(this: ExtensionHost): DelegateAgentInfo[] {
  return this.delegationProfiles().map(profile => ({ name: profile.name, description: profile.description, mode: profile.mode, model: profile.model }));
}

/** Subagents get a toolpack-only bridge so they can use external apps without delegating further. */
export function delegateConfig(this: ExtensionHost, ownerId: string, toolpacksOnly = false): { command: string; args: string[]; env: Record<string, string> } | undefined {
  const url = this.delegateHost.url;
  if (!url || !vscode.workspace.isTrusted) return undefined;
  if (toolpacksOnly && !this.bridgeTools().length) return undefined;
  const nodePath = vscode.workspace.getConfiguration('unify').get<string>('runtime.nodePath') || undefined;
  return {
    command: nodePath || process.execPath,
    args: [join(this.context.extensionPath, 'dist', 'delegate-server.js')],
    env: { UNIFY_DELEGATE_URL: url, UNIFY_DELEGATE_TOKEN: this.delegateHost.token, UNIFY_DELEGATE_OWNER: ownerId, ...(toolpacksOnly ? { UNIFY_DELEGATE_SCOPE: TOOLPACK_SCOPE } : {}), ...(nodePath ? {} : { ELECTRON_RUN_AS_NODE: '1' }) },
  };
}

export async function handleDelegateCall(this: ExtensionHost, owner: string, tool: string, args: Record<string, unknown>): Promise<DelegateResult> {
  const child = [...this.childRuns].find(item => item.owner === owner);
  if (child) {
    if (child.parent.cancelRequested && !child.background) return { text: 'Cancelled.', isError: true };
    if (tool === SUMMARY_TOOL.name) return this.readSummaries(child.parent, args);
    if (tool === SEND_MEDIA) return this.sendMedia(child.parent, args, child);
    if (tool === GENERATE_IMAGE) return this.generateImage(child.parent, args, child);
    if (tool === 'edit_range') return this.editRange(child.parent, owner, args);
    return this.packCall(child.parent, tool, args) ?? { text: `Subagents may only use toolpack, file summary, media and image tools, not "${tool}".`, isError: true };
  }
  const chat = [...this.chats.values()].find(item => item.ownerId === owner);
  if (!chat) return { text: 'This chat is no longer active.', isError: true };
  const result = await this.dispatchChatTool(chat, tool, args);
  // Images a background subagent sent ride the parent's next tool result, like inbox mail.
  return this.withPendingParentMedia(chat, result);
}

export async function dispatchChatTool(this: ExtensionHost, chat: Chat, tool: string, args: Record<string, unknown>): Promise<DelegateResult> {
  if (chat.cancelRequested || chat.ping) return { text: 'Tools are unavailable during this turn.', isError: true };
  if (isBatchTool(tool)) return this.feature('batching') ? this.runBatch(chat, args) : { text: 'Batching is turned off.', isError: true };
  if (tool === 'list_subagents') {
    const infos = this.subagentInfos();
    return { text: infos.length ? infos.map(info => `- ${info.name} (${info.mode}, model ${info.model})${info.description ? `: ${info.description}` : ''}`).join('\n') : 'No subagents are configured. Add them to the unify.subagents setting.' };
  }
  if (tool === 'list_locked_files') {
    const locks = [...chat.locks];
    return { text: locks.length ? locks.map(([path, lock]) => `${path} (locked by subagent "${lock.label}")`).join('\n') : 'No files are locked.' };
  }
  if (tool === 'checkpoint') {
    try {
      chat.pendingCheckpoint = parseCheckpoint(args);
      if (chat.compactWatch?.askedAt !== undefined) return { text: 'Checkpoint saved. End your turn now with one short line; Unify continues the task in a fresh session automatically.' };
      return { text: 'Checkpoint saved; it takes effect after this turn. Nothing continues automatically: finish the user\'s request in this turn before you end it.' };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  }
  if (tool === CHAT_HISTORY_TOOL) {
    // The running turn's own message is already in the agent's prompt.
    const history = this.transcripts.get(chat.record.id) || [];
    return { text: chatHistoryReply(chat.running ? history.slice(0, -1) : history, Number(args.count) || 10, typeof args.query === 'string' ? args.query : undefined) };
  }
  if (tool === 'delegate_task') return this.runSubagent(chat, args);
  if (tool === WAIT_SUBAGENTS) return this.waitSubagents(chat, args);
  if (tool === CANCEL_SUBAGENT) return this.cancelSubagent(chat, args);
  if (tool === 'edit_range') return this.editRange(chat, chat.ownerId, args);
  if (tool === 'ask_questions') return this.askQuestions(chat, args);
  if (tool === SUMMARY_TOOL.name) return this.readSummaries(chat, args);
  if (tool === SEND_MEDIA) return this.sendMedia(chat, args);
  if (tool === GENERATE_IMAGE) return this.generateImage(chat, args);
  return this.packCall(chat, tool, args, true) ?? { text: `Unknown tool "${tool}".`, isError: true };
}

/**
 * edit_range runs in this engine rather than in the MCP child, so it obeys the same review, read-only,
 * lock and realpath containment rules as a native edit tool. Subagents are confined to their files.
 */
export async function editRange(this: ExtensionHost, chat: Chat, owner: string, args: Record<string, unknown>): Promise<DelegateResult> {
  const fail = (text: string): DelegateResult => ({ text, isError: true });
  if (!getUnifyFeature('tools.rangeEdits')) return fail('Range edits are turned off in Settings (tools.rangeEdits).');
  const run = [...this.childRuns].find(item => item.owner === owner);
  if (run?.readOnly || this.jobReadOnly(chat)) return fail('This agent is read-only and may not edit files.');
  if (chat.cancelRequested) return fail('Cancelled.');
  const pathArg = typeof args.path === 'string' ? args.path.trim() : '';
  if (!pathArg) return fail('path is required.');
  if (isAbsolute(pathArg)) return fail(`${pathArg} must be relative to the working copy.`);
  if (args.replacement !== undefined && typeof args.replacement !== 'string') return fail('replacement must be text.');
  const target = resolvePath(chat.mirror.cwd, pathArg);
  const rawRel = relative(chat.mirror.cwd, target);
  if (!rawRel || rawRel === '..' || rawRel.startsWith(`..${sep}`) || isAbsolute(rawRel)) return fail(`${pathArg} is outside the working copy.`);
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(chat.mirror.cwd);
    const info = await lstat(target);
    if (info.isSymbolicLink()) return fail(`${pathArg} is a symlink; edit the file it points at instead.`);
    realTarget = await realpath(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return fail(code === 'ENOENT' ? `${pathArg} does not exist.` : `Could not read ${pathArg}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A symlinked parent folder can still point outside the working copy.
  const contained = relative(realRoot, realTarget);
  if (!contained || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained)) return fail(`${pathArg} is outside the working copy.`);
  const rel = contained.split(sep).join('/');
  if (run && !run.files.some(file => pathCovers(file, rel))) {
    return fail(`"${rel}" is outside this subagent's files${run.files.length ? `: ${run.files.join(', ')}` : ''}.`);
  }
  const conflict = this.lockConflict(chat, rel, owner);
  if (conflict) return fail(`"${rel}" is locked by subagent "${conflict.label}" until it finishes.`);
  this.recordAgentKnowledgeVersion(chat, rel, run ? run.label : chat.record.name);
  let text: string;
  try {
    text = await readFile(realTarget, 'utf8');
  } catch (error) {
    return fail(`Could not read ${pathArg}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = applyRangeEdit(text, {
    startLine: Number(args.startLine),
    endLine: Number(args.endLine),
    ...(typeof args.expected === 'string' ? { expected: args.expected } : {}),
    replacement: typeof args.replacement === 'string' ? args.replacement : '',
  });
  if (!result.ok) return fail(result.error);
  try {
    await writeFile(realTarget, result.text, 'utf8');
  } catch (error) {
    return fail(`Could not write ${pathArg}: ${error instanceof Error ? error.message : String(error)}`);
  }
  run?.changed.add(rel);
  // The mirror scan feeds the review pane, exactly as an edit made by the agent's own tool does.
  await chat.mirror.scan();
  return { text: `Edited ${rel} lines ${result.startLine}-${result.endLine}.` };
}

export async function runSubagent(this: ExtensionHost, chat: Chat, args: Record<string, unknown>): Promise<DelegateResult> {
  const fail = (text: string): DelegateResult => ({ text, isError: true });
  const name = typeof args.agent === 'string' ? args.agent.trim() : '';
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  const profile = this.delegationProfiles().find(item => item.name === name);
  if (!profile) return fail(`Unknown subagent "${name}". Available: ${this.subagentInfos().map(info => info.name).join(', ') || '(none)'}.`);
  if (!task) return fail('"task" is required.');
  const files = (Array.isArray(args.files) ? args.files : []).filter((item): item is string => typeof item === 'string');
  if (args.background !== true) return this.runSubagentCore(chat, profile, task, files);
  const afterTurn: AfterTurn = args.after_turn === 'hold' || args.after_turn === 'cancel' ? args.after_turn : 'resume';
  const id = `bg-${randomUUID().slice(0, 8)}`;
  const entry: BackgroundTask = { id, label: profile.name, afterTurn, done: false, finished: Promise.resolve() };
  chat.background.set(id, entry);
  const sessionId = chat.record.id;
  this.backgroundProcesses.add(sessionId, {
    id,
    kind: 'subagent',
    title: `${profile.name}: ${task.length > 80 ? `${task.slice(0, 80)}…` : task}`,
    stop: async () => { await this.cancelSubagent(chat, { id }); },
  });
  // runSubagentCore registers the agent (and calls onBackground) before its first await, so the name is known here.
  let agentName: string | undefined;
  entry.finished = this.runSubagentCore(chat, profile, task, files, run => { entry.run = run; agentName = run.name; })
    .catch((error): DelegateResult => ({ text: `Subagent "${profile.name}" failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }))
    .then(result => {
      entry.done = true; entry.result = result; entry.run = undefined;
      this.backgroundProcesses.end(sessionId, id, result.isError ? 'error' : 'done');
      this.backgroundSettled(chat);
    });
  if (agentName) entry.label = `${agentName}, ${profile.name}`;
  const started = agentName
    ? `Started subagent ${agentName} (${profile.name}) in the background as task ${id}.`
    : `Started subagent "${profile.name}" in the background as task ${id}.`;
  return { text: `${started} Keep working; call ${WAIT_SUBAGENTS} to yield until it finishes and get its report.`
    + ` If your turn ends first: ${afterTurn === 'resume' ? 'its result is sent to you in a new turn' : afterTurn === 'hold' ? 'its result is attached to the user\'s next message' : 'it is cancelled'}.`
    + (agentName ? messageByNameHint(agentName) : '') };
}

/** Background tasks finished and not yet collected, removed from the chat and formatted as one report. */
export function takeBackgroundResults(this: ExtensionHost, chat: Chat, ids?: string[]): string {
  const done = [...chat.background.values()].filter(task => task.done && (!ids || ids.includes(task.id)));
  for (const task of done) chat.background.delete(task.id);
  return done.map(task => `### ${task.id} (${task.label})${task.result?.isError ? ' FAILED' : ''}\n${task.result?.text || '(no report)'}`).join('\n\n');
}

export async function waitSubagents(this: ExtensionHost, chat: Chat, args: Record<string, unknown>): Promise<DelegateResult> {
  const asked = Array.isArray(args.ids) ? args.ids.filter((item): item is string => typeof item === 'string') : undefined;
  const unknown = asked?.filter(id => !chat.background.has(id)) || [];
  const tasks = [...chat.background.values()].filter(task => !asked || asked.includes(task.id));
  if (!tasks.length) return { text: unknown.length ? `No background subagent with id ${unknown.join(', ')} is waiting to be collected.` : 'No background subagents are running or waiting to be collected.', isError: !!unknown.length };
  const seconds = Number.isFinite(Number(args.timeout_seconds)) ? Math.max(0, Math.min(3000, Number(args.timeout_seconds))) : 1800;
  let timer: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, seconds * 1000); });
  // A message from another agent ends the wait too, so the agent can answer it; the MCP server appends the inbox to this result.
  const hasMail = (): boolean => getUnifyFeature('agents.messaging') && agentBus.hasInbox(chat.record.id);
  let interrupted = false;
  // Cancelling the parent turn ends the wait; the subagents themselves keep running unless cancelled.
  const stopped = new Promise<void>(resolve => {
    poll = setInterval(() => {
      if (hasMail()) interrupted = true;
      if (interrupted || chat.cancelRequested || !chat.running) {
        clearInterval(poll);
        resolve();
      }
    }, 200);
  });
  const finished = args.any === true ? Promise.race(tasks.map(task => task.finished)) : Promise.all(tasks.map(task => task.finished));
  try { await Promise.race([finished, timeout, stopped]); } finally { clearTimeout(timer); if (poll) clearInterval(poll); }
  const report = this.takeBackgroundResults(chat, tasks.map(task => task.id));
  const running = tasks.filter(task => !task.done).map(task => `${task.id} (${task.label})`);
  const mailNote = interrupted && running.length ? `Stopped waiting because another agent messaged you (below). Answer it, then call ${WAIT_SUBAGENTS} again for the rest.` : '';
  return { text: [mailNote, report, running.length ? `Still running: ${running.join(', ')}.` : '', unknown.length ? `Unknown ids: ${unknown.join(', ')}.` : ''].filter(Boolean).join('\n\n') || 'Nothing finished yet.' };
}

/** Stops a background subagent and reports what it did so far, waiting briefly for it to wind down. */
export async function cancelSubagent(this: ExtensionHost, chat: Chat, args: Record<string, unknown>): Promise<DelegateResult> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const task = chat.background.get(id);
  if (!task) return { text: `No background subagent with id "${id}".`, isError: true };
  chat.background.delete(id);
  const heading = task.done ? `Background subagent ${id} (${task.label}) had already finished.` : `Cancelled background subagent ${id} (${task.label}).`;
  task.run?.cancel();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([task.finished, new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })]);
  clearTimeout(timer);
  const report = task.done ? task.result?.text || '(no report)' : 'It had not stopped after 5 seconds, so there is no report of its work.';
  return { text: `${heading}\n\n${report}` };
}

/** Called when a background subagent finishes: once every "resume" task of an idle chat is done, their results start a new turn. */
export function backgroundSettled(this: ExtensionHost, chat: Chat): void {
  const id = chat.record.id;
  if (this.deletedSessions.has(id) || this.chats.get(id) !== chat || chat.running || chat.jobActive || this.promptStarts.has(id)) return;
  const tasks = [...chat.background.values()];
  if (tasks.some(task => !task.done)) { this.postRun(id, 'tool', `${tasks.filter(task => !task.done).length} subagent${tasks.filter(task => !task.done).length === 1 ? '' : 's'} working…`); return; }
  this.postRun(id, 'idle', 'Ready');
  const ready = tasks.filter(task => task.afterTurn === 'resume');
  // Messages that arrived during the turn and were not read wake the chat again.
  if (!ready.length) { this.wakeForMessages(chat); return; }
  void this.guarded(() => this.sendPrompt(`Background subagent results (your earlier turn ended before you collected them). Continue the task with them.\n\n${this.takeBackgroundResults(chat, ready.map(task => task.id))}`,
    undefined, [], id, 'queue', { internal: true }));
}

export async function runSubagentCore(this: ExtensionHost, chat: Chat, profile: SubagentProfile, task: string, paths: string[], onBackground?: (run: ChildRun) => void): Promise<DelegateResult> {
  const fail = (text: string): DelegateResult => ({ text, isError: true });
  const name = profile.name;
  const entry = this.availableModel(profile.model);
  if (!entry || !entry.enabled) return fail(`Subagent "${name}" uses model "${profile.model}", which is not available.`);
  const speed = profile.speed ?? entry.speedOptions?.[0]?.label;
  const speedOption = entry.speedOptions?.find(item => item.label === speed);
  if (profile.speed && !speedOption) return fail(`Speed "${profile.speed}" is not an option for model "${entry.name}".`);
  if (profile.effort && !entry.effortOptions?.includes(profile.effort)) return fail(`Effort "${profile.effort}" is not an option for model "${entry.name}".`);
  // Paths outside the working copy are allowed: the subagent has its parent's permissions, so editing them
  // is approved (or asked about) exactly as it would be for the parent.
  const files = paths.map(item => this.fileKey(chat, item)).filter(Boolean);
  const readOnly = profile.mode !== 'edit' || !files.length || this.jobReadOnly(chat);
  const overlaps = (a: string, b: string): boolean => pathCovers(a, b) || pathCovers(b, a);
  if (!readOnly) {
    const conflicts = files.flatMap(file => [...chat.locks].filter(([path]) => overlaps(path, file)).map(([path, lock]) => `${file} (locked by "${lock.label}" via ${path})`));
    if (conflicts.length) return fail(`Cannot lock: ${conflicts.join('; ')}. Wait for that subagent or choose other files.`);
  }
  const backend = speedOption?.backend || entry.backend;
  const model: ModelEntry = { ...entry, backend };
  const owner = `sub:${randomUUID()}`;
  const agentId = `${chat.turnEntryId}:delegate:${randomUUID()}`;
  const explorer = name === 'explorer' && readOnly;
  const places = this.internalPlaces(chat);
  const post = (event: { title?: string; name?: string; prompt?: string; model?: string; effort?: string; speed?: string; profile?: string; ranges?: SidebarExplorerRange[]; tokens?: number; state?: 'running' | 'complete' | 'error' | 'cancelled'; delegated?: boolean; files?: string[]; text?: string; messageId?: string; role?: 'assistant' | 'tool'; tool?: SidebarSubagentTool; media?: SidebarMedia[] }): void => {
    if (event.state) setSubagentState(agentId, event.state === 'running' ? 'running' : 'idle');
    this.sidebar.postMessage({ type: 'subagentEvent', sessionId: chat.record.id, agentId, ...event });
  };
  const run: ChildRun = { parent: chat, owner, label: profile.name, agentId, readOnly, changed: new Set(), outOfScope: new Set(), files: readOnly ? [] : files, sentToParent: [],queuedForParent: [], background: !!onBackground, cancel: () => undefined };
  this.childRuns.add(run); chat.children.add(run);
  const agentName = registerSubagentAgent({ id: agentId, owner, profile: profile.name, task, chatId: chat.record.id, parentId: chat.record.id });
  run.name = agentName;
  onBackground?.(run);
  if (!readOnly) for (const file of files) chat.locks.set(file, { owner, label: profile.name });
  post({ title: profile.name, name: agentName, prompt: task, model: entry.name, effort: profile.effort, speed, state: 'running', delegated: true, files: readOnly ? [] : files, ...(explorer ? { profile: 'explorer' } : {}) });
  let reply = '';
  let explorerTokens = 0;
  let cancelled = false;
  run.cancel = () => { cancelled = true; };
  const instructions = readOnly
    ? 'You are a READ-ONLY subagent. Do not modify, create or delete any files.'
    : `You may edit ONLY these paths: ${files.join(', ')}. Do not touch anything else; other agents are working in parallel.`;
  const summaries = profile.tools !== false && this.summariesOn() ? `${SUMMARY_INSTRUCTIONS}\n\n` : '';
  const memory = memoryInstructions(chat.mirror.cwd, this.memorySettings().enabled);
  // Tied to the parent chat, so a subagent's scratch files go in the same folder and are deleted with it.
  const storage = `${chatStorageInstructions(chat.mirror.cwd, chat.record.id)}${readOnly ? ' This folder is the one exception to the no-files rule above.' : ''}`;
  const explorerNote = explorer ? explorerPromptNote() : '';
  const shell = [BACKGROUND_CLEANUP, shellInstructions()].filter(Boolean).join('\n');
  const intro = `You are a subagent working in a shared working copy on behalf of another agent. ${instructions}\n\n${shell}`;
  // Claude already gets the delegation note as system text.
  const promptFor = (text: string, systemDelegation: boolean): string => `${intro}\n\n${systemDelegation ? '' : `${delegationInstructions(false)}\n\n`}${memory ? `${memory}\n\n` : ''}${storage}\n\n${summaries}Task:\n${explorerNote}${text}\n\n`
    + 'When you finish, reply with a concise final report of at most 300 words unless the task asks for more: findings, files changed, and anything the requester must still do.';
  // Where the reply of the session that finished the task starts; earlier sessions ended in checkpoints.
  let reportStart = 0;
  // Text after a tool call or a new model message starts a new paragraph instead of running on.
  let gap = false;
  // Text after a tool call opens a new message, so the subagent view keeps text and tools in order.
  let replySegment = 0;
  let segmentStarted = false;
  const onText = (raw: string): void => {
    const text = gap && reply.trim() && raw.trim() ? `${reply.endsWith('\n\n') ? '' : reply.endsWith('\n') ? '\n' : '\n\n'}${raw.trimStart()}` : raw;
    if (raw.trim()) gap = false;
    reply += text;
    // A message that starts after a tool call drops the paragraph break that joined it to the reply.
    const shown = segmentStarted ? text : text.replace(/^\s+/, '');
    if (!shown) return;
    segmentStarted = true;
    post({ text: shown, messageId: `reply:${replySegment}` });
  };
  // The latest tool calls, reported if the subagent is cancelled or fails.
  const toolLog: string[] = [];
  let toolCount = 0;
  // Live edit preview: edit calls whose row exists (posted from streamed input or a running event).
  const liveEdits = new LiveEdits(chat.mirror.cwd);
  // How each edit row was last shown, so its finished event keeps the same title.
  const editRows = new Map<string, ReturnType<typeof displayTool>>();
  const onTool = (id: string, title: string, detail: string | undefined, state: 'running' | 'complete' | 'error', error?: string): void => {
    if (state !== 'running') {
      // Only edit rows show a finished state; other subagent tools have none.
      const shownRow = editRows.get(id);
      // An edit that succeeded changed the files it names, whether or not it was ever asked to approve.
      const edited = state === 'complete' ? liveEdits.targets(id) : [];
      for (const rel of edited) {
        run.changed.add(rel);
        if (!run.files.some(file => pathCovers(file, rel))) run.outOfScope.add(rel);
      }
      if (!shownRow) return;
      editRows.delete(id);
      const edit = liveEdits.finish(id, state === 'error' ? error || 'The edit failed.' : undefined);
      post({ messageId: `tool:${id}`, role: 'tool', tool: { ...shownRow, state, ...(edit ? { edit } : {}) } });
      return;
    }
    gap = true;
    toolCount += 1;
    toolLog.push(`- ${title}${detail ? `: ${detail.replace(/\s+/g, ' ').slice(0, 150)}` : ''}`);
    if (toolLog.length > 30) toolLog.shift();
    if (segmentStarted) { replySegment += 1; segmentStarted = false; }
    const shown = displayTool(title, detail);
    const edit = shown.kind === 'edit' ? liveEdits.current(id) : undefined;
    if (shown.kind === 'edit') editRows.set(id, shown);
    post({ text: `${title}${detail ? `: ${detail.slice(0, 300)}` : ''}`, messageId: `tool:${id}`, role: 'tool', tool: {
      ...shown, internal: internalToolOf({ tool: title, input: detail }, places),
      ...(shown.kind === 'edit' ? { state: 'running' as const } : {}), ...(edit ? { edit } : {}),
    } });
    this.noteRead(chat.mirror.cwd, readToolPath(title, detail));
  };
  const onToolInput = (event: { id: string; name: string; input: Record<string, unknown>; streaming: boolean }): void => {
    const edit = liveEdits.update(event.id, event.name, event.input, event.streaming);
    if (!edit) return;
    const shown = { ...displayTool(event.name, JSON.stringify(event.input).slice(0, 500)), kind: 'edit' as const };
    if (!editRows.has(event.id)) {
      // The row starts before the call's running event, so later text opens a new message after it.
      gap = true;
      if (segmentStarted) { replySegment += 1; segmentStarted = false; }
    }
    editRows.set(event.id, shown);
    post({ messageId: `tool:${event.id}`, role: 'tool', tool: { ...shown, state: 'running', edit } });
  };
  // Fingerprints of the locked paths before the run, for edits no edit row reported (shell commands, auto-approved writes).
  let filesBefore: Map<string, string> | undefined;
  const noteFileChanges = async (): Promise<void> => {
    if (!filesBefore) return;
    const after = await snapshotFiles(chat.mirror.cwd, run.files).catch(() => undefined);
    const before = filesBefore;
    filesBefore = undefined;
    if (after) for (const rel of diffSnapshots(before, after)) run.changed.add(rel);
  };
  try {
    const route = await this.resolveRoute(model);
    const effort = profile.effort || undefined;
    // Mid-turn compaction: past the threshold a subagent replies with a checkpoint and goes on in a fresh session from it.
    const compactAt = this.autoCompactAt();
    let watch: CompactWatch | undefined;
    let turn: TurnChannel | undefined;
    // The first context report of a session is its fixed overhead plus the opening prompt.
    let base: number | undefined;
    let askedFrom = -1;
    const onContext = (tokens: number): void => {
      if (!watch || !turn || !Number.isFinite(tokens) || tokens <= 0) return;
      if (base === undefined) { base = tokens; return; }
      const step = compactStep(watch, tokens - base);
      if (!step) return;
      if (!sendCompactRequest(watch, turn, subagentCompactRequest(tokens, step === 'urge'))) { if (step === 'ask') watch.askedAt = undefined; return; }
      if (askedFrom < 0) askedFrom = reply.length;
      this.output.appendLine(`Mid-turn compaction: asked subagent "${name}" to checkpoint at about ${Math.round(tokens / 1000)}k tokens${step === 'urge' ? ' (again)' : ''}.`);
    };
    let runSession: (sessionTask: string) => Promise<void>;
    if ('oauthAccount' in route && route.model.provider === 'codex-cli' && isCodexCliChat(chat.record)) {
      const cli = new CodexCliRuntime();
      run.cancel = () => { cancelled = true; cli.cancel(); };
      // `codex exec` is single-turn and cannot receive a mid-turn compaction request.
      runSession = async sessionTask => {
        if (cancelled) throw new Error('Cancelled.');
        await cli.prompt({ account: route.oauthAccount, cwd: chat.mirror.cwd, backend: codexBackend(backend),
          effort, readOnly, fullAccess: this.approvalMode === 'full' && !readOnly,
          delegate: profile.tools === false ? undefined : this.delegateConfig(owner, true),
          prompt: promptFor(sessionTask, true), onText, onTool,
          onUsage: usage => {
            this.logUsage(chat.record.id, explorer ? 'explorer' : 'subagent', entry.name, usage);
            if (explorer) {
              const total = usage.total;
              explorerTokens += total.input + total.cacheRead + total.cacheWrite + total.output;
              chat.record.explorerTokens = (chat.record.explorerTokens || 0) + total.input + total.cacheRead + total.cacheWrite + total.output;
              this.refreshSessions();
            }
          } });
      };
    } else if ('oauthAccount' in route && isCliProvider(route.model.provider)) {
      const account = route.oauthAccount;
      const cli = new OAuthCliRuntime();
      run.cancel = () => { cancelled = true; cli.cancel(); };
      await this.shareGlobalInstructions(account);
      if (cancelled) throw new Error('Cancelled.');
      turn = cli;
      run.say = text => cli.say(text);
      runSession = async sessionTask => {
        await this.promptPooled(cli, { account, cwd: chat.mirror.cwd, backend, effort, speed, readOnly, fullAccess: this.approvalMode === 'full',
          cacheTtl: explorer ? '5m' : undefined,
          explorer,
          onContext,
          onUsage: usage => {
            this.logUsage(chat.record.id, explorer ? 'explorer' : 'subagent', entry.name, usage);
            if (explorer) {
              const total = usage.total;
              explorerTokens += total.input + total.cacheRead + total.cacheWrite + total.output;
              chat.record.explorerTokens = (chat.record.explorerTokens || 0) + total.input + total.cacheRead + total.cacheWrite + total.output;
              this.refreshSessions();
              void this.saveSession(chat.record).catch(error => this.output.appendLine(`Saving explorer usage failed: ${String(error)}`));
            }
          },
          delegate: profile.tools === false ? undefined : this.delegateConfig(owner, true), prompt: promptFor(sessionTask, true), onText, onTool, onToolInput,
          // Images a tool returned (Read of a screenshot) land on its row in the subagent feed, as on the ACP path.
          onToolImages: (id, title, content) => {
            const images = this.incomingImages(content);
            if (images.length) void this.storeIncomingImages(chat.record.id, images, profile.name).then(items => {
              if (items.length) post({ messageId: `tool:${id}`, role: 'tool', tool: displayTool(title, undefined), media: items });
            });
          },
          onMessageBreak: () => { gap = true; }, onApproval: (description, info) => this.decideApproval(chat, { owner, label: profile.name, readOnly }, description, info) },
        () => cancelled, (next, failed) => { post({ text: `Account switch: ${failed.label} hit its usage limit; continuing on ${next.label}`, messageId: `account:${next.id}`, role: 'tool' }); gap = true; return {}; });
      };
    } else {
      const slot = await this.ensureRuntime(route, chat.mirror.cwd, owner, { kind: 'subagent', profile: name });
      if (!slot) throw new Error('No runtime is available for this subagent model.');
      run.runtimeKey = slot.key;
      const cursor = route.model.provider === 'cursor-acp';
      const toolTexts = new Set<string>();
      run.onUpdate = update => {
        const kind = String(update.sessionUpdate || '');
        if (kind === 'agent_message_chunk') {
          const content = update.content as Record<string, unknown> | undefined;
          if (content?.type === 'text' && typeof content.text === 'string') onText(content.text);
        } else if (kind === 'tool_call' && typeof update.toolCallId === 'string' && !toolTexts.has(update.toolCallId)) {
          toolTexts.add(update.toolCallId);
          const title = String(update.title || 'Tool');
          const rawInput = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput as Record<string, unknown> : undefined;
          const editName = rawInput ? LiveEdits.acpToolName(title, String(update.kind || ''), rawInput) : undefined;
          if (rawInput && editName) onToolInput({ id: update.toolCallId, name: editName, input: rawInput, streaming: false });
          onTool(update.toolCallId, editName || title, editName ? JSON.stringify(rawInput).slice(0, 500) : undefined, 'running');
        } else if (kind === 'tool_call_update' && typeof update.toolCallId === 'string' && (update.status === 'completed' || update.status === 'failed')) {
          const failed = update.status === 'failed';
          const contents = Array.isArray(update.content) ? update.content as Record<string, unknown>[] : [];
          const message = contents.map(item => (item.content as Record<string, unknown> | undefined)?.text ?? item.text).filter(text => typeof text === 'string').join('\n').trim();
          // Only edit rows use this; onTool ignores finished states of other tools.
          onTool(update.toolCallId, String(update.title || 'Edit'), undefined, failed ? 'error' : 'complete', failed ? message.slice(0, 300) || undefined : undefined);
          const images = this.incomingImages(update.content);
          if (images.length) {
            const id = update.toolCallId;
            const title = String(update.title || 'Tool');
            void this.storeIncomingImages(chat.record.id, images, profile.name).then(items => {
              if (items.length) post({ messageId: `tool:${id}`, role: 'tool', tool: displayTool(title, undefined), media: items });
            });
          }
        } else if (kind === 'tool_call_update' && typeof update.toolCallId === 'string') {
          // Images a tool returned land on its row, so the subagent feed shows them too.
          const images = this.incomingImages(update.content);
          if (images.length) {
            const id = update.toolCallId;
            const title = String(update.title || 'Tool');
            void this.storeIncomingImages(chat.record.id, images, profile.name).then(items => {
              if (items.length) post({ messageId: `tool:${id}`, role: 'tool', tool: displayTool(title, undefined), media: items });
            });
          }
        } else if (kind === 'usage_update' && typeof update.used === 'number') onContext(update.used);
        if (kind.startsWith('tool_call') && String(update.kind || '').toLowerCase() === 'read' && Array.isArray(update.locations)) {
          this.noteRead(chat.mirror.cwd, (update.locations as Record<string, unknown>[]).find(item => typeof item.path === 'string')?.path);
        }
      };
      runSession = async sessionTask => {
        run.cancel = () => { cancelled = true; void slot.runtime.stop(); };
        if (cancelled) throw new Error('Cancelled.');
        const sessionId = await slot.runtime.newSession(chat.mirror.cwd, this.mcpServers(profile.tools === false ? undefined : owner, true));
        run.sessionId = sessionId;
        run.cancel = () => { cancelled = true; slot.runtime.cancel(sessionId); };
        turn = { interrupt: () => slot.runtime.interrupt(sessionId) };
        // User messages stop the prompt and go in as the session's next one.
        const fromUser: string[] = [];
        run.say = text => {
          if (!turn) return false;
          fromUser.push(text);
          if (slot.runtime.interrupt(sessionId)) return true;
          fromUser.pop();
          return false;
        };
        const nextPrompt = (): string | undefined => {
          const compact = takeFollowUp(watch);
          if (!fromUser.length) return compact;
          const user = fromUser.splice(0).join('\n\n');
          return compact ? `${compact}\n\n${user}` : `${PAUSED_NOTE}${user}`;
        };
        try {
          if (cursor) {
            await this.refreshCursorModels(slot.runtime, sessionId);
            if (backend !== 'auto' || slot.runtime.models(sessionId).some(option => option.value === 'auto')) await slot.runtime.setModel(sessionId, backend);
          }
          if (effort) await slot.runtime.setConfigOption(sessionId, 'reasoning_effort', effort);
          if (cancelled) throw new Error('Cancelled.');
          await slot.runtime.prompt(sessionId, promptFor(sessionTask, false));
          // Mid-turn compaction stopped the prompt to ask for a checkpoint; the request is the session's next prompt.
          for (let ask = nextPrompt(); ask && !cancelled; ask = nextPrompt()) await slot.runtime.prompt(sessionId, ask);
        } finally {
          turn = undefined;
          run.say = undefined;
          if (cancelled) await slot.runtime.stop();
          else await slot.runtime.closeSession(sessionId).catch(() => undefined);
        }
      };
    }
    if (!readOnly && run.files.length) filesBefore = await snapshotFiles(chat.mirror.cwd, run.files).catch(() => undefined);
    let sessionTask = task;
    for (let segment = 1; ; segment++) {
      watch = compactAt && segment < MAX_SUBAGENT_SEGMENTS ? { threshold: compactAt } : undefined;
      base = undefined;
      askedFrom = -1;
      reportStart = reply.length;
      await runSession(sessionTask);
      // No checkpoint means the session finished the task (or stopped for another reason) before it saw the request.
      const checkpoint = askedFrom >= 0 && !cancelled ? subagentCheckpoint(reply.slice(askedFrom)) : undefined;
      if (!checkpoint) break;
      post({ text: `Context compacted; continuing in a fresh session (part ${segment + 1})`, messageId: `compact:${segment}`, role: 'tool' });
      gap = true;
      sessionTask = subagentResumeTask(task, checkpoint, segment);
    }
    await noteFileChanges();
    if (cancelled) throw new Error('Cancelled.');
    const parsed = explorer
      ? parseExplorerRanges(reply.slice(reportStart).trim())
      : { text: reply.slice(reportStart).trim(), ranges: [] as SidebarExplorerRange[] };
    post({ state: 'complete', ...(explorer ? { ranges: parsed.ranges, tokens: explorerTokens } : {}) });
    let result = parsed.text || '(The subagent finished without a written report.)';
    if (explorer) {
      const rangeBlock = formatExplorerRanges(parsed.ranges);
      if (rangeBlock) result += `\n\n${rangeBlock}`;
    }
    if (run.changed.size) {
      result += `\n\n---\nFiles changed by this subagent: ${[...run.changed].join(', ')}`;
      if (run.outOfScope.size) result += `\nWARNING: edits outside its locked paths (${files.join(', ') || 'none'}): ${[...run.outOfScope].join(', ')}`;
    } else if (!readOnly) {
      result += '\n\n---\nNo files were changed by this subagent.';
    }
    await this.attachReportImages(chat, run, parsed.text).catch(error => this.output.appendLine(`Report images failed: ${String(error)}`));
    const mediaBlocks = await this.deliverRunMediaToParent(run);
    if (mediaBlocks.length) return { text: result, content: [{ type: 'text', text: result }, ...mediaBlocks] };
    return { text: result };
  } catch (error) {
    post({ state: cancelled ? 'cancelled' : 'error' });
    await noteFileChanges();
    const message = error instanceof Error ? error.message : String(error);
    let result = cancelled ? 'The subagent was cancelled.' : `Subagent "${name}" failed: ${message}`;
    // What it did before stopping, so the requester need not redo or guess at it.
    const partial = reply.slice(reportStart).trim();
    if (partial) result += `\n\nIts reply so far:\n${partial.length > 1500 ? `…${partial.slice(-1500)}` : partial}`;
    if (toolLog.length) result += `\n\nTools it ran${toolCount > toolLog.length ? ` (last ${toolLog.length} of ${toolCount})` : ''}:\n${toolLog.join('\n')}`;
    if (run.changed.size) result += `\n\n---\nFiles changed by this subagent: ${[...run.changed].join(', ')}`;
    // Images it already sent still reach the parent, even when the run failed.
    if (partial && !cancelled) await this.attachReportImages(chat, run, partial).catch(failure => this.output.appendLine(`Report images failed: ${String(failure)}`));
    const mediaBlocks = await this.deliverRunMediaToParent(run);
    if (mediaBlocks.length) return { text: result, isError: true, content: [{ type: 'text', text: result }, ...mediaBlocks] };
    return { text: result, isError: true };
  } finally {
    // Messages that waited for a Unify tool result the subagent never made.
    const unread = takeUserMessages(agentId);
    if (unread.length) post({ text: `Finished before reading ${unread.length === 1 ? 'your message' : `${unread.length} of your messages`}`, messageId: 'user-unread', role: 'tool' });
    run.say = undefined;
    unregisterSubagentAgent(agentId);
    for (const [path, lock] of [...chat.locks]) if (lock.owner === owner) chat.locks.delete(path);
    this.childRuns.delete(run); chat.children.delete(run);
    await this.releaseRuntime(run.runtimeKey);
  }
}
