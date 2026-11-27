/**
 * Local inference ("Local model" provider) as the renderer sees it: the engine's LocalInferenceState, each
 * server's live log, and the last error. The engine owns everything; this store only mirrors its messages
 * (engine/local/types.ts LocalHostMessage) and sends LocalRequest messages with a requestId.
 *
 * `localRequest(...)` returns a promise for requests whose reply carries the requestId (localBrowseResult,
 * localServerCreated, localInferenceError). Requests the engine answers only with state can be fired and forgotten.
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { post } from '../../../bridge';
import type { SidebarWebviewMessage } from '../../../protocol';
import { onHostMessage } from '../../../store';
import type {
  LocalEngineInfo,
  LocalEngineKind,
  LocalFileFilter,
  LocalHostMessage,
  LocalInferenceState,
  LocalRequest,
  LocalServerStatus,
  LocalServerView,
  LocalValues,
} from '../../../../engine/local/types';

export const localProvider = 'local';

/** Lines kept per server log. */
const logLineCap = 3000;

const emptyState: LocalInferenceState = { engines: [], presets: [], servers: [], exclusive: true };

const [state, setState] = createStore<LocalInferenceState>(structuredClone(emptyState));
const [loaded, setLoaded] = createSignal(false);
const [logs, setLogs] = createSignal<Record<string, string[]>>({});
const [lastError, setLastError] = createSignal<{ id?: string; message: string; at: number }>();

export { state as localState, loaded as localLoaded, lastError as localLastError };

/** Replies a request can be waiting for. */
type LocalReply = Extract<LocalHostMessage, { type: 'localBrowseResult' | 'localServerCreated' | 'localInferenceError' }>;

const waiting = new Map<string, (reply: LocalReply) => void>();

let requestCount = 0;

function nextRequestId(): string {
  requestCount += 1;
  return `local-${Date.now().toString(36)}-${requestCount}`;
}

function applyStatus(status: LocalServerStatus): void {
  const index = state.servers.findIndex(server => server.config.id === status.id);
  if (index < 0) return;
  setState('servers', index, 'status', reconcile(status));
}

function appendLog(id: string, lines: string[], reset: boolean): void {
  setLogs(current => {
    const previous = reset ? [] : current[id] ?? [];
    const next = previous.length + lines.length > logLineCap
      ? [...previous, ...lines].slice(-logLineCap)
      : [...previous, ...lines];
    return { ...current, [id]: next };
  });
}

createRoot(() => {
  onHostMessage(raw => {
    const message = raw as unknown as LocalHostMessage;
    switch (message.type) {
      case 'localInferenceState':
        setState(reconcile(message.state, { key: 'id' }));
        setLoaded(true);
        break;
      case 'localServerStatus':
        applyStatus(message.status);
        break;
      case 'localServerLog':
        appendLog(message.id, message.lines, message.reset);
        break;
      case 'localInferenceError':
        setLastError({ id: message.id, message: message.message, at: Date.now() });
        resolveWaiting(message);
        break;
      case 'localBrowseResult':
      case 'localServerCreated':
        resolveWaiting(message);
        break;
    }
  });
});

function resolveWaiting(reply: LocalReply): void {
  if (!reply.requestId) return;
  const resolve = waiting.get(reply.requestId);
  if (!resolve) return;
  waiting.delete(reply.requestId);
  resolve(reply);
}

type RequestBody<T extends LocalRequest['type']> = Omit<Extract<LocalRequest, { type: T }>, 'type' | 'requestId'>;

/** Sends a request and returns its requestId. */
export function sendLocal<T extends LocalRequest['type']>(type: T, body: RequestBody<T>): string {
  const requestId = nextRequestId();
  post({ type, requestId, ...body } as unknown as SidebarWebviewMessage);
  return requestId;
}

/** Sends a request and waits for its localBrowseResult / localServerCreated / localInferenceError. */
export function localRequest<T extends LocalRequest['type']>(type: T, body: RequestBody<T>): Promise<LocalReply> {
  return new Promise(resolve => {
    const requestId = nextRequestId();
    waiting.set(requestId, resolve);
    post({ type, requestId, ...body } as unknown as SidebarWebviewMessage);
  });
}

/* ---------- helpers the screens use ---------- */

/** Asks the engine for the whole state (the Providers screen calls this on mount). */
export function loadLocalInference(): void {
  sendLocal('localInferenceGet', {});
}

