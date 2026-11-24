/**
 * Preload bridge for the Unify renderer.
 *
 * Exposes `window.unify` (the documented API), an optional UI-request channel
 * for the new renderer, and `acquireVsCodeApi()` so the legacy sidebar
 * runs unchanged. Engine messages are also re-posted on `window` because the
 * legacy sidebar listens with `window.addEventListener('message', ...)`.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

type HostMessage = Record<string, unknown>;
type Listener = (message: HostMessage) => void;

const messageListeners = new Set<Listener>();
const uiListeners = new Set<(request: unknown) => void>();
const maximizedListeners = new Set<(maximized: boolean) => void>();
const popoutListeners = new Set<(chatIds: string[]) => void>();
const terminalDataListeners = new Set<(id: string, data: string) => void>();
const terminalExitListeners = new Set<(id: string, code: number) => void>();
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

ipcRenderer.on('unify:term-data', (_event, id: unknown, data: unknown) => {
  if (typeof id !== 'string' || typeof data !== 'string') return;
  for (const listener of [...terminalDataListeners]) listener(id, data);
});

ipcRenderer.on('unify:term-exit', (_event, id: unknown, code: unknown) => {
  if (typeof id !== 'string') return;
  const exitCode = typeof code === 'number' ? code : -1;
  for (const listener of [...terminalExitListeners]) listener(id, exitCode);
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

  /** Moves `relative` (inside the project folder `root`) to the OS trash. */
  trashItem(root: string, relative: string): Promise<void> {
    return ipcRenderer.invoke('unify:trash-item', root, relative) as Promise<void>;
  },

  /** Shows `relative` (inside `root`) selected in the OS file manager. */
  revealItem(root: string, relative: string): Promise<void> {
    return ipcRenderer.invoke('unify:reveal-item', root, relative) as Promise<void>;
  },

  /** Absolute path of a file dropped from the OS (empty for files that are not on disk). */
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
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

  /** Integrated terminals: one shell per renderer-chosen id (the pane id). */
  terminal: {
    create(id: string, opts: { cols: number; rows: number; cwd?: string }): Promise<{ ok: boolean; shell?: string; cwd?: string; error?: string }> {
      return ipcRenderer.invoke('unify:term-create', { id, cols: opts.cols, rows: opts.rows, cwd: opts.cwd }) as Promise<
        { ok: boolean; shell?: string; cwd?: string; error?: string }
      >;
    },
    write(id: string, data: string): void {
      ipcRenderer.send('unify:term-input', id, data);
    },
    resize(id: string, cols: number, rows: number): void {
      ipcRenderer.send('unify:term-resize', id, cols, rows);
    },
    kill(id: string): void {
      ipcRenderer.send('unify:term-kill', id);
    },
    onData(listener: (id: string, data: string) => void): () => void {
      terminalDataListeners.add(listener);
      return () => terminalDataListeners.delete(listener);
    },
    onExit(listener: (id: string, code: number) => void): () => void {
      terminalExitListeners.add(listener);
      return () => terminalExitListeners.delete(listener);
    },
  },

  /** Source Control: git in the main process (src/main/git.ts). Results are typed in renderer/bridge.ts (UnifyGitApi). */
  git: {
    status(cwd?: string): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-status', cwd) as Promise<unknown>;
    },
    log(cwd?: string): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-log', cwd) as Promise<unknown>;
    },
    diff(cwd: string | undefined, path: string, options: { staged?: boolean; untracked?: boolean }): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-diff', cwd, path, options) as Promise<unknown>;
    },
    stage(cwd: string | undefined, paths: string[] | null): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-stage', cwd, paths) as Promise<unknown>;
    },
    unstage(cwd: string | undefined, paths: string[]): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-unstage', cwd, paths) as Promise<unknown>;
    },
    discard(cwd: string | undefined, items: { path: string; untracked: boolean }[]): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-discard', cwd, items) as Promise<unknown>;
    },
    commit(cwd: string | undefined, message: string, options: { amend?: boolean } = {}): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-commit', cwd, message, options) as Promise<unknown>;
    },
    pull(cwd?: string, options: { rebase?: boolean } = {}): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-pull', cwd, options) as Promise<unknown>;
    },
    push(cwd?: string): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-push', cwd) as Promise<unknown>;
    },
    fetch(cwd?: string): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-fetch', cwd) as Promise<unknown>;
    },
    sync(cwd?: string): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-sync', cwd) as Promise<unknown>;
    },
    branches(cwd?: string): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-branches', cwd) as Promise<unknown>;
    },
    checkout(cwd: string | undefined, branch: string): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-checkout', cwd, branch) as Promise<unknown>;
    },
    createBranch(cwd: string | undefined, name: string): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-create-branch', cwd, name) as Promise<unknown>;
    },
    stash(cwd: string | undefined, options: { includeUntracked?: boolean } = {}): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-stash', cwd, options) as Promise<unknown>;
    },
    stashPop(cwd?: string): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-stash-pop', cwd) as Promise<unknown>;
    },
    undoLastCommit(cwd?: string): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-undo-commit', cwd) as Promise<unknown>;
    },
    init(cwd?: string): Promise<unknown> {
      return ipcRenderer.invoke('unify:git-init', cwd) as Promise<unknown>;
    },
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
