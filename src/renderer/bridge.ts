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

/** One changed file. `status`: M modified, A added, D deleted, R renamed, C conflicted, U untracked. */
export interface GitChange {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | 'C' | 'U';
  origPath?: string;
}

export type GitStatusResult =
  | { repo: false }
  | {
      repo: true;
      /** Repository root; every path below is relative to it. */
      root: string;
      branch: string;
      ahead: number;
      behind: number;
      hasUpstream: boolean;
      staged: GitChange[];
      unstaged: GitChange[];
    }
  | { error: string };

export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  /** Relative date, e.g. "3 days ago". */
  date: string;
  /** Decorations: "HEAD -> main", "origin/main", "tag: v1". */
  refs: string[];
  parents: string[];
}

export type GitLogResult = { commits: GitCommit[] } | { error: string };
export type GitDiffResult = { text: string; truncated: boolean } | { error: string };
export type GitActionResult = { ok: true } | { error: string };
export type GitBranchesResult = { current: string; local: string[]; remote: string[] } | { error: string };

/**
 * Source control (main process git, see src/main/git.ts). `cwd` is optional: unset means the project folder.
 * Failures come back as `{ error }`; nothing rejects. Outside Electron the whole API is missing.
 */
export interface UnifyGitApi {
  status(cwd?: string): Promise<GitStatusResult>;
  log(cwd?: string): Promise<GitLogResult>;
  diff(cwd: string | undefined, path: string, options: { staged?: boolean; untracked?: boolean }): Promise<GitDiffResult>;
  /** Stages `paths`; `null` stages every change (`git add -A`). */
  stage(cwd: string | undefined, paths: string[] | null): Promise<GitActionResult>;
  unstage(cwd: string | undefined, paths: string[]): Promise<GitActionResult>;
  /** Tracked files revert to the index; untracked files are deleted. Ask the user before calling. */
  discard(cwd: string | undefined, items: { path: string; untracked: boolean }[]): Promise<GitActionResult>;
  commit(cwd: string | undefined, message: string, options?: { amend?: boolean }): Promise<GitActionResult>;
  pull(cwd?: string, options?: { rebase?: boolean }): Promise<GitActionResult>;
  push(cwd?: string): Promise<GitActionResult>;
  fetch(cwd?: string): Promise<GitActionResult>;
  /** Pull, then push (only the push when the branch has no upstream yet). Stops at the first failure. */
  sync(cwd?: string): Promise<GitActionResult>;
  branches(cwd?: string): Promise<GitBranchesResult>;
  /** Switches to a local branch, or to a remote-only name (origin/foo) through a new tracking branch. */
  checkout(cwd: string | undefined, branch: string): Promise<GitActionResult>;
  createBranch(cwd: string | undefined, name: string): Promise<GitActionResult>;
  stash(cwd: string | undefined, options?: { includeUntracked?: boolean }): Promise<GitActionResult>;
  stashPop(cwd?: string): Promise<GitActionResult>;
  /** `reset --soft HEAD~1`: the commit's changes stay staged. */
  undoLastCommit(cwd?: string): Promise<GitActionResult>;
  /** `git init` in the project folder. */
  init(cwd?: string): Promise<GitActionResult>;
}

/** Integrated terminal sessions (main process node-pty). Each id is one shell, keyed by the renderer's pane id. */
export interface UnifyTerminalApi {
  /**
   * Starts a shell for `id` (replacing any existing one). Resolves `{ ok: false, error }` when it cannot start;
   * on success `cwd` is the folder it started in (the requested one, else the project folder, else home).
   */
  create(id: string, opts: { cols: number; rows: number; cwd?: string }): Promise<{ ok: boolean; shell?: string; cwd?: string; error?: string }>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  /** Output for any session; filter by `id`. Returns an unsubscribe function. */
  onData(listener: (id: string, data: string) => void): () => void;
  /** The shell for `id` exited with `code`; the session is gone. Returns an unsubscribe function. */
  onExit(listener: (id: string, code: number) => void): () => void;
}

/** Mirrors `AppUpdateStatus` in src/main/updater.ts. */
export type AppUpdateStatus =
  | { state: 'unavailable'; message: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current' }
  | { state: 'downloading'; version: string; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { state: 'ready'; version: string }
  | { state: 'installing'; version: string }
  | { state: 'error'; message: string; detail?: string };

export interface AppUpdateRelease {
  version: string;
  date?: string;
  /** Plain text. */
  notes?: string;
  url: string;
}

export interface AppUpdateSnapshot {
  currentVersion: string;
  status: AppUpdateStatus;
  lastCheckedAt?: number;
  release?: AppUpdateRelease;
}

/** App updater in the main process (src/main/updater.ts). */
export interface UnifyUpdatesApi {
  state(): Promise<AppUpdateSnapshot>;
  check(): Promise<{ status: 'unavailable' | 'checking' | 'error'; message?: string }>;
  /** Only works in `ready`: shows the installer window, quits, and the installer reopens Unify. */
  install(): Promise<{ ok: boolean; message?: string }>;
  onState(listener: (snapshot: AppUpdateSnapshot) => void): () => void;
  /** The "update ready" notification was clicked. */
  onOpen(listener: () => void): () => void;
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
  /** App version (semver, e.g. 1.1.0) and whether this is a dev run (run.cmd / run.sh). Missing outside Electron. */
  appInfo?: { version: string; dev: boolean };
  /** Integrated terminals (node-pty in the main process). Missing outside Electron. */
  terminal?: UnifyTerminalApi;
  /** Source Control (git in the main process). Missing outside Electron. */
  git?: UnifyGitApi;
  /** App updates. Missing outside Electron (the browser preview). */
  updates?: UnifyUpdatesApi;
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
