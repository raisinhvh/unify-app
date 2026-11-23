/**
 * Preload bridge for the Unify renderer.
 *
 * Exposes `window.unify` (the documented API), an optional UI-request channel
 * for the new renderer, and `acquireVsCodeApi()` so the legacy sidebar
 * runs unchanged. Engine messages are also re-posted on `window` because the
 * legacy sidebar listens with `window.addEventListener('message', ...)`.
 */
import { contextBridge, ipcRenderer } from 'electron';

type HostMessage = Record<string, unknown>;
type Listener = (message: HostMessage) => void;

const messageListeners = new Set<Listener>();
const uiListeners = new Set<(request: unknown) => void>();
const maximizedListeners = new Set<(maximized: boolean) => void>();
const popoutListeners = new Set<(chatIds: string[]) => void>();
let lastMessage: HostMessage | undefined;

/** Absolute path of the open project folder, read once from the main process. */
function readProjectPath(): string | undefined {
  try {
    const value = ipcRenderer.sendSync('unify:project-path') as unknown;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

const projectPath = readProjectPath();

function popoutChatIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

ipcRenderer.on('unify:message', (_event, message: HostMessage) => {
  lastMessage = message;
  for (const listener of [...messageListeners]) {
    try {
      listener(message);
    } catch (error) {
      console.error('[unify] message listener failed', error);
    }
  }
  // The legacy sidebar was written for a VS Code webview, where the host's
  // postMessage surfaces as a window message event.
  window.postMessage(message, '*');
});

ipcRenderer.on('unify:ui-request', (_event, request: unknown) => {
  for (const listener of [...uiListeners]) {
    try {
      listener(request);
    } catch (error) {
      console.error('[unify] UI listener failed', error);
    }
  }
});

ipcRenderer.on('unify:maximized', (_event, maximized: boolean) => {
  for (const listener of [...maximizedListeners]) listener(maximized);
});

ipcRenderer.on('unify:popouts', (_event, chatIds: unknown) => {
  const ids = popoutChatIds(chatIds);
  for (const listener of [...popoutListeners]) listener(ids);
});

const api = {
  post(message: unknown): void {
    ipcRenderer.send('unify:post', message);
  },

  onMessage(listener: Listener): () => void {
    messageListeners.add(listener);
    return () => messageListeners.delete(listener);
  },

  /** The last engine message, for a renderer that mounts after startup. */
  lastMessage(): HostMessage | undefined {
    return lastMessage;
  },

  getState<T>(): T | undefined {
    return ipcRenderer.sendSync('unify:state-get') as T | undefined;
  },

  setState<T>(value: T): void {
    ipcRenderer.send('unify:state-set', value);
  },

  platform: process.platform as 'win32' | 'darwin' | 'linux',

  /** Absolute path of the open project folder (main process `projectPath`). */
  projectPath,

  /** Opens the chat in its own window, or focuses the one already showing it. */
  popOut(chatId: string): void {
    if (typeof chatId !== 'string' || !chatId) return;
    ipcRenderer.send('unify:popout', chatId);
  },

  /** Chats shown in pop-out windows; the current list arrives right after subscribing. */
  onPopoutsChanged(listener: (chatIds: string[]) => void): () => void {
    popoutListeners.add(listener);
    void ipcRenderer.invoke('unify:popouts-get')
      .then((ids: unknown) => {
        if (popoutListeners.has(listener)) listener(popoutChatIds(ids));
      })
      .catch((error: unknown) => console.error('[unify] pop-out list failed', error));
    return () => popoutListeners.delete(listener);
  },

  window: {
    minimize(): void { ipcRenderer.send('unify:window', 'minimize'); },
    maximize(): void { ipcRenderer.send('unify:window', 'maximize'); },
    close(): void { ipcRenderer.send('unify:window', 'close'); },
    isMaximized(): Promise<boolean> { return ipcRenderer.invoke('unify:is-maximized') as Promise<boolean>; },
    onMaximized(listener: (maximized: boolean) => void): () => void {
      maximizedListeners.add(listener);
      return () => maximizedListeners.delete(listener);
    },
  },

  pickFolder(): Promise<string | undefined> {
    return ipcRenderer.invoke('unify:pick-folder') as Promise<string | undefined>;
  },

  /** Folder picker for "Folder as context"; defaults to the project. */
  pickContextFolder(): Promise<string | undefined> {
    return ipcRenderer.invoke('unify:pick-context-folder') as Promise<string | undefined>;
  },

  /** Screenshot of the primary display, with Unify's windows hidden for the capture. */
  captureScreen(): Promise<{ dataUrl: string; width: number; height: number } | undefined> {
    return ipcRenderer.invoke('unify:capture-screen') as Promise<
      { dataUrl: string; width: number; height: number } | undefined
    >;
  },

  openExternal(url: string): void {
    ipcRenderer.send('unify:open-external', url);
  },

  /** Native OS notification (title plus optional body). */
  notify(title: string, body?: string): void {
    if (typeof title !== 'string' || !title.trim()) return;
    ipcRenderer.send('unify:notify', {
      title: title.slice(0, 200),
      body: typeof body === 'string' ? body.slice(0, 500) : undefined,
    });
  },

  setupStatus(): Promise<unknown> {
    return ipcRenderer.invoke('unify:setup-status') as Promise<unknown>;
  },

  /** Asks the main-process updater to check GitHub Releases now. */
  checkForUpdates(): Promise<unknown> {
    return ipcRenderer.invoke('unify:check-for-updates') as Promise<unknown>;
  },

  /** New renderer: receive native UI requests and answer them by id. */
  onUiRequest(listener: (request: unknown) => void): () => void {
    uiListeners.add(listener);
    return () => uiListeners.delete(listener);
  },

  respondToUi(id: string, result: unknown): void {
    ipcRenderer.send('unify:ui-response', { id, result });
  },
};

contextBridge.exposeInMainWorld('unify', api);

/** VS Code webview API, backed by the same bridge. */
contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({
  postMessage(message: unknown): void {
    api.post(message);
  },
  getState<T>(): T | undefined {
    return api.getState<T>();
  },
  setState<T>(value: T): void {
    api.setState(value);
  },
}));
