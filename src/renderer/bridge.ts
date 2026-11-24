/**
 * The only way the renderer talks to the engine.
 *
 * Prefers Unify's preload API (`window.unify`, see ARCHITECTURE.md). Falls back to a VS Code style
 * `acquireVsCodeApi()` (the preload exposes one too, and it lets the renderer run inside a VS Code webview).
 * In a plain browser (vite dev, screenshots) `installDevBridge` swaps in a mock fed from fixture JSON.
 */
import type { SidebarHostMessage, SidebarWebviewMessage } from './protocol';

export interface UnifyWindowControls {
  minimize(): void;
  maximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
}

export interface UnifyBridge {
  post(message: SidebarWebviewMessage): void;
  onMessage(listener: (message: SidebarHostMessage) => void): () => void;
  getState<T>(): T | undefined;
  setState<T>(value: T): void;
  platform: 'win32' | 'darwin' | 'linux';
  window: UnifyWindowControls;
  pickFolder(): Promise<string | undefined>;
  openExternal(url: string): void;
  /**
   * Pop-out windows (main process). `popOut` opens the chat in its own frameless window, or focuses the one
   * already open for it. A popped-out window loads the same renderer with `?popout=<chatId>` in its URL
   * (see `popoutChatId()` below). Missing outside Electron.
   */
  popOut?(chatId: string): void;
  /** Chats currently shown in pop-out windows (main window only cares). */
  onPopoutsChanged?(listener: (chatIds: string[]) => void): () => void;
  /**
   * Screenshot of the primary display for the composer's "Screenshot" attachment. Unify's own windows are hidden
   * for the capture and shown again. Resolves undefined when the OS refuses (e.g. macOS screen permission).
   */
  captureScreen?(): Promise<{ dataUrl: string; width: number; height: number } | undefined>;
  /** Moves `relative` (inside the project folder `root`) to the OS trash / Recycle Bin. Missing outside Electron. */
  trashItem?(root: string, relative: string): Promise<void>;
  /** Shows `relative` (inside `root`) selected in the OS file manager. Missing outside Electron. */
  revealItem?(root: string, relative: string): Promise<void>;
  /** Absolute path of a file dropped from the OS ('' when it has none). Missing outside Electron. */
  pathForFile?(file: File): string;
  /** Folder picker for "Folder as context" (any folder; defaults to the project). */
  pickContextFolder?(): Promise<string | undefined>;
  /** Absolute path of the open project folder (main process `projectPath`). */
  projectPath?: string;
}

/** The chat this window shows on its own, when it is a pop-out window (`?popout=<chatId>`). */
export function popoutChatId(): string | undefined {
  try {
    return new URLSearchParams(window.location.search).get('popout') || undefined;
  } catch {
    return undefined;
  }
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(value: unknown): void;
}

declare global {
  interface Window {
    unify?: UnifyBridge;
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

const noWindowControls: UnifyWindowControls = {
  minimize: () => undefined,
  maximize: () => undefined,
  close: () => undefined,
  isMaximized: async () => false,
};

function bridgeFromVsCode(api: VsCodeApi): UnifyBridge {
  return {
    post: message => api.postMessage(message),
    onMessage: listener => {
      const handle = (event: MessageEvent) => {
        const message = event.data;
        if (message && typeof message.type === 'string') listener(message as SidebarHostMessage);
      };
      window.addEventListener('message', handle);
      return () => window.removeEventListener('message', handle);
    },
    getState: <T>() => api.getState() as T | undefined,
    setState: value => api.setState(value),
    platform: navigator.userAgent.includes('Mac') ? 'darwin' : navigator.userAgent.includes('Linux') ? 'linux' : 'win32',
    window: noWindowControls,
    pickFolder: async () => undefined,
    openExternal: url => window.open(url, '_blank'),
  };
}

let activeBridge: UnifyBridge | undefined;

/** Sets the bridge explicitly (the dev mock calls this before the app mounts). */
export function setBridge(bridge: UnifyBridge): void {
  activeBridge = bridge;
}

export function hasHostBridge(): boolean {
  return !!window.unify || typeof window.acquireVsCodeApi === 'function';
}

export function bridge(): UnifyBridge {
  if (activeBridge) return activeBridge;
  if (window.unify) {
    activeBridge = window.unify;
  } else if (typeof window.acquireVsCodeApi === 'function') {
    activeBridge = bridgeFromVsCode(window.acquireVsCodeApi());
  } else {
    throw new Error('No engine bridge: window.unify is missing. In a browser, load the dev mock first.');
  }
  return activeBridge;
}

/**
 * Messages often carry values read straight from the Solid store (e.g. a model's speedOptions), and store proxies
 * can't be structured-cloned across IPC. Protocol messages are plain JSON, so a JSON copy is an exact fallback.
 */
export function post(message: SidebarWebviewMessage): void {
  try {
    bridge().post(message);
  } catch (error) {
    if (!(error instanceof Error) || !/could not be cloned/i.test(error.message)) throw error;
    bridge().post(JSON.parse(JSON.stringify(message)) as SidebarWebviewMessage);
  }
}
