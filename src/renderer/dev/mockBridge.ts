/**
 * DEV ONLY. A fake `window.unify` so the renderer runs in a plain browser (vite dev, tools/shot.mjs).
 * main.tsx loads it only when no host bridge exists, so it never ships in the Electron window's code path.
 *
 * Fixtures live in tools/fixtures/*.json and are picked with `?fixture=<name>` (default `home`):
 *
 *   {
 *     "extends": "base",            optional: start from another fixture's messages and persisted state
 *     "persisted": { ... },         renderer-local state (route, layout, panelOpen...) as persist.ts stores it
 *     "messages": [ ... ]           SidebarHostMessages sent after the renderer posts `ready`
 *     "timed": [                    optional: messages played later, `after` ms from `ready` (a run that moves on)
 *       { "after": 1200, "message": { ... } }
 *     ]
 *   }
 *
 * `?timed=0` skips the timed messages (the first frame), `?timed=end` sends them all straight away (the end
 * state), so screenshots of either are repeatable.
 *
 * Time fields (`updatedAt`, `resetsAt`, `fetchedAt`) may be negative or small: -42 means "42 minutes ago",
 * 300 means "300 minutes from now". Real epoch values pass through unchanged.
 *
 * The mock answers a few messages so the UI can be clicked through: newSession (with an optional project),
 * selectSession, sendPrompt (echo + a short streamed reply), cancel, approvalResponse (including "always
 * allow"), cancelProgress (logged; the fixture's timeline moves the task on), and setUnifyFeature
 * (persisted into the mock state and echoed as unifyFeaturesState). Host events
 * the fixtures do not drive (agentMessage, agentRoster, approvalRequest, ...) can be pushed from the console
 * through `__unifyMock.emit({...})`. Everything else is logged.
 */
import { setBridge, type UnifyBridge } from '../bridge';
import type { SidebarBackgroundProcess, SidebarHostMessage, SidebarSession, SidebarWebviewMessage } from '../protocol';

interface Fixture {
  extends?: string;
  persisted?: Record<string, unknown>;
  messages?: SidebarHostMessage[];
  timed?: TimedMessage[];
}

interface TimedMessage {
  /** Milliseconds after the renderer posts `ready`. */
  after: number;
  message: SidebarHostMessage;
}

// Fixtures are dev-server only; production builds carry none.
const fixtureFiles: Record<string, () => Promise<Fixture>> = import.meta.env.DEV
  ? import.meta.glob<Fixture>('../tools/fixtures/*.json', { import: 'default' })
  : {};

async function loadFixture(name: string): Promise<Fixture> {
  const loader = fixtureFiles[`../tools/fixtures/${name}.json`];
  if (!loader) {
    console.warn(`[mock] no fixture "${name}"; available: ${Object.keys(fixtureFiles).join(', ')}`);
    return {};
  }
  const fixture = await loader();
  if (!fixture.extends) return fixture;
  const parent = await loadFixture(fixture.extends);
  const childMessages = fixture.messages || [];
  // A child's session list replaces the parent's: otherwise the parent's list lands first and the
  // renderer prunes the child's persisted panes (their chats are not in it yet).
  const childHasSessions = childMessages.some(message => message.type === 'sessionState');
  const parentMessages = (parent.messages || []).filter(message => !childHasSessions || message.type !== 'sessionState');
  return {
    persisted: { ...parent.persisted, ...fixture.persisted },
    messages: [...parentMessages, ...childMessages],
    timed: [...(parent.timed || []), ...(fixture.timed || [])],
  };
}

const timeKeys = new Set(['updatedAt', 'resetsAt', 'fetchedAt']);
const epochThreshold = 1e11;

type UnifyFeatureValue = boolean | number | string;

/**
 * The engine-side feature defaults (`src/engine/unify/settings.ts`), seeded into the mock state so screens
 * have values before the engine ever sends a `unifyFeaturesState`.
 */
const featureDefaults: Record<string, UnifyFeatureValue> = {
  'agents.messaging': true,
  'agents.messaging.scope': 'everyone',
  'agents.blockNativeAgents': true,
  'agents.maxParallel': 4,
  'agents.explorerRanges': true,
  'agents.stuckCommandMinutes': 5,
  'agents.messaging.showInChat': true,
  'chats.toolImages': true,
  'chats.subagentImageStrip': true,
  'knowledge.agentWrites': true,
  'knowledge.audiences': true,
  'notifications.desktop': true,
  'power.shutdownWhenIdle': false,
  'power.rememberArmed': false,
};

/** The incoming state object, or an empty one when a fixture persisted something that is not an object. */
function stateRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Feature values already in a persisted state, if any. */
function stateFeatures(value: unknown): Record<string, UnifyFeatureValue> | undefined {
  const features = stateRecord(value).unifyFeatures;
  return features && typeof features === 'object' ? features as Record<string, UnifyFeatureValue> : undefined;
}

