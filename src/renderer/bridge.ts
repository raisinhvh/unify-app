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

export function post(message: SidebarWebviewMessage): void {
  bridge().post(message);
}
