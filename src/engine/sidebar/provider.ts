import * as vscode from 'vscode';
import {
  getSidebarHtml,
  initialSidebarState,
  SidebarHostMessage,
  SidebarViewState,
  SidebarWebviewMessage,
  SidebarTimelineItem,
  SidebarSubagent,
  SidebarToolEvent,
} from './view';

export type SidebarMessageHandler = (message: SidebarWebviewMessage) => void | Promise<void>;

/** A tool (and its batch calls) still running when the turn ended: cancelled if you stopped it, otherwise done. */
function settleTool(tool: SidebarToolEvent, cancelled: boolean): SidebarToolEvent {
  const children = tool.children?.some(child => child.state === 'running')
    ? tool.children.map(child => (child.state === 'running' ? { ...child, state: 'complete' as const } : child))
    : tool.children;
  if (tool.state !== 'running' && children === tool.children) return tool;
  return {
    ...tool,
    state: tool.state === 'running' ? (cancelled ? 'cancelled' : 'complete') : tool.state,
    ...(children ? { children } : {}),
  };
}

/** Host side of the Unify sidebar. Runtime integration is supplied via onMessage. */
export class UnifySidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'unify.sidebar';
  private view?: vscode.WebviewView;
  private state: SidebarViewState = initialSidebarState();
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage?: SidebarMessageHandler,
    private readonly saveTimeline?: (sessionId: string, timeline: SidebarTimelineItem[], subagents: Record<string, SidebarSubagent>) => void,
    /** Folder that agent-sent media is copied into, so the webview may load it. */
    private readonly mediaRoot?: vscode.Uri,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: this.mediaRoot ? [this.extensionUri, this.mediaRoot] : [this.extensionUri] };
    const asset = (name: string): string => webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString();
    if (this.mediaRoot) this.state.mediaBase = webviewView.webview.asWebviewUri(this.mediaRoot).toString().replace(/\/+$/, '');
    webviewView.webview.html = getSidebarHtml(webviewView.webview, this.state, {
      stylesheet: asset('sidebar.css'), script: asset('sidebar.js'), font: asset('MaterialSymbolsRounded.woff2'), markdown: asset('markdown-it.min.js'),
    });
    this.disposables.push(webviewView.webview.onDidReceiveMessage((message: SidebarWebviewMessage) => {
      if (!message || typeof message.type !== 'string') return;
      void this.onMessage?.(message);
    }));
    webviewView.onDidDispose(() => { this.view = undefined; });
  }

  /** Push a runtime event into the sidebar. Safe before the view has been opened. */
  public postMessage(message: SidebarHostMessage): Thenable<boolean> | undefined {
    this.reduce(message);
    const sessionId = 'sessionId' in message ? message.sessionId : undefined;
    // Only a chat whose timeline this view holds is saved: messages such as jobState or runState arrive for a chat
    // before its saved history is replayed after a reload, and saving then would overwrite that history with nothing.
    if (sessionId && this.state.timeline[sessionId]) this.saveTimeline?.(sessionId, this.state.timeline[sessionId], this.state.subagents[sessionId] || {});
    // Every chat-specific message names its chat, so a pane showing another chat can ignore it.
    const outgoing = sessionId && !message.chatId ? { ...message, chatId: sessionId } : message;
    return this.view?.webview.postMessage(outgoing);
  }

  public dispose(): void { this.disposables.splice(0).forEach(d => d.dispose()); }

  public hasTimeline(sessionId: string): boolean { return (this.state.timeline[sessionId]?.length || 0) > 0; }

  public timeline(sessionId: string): SidebarTimelineItem[] { return this.state.timeline[sessionId] || []; }
  public subagents(sessionId: string): Record<string, SidebarSubagent> { return this.state.subagents[sessionId] || {}; }

  /**
   * Re-sends what the UI knows about one chat (timeline, run state, queue, job) without selecting it, so a window
   * that opened late (a pop-out) can show the chat. Returns false when nothing is held for it yet.
   */
  public resendChat(sessionId: string): boolean {
    if (!this.hasTimeline(sessionId)) return false;
    void this.postMessage({ type: 'timelineState', sessionId, timeline: this.timeline(sessionId), subagents: this.subagents(sessionId) });
    const run = this.state.runStates[sessionId];
    if (run) void this.postMessage({ type: 'runState', sessionId, state: run.state, label: run.label });
    const queue = this.state.queues[sessionId];
    if (queue) void this.postMessage({ type: 'queueState', sessionId, items: queue });
    const job = this.state.jobs[sessionId];
    if (job) void this.postMessage({ type: 'jobState', sessionId, job });
    return true;
  }

  public setPage(page: SidebarViewState['page']): void { this.state.page = page; }

  /** Unify power status, read from the engine's shutdown controller on reload and on every change. */
  public setShutdown(status: { armed: boolean; phase: string; secondsLeft?: number }): void {
    this.state.shutdown = { ...status };
  }

  /** Unify GitHub sign-in, so a view resolved later boots with the current account. */
  public setGithub(github: { signedIn: boolean; login?: string; source?: 'gh' | 'token'; error?: string }): void {
    this.state.github = { ...github };
  }

  private reduce(message: SidebarHostMessage): void {
    switch (message.type) {
      case 'timelineState':
        this.state.timeline[message.sessionId] = message.timeline;
        this.state.subagents[message.sessionId] = message.subagents;
        this.state.messages[message.sessionId] = message.timeline.flatMap(item => item.kind === 'message' ? [{ role: item.role, text: item.text }] : []);
        if (message.sessionId === this.state.activeSessionId) this.state.tools = [];
        break;
      case 'sessionState': Object.assign(this.state, { sessions: message.sessions, activeSessionId: message.activeSessionId }); break;
      case 'sessionDeleted':
        for (const table of [this.state.timeline, this.state.messages, this.state.subagents, this.state.runStates, this.state.queues, this.state.jobs] as Record<string, unknown>[]) delete table[message.sessionId];
        break;
      case 'queueState': this.state.queues[message.sessionId] = message.items; break;
      case 'modelState': Object.assign(this.state, { models: message.models, cursorBackends: message.cursorBackends, selectedModelId: message.selectedModelId, selectedSpeed: message.selectedSpeed, selectedEffort: message.selectedEffort }); break;
      case 'accountState': Object.assign(this.state, { providerLabel: message.provider, accountLabel: message.label, accountConnected: message.connected }); break;
      case 'accountsState': Object.assign(this.state, { accounts: message.accounts, cursor: message.cursor }); break;
      case 'usageState': this.state.usage = message.usage; break;
      case 'subagentProfilesState': this.state.subagentProfiles = message.profiles; break;
      case 'instructionsState': this.state.instructions = message.items; break;
      case 'customizeState': this.state.features = message.features; this.state.nameModel = message.nameModel; this.state.reviewModel = message.reviewModel; this.state.summaryModel = message.summaryModel;
        this.state.deciderModel = message.deciderModel; this.state.explorerModel = message.explorerModel; this.state.smartAutoRanks = message.smartAutoRanks; this.state.accessibility = message.accessibility;
        this.state.autoCompactTokens = message.autoCompactTokens; this.state.voiceCommands = message.voiceCommands; this.state.voiceAvailable = message.voiceAvailable;
        this.state.processPriority = message.processPriority;
        if (message.unifyFeatures) this.state.unifyFeatures = { ...message.unifyFeatures };
        break;
      case 'unifyFeaturesState': this.state.unifyFeatures = { ...message.features }; break;
      case 'jobState': if (message.job) this.state.jobs[message.sessionId] = message.job; else delete this.state.jobs[message.sessionId]; break;
      case 'syncState': this.state.sync = message.sync; break;
      case 'shutdownArmed': this.state.shutdown = { armed: message.armed, phase: message.armed ? 'waiting' : 'disarmed' }; break;
      case 'shutdownCountdown': this.state.shutdown = { armed: true, phase: 'countdown', secondsLeft: message.secondsLeft }; break;
      case 'shutdownCancelled': this.state.shutdown = { armed: false, phase: 'disarmed' }; break;
      case 'shutdownWaiting': this.state.shutdown = { armed: true, phase: 'waiting' }; break;
      case 'shutdownFailed': this.state.shutdown = { armed: false, phase: 'disarmed' }; break;
      case 'approvalState': this.state.approvalMode = message.mode; break;
      case 'showPage': this.state.page = message.page; break;
      case 'userMessage': {
        (this.state.messages[message.sessionId] ||= []).push({ role: 'user', text: message.text });
        (this.state.timeline[message.sessionId] ||= []).push({ id: message.entryId || `user:${Date.now()}:${Math.random()}`, kind: 'message', role: 'user', text: message.text });
        break;
      }
      case 'assistantDelta': {
        const items = this.state.messages[message.sessionId] ||= [];
        const last = items[items.length - 1];
        if (last?.role === 'assistant') last.text += message.text;
        else items.push({ role: 'assistant', text: message.text });
        const timeline = this.state.timeline[message.sessionId] ||= [];
        const id = message.entryId || `assistant:${timeline.length}`;
        const entry = timeline.find(item => item.id === id);
        if (entry?.kind === 'message') entry.text += message.text;
        else timeline.push({ id, kind: 'message', role: 'assistant', text: message.text });
        break;
      }
      case 'mediaMessage': {
        const timeline = this.state.timeline[message.sessionId] ||= [];
        const entry = { id: message.entryId, kind: 'media' as const, caption: message.caption, items: message.items,
          ...(message.generated ? { generated: true } : {}), ...(message.status ? { status: message.status } : {}) };
        const index = timeline.findIndex(item => item.id === message.entryId);
        if (index < 0) timeline.push(entry); else timeline[index] = entry;
        break;
      }
      case 'noteMessage': {
        const timeline = this.state.timeline[message.sessionId] ||= [];
        if (!timeline.some(item => item.id === message.entryId)) timeline.push({ id: message.entryId, kind: 'note', icon: message.icon, text: message.text });
        break;
      }
      case 'assistantMessage': {
        (this.state.messages[message.sessionId] ||= []).push({ role: 'assistant', text: message.text });
        (this.state.timeline[message.sessionId] ||= []).push({ id: `assistant:${Date.now()}:${Math.random()}`, kind: 'message', role: 'assistant', text: message.text });
        break;
      }
      case 'runState': {
        const previous = this.state.runStates[message.sessionId]?.state || 'idle';
        // A finished turn has no running tools: calls it never reported back (interrupted, restarted, CLI exit) settle here.
        if (previous !== 'idle' && message.state === 'idle') {
          const cancelled = previous === 'cancelling';
          if (message.sessionId === this.state.activeSessionId) this.state.tools = this.state.tools.map(tool => settleTool(tool, cancelled));
          for (const entry of this.state.timeline[message.sessionId] || []) if (entry.kind === 'tool') entry.event = settleTool(entry.event, cancelled);
          if (cancelled) for (const agent of Object.values(this.state.subagents[message.sessionId] || {})) if (agent.state === 'running' && !agent.delegated) agent.state = 'cancelled';
        }
        this.state.runStates[message.sessionId] = { state: message.state, label: message.label };
        if (message.state === 'thinking') this.state.error = undefined;
        break;
      }
      case 'toolEvent': {
        const previous = this.state.tools.find(t => t.id === message.event.id);
        const event = { ...previous, ...message.event };
        if (event.title === 'Tool' && previous?.title) event.title = previous.title;
        if (!event.detail && previous?.detail) event.detail = previous.detail;
        this.state.tools = this.state.tools.filter(t => t.id !== event.id).concat(event);
        const sessionId = message.sessionId || this.state.activeSessionId;
        if (sessionId && event.kind !== 'subagent') {
          const timeline = this.state.timeline[sessionId] ||= [];
          const id = message.entryId || `tool:${event.id}`;
          const entry = timeline.find(item => item.id === id);
          if (entry?.kind === 'tool') entry.event = event;
          else timeline.push({ id, kind: 'tool', event });
        }
        break;
      }
      case 'subagentEvent': {
        const agents = this.state.subagents[message.sessionId] ||= {};
        const agent = agents[message.agentId] ||= { id: message.agentId, title: message.title || 'Subagent', state: 'running', messages: [] };
        if (message.title) agent.title = message.title;
        if (message.model) agent.model = message.model;
        if (message.prompt) agent.prompt = message.prompt;
        if (message.files) agent.files = message.files;
        if (message.state) agent.state = message.state;
        if (message.delegated) agent.delegated = true;
        if (message.profile) agent.profile = message.profile;
        if (message.effort) agent.effort = message.effort;
        if (message.speed) agent.speed = message.speed;
        if (message.sentToParent) agent.sentToParent = message.sentToParent;
        if (message.text || message.media?.length || message.tool?.edit || message.tool?.state) {
          const id = message.messageId || `message:${agent.messages.length}`;
          const text = message.text || '';
          const entry = agent.messages.find(item => item.id === id);
          if (entry) {
            entry.text += text;
            // Live edit preview: later events for the same call carry the grown diff and the final state.
            if (message.tool) {
              const defined = Object.fromEntries(Object.entries(message.tool).filter(([, value]) => value !== undefined));
              entry.tool = { ...entry.tool, ...defined } as typeof message.tool;
            }
            if (message.media?.length) {
              // Repeated tool_call_update events can report the same image again; the file URL is the hash.
              const known = new Set((entry.media || []).map(item => item.file));
              const fresh = message.media.filter(item => !known.has(item.file));
              if (fresh.length) entry.media = [...(entry.media || []), ...fresh];
            }
          } else {
            agent.messages.push({
              id, role: message.role || 'assistant', text,
              ...(message.from ? { from: message.from } : {}),
              ...(message.tool ? { tool: message.tool } : {}),
              ...(message.media?.length ? { media: message.media } : {}),
            });
          }
        }
        const timeline = this.state.timeline[message.sessionId] ||= [];
        if (!timeline.some(item => item.kind === 'subagent' && item.agentId === message.agentId)) timeline.push({ id: `subagent:${message.agentId}`, kind: 'subagent', agentId: message.agentId });
        break;
      }
      case 'approvalRequest':
        (this.state.timeline[message.sessionId] ||= []).push({
          id: `approval:${message.id}`,
          kind: 'approval',
          title: message.title,
          detail: message.detail,
          status: 'pending',
          ...(message.canAlwaysAllow ? { canAlwaysAllow: true } : {}),
        });
        break;
      case 'approvalResolved': {
        const entry = (this.state.timeline[message.sessionId] || []).find(item => item.id === `approval:${message.id}`);
        if (entry?.kind === 'approval') entry.status = message.allowed ? 'allowed' : 'rejected';
        break;
      }
      case 'questionRequest':
        (this.state.timeline[message.sessionId] ||= []).push({ id: `question:${message.id}`, kind: 'question', questions: message.questions, status: 'pending' });
        break;
      case 'questionResolved': {
        const entry = (this.state.timeline[message.sessionId] || []).find(item => item.id === `question:${message.id}`);
        if (entry?.kind === 'question') { entry.status = message.answers ? 'answered' : 'skipped'; entry.answers = message.answers || undefined; }
        break;
      }
      case 'toolpacksState': this.state.toolpacks = message.packs; this.state.toolpackError = message.error; break;
      case 'toolState': this.state.tools = message.tools; break;
      case 'diff': this.state.diffs = this.state.diffs.filter(d => d.id !== message.diff.id).concat(message.diff); break;
      case 'diffState': this.state.diffs = message.diffs; break;
      case 'chatDiffState': (this.state.chatDiffs ||= {})[message.sessionId] = message.diffs; break;
      case 'error': this.state.error = message.message; break;
      case 'dependencyState': this.state.dependencies = message.providers; break;
    }
  }

}

/** Descriptive alias for hosts that prefer the VS Code API terminology. */
export { UnifySidebarProvider as WebviewViewProvider };

export { getSidebarHtml, initialSidebarState } from './view';
export type { SidebarHostMessage, SidebarWebviewMessage, SidebarViewState } from './view';
