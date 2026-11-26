/** Permission requests, questions to the user, approval decisions, reckless-action blocking and file locks. */
import type { Host as ExtensionHost } from '../extension';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import * as vscode from 'vscode';
import { DelegateResult } from '../delegate/host';
import { addDecision } from '../goal/runner';
import { recklessBlockMessage, recklessPathReason, recklessToolReason, toolCommandText } from '../runtime/reckless';
import { NO_QUESTIONS_MESSAGE } from '../slash/registry';
import { answersByQuestion, formatAnswers, parseQuestions } from '../sidebar/questions';
import { isNativeSubagentTool } from '../runtime/delegation';
import { displayTool } from '../runtime/toolDisplay';
import { isMemoryPath } from '../runtime/memory';
import { SidebarQuestion } from '../sidebar/view';
import { getUnifyFeature } from '../unify/settings';
import { recordKnowledgeVersion } from '../unify/requests/knowledge';
import { requestPaths } from '../unify/requests/state';
import { nativeAgentsBlocked } from '../runtime/nativeAgents';
import { addAllowRule, commandPrefix, isAlwaysAllowed } from '../sidebar/allowRules';
import type { Actor, ToolInfo, ChildRun, Chat } from './types';
import { PARENT, EDIT_TOOLS, APPROVAL_TIMEOUT_MS } from './constants';
import { pathCovers, isRiskyAction } from './helpers';

/**
 * `background` marks a request from a background subagent, which stays open when the parent's turn ends.
 * `prefix` is the command prefix an "Always allow" answer would remember.
 */
export function askInChat(this: ExtensionHost, sessionId: string | undefined, title: string, detail: string, background = false, prefix?: string): Promise<boolean> {
  if (!sessionId) return Promise.resolve(false);
  const asking = this.sessions().find(item => item.id === sessionId);
  const project = asking?.noFolder ? undefined : asking?.project?.path || this.currentProject()?.path;
  // A remembered "Always allow" answers before the user is asked.
  if (prefix && project && isAlwaysAllowed(project, prefix)) return Promise.resolve(true);
  const id = randomUUID();
  void vscode.commands.executeCommand('workbench.view.extension.unify');
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => {
      this.output.appendLine(`Approval request "${title}" went unanswered for 10 minutes; rejecting it so the turn can finish.`);
      this.settleApproval(id, false);
    }, APPROVAL_TIMEOUT_MS);
    this.pendingApprovals.set(id, { sessionId, background, resolve, timer, ...(project ? { project } : {}), ...(prefix ? { prefix } : {}) });
    this.sidebar.postMessage({
      type: 'approvalRequest',
      sessionId,
      id,
      title,
      detail: detail.slice(0, 2000),
      canAlwaysAllow: Boolean(project && prefix),
    });
    this.notifyDesktop(title, detail.slice(0, 300));
  });
}

/** Rejects a chat's open requests. With `keepBackground`, requests from background subagents stay open. */
export function settleChatApprovals(this: ExtensionHost, chatId: string, keepBackground = false): void {
  for (const [id, pending] of [...this.pendingApprovals]) if (pending.sessionId === chatId && !(keepBackground && pending.background)) this.settleApproval(id, false);
  for (const [id, pending] of [...this.pendingQuestions]) if (pending.sessionId === chatId) this.settleQuestion(id, null);
}

export async function askQuestions(this: ExtensionHost, chat: Chat, args: Record<string, unknown>): Promise<DelegateResult> {
  if (chat.cancelRequested) return { text: 'Cancelled.', isError: true };
  if (getUnifyFeature('agents.noQuestions')) return { text: NO_QUESTIONS_MESSAGE, isError: true };
  const parsed = parseQuestions(args);
  if ('error' in parsed) return { text: parsed.error, isError: true };
  const answers = await this.showQuestions(chat, parsed.questions);
  await this.logJobDecisions(chat, parsed.questions, answers);
  return { text: formatAnswers(parsed.questions, answers) };
}

