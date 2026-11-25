/**
 * The renderer's single source of engine state.
 *
 * `viewState` mirrors SidebarViewState and is updated only by `applyHostMessage`, a port of the message
 * listener in DSH media/sidebar.js (lines ~2536-2707). Behaviour is kept exactly: how deltas merge, how
 * cancelling marks running tools, when a finished chat becomes unread, how approvals/questions resolve.
 * UI-only state (open menus, drafts) lives in components; state that must outlive a reload lives in persist.ts.
 */
import { batch, createSignal } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import { bridge, post } from '../bridge';
import { readPersisted, writePersisted } from '../persist';
import type {
  AgentInfo,
  SidebarBackgroundProcess,
  SidebarHostMessage,
  SidebarImage,
  SidebarScheduledPrompt,
  SidebarTimelineItem,
  SidebarToolEvent,
  SidebarViewState,
} from '../protocol';
import { defaultViewState, readBootState } from './defaults';

const [viewState, setViewState] = createStore<SidebarViewState>({ ...defaultViewState(), ...readBootStateSafe() });

function readBootStateSafe(): Partial<SidebarViewState> {
  try {
    return readBootState() ?? {};
  } catch {
    return {};
  }
}

export { viewState };

/** Chats whose turn finished while nobody was looking: id -> finish time. Drives "done" in the Active group. */
const [unread, setUnread] = createSignal<Record<string, number>>(readPersisted('unread', {}));
export { unread };

function saveUnread(next: Record<string, number>): void {
  setUnread(next);
  writePersisted('unread', next);
}

export function markRead(sessionId: string): void {
  const current = unread();
  if (!(sessionId in current)) return;
  const next = { ...current };
  delete next[sessionId];
  saveUnread(next);
}

/** Images the user attached, keyed by the user timeline entry they belong to (the protocol only echoes text). */
const [userImages, setUserImages] = createSignal<Record<string, SidebarImage[]>>({});
export { userImages };
const pendingImages = new Map<string, SidebarImage[]>();

/** Remembers images just sent so the matching userMessage echo can show them in the bubble. */
export function rememberSentImages(sessionId: string, images: SidebarImage[]): void {
  if (images.length) pendingImages.set(sessionId, images);
}

/** Set by the shell: whether a chat is on screen right now (any pane, chats route, window visible). */
let chatIsSeen: (sessionId: string) => boolean = sessionId => sessionId === viewState.activeSessionId;
export function setChatVisibilityCheck(check: (sessionId: string) => boolean): void {
  chatIsSeen = check;
}

/** Every running agent (all chats), for agent labels and roster badges. Explorer runs are filtered out by the UI. */
const [agentRoster, setAgentRoster] = createSignal<AgentInfo[]>([]);
export { agentRoster };

/** The roster name of an agent, or undefined when it is not running (or not known yet). */
export function agentName(agentId: string): string | undefined {
  return agentRoster().find(agent => agent.id === agentId)?.name;
}

/** Last error the engine reported, shown as a notice. */
export const [engineError, setEngineError] = createSignal<string | undefined>();

/** One long-running task outside a chat (agent runtime update, toolpack setup), from `progressNotice`. */
export interface ProgressTask {
  id: string;
  title: string;
  message?: string;
  /** 0-100 when the task knows it. */
  percent?: number;
  state: 'running' | 'done' | 'error';
  /** The task honours cancellation: show Cancel, which posts `cancelProgress`. */
  cancellable?: boolean;
  /** Epoch ms of the last update. */
  updatedAt: number;
}

/** Pending `/schedule` prompts, soonest first (engine `scheduledPromptsState`). */
export const [scheduledPrompts, setScheduledPrompts] = createSignal<SidebarScheduledPrompt[]>([]);

/** Every progress task still on screen, oldest first. The notice row shows the newest one; dismiss removes it. */
export const [progressTasks, setProgressTasks] = createSignal<ProgressTask[]>([]);

export function dismissProgressTask(id: string): void {
  setProgressTasks(current => current.filter(task => task.id !== id));
}