/** Turns relative minutes into epoch milliseconds, recursively. */
function resolveTimes<T>(value: T, now: number): T {
  if (Array.isArray(value)) return value.map(item => resolveTimes(item, now)) as T;
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (timeKeys.has(key) && typeof item === 'number' && Math.abs(item) < epochThreshold) {
      result[key] = now + item * 60000;
    } else {
      result[key] = resolveTimes(item, now);
    }
  }
  return result as T;
}

export async function installMockBridge(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const fixtureName = params.get('fixture') || 'home';
  const fixture = resolveTimes(await loadFixture(fixtureName), Date.now());
  const storageKey = `unify-mock-state:${fixtureName}`;
  // A named fixture always starts from its own persisted state, so screenshots are repeatable.
  const keepState = !params.has('fixture');
  const storedState = keepState ? sessionStorage.getItem(storageKey) : null;
  let state: unknown = storedState ? JSON.parse(storedState) : fixture.persisted ?? {};
  // `?theme=<id>` overrides the persisted theme (tools/shot.mjs --theme).
  const themeOverride = params.get('theme');
  if (themeOverride) state = { ...(state as Record<string, unknown>), theme: themeOverride };
  // Engine feature values live in the same persisted state; the mock seeds the engine defaults and then
  // answers setUnifyFeature itself, so toggles work with no engine attached.
  let features: Record<string, UnifyFeatureValue> = { ...featureDefaults, ...(stateFeatures(state) || {}) };
  /** Writes the current feature values back into the mock state (and sessionStorage), so reloads keep them. */
  const rememberState = (next: unknown): void => {
    state = { ...stateRecord(next), unifyFeatures: features };
    if (keepState) sessionStorage.setItem(storageKey, JSON.stringify(state));
  };
  rememberState(state);

  const listeners = new Set<(message: SidebarHostMessage) => void>();
  const emit = (message: SidebarHostMessage) => {
    for (const listener of listeners) listener(message);
  };
  // Lets dev tools (motion-audit scenarios, the console) push host messages: __unifyMock.emit({...}).
  (window as unknown as { __unifyMock: unknown }).__unifyMock = { emit };
  const sessions: SidebarSession[] = [];
  let activeSessionId: string | undefined;

  const sendSessions = () => emit({ type: 'sessionState', sessions: [...sessions], activeSessionId });

  // ?fixture=chat-progress: running tools with progress bars and the chat's background processes. Times are
  // absolute, taken from now, so the elapsed labels and bar positions are the same on every load.
  const progressSessionId = 's-progress';
  let progressProcesses: SidebarBackgroundProcess[] = [];
  const emitProgressDemo = () => {
    const now = Date.now();
    emit({
      type: 'timelineState',
      sessionId: progressSessionId,
      subagents: {},
      timeline: [
        { id: 'pu1', kind: 'message', role: 'user', text: 'Start the dev server, write the tests, then lint.' },
        { id: 'pt1', kind: 'tool', event: { id: 'pt1', kind: 'shell', title: 'Shell', detail: 'npm run build', state: 'running', progress: { startedAt: now - 5000, fraction: 0.42, label: '42%' } } },
        { id: 'pt2', kind: 'tool', event: { id: 'pt2', kind: 'shell', title: 'Shell', detail: 'npm test', state: 'running', progress: { startedAt: now - 8000, expectedMs: 20000 } } },
        { id: 'pa1', kind: 'message', role: 'assistant', text: 'Tests pass. Installing the new lint plugin.' },
        { id: 'pt3', kind: 'tool', event: { id: 'pt3', kind: 'shell', title: 'Shell', detail: 'npm install eslint-plugin-solid', state: 'running', progress: { startedAt: now - 3000 } } },
      ],
    });
    progressProcesses = [
      { id: 'bg1', kind: 'shell', title: 'npm run dev', startedAt: now - 192000, state: 'running', stoppable: true },
      { id: 'bg2', kind: 'subagent', title: 'Sol: write tests', startedAt: now - 60000, state: 'running' },
      { id: 'bg3', kind: 'shell', title: 'npm run lint', startedAt: now - 120000, endedAt: now - 30000, state: 'done' },
    ];
    emit({ type: 'backgroundProcesses', sessionId: progressSessionId, processes: progressProcesses });
  };

  for (const message of fixture.messages || []) {
    if (message.type === 'sessionState') {
      sessions.splice(0, sessions.length, ...message.sessions);
      activeSessionId = message.activeSessionId;
    }
  }

  const streamReply = (sessionId: string, text: string) => {
    const entryId = `assistant:${Date.now()}`;
    emit({ type: 'runState', sessionId, state: 'thinking', label: 'Thinking' });
    const words = text.split(' ');
    words.forEach((word, index) => {
      window.setTimeout(() => {
        emit({ type: 'assistantDelta', sessionId, entryId, text: (index ? ' ' : '') + word });
        if (index === words.length - 1) emit({ type: 'runState', sessionId, state: 'idle' });
      }, 400 + index * 60);
    });
  };

  const handle = (message: SidebarWebviewMessage) => {
    const sessionId = message.chatId || activeSessionId;
    switch (message.type) {
      case 'ready': {
        for (const item of fixture.messages || []) emit(item);
        if (fixtureName === 'chat-progress') emitProgressDemo();
        const timedMode = params.get('timed');
        const timed = [...(fixture.timed || [])].sort((first, second) => first.after - second.after);
        if (timedMode === '0') break;
        if (timedMode === 'end') {
          for (const entry of timed) emit(entry.message);
          break;
        }
        for (const entry of timed) window.setTimeout(() => emit(entry.message), entry.after);
        break;
      }
      case 'newSession': {
        const id = `mock-${Date.now()}`;
        sessions.unshift({ id, name: 'New chat', updatedAt: Date.now(), ...(message.project ? { project: message.project } : {}) });
        activeSessionId = id;
        sendSessions();
        emit({ type: 'timelineState', sessionId: id, timeline: [], subagents: {} });
        break;
      }
      case 'loadChat': {
        // ?loadDelay=ms holds the reply to preview a pane's "Loading history" state.
        const delay = Number(params.get('loadDelay')) || 0;
        const chatId = message.sessionId;
        window.setTimeout(() => emit({ type: 'chatLoaded', sessionId: chatId }), delay);
        break;
      }
      case 'selectSession':
        activeSessionId = message.sessionId;
        sendSessions();
        break;
      case 'sendPrompt':
        if (!sessionId) break;
        emit({ type: 'userMessage', sessionId, text: message.prompt, entryId: `user:${Date.now()}` });
        streamReply(sessionId, 'This is the dev mock. The engine is not connected, so nothing ran.');
        break;
      case 'setUnifyFeature':
        if (typeof message.id === 'string' && message.id && ['boolean', 'number', 'string'].includes(typeof message.value)) {
          features = { ...features, [message.id]: message.value };
          rememberState(state);
          emit({ type: 'unifyFeaturesState', features: { ...features } });
        }
        break;
      case 'approvalResponse':
        if (sessionId) emit({ type: 'approvalResolved', sessionId, id: message.id, allowed: message.allow === true });
        console.info(`[mock] approval ${message.id}: ${message.allow ? 'allowed' : 'rejected'}${message.always ? ' (always allow)' : ''}`);
        break;
      case 'cancelProgress':
        console.info(`[mock] cancel progress ${message.id}`);
        break;
      case 'listProviderModels': {
        // Answers with the fixture's Cursor list (the engine runs `cursor-agent models`); other accounts list nothing.
        const listed = (fixture.messages || []).find(item => item.type === 'modelState' && item.cursorBackends);
        const backends = listed && listed.type === 'modelState' ? listed.cursorBackends || [] : [];
        window.setTimeout(() => emit({ type: 'providerModels', accountId: message.accountId, models: backends.map(item => item.value) }), 300);
        break;
      }
      case 'stopBackgroundProcess':
        if (message.sessionId === progressSessionId) {
          // The engine ends the process and reports it; the mock keeps the ended entry in the list.
          progressProcesses = progressProcesses.map(process => process.id === message.id
            ? { ...process, state: 'stopped' as const, endedAt: Date.now(), stoppable: false }
            : process);
          emit({ type: 'backgroundProcesses', sessionId: progressSessionId, processes: progressProcesses });
        }
        break;
      case 'cancel':
        if (sessionId) {
          emit({ type: 'runState', sessionId, state: 'cancelling' });
          window.setTimeout(() => emit({ type: 'runState', sessionId, state: 'idle' }), 300);
        }
        break;
      default:
        console.info('[mock] post', message);
    }
  };

  const bridge: UnifyBridge = {
    post: message => queueMicrotask(() => handle(message)),
    onMessage: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: <T>() => state as T,
    setState: value => {
      // The renderer persists the whole view state (including unifyFeatures); keep the mock's copy in step
      // with values it has not seen yet, then write the authoritative feature record back.
      const incoming = stateFeatures(value);
      if (incoming) features = { ...features, ...incoming };
      rememberState(value);
    },
    platform: 'win32',
    // Rail footer: `?appdev=0` previews an installed build (no DEV badge).
    appInfo: { version: '1.1.0', dev: new URLSearchParams(window.location.search).get('appdev') !== '0' },
    window: {
      minimize: () => console.info('[mock] minimize'),
      maximize: () => console.info('[mock] maximize'),
      close: () => console.info('[mock] close'),
      isMaximized: async () => false,
    },
    // Opens the pop-out UI in a browser window with the same fixture, so it can be clicked through.
    popOut: chatId => {
      window.open(`?popout=${encodeURIComponent(chatId)}&fixture=${encodeURIComponent(fixtureName)}`, '_blank', 'width=560,height=760');
    },
    pickFolder: async () => window.prompt('Folder path (dev mock)') || undefined,
    openExternal: url => window.open(url, '_blank'),
  };
  setBridge(bridge);

  // `?update=<state>`: the app updater in that state (there is no updater bridge here); see updatePreview.ts.
  const updatePreview = params.get('update');
  if (updatePreview) {
    const { applyUpdatePreview } = await import('./updatePreview');
    applyUpdatePreview(updatePreview);
  }
}