export function localEngine(kind: LocalEngineKind | undefined): LocalEngineInfo | undefined {
  return kind ? state.engines.find(engine => engine.kind === kind) : undefined;
}

export function localServerByAccount(accountId: string | undefined): LocalServerView | undefined {
  return accountId ? state.servers.find(server => server.accountId === accountId) : undefined;
}

export function localServer(id: string | undefined): LocalServerView | undefined {
  return id ? state.servers.find(server => server.config.id === id) : undefined;
}

let panelRequestedState = false;

/** Short server state for the Providers side panel; undefined when the account is not a known local server. */
export function localServerStateLabel(accountId: string): string | undefined {
  if (!loaded() && !panelRequestedState) {
    panelRequestedState = true;
    loadLocalInference();
  }
  const server = localServerByAccount(accountId);
  if (!server) return undefined;
  switch (server.status.state) {
    case 'running':
      return 'Running';
    case 'starting':
      return 'Starting…';
    case 'stopping':
      return 'Stopping…';
    case 'error':
      return 'Error';
    default:
      return 'Stopped';
  }
}

export const localLogs = (id: string): string[] => logs()[id] ?? [];

/** Opens the OS picker for a file or folder. Resolves undefined when cancelled. */
export async function browseLocalPath(options: {
  kind: 'file' | 'folder';
  title?: string;
  filters?: LocalFileFilter[];
  defaultPath?: string;
}): Promise<string | undefined> {
  const reply = await localRequest('localBrowse', {
    kind: options.kind,
    ...(options.title ? { title: options.title } : {}),
    ...(options.filters?.length ? { filters: options.filters } : {}),
    ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
  });
  return reply.type === 'localBrowseResult' ? reply.path || undefined : undefined;
}

/** Browses for an engine's binary or folder and saves it. */
export async function browseEnginePath(engine: LocalEngineInfo): Promise<void> {
  if (engine.pathKind === 'none') return;
  const path = await browseLocalPath({
    kind: engine.pathKind,
    title: `Choose the ${engine.pathLabel}`,
    defaultPath: engine.install?.path,
  });
  if (path) sendLocal('localEngineSetPath', { engine: engine.kind, path });
}

export function installEngine(kind: LocalEngineKind): void {
  sendLocal('localEngineInstall', { engine: kind });
}

export function detectEngines(): void {
  sendLocal('localEngineDetect', {});
}

export function setLocalExclusive(exclusive: boolean): void {
  setState('exclusive', exclusive);
  sendLocal('localInferenceSettings', { exclusive });
}

export function startServer(id: string): void {
  sendLocal('localServerStart', { id });
}

export function stopServer(id: string): void {
  sendLocal('localServerStop', { id });
}

export function restartServer(id: string): void {
  sendLocal('localServerRestart', { id });
}

export function requestServerLogs(id: string): void {
  sendLocal('localServerLogs', { id });
}

export function saveServer(
  id: string,
  changes: { label?: string; values?: LocalValues; port?: number; autoStart?: boolean; idleStopMinutes?: number },
): void {
  sendLocal('localServerSave', { id, ...changes });
}

export function savePreset(serverId: string, label: string): void {
  sendLocal('localPresetSave', { serverId, label });
}

/** Creates a server from a preset; resolves with the new account id, or an error message. */
export async function createServer(input: {
  presetId?: string;
  engine?: LocalEngineKind;
  label: string;
  values?: LocalValues;
}): Promise<{ accountId?: string; serverId?: string; error?: string }> {
  const reply = await localRequest('localServerCreate', input);
  if (reply.type === 'localServerCreated') return { accountId: reply.accountId, serverId: reply.id };
  if (reply.type === 'localInferenceError') return { error: reply.message };
  return {};
}

/** "llama.cpp installed b6123", "Not installed", "Not set". */
export function engineInstallText(engine: LocalEngineInfo): string {
  if (engine.installing) return 'Installing…';
  if (engine.install) {
    const how = engine.install.source === 'installed' ? 'Installed' : engine.install.source === 'detected' ? 'Detected' : 'Set';
    return engine.install.version ? `${how} ${engine.install.version}` : how;
  }
  if (engine.pathKind === 'none') return 'Uses its own command';
  return engine.installable ? 'Not installed' : 'Not set';
}