/**
 * Background processes per chat (engine `backgroundProcesses`), keyed by sessionId like `jobs`. Kept beside
 * viewState so the chat state shape stays as it is; a chat with none has no entry.
 */
const [backgroundStore, setBackgroundStore] = createStore<Record<string, SidebarBackgroundProcess[]>>({});

/** The chat's background processes in the engine's order (running ones and ended ones still lingering). */
export function backgroundProcesses(sessionId: string): SidebarBackgroundProcess[] {
  return backgroundStore[sessionId] ?? [];
}

/** Fields a subagentEvent may carry beyond the protocol's own (the profile's effort and speed chips). */
interface SubagentEventExtras {
  effort?: string;
  speed?: string;
}

/**
 * "Shut down when all tasks finish". Arming is the `power.shutdownWhenIdle` feature: the engine's shutdown
 * controller arms when it turns on and answers with shutdownArmed (engine/unify/power.ts). Until that answer
 * arrives the switch shows what was asked for, so it moves on the click instead of a round trip later.
 */
const [requestedArm, setRequestedArm] = createSignal<boolean>();

/** Whether the one-shot shutdown is armed right now (live engine state, or the request still in flight). */
export function shutdownArmed(): boolean {
  return requestedArm() ?? !!viewState.shutdown?.armed;
}

export function setShutdownArmed(armed: boolean): void {
  setRequestedArm(armed);
  post({ type: 'setUnifyFeature', id: 'power.shutdownWhenIdle', value: armed });
}

type Listener = (message: SidebarHostMessage) => void;
const extraListeners = new Set<Listener>();

/** Screens that need raw messages (forms waiting for "saved" acks, voice) subscribe here. */
export function onHostMessage(listener: Listener): () => void {
  extraListeners.add(listener);
  return () => extraListeners.delete(listener);
}

/**
 * Chat history on demand. The engine only pushes a timeline when a chat is selected, so a pane that shows a chat
 * at startup (persisted layout) or in a pop-out asks for it with `loadChat`; the engine answers with its history
 * and then `chatLoaded`. Requests made before `connectStore` wait for `ready`.
 */
const [loadingChats, setLoadingChats] = createSignal<ReadonlySet<string>>(new Set());
const requestedChats = new Set<string>();
const chatLoadTimers = new Map<string, number>();
let connected = false;
/** An engine that never answers must not leave a pane loading forever. */
const chatLoadTimeoutMs = 10000;

export const isChatLoading = (chatId: string): boolean => loadingChats().has(chatId);

function finishChatLoad(chatId: string): void {
  window.clearTimeout(chatLoadTimers.get(chatId));
  chatLoadTimers.delete(chatId);
  if (!loadingChats().has(chatId)) return;
  const next = new Set(loadingChats());
  next.delete(chatId);
  setLoadingChats(next);
}

function postChatLoad(chatId: string): void {
  post({ type: 'loadChat', sessionId: chatId });
  chatLoadTimers.set(chatId, window.setTimeout(() => finishChatLoad(chatId), chatLoadTimeoutMs));
}

/** Makes sure a chat on screen has its history. Asks once per chat per window; safe to call on every mount. */
export function requestChatHistory(chatId: string): void {
  if (!chatId || requestedChats.has(chatId)) return;
  requestedChats.add(chatId);
  setLoadingChats(new Set(loadingChats()).add(chatId));
  if (connected) postChatLoad(chatId);
}

function timelineOf(state: SidebarViewState, sessionId: string): SidebarTimelineItem[] {
  return (state.timeline[sessionId] ||= []);
}

