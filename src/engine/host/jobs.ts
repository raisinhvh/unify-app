/** Goal jobs, the message queue and scheduled prompts. */
import type { Host as ExtensionHost } from '../extension';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { JobHost, JobState } from '../goal/types';
import { createJob, runJob } from '../goal/runner';
import { terminateProcessTree } from '../runtime/cancellation';
import { SidebarImage, SidebarScheduledPrompt } from '../sidebar/view';
import type { SessionRecord, Chat } from './types';
import { toSidebarJob } from './helpers';

export function jobReadOnly(this: ExtensionHost, chat: Chat): boolean { return chat.record.job?.phase === 'draft' || chat.record.job?.phase === 'verify'; }

export function postJob(this: ExtensionHost, record: SessionRecord): void {
  this.sidebar.postMessage({ type: 'jobState', sessionId: record.id, job: record.job ? toSidebarJob(record.job) : null });
}

/** Synchronous so chat switches and loads keep their ordering; the save runs in the background. */
export function restoreJob(this: ExtensionHost, record: SessionRecord): void {
  if (!record.job || !['draft', 'work', 'verify'].includes(record.job.phase) || this.chats.get(record.id)?.jobActive) return;
  record.job.phase = 'stopped'; record.job.stopReason = 'Interrupted (VS Code reloaded)';
  void this.saveSession(record, false).catch(error => this.output.appendLine(`Saving a stopped job failed: ${String(error)}`));
}

export async function updateJob(this: ExtensionHost, chat: Chat, job: JobState): Promise<void> {
  chat.record.job = job;
  await this.saveSession(chat.record, false);
  if (!this.deletedSessions.has(chat.record.id)) this.postJob(chat.record);
}