/** Claude's built-in AskUserQuestion, shown with the same chat card as ask_questions. */
export async function askNativeQuestions(this: ExtensionHost, chat: Chat, input: Record<string, unknown>): Promise<Record<string, string> | string> {
  if (chat.cancelRequested) return 'Cancelled.';
  // A string answer makes the runtime deny the AskUserQuestion call with this message.
  if (getUnifyFeature('agents.noQuestions')) return NO_QUESTIONS_MESSAGE;
  const parsed = parseQuestions(input);
  if ('error' in parsed) return parsed.error;
  const answers = await this.showQuestions(chat, parsed.questions);
  await this.logJobDecisions(chat, parsed.questions, answers);
  return answers ? answersByQuestion(input, answers) : formatAnswers(parsed.questions, null);
}

export async function logJobDecisions(this: ExtensionHost, chat: Chat, questions: SidebarQuestion[], answers: string[] | null): Promise<void> {
  const job = chat.record.job;
  if (!chat.jobActive || !job || !['draft', 'work', 'verify'].includes(job.phase) || !answers) return;
  questions.forEach((question, index) => { if (typeof answers[index] === 'string') addDecision(job, question.question, answers[index]); });
  await this.updateJob(chat, job);
}

export function showQuestions(this: ExtensionHost, chat: Chat, questions: SidebarQuestion[]): Promise<string[] | null> {
  const id = randomUUID();
  const sessionId = chat.record.id;
  void vscode.commands.executeCommand('workbench.view.extension.unify');
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      this.output.appendLine('A question went unanswered for 10 minutes; skipping it so the turn can finish.');
      this.settleQuestion(id, null);
    }, APPROVAL_TIMEOUT_MS);
    this.pendingQuestions.set(id, { sessionId, resolve, timer });
    this.sidebar.postMessage({ type: 'questionRequest', sessionId, id, questions });
    this.notifyDesktop(questions[0]?.question || 'Question from the agent', questions.length > 1 ? `${questions.length} questions are waiting in Unify.` : 'It is waiting in Unify.');
  });
}

export function settleQuestion(this: ExtensionHost, id: string, answers: string[] | null): void {
  const pending = this.pendingQuestions.get(id);
  if (!pending) return;
  this.pendingQuestions.delete(id);
  clearTimeout(pending.timer);
  this.sidebar.postMessage({ type: 'questionResolved', sessionId: pending.sessionId, id, answers });
  pending.resolve(answers);
}