export function applyHostMessage(message: SidebarHostMessage): void {
  batch(() => {
    // A shutdown message settles a pending arm request; so does a feature echo that disagrees with it (refused).
    if (message.type.startsWith('shutdown')) setRequestedArm(undefined);
    if (message.type === 'unifyFeaturesState' && message.features?.['power.shutdownWhenIdle'] !== requestedArm()) setRequestedArm(undefined);
    switch (message.type) {
      case 'sessionState':
        setViewState('sessions', reconcile(message.sessions || [], { key: 'id' }));
        setViewState('activeSessionId', message.activeSessionId);
        break;
      case 'modelState':
        setViewState(produce(state => {
          state.models = reconcile(message.models || [], { key: 'id' })(state.models);
          state.cursorBackends = message.cursorBackends || [];
          state.selectedModelId = message.selectedModelId;
          state.selectedSpeed = message.selectedSpeed;
          state.selectedEffort = message.selectedEffort;
        }));
        break;
      case 'chatLoaded':
        finishChatLoad(message.sessionId);
        break;
      case 'sessionDeleted':
        markRead(message.sessionId);
        finishChatLoad(message.sessionId);
        requestedChats.delete(message.sessionId);
        setViewState(produce(state => {
          for (const table of [state.timeline, state.messages, state.subagents, state.runStates, state.queues, state.jobs]) {
            delete (table as Record<string, unknown>)[message.sessionId];
          }
        }));
        setBackgroundStore(produce(table => {
          delete table[message.sessionId];
        }));
        break;
      case 'progressNotice': {
        const task: ProgressTask = {
          id: message.id,
          title: message.title,
          message: message.message,
          percent: message.percent,
          state: message.state,
          cancellable: message.cancellable,
          updatedAt: Date.now(),
        };
        setProgressTasks(current => {
          const others = current.filter(item => item.id !== task.id);
          return [...others, task];
        });
        break;
      }
      case 'slashCommandsState':
        setViewState('slashCommands', reconcile(message.commands || [], { key: 'name' }));
        break;
      case 'scheduledPromptsState':
        setScheduledPrompts(message.prompts || []);
        break;
      case 'jobState':
        setViewState(produce(state => {
          if (message.job) state.jobs[message.sessionId] = message.job;
          else delete state.jobs[message.sessionId];
        }));
        break;
      case 'backgroundProcesses':
        setBackgroundStore(produce(table => {
          const processes = message.processes || [];
          if (processes.length) table[message.sessionId] = processes;
          else delete table[message.sessionId];
        }));
        break;
      case 'queueState':
        setViewState('queues', message.sessionId, message.items || []);
        break;
      case 'accountState':
        setViewState(produce(state => {
          state.providerLabel = message.provider;
          state.accountLabel = message.label;
          state.accountConnected = message.connected;
        }));
        break;
      case 'accountsState':
        setViewState(produce(state => {
          state.accounts = reconcile(message.accounts || [], { key: 'id' })(state.accounts);
          state.cursor = message.cursor || state.cursor;
        }));
        break;
      case 'usageState':
        setViewState('usage', reconcile(message.usage || {}));
        break;
      case 'subagentProfilesState':
        setViewState('subagentProfiles', reconcile(message.profiles || [], { key: 'name' }));
        break;
      case 'toolpacksState':
        setViewState(produce(state => {
          state.toolpacks = reconcile(message.packs || [], { key: 'id' })(state.toolpacks);
          state.toolpackError = message.error;
        }));
        break;
      case 'instructionsState':
        setViewState('instructions', reconcile(message.items || [], { key: 'id' }));
        break;
      case 'customizeState':
        setViewState(produce(state => {
          if (message.features) state.features = reconcile(message.features)(state.features);
          state.nameModel = message.nameModel || {};
          state.reviewModel = message.reviewModel || {};
          state.summaryModel = message.summaryModel || {};
          state.deciderModel = message.deciderModel || {};
          state.explorerModel = message.explorerModel || {};
          state.smartAutoRanks = message.smartAutoRanks || [];
          state.accessibility = message.accessibility || state.accessibility;
          if (typeof message.autoCompactTokens === 'number') state.autoCompactTokens = message.autoCompactTokens;
          if (Array.isArray(message.voiceCommands)) state.voiceCommands = message.voiceCommands;
          if (typeof message.voiceAvailable === 'boolean') state.voiceAvailable = message.voiceAvailable;
          if (message.processPriority) state.processPriority = message.processPriority;
          // Unify feature values ride along on customize pushes; an omitted field leaves them unchanged.
          if (message.unifyFeatures) state.unifyFeatures = { ...state.unifyFeatures, ...message.unifyFeatures };
        }));
        break;
      case 'syncState':
        setViewState('sync', message.sync || viewState.sync);
        break;
      case 'accountSaved':
      case 'modelSaved':
      case 'subagentSaved':
      case 'instructionSaved':
        setEngineError(undefined);
        break;
      case 'userMessage':
        setViewState(produce(state => {
          (state.messages[message.sessionId] ||= []).push({ role: 'user', text: message.text });
          const id = message.entryId || `user:${Date.now()}`;
          timelineOf(state, message.sessionId).push({ id, kind: 'message', role: 'user', text: message.text });
          const images = pendingImages.get(message.sessionId);
          if (images) {
            pendingImages.delete(message.sessionId);
            setUserImages(current => ({ ...current, [id]: images }));
          }
        }));
        break;
      case 'assistantDelta':
        setViewState(produce(state => {
          const items = (state.messages[message.sessionId] ||= []);
          const last = items[items.length - 1];
          if (last && last.role === 'assistant') last.text += message.text;
          else items.push({ role: 'assistant', text: message.text });
          const timeline = timelineOf(state, message.sessionId);
          const id = message.entryId || `assistant:${timeline.length}`;
          const entry = timeline.find(item => item.id === id);
          if (entry && entry.kind === 'message') entry.text += message.text;
          else timeline.push({ id, kind: 'message', role: 'assistant', text: message.text });
        }));
        break;
      case 'assistantMessage':
        setViewState(produce(state => {
          (state.messages[message.sessionId] ||= []).push({ role: 'assistant', text: message.text });
          timelineOf(state, message.sessionId).push({ id: `assistant:${Date.now()}`, kind: 'message', role: 'assistant', text: message.text });
        }));
        break;
      case 'runState':
        applyRunState(message);
        break;
      case 'toolEvent':
        setViewState(produce(state => {
          const previous = state.tools.find(item => item.id === message.event.id);
          const event = { ...previous, ...message.event };
          if (event.title === 'Tool' && previous?.title) event.title = previous.title;
          if (!event.detail && previous?.detail) event.detail = previous.detail;
          state.tools = state.tools.filter(item => item.id !== event.id).concat(event);
          const sessionId = message.sessionId || state.activeSessionId;
          // Edit calls get their own row (live edit preview); the Timeline batches them like other tools when that feature is off.
          if (sessionId && event.kind !== 'subagent') {
            const timeline = timelineOf(state, sessionId);
            const id = message.entryId || `tool:${event.id}`;
            const entry = timeline.find(item => item.id === id);
            if (entry && entry.kind === 'tool') entry.event = event;
            else timeline.push({ id, kind: 'tool', event });
          }
        }));
        break;
      case 'subagentEvent':
        setViewState(produce(state => {
          const agents = (state.subagents[message.sessionId] ||= {});
          const agent = (agents[message.agentId] ||= { id: message.agentId, title: message.title || 'Subagent', state: 'running', messages: [] });
          if (message.title) agent.title = message.title;
          if (message.model) agent.model = message.model;
          if (message.prompt) agent.prompt = message.prompt;
          if (message.files) agent.files = message.files;
          if (message.state) agent.state = message.state;
          if (message.delegated) agent.delegated = true;
          if (message.profile) agent.profile = message.profile;
          if (message.ranges) agent.ranges = message.ranges;
          if (typeof message.tokens === 'number') agent.tokens = message.tokens;
          if (message.sentToParent) agent.sentToParent = message.sentToParent;
          const extras = message as SubagentEventExtras;
          if (extras.effort) agent.effort = extras.effort;
          if (extras.speed) agent.speed = extras.speed;
          if (message.text || message.media?.length || message.tool?.edit || message.tool?.state) {
            const id = message.messageId || `message:${agent.messages.length}`;
            const entry = agent.messages.find(item => item.id === id);
            if (entry) {
              entry.text += message.text || '';
              if (message.media?.length) entry.media = [...(entry.media || []), ...message.media];
              // Live edit preview: later events for the same call carry the grown diff and the final state.
              // Undefined fields (a media-only update has no detail) keep what the row already shows.
              if (message.tool) {
                const defined = Object.fromEntries(Object.entries(message.tool).filter(([, value]) => value !== undefined));
                entry.tool = { ...entry.tool, ...defined } as typeof message.tool;
              }
            } else {
              agent.messages.push({
                id,
                role: message.role || 'assistant',
                text: message.text || '',
                ...(message.from ? { from: message.from } : {}),
                ...(message.to ? { to: message.to } : {}),
                ...(message.tool ? { tool: message.tool } : {}),
                ...(message.media?.length ? { media: message.media } : {}),
              });
            }
          }
          const timeline = timelineOf(state, message.sessionId);
          if (!timeline.some(item => item.kind === 'subagent' && item.agentId === message.agentId)) {
            timeline.push({ id: `subagent:${message.agentId}`, kind: 'subagent', agentId: message.agentId });
          }
        }));
        break;
      case 'approvalRequest':
        setViewState(produce(state => {
          timelineOf(state, message.sessionId).push({
            id: `approval:${message.id}`,
            kind: 'approval',
            title: message.title,
            detail: message.detail,
            status: 'pending',
            ...(message.canAlwaysAllow ? { canAlwaysAllow: true } : {}),
          });
        }));
        break;
      case 'approvalResolved':
        setViewState(produce(state => {
          const entry = (state.timeline[message.sessionId] || []).find(item => item.id === `approval:${message.id}`);
          if (entry && entry.kind === 'approval') entry.status = message.allowed ? 'allowed' : 'rejected';
        }));
        break;
      case 'questionRequest':
        setViewState(produce(state => {
          timelineOf(state, message.sessionId).push({ id: `question:${message.id}`, kind: 'question', questions: message.questions || [], status: 'pending' });
        }));
        break;
      case 'questionResolved':
        setViewState(produce(state => {
          const entry = (state.timeline[message.sessionId] || []).find(item => item.id === `question:${message.id}`);
          if (entry && entry.kind === 'question') {
            entry.status = message.answers === null ? 'skipped' : 'answered';
            if (message.answers !== null) entry.answers = message.answers;
          }
        }));
        break;
      case 'mediaMessage':
        setViewState(produce(state => {
          const timeline = timelineOf(state, message.sessionId);
          const entry: SidebarTimelineItem = {
            id: message.entryId,
            kind: 'media',
            caption: message.caption,
            items: message.items || [],
            ...(message.generated ? { generated: true } : {}),
            ...(message.status ? { status: message.status } : {}),
          };
          const index = timeline.findIndex(item => item.id === message.entryId);
          if (index >= 0) timeline[index] = entry;
          else timeline.push(entry);
        }));
        break;
      case 'noteMessage':
        setViewState(produce(state => {
          const timeline = timelineOf(state, message.sessionId);
          if (!timeline.some(item => item.id === message.entryId)) {
            timeline.push({ id: message.entryId, kind: 'note', icon: message.icon, text: message.text });
          }
        }));
        break;
      case 'toolState':
        setViewState('tools', reconcile(message.tools || [], { key: 'id' }));
        break;
      case 'diff':
        setViewState('diffs', diffs => diffs.filter(item => item.id !== message.diff.id).concat(message.diff));
        break;
      case 'diffState':
        setViewState('diffs', reconcile(message.diffs || [], { key: 'id' }));
        break;
      case 'chatDiffState':
        // Reconcile keeps unchanged rows' proxies so their <For> rows don't remount on every push.
        if (!viewState.chatDiffs) setViewState('chatDiffs', { [message.sessionId]: message.diffs || [] });
        else setViewState('chatDiffs', message.sessionId, reconcile(message.diffs || [], { key: 'id' }));
        break;
      case 'timelineState':
      {
        // The engine does not save agent messages in a chat's history, so a replay or compaction would drop them.
        const timeline = message.timeline || [];
        const kept = (viewState.timeline[message.sessionId] || []).filter(
          item => item.kind === 'agentMessage' && !timeline.some(entry => entry.id === item.id),
        );
        // Reconcile by id: a resent timeline only touches entries that changed, so rows don't remount.
        setViewState('timeline', message.sessionId, reconcile([...timeline, ...kept], { key: 'id' }));
        setViewState('subagents', message.sessionId, reconcile(message.subagents || {}));
        setViewState('tools', []);
      }
        break;
      case 'approvalState':
        setViewState('approvalMode', message.mode);
        break;
      case 'unifyFeaturesState':
        setViewState('unifyFeatures', reconcile(message.features || {}));
        break;
      case 'agentMessage':
        setViewState(produce(state => {
          const timeline = timelineOf(state, message.chatId);
          const id = `agentMessage:${message.message.id}`;
          if (!timeline.some(item => item.id === id)) timeline.push({ id, kind: 'agentMessage', message: message.message });
        }));
        break;
      case 'agentRoster':
        setAgentRoster(message.agents || []);
        break;
      case 'shutdownArmed':
        setViewState('shutdown', { armed: message.armed, phase: message.armed ? 'armed' : 'idle' });
        break;
      case 'shutdownCountdown':
        setViewState('shutdown', { armed: true, phase: 'countdown', secondsLeft: message.secondsLeft });
        break;
      case 'shutdownWaiting':
        setViewState('shutdown', { armed: true, phase: 'armed' });
        break;
      case 'shutdownCancelled':
        setViewState('shutdown', { armed: false, phase: 'idle' });
        break;
      case 'shutdownFailed':
        setViewState('shutdown', { armed: false, phase: 'failed' });
        setEngineError(message.error);
        break;
      case 'githubState':
        setViewState('github', message.github);
        break;
      case 'error':
        setEngineError(message.message);
        break;
      default:
        break;
    }
  });
  for (const listener of extraListeners) listener(message);
}