export async function startJob(this: ExtensionHost, spec: string, images?: SidebarImage[], chatId?: string): Promise<void> {
  if (!spec.trim()) { this.sidebar.postMessage({ type: 'error', message: 'Usage: /job <spec>' }); return; }
  let record: SessionRecord;
  if (chatId) {
    const target = this.sessions().find(item => item.id === chatId);
    if (!target || this.deletedSessions.has(chatId)) {
      this.sidebar.postMessage({ type: 'error', message: 'That chat no longer exists.' });
      return;
    }
    record = target;
  } else {
    if (!this.active) await this.newChat();
    record = this.active!;
  }
  const busy = (): boolean => !!this.promptStarts.has(record.id) || !!this.chats.get(record.id)?.running || !!this.chats.get(record.id)?.jobActive || !!record.job && ['draft', 'work', 'verify'].includes(record.job.phase);
  if (busy()) { this.sidebar.postMessage({ type: 'error', message: 'Finish or cancel the current task before starting a job.' }); return; }
  let attachments = await this.saveImages(images, record.id);
  const chat = await this.loadChat(record);
  if (busy()) { this.sidebar.postMessage({ type: 'error', message: 'Finish or cancel the current task before starting a job.' }); return; }
  const job = createJob(spec);
  chat.jobActive = true; chat.jobCancelled = false; chat.cancelRequested = false; chat.jobNotes = []; chat.jobInterrupted = false;
  record.job = job;
  const fileList = (files: { name: string }[]): string => files.length ? `[Files: ${files.map(file => file.name).join(', ')}]` : '';
  // The first turn shows the /job message as typed; later turns show their step label.
  let original: string | undefined = [`/job ${spec.trim()}`, fileList(attachments)].filter(Boolean).join('\n\n');
  const cancelled = (): boolean => chat.jobCancelled || this.deletedSessions.has(record.id);
  const runTurn = async (prompt: string, label: string): Promise<string | undefined> => {
    while (chat.running || this.promptStarts.has(record.id)) {
      if (cancelled()) return undefined;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (cancelled()) return undefined;
    let reply: string | undefined;
    const files = attachments; attachments = [];
    // Only the first turn carries the user's own /job message; later steps are Unify's and show no user message.
    const shown = original; const internal = original === undefined; original = undefined;
    chat.jobInterrupted = false;
    try {
      await this.sendPrompt(prompt, undefined, files.length ? files : undefined, record.id, 'interrupt', { job: true, shown, internal,
        onFinish: (text, wasCancelled) => { if (!wasCancelled && !cancelled()) reply = text; } });
    } catch (error) { reply = undefined; this.output.appendLine(`Job turn failed: ${String(error)}`); }
    return reply;
  };
  const host: JobHost = {
    runTurn,
    review: async (prompt, label) => {
      if (!this.feature('reviewAgent')) return runTurn(prompt, label);
      if (cancelled()) return undefined;
      const choice = this.modelSetting('reviewModel');
      const model = choice.model && this.availableModel(choice.model);
      if (!model || !model.enabled) throw new Error('Separate review agent is on, but no review model is chosen in Customize.');
      chat.turnEntryId = randomUUID();
      chat.jobInterrupted = false;
      this.postRun(record.id, 'thinking', label);
      try {
        const result = await this.runSubagentCore(chat, { name: 'Reviewer', model: model.name, effort: choice.effort, speed: choice.speed, mode: 'read-only' }, prompt, []);
        if (cancelled() || chat.jobInterrupted) return undefined;
        if (result.isError) throw new Error(result.text);
        return result.text;
      } finally { this.postRun(record.id, 'idle', 'Ready'); }
    },
    ask: questions => cancelled() ? Promise.resolve(null) : this.showQuestions(chat, questions),
    runCheck: command => this.runJobCheck(chat, command),
    update: state => this.updateJob(chat, state),
    cancelled,
    // Files sent with a message go out with the job's next turn.
    takeNotes: () => chat.jobNotes.splice(0).map(note => {
      attachments.push(...note.images);
      return [note.prompt, fileList(note.images)].filter(Boolean).join('\n\n');
    }),
  };
  try { await this.updateJob(chat, job); }
  catch (error) { chat.jobActive = false; throw error; }
  void this.guarded(async () => {
    try { await runJob(job, host); }
    finally {
      chat.jobActive = false; chat.jobCancelled = false; chat.jobInterrupted = false;
      // Messages the job ended before logging are sent as ordinary messages.
      chat.queue.unshift(...chat.jobNotes.splice(0));
      if (!this.deletedSessions.has(record.id)) {
        this.postJob(record);
        const next = chat.queue.shift();
        if (next) {
          this.postQueue(chat);
          void this.guarded(() => this.sendPrompt(next.prompt, undefined, next.images, record.id));
        }
      }
    }
  });
}

export function runJobCheck(this: ExtensionHost, chat: Chat, command: string): Promise<{ code: number | null; output: string }> {
  const id = randomUUID();
  const post = (state: 'running' | 'complete' | 'error', detail?: string): void => {
    this.sidebar.postMessage({ type: 'toolEvent', sessionId: chat.record.id, entryId: `tool:check:${id}`, event: { id, kind: 'shell', title: `Check: ${command}`, detail, state } });
  };
  post('running');
  this.postRun(chat.record.id, 'tool', `Check: ${command}`);
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let polling: ReturnType<typeof setInterval> | undefined;
    const append = (text: string): void => { output = (output + text).slice(-4000); };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true; clearTimeout(timeout); clearInterval(polling);
      post(code === 0 ? 'complete' : 'error', output);
      if (!chat.running) this.postRun(chat.record.id, 'idle', 'Ready');
      resolve({ code, output });
    };
    if (chat.jobCancelled || this.deletedSessions.has(chat.record.id)) { append('Cancelled.'); finish(null); return; }
    try {
      const child = spawn(command, { cwd: chat.mirror.cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe' });
      child.stdout.on('data', data => append(String(data)));
      child.stderr.on('data', data => append(String(data)));
      child.on('error', error => { append(String(error)); finish(null); });
      child.on('close', code => finish(code));
      const stop = (reason: string): void => { append(reason); terminateProcessTree(child); finish(null); };
      timeout = setTimeout(() => stop('\nCheck timed out after 10 minutes.'), 10 * 60 * 1000);
      polling = setInterval(() => { if (chat.jobCancelled || this.deletedSessions.has(chat.record.id)) stop('\nCancelled.'); }, 100);
    } catch (error) { append(String(error)); finish(null); }
  });
}

export function postQueue(this: ExtensionHost, chat: Chat): void {
  this.sidebar.postMessage({ type: 'queueState', sessionId: chat.record.id, items: chat.queue.map(item => item.prompt || '(attachment)') });
}

/** Pushes the current project's pending `/schedule` prompts to the composer. */
export function postScheduledPrompts(this: ExtensionHost): void {
  this.sidebar.postMessage({ type: 'scheduledPromptsState', prompts: this.scheduled.list() });
}

/**
 * Sends a prompt that came due. A chat that still exists gets it with `queue` mode, so a running
 * turn finishes first; a deleted or missing chat means a new chat, as the New button would make.
 */
export async function deliverScheduledPrompt(this: ExtensionHost, prompt: SidebarScheduledPrompt, images: SidebarImage[]): Promise<void> {
  const chatId = prompt.chatId && this.sessions().some(item => item.id === prompt.chatId) && !this.deletedSessions.has(prompt.chatId)
    ? prompt.chatId
    : undefined;
  if (!chatId) await this.newChat();
  await this.sendPrompt(prompt.prompt, images.length ? images : undefined, undefined, undefined, 'queue', { chatId: chatId || this.active?.id });
  this.notifyDesktop('Scheduled prompt sent', prompt.prompt.slice(0, 300));
}