export function settleApproval(this: ExtensionHost, id: string, allow: boolean, always = false): void {
  const pending = this.pendingApprovals.get(id);
  if (!pending) return;
  this.pendingApprovals.delete(id);
  clearTimeout(pending.timer);
  // "Always allow" remembers the command prefix for this project, so later matching requests skip the prompt.
  if (allow && always && pending.project && pending.prefix) {
    try {
      addAllowRule(pending.project, pending.prefix);
      this.output.appendLine(`Always allowing "${pending.prefix}" in ${pending.project}.`);
    } catch (error) {
      this.output.appendLine(`Could not save the allow rule: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  this.sidebar.postMessage({ type: 'approvalResolved', sessionId: pending.sessionId, id, allowed: allow });
  pending.resolve(allow);
}

export async function requestPermission(this: ExtensionHost, params: Record<string, unknown>, key: string): Promise<string | undefined> {
  if (!vscode.workspace.isTrusted) return undefined;
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  const chat = this.chatForRuntime(sessionId, key);
  const child = chat ? undefined : [...this.childRuns].find(run => run.runtimeKey === key && run.sessionId === sessionId);
  const parent = chat ?? child?.parent;
  const tool = params.toolCall as Record<string, unknown> | undefined;
  const options = Array.isArray(params.options) ? params.options as Record<string, unknown>[] : [];
  const allow = options.find(option => option.kind === 'allow_once');
  const reject = options.find(option => option.kind === 'reject_once');
  const title = typeof tool?.title === 'string' ? tool.title : 'Agent tool';
  if (!parent) return reject ? String(reject.optionId || '') : undefined;
  const locations = Array.isArray(tool?.locations) ? tool.locations as Record<string, unknown>[] : [];
  const path = locations.find(item => typeof item.path === 'string')?.path;
  const isEdit = ['edit', 'delete', 'move'].includes(String(tool?.kind || ''));
  const actor: Actor = child ? { owner: child.owner, label: child.label, readOnly: child.readOnly } : PARENT;
  const shown = displayTool(title, tool?.rawInput && typeof tool.rawInput === 'object' ? JSON.stringify(tool.rawInput) : undefined);
  const detail = `${shown.title}${shown.detail ? `: ${shown.detail}` : ''}${path ? ` (${path})` : ''} ${JSON.stringify(tool?.rawInput ?? tool?.content ?? '')}`;
  const verdict = await this.decideApproval(parent, actor, detail, isEdit ? { tool: 'Edit', input: { file_path: typeof path === 'string' ? path : undefined } } : { tool: title, input: {} });
  return verdict === true ? String(allow?.optionId || '') : reject ? String(reject.optionId || '') : undefined;
}

export async function decideApproval(this: ExtensionHost, chat: Chat, actor: Actor, description: string, info?: ToolInfo): Promise<boolean | string> {
  // Claude sends this hint on every tool, including reads.
  if (info?.autoAllowEdits && !EDIT_TOOLS.test(info.tool)) info = { ...info, autoAllowEdits: false };
  const verdict = await this.decideApprovalInner(chat, actor, description, info);
  if (verdict === true && info && EDIT_TOOLS.test(info.tool)) {
    // Keep what an agent is about to overwrite, so Knowledge's Undo can restore it.
    const rel = this.relPath(chat, info.input);
    if (rel) this.recordAgentKnowledgeVersion(chat, rel, actor.owner === PARENT.owner ? chat.record.name : actor.label);
  }
  if (verdict === true && info && EDIT_TOOLS.test(info.tool) && actor.owner !== PARENT.owner) {
    const raw = this.rawToolPath(info.input);
    const key = raw ? this.fileKey(chat, raw) : '';
    const run = [...this.childRuns].find(item => item.owner === actor.owner);
    if (key && run) {
      run.changed.add(key);
      if (!run.files.some(file => pathCovers(file, key))) run.outOfScope.add(key);
    }
  }
  return verdict;
}

/** Snapshots project rules, memory notes and skills before an agent edits them (Knowledge screen Undo). */
export function recordAgentKnowledgeVersion(this: ExtensionHost, chat: Chat, rel: string, by: string): void {
  const knowledge = rel === 'AGENTS.md'
    || rel.startsWith('.unify/memory/')
    || rel.startsWith('.agents/skills/');
  if (!knowledge) return;
  const root = chat.record.project?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  try {
    recordKnowledgeVersion(requestPaths({ workspaceRoot: root }), join(root, rel), by);
  } catch (error) {
    this.output.appendLine(`Could not keep a knowledge version: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function decideApprovalInner(this: ExtensionHost, chat: Chat, actor: Actor, description: string, info?: ToolInfo): Promise<boolean | string> {
  const background = !!this.backgroundRun(actor.owner);
  if (chat.cancelRequested && !background) return false;
  if (!vscode.workspace.isTrusted) return false;
  if (info && this.jobReadOnly(chat) && (EDIT_TOOLS.test(info.tool) || info.autoAllowEdits)) return 'The job is in a read-only phase (drafting or reviewing); do not edit files.';
  if (info && isNativeSubagentTool(info.tool) && nativeAgentsBlocked()) return 'Use Unify delegate_task with a configured subagent profile.';
  if (info && EDIT_TOOLS.test(info.tool)) {
    if (actor.readOnly) return 'This subagent is read-only and may not edit files.';
    const path = this.relPath(chat, info.input);
    const conflict = path ? this.lockConflict(chat, path, actor.owner) : undefined;
    if (conflict) return `"${path}" is locked by subagent "${conflict.label}" until it finishes. Edit other files or wait.`;
    // Memory vaults are part of every agent's permissions, like any file in the project, unless the user
    // turned off agent writes to the knowledge folders (knowledge.agentWrites); then edits are asked about.
    if (path && isMemoryPath(path) && this.memorySettings().enabled && getUnifyFeature('knowledge.agentWrites')) return true;
    // Outside the working copy nothing reviews the edit, so only full or most access skips asking.
    const outsidePath = !path ? this.rawToolPath(info.input) : undefined;
    if (outsidePath) {
      const outsideConflict = this.lockConflict(chat, this.fileKey(chat, outsidePath), actor.owner);
      if (outsideConflict) return `"${outsidePath}" is locked by subagent "${outsideConflict.label}" until it finishes. Edit other files or wait.`;
      if (this.approvalMode === 'most') {
        const reason = recklessPathReason(outsidePath);
        return reason ? this.blockReckless(chat, actor, reason, outsidePath) : true;
      }
      return this.approvalMode === 'full' || this.askInChat(chat.record.id, actor.owner === PARENT.owner ? 'Edit outside the project' : `Subagent "${actor.label}" wants to edit outside the project`, description, background);
    }
    if (info.autoAllowEdits) return true;
  }
  if (this.approvalMode === 'most') {
    const reason = recklessToolReason(description, info?.input);
    return reason ? this.blockReckless(chat, actor, reason, toolCommandText(description, info?.input)) : true;
  }
  if (this.approvalMode === 'full' || (this.approvalMode === 'auto' && !isRiskyAction(description))) return true;
  // Only shell commands can be remembered as an allow rule ("Always allow").
  const command = info && typeof info.input.command === 'string' ? info.input.command : '';
  const prefix = command ? commandPrefix(command) : undefined;
  return this.askInChat(chat.record.id, actor.owner === PARENT.owner ? 'Permission requested' : `Subagent "${actor.label}" requests permission`, description, background, prefix);
}

/** Full and Most access both skip the approval prompts for reads outside the project and for sensitive paths. */
export function broadAccess(this: ExtensionHost): boolean {
  return this.approvalMode === 'full' || this.approvalMode === 'most';
}

/** Most access refused a reckless call: logs it and returns the reason the agent sees as the tool result. */
export function blockReckless(this: ExtensionHost, chat: Chat, actor: Actor, reason: string, what: string): string {
  const who = actor.owner === PARENT.owner ? chat.record.name : `subagent "${actor.label}"`;
  this.output.appendLine(`Most access blocked ${who}: ${reason}: ${what.slice(0, 500)}`);
  return recklessBlockMessage(reason);
}

export function backgroundRun(this: ExtensionHost, owner: string): ChildRun | undefined {
  const run = [...this.childRuns].find(item => item.owner === owner);
  return run?.background ? run : undefined;
}

export function rawToolPath(this: ExtensionHost, input: Record<string, unknown>): string | undefined {
  return [input.file_path, input.notebook_path, input.path].find((value): value is string => typeof value === 'string' && !!value);
}

export function relPath(this: ExtensionHost, chat: Chat, input: Record<string, unknown>): string | undefined {
  const raw = this.rawToolPath(input);
  if (!raw) return undefined;
  const rel = (isAbsolute(raw) ? relative(chat.mirror.cwd, raw) : raw).replaceAll('\\', '/').replace(/^\.\//, '');
  return rel.startsWith('..') ? undefined : rel;
}

export function lockConflict(this: ExtensionHost, chat: Chat, rel: string, owner: string): { owner: string; label: string } | undefined {
  for (const [path, lock] of chat.locks) if (lock.owner !== owner && pathCovers(path, rel)) return lock;
  return undefined;
}

/**
 * A path as a lock / subagent-files key: forward-slash and relative inside the working copy, absolute outside it.
 * A trailing "/" (a folder) is kept.
 */
export function fileKey(this: ExtensionHost, chat: Chat, raw: string): string {
  const trimmed = raw.trim().replaceAll('\\', '/');
  if (!trimmed) return '';
  const folder = trimmed.endsWith('/');
  const absolute = resolvePath(chat.mirror.cwd, trimmed);
  const rel = relative(chat.mirror.cwd, absolute);
  const inside = !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  const key = (inside ? rel : absolute).replaceAll('\\', '/');
  return folder && !key.endsWith('/') ? `${key}/` : key;
}