function applyRunState(message: Extract<SidebarHostMessage, { type: 'runState' }>): void {
  const previous = viewState.runStates[message.sessionId]?.state || 'idle';
  setViewState(produce(state => {
    // A finished turn has no running tools: calls it never reported back (interrupted, restarted, CLI exit) settle here.
    if (previous !== 'idle' && message.state === 'idle') {
      const cancelled = previous === 'cancelling';
      if (message.sessionId === state.activeSessionId) {
        state.tools = state.tools.map(tool => settleTool(tool, cancelled));
      }
      for (const entry of state.timeline[message.sessionId] || []) {
        if (entry.kind === 'tool') entry.event = settleTool(entry.event, cancelled);
      }
      // Delegated subagents can outlive the turn; the host reports how they end.
      if (cancelled) {
        for (const agent of Object.values(state.subagents[message.sessionId] || {})) {
          if (agent.state === 'running' && !agent.delegated) agent.state = 'cancelled';
        }
      }
    }
    state.runStates[message.sessionId] = { state: message.state, label: message.label };
  }));
  // A turn that ends on its own while you are looking elsewhere stays unread; cancelling is your own doing.
  const unseen = !chatIsSeen(message.sessionId) || document.hidden;
  if (message.state === 'idle' && previous !== 'idle' && previous !== 'cancelling' && unseen) {
    saveUnread({ ...unread(), [message.sessionId]: Date.now() });
  }
  if (message.state === 'thinking') setEngineError(undefined);
}

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

export const isRunning = (sessionId: string): boolean => (viewState.runStates[sessionId]?.state || 'idle') !== 'idle';

/** Starts listening to the engine and tells it the UI is ready. Call once before mounting. */
export function connectStore(): () => void {
  const stop = bridge().onMessage(applyHostMessage);
  post({ type: 'ready' });
  connected = true;
  for (const chatId of loadingChats()) postChatLoad(chatId);
  return () => {
    connected = false;
    stop();
  };
}
