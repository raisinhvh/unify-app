/** window, commands, env, status bar and dialog surface. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Disposable, EventEmitter } from './events';
import { appendLog, nativeUi, outputChannel, onDidChangeWindowState, postToRenderer, registerWebviewViewProvider, requestUi, showDesktopNotification } from './host';
import { Position, Range, Selection, Uri } from './uri';
import { onDidSaveTextDocument, openTextDocument, TextDocument, workspace } from './workspace';
import { settingsSnapshot, shimPaths } from './state';
import {
  TabInputText, activeTextEditor, createEditor, onDidChangeActiveTextEditor, onDidChangeTextEditorSelection,
  onDidChangeVisibleTextEditors, tabGroups, visibleTextEditors,
} from './editor';
import { GithubAuth, getGithubAuth, onGithubAuthChange } from '../../engine/unify/github';

export { TabInputText };

export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum TextEditorRevealType { Default = 0, InCenter = 1, InCenterIfOutsideViewport = 2, AtTop = 3 }
export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2, Three = 3 }



interface StatusBarItem extends Disposable {
  text: string;
  tooltip?: string;
  command?: string;
  color?: string;
  backgroundColor?: string;
  show(): void;
  hide(): void;
}

function itemFromArguments(args: unknown[]): { text: string; options: Record<string, unknown>; buttons: string[] } {
  const options = args.length && typeof args[0] === 'object' && args[0] !== null ? args[0] as Record<string, unknown> : {};
  const buttons = args.filter((value): value is string => typeof value === 'string');
  return { text: typeof args[0] === 'string' ? args[0] : String(options.message ?? ''), options, buttons };
}

async function showMessage(level: 'info' | 'warning' | 'error', ...args: unknown[]): Promise<string | undefined> {
  const { text, options, buttons } = itemFromArguments(args);
  const detail = typeof options.detail === 'string' ? options.detail : undefined;
  const request = await requestUi({ kind: 'message', level, message: text, detail, items: buttons });
  if (request?.choice !== undefined) return request.choice;
  const ui = nativeUi();
  if (ui) return ui.showMessage(level, text, detail, buttons, !!options.modal);
  appendLog(`${level}: ${text}${detail ? `\n${detail}` : ''}`);
  return undefined;
}

function convertPicked<T>(picked: unknown, items: T[]): T | T[] | undefined {
  if (Array.isArray(picked)) {
    const chosen = picked as unknown[];
    return items.filter(item => chosen.includes(item) || chosen.includes((item as { label?: string })?.label ?? item));
  }
  if (typeof picked === 'string') {
    const match = items.find(item => {
      const label = typeof item === 'string' ? item : (item as { label?: string })?.label;
      return label === picked;
    });
    return (match ?? picked) as T;
  }
  return picked as T;
}

function selectionFromOptions(options: unknown): Selection | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const selection = (options as { selection?: unknown }).selection;
  if (selection instanceof Selection) return selection;
  if (selection instanceof Range) return new Selection(selection.start, selection.end);
  return undefined;
}

export const window = {
  get activeTextEditor() { return activeTextEditor(); },
  get visibleTextEditors() { return visibleTextEditors(); },
  get tabGroups() { return tabGroups(); },

  showInformationMessage: (message: string, ...args: unknown[]) => showMessage('info', message, ...args),
  showWarningMessage: (message: string, ...args: unknown[]) => showMessage('warning', message, ...args),
  showErrorMessage: (message: string, ...args: unknown[]) => showMessage('error', message, ...args),

  async showInputBox(options: Record<string, unknown> = {}): Promise<string | undefined> {
    const answer = await requestUi({ kind: 'input', options });
    if (answer?.value !== undefined) return answer.value;
    return nativeUi()?.showInput(options);
  },

  async showQuickPick(itemsOrThenable: unknown, options: Record<string, unknown> = {}): Promise<unknown> {
    const all = await Promise.resolve(itemsOrThenable as unknown[]);
    const items = Array.isArray(all) ? all : [];
    const labels = items.map(item => typeof item === 'string' ? item : String((item as { label?: unknown })?.label ?? ''));
    const answer = await requestUi({ kind: 'quickPick', items: labels, options });
    if (answer) return convertPicked(answer.choice, items);
    return nativeUi()?.showQuickPick(items, options);
  },

  async showOpenDialog(options: Record<string, unknown> = {}): Promise<Uri[] | undefined> {
    const answer = await requestUi({ kind: 'openDialog', options });
    if (answer?.paths?.length) return answer.paths.map(path => Uri.file(path));
    return nativeUi()?.showOpenDialog(options);
  },

  async showSaveDialog(): Promise<Uri | undefined> { return undefined; },

  async showTextDocument(documentOrUri: TextDocument | Uri, options?: unknown) {
    const document = documentOrUri instanceof TextDocument
      ? documentOrUri
      : await openTextDocument(documentOrUri);
    const selection = selectionFromOptions(options);
    if (document.uri.scheme === 'file') {
      postToRenderer({
        type: 'editorOpen',
        path: document.uri.fsPath,
        ...(selection ? { startLine: selection.start.line + 1, endLine: selection.end.line + 1 } : {}),
      });
    }
    return createEditor(document, selection);
  },

  async withProgress(options: unknown, task: (progress: { report(value: unknown): void }, token: { isCancellationRequested: boolean; onCancellationRequested(): Disposable }) => PromiseLike<unknown> | unknown): Promise<unknown> {
    const token = { isCancellationRequested: false, onCancellationRequested: () => new Disposable(() => undefined) };
    const settings = options && typeof options === 'object' ? options as { title?: unknown } : {};
    const id = `progress-${randomUUID()}`;
    const title = typeof settings.title === 'string' && settings.title ? settings.title : 'Working…';
    let message: string | undefined;
    let percent: number | undefined;
    const post = (state: 'running' | 'done' | 'error', error?: string): void => {
      postToRenderer({
        type: 'progressNotice',
        id,
        title,
        ...(message ? { message } : {}),
        ...(percent !== undefined ? { percent } : {}),
        ...(error ? { message: error } : {}),
        state,
      });
    };
    post('running');
    const progress = {
      report(value: unknown): void {
        if (!value || typeof value !== 'object') return;
        const report = value as { message?: unknown; increment?: unknown };
        if (typeof report.message === 'string' && report.message) message = report.message;
        if (typeof report.increment === 'number' && Number.isFinite(report.increment)) {
          percent = Math.max(0, Math.min(100, (percent ?? 0) + report.increment));
        }
        post('running');
      },
    };
    try {
      const result = await task(progress, token);
      post('done');
      return result;
    } catch (error) {
      post('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  },

  createOutputChannel(name: string) {
    return outputChannel(name);
  },

  createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem {
    let visible = false;
    return {
      text: '',
      tooltip: '',
      command: '',
      alignment,
      priority,
      show() { visible = true; },
      hide() { visible = false; },
      dispose() { visible = false; },
      get visible() { return visible; },
    } as StatusBarItem;
  },

  createTerminal(options: { name?: string; cwd?: string } = {}) {
    const ui = nativeUi();
    if (ui) return ui.createTerminal(options);
    return { name: options.name ?? 'Terminal', show() { /* No terminal adapter. */ }, sendText() { /* No terminal adapter. */ }, dispose() { /* Nothing to dispose. */ } };
  },

  registerWebviewViewProvider(viewType: string, provider: { resolveWebviewView(view: unknown): void | PromiseLike<void> }, options?: unknown): Disposable {
    return registerWebviewViewProvider(viewType, provider as never, options);
  },

  onDidChangeWindowState,

  onDidChangeActiveTextEditor,
  onDidChangeVisibleTextEditors,
  onDidChangeTextEditorSelection,
  onDidCloseTerminal: new EventEmitter<unknown>().event,
};

export const env = {
  get appName(): string { return 'Unify'; },
  get appRoot(): string { return shimPaths().extensionPath; },
  get language(): string { return 'en'; },
  get machineId(): string { return 'unify-desktop'; },
  get sessionId(): string { return `unify-${process.pid}`; },
  get isNewAppInstall(): boolean { return true; },
  get uiKind(): number { return 1; },
  async openExternal(target: Uri | string): Promise<boolean> {
    const uri = typeof target === 'string' ? Uri.parse(target) : target;
    if (uri.scheme === 'file' && uri.fsPath.endsWith('settings.json')) {
      // The customization pages write settings.json; opening it locally is the
      // closest native equivalent of VS Code's settings editor.
    }
    const ui = nativeUi();
    if (ui) return ui.openExternal(uri);
    return false;
  },
  async asExternalUri(uri: Uri): Promise<Uri> { return uri; },
  /**
   * Native OS notification, the desktop counterpart of VS Code's
   * `ProgressLocation.Notification` messages. Engine code calls this directly;
   * the setting `notifications.desktop` is checked by the caller.
   */
  notify(title: string, body?: string): void {
    showDesktopNotification(title, body);
  },
};

const commands = new Map<string, (...args: unknown[]) => unknown>();

export const commandRegistry = {
  execute(name: string, ...args: unknown[]): Promise<unknown> {
    const handler = commands.get(name);
    if (handler) {
      try { return Promise.resolve(handler(...args)); }
      catch (error) { return Promise.reject(error); }
    }
    return executeBuiltin(name, args);
  },
};

function diffPath(value: unknown): string | undefined {
  if (value instanceof Uri) return value.scheme === 'file' ? value.fsPath : undefined;
  if (typeof value !== 'string' || !value) return undefined;
  const uri = Uri.parse(value);
  return uri.scheme === 'file' ? uri.fsPath : undefined;
}

async function executeBuiltin(name: string, args: unknown[]): Promise<unknown> {
  if (name === 'vscode.open' && args[0] instanceof Uri) {
    await env.openExternal(args[0]);
    return undefined;
  }
  if (name === 'vscode.diff') {
    const leftPath = diffPath(args[0]);
    const rightPath = diffPath(args[1]);
    if (!leftPath || !rightPath) {
      appendLog('vscode.diff ignored: both sides must be file URIs.');
      return undefined;
    }
    postToRenderer({
      type: 'editorDiff',
      title: typeof args[2] === 'string' && args[2] ? args[2] : `${leftPath} ↔ ${rightPath}`,
      leftPath,
      rightPath,
    });
    return undefined;
  }
  if (name === 'vscode.changes') {
    // A multi-file change view has no renderer counterpart yet.
    return undefined;
  }
  if (name === 'workbench.action.openSettings') {
    const target = typeof args[0] === 'string' ? args[0] : '';
    postToRenderer({ type: 'uiNotice', kind: 'settings', key: target });
    return undefined;
  }
  if (name === 'workbench.view.extension.unify') {
    postToRenderer({ type: 'uiNotice', kind: 'showSidebar' });
    return undefined;
  }
  return undefined;
}

export const commandsApi = {
  registerCommand(name: string, callback: (...args: unknown[]) => unknown, thisArg?: unknown): Disposable {
    commands.set(name, thisArg ? callback.bind(thisArg) : callback);
    return new Disposable(() => {
      if (commands.get(name) === callback) commands.delete(name);
    });
  },
  executeCommand: commandRegistry.execute,
  getCommands(): Promise<string[]> { return Promise.resolve([...commands.keys()]); },
};

export const languages = {
  getDiagnostics(_uri?: Uri): unknown[] { return []; },
  createDiagnosticCollection() {
    return { set() { /* Diagnostics are not read from the shell. */ }, delete() { /* No-op. */ }, clear() { /* No-op. */ }, dispose() { /* No-op. */ } };
  },
};

/**
 * A VS Code `AuthenticationSession` for the account github.ts resolves. Sync
 * and Hub publishing call `getSession('github', …)`, so a signed-in `gh` CLI or
 * a pasted token in Settings is enough for both.
 */
function githubSession(auth: GithubAuth, scopes: readonly string[]): {
  id: string;
  accessToken: string;
  account: { id: string; label: string };
  scopes: readonly string[];
} {
  return {
    id: `github:${auth.login}`,
    accessToken: auth.token,
    account: { id: auth.login, label: auth.login },
    scopes,
  };
}

const authSessions = new EventEmitter<{
  providerId: string;
  added: unknown[];
  removed: unknown[];
  changed: unknown[];
}>();
let currentGithubSession: ReturnType<typeof githubSession> | undefined;

onGithubAuthChange(auth => {
  const previous = currentGithubSession;
  currentGithubSession = auth ? githubSession(auth, ['repo', 'gist']) : undefined;
  if (currentGithubSession) {
    authSessions.fire({ providerId: 'github', added: [currentGithubSession], removed: [], changed: previous ? [currentGithubSession] : [] });
  } else if (previous) {
    authSessions.fire({ providerId: 'github', added: [], removed: [previous], changed: [] });
  }
});

export const authentication = {
  async getSession(providerId: string, scopes: readonly string[] = []): Promise<ReturnType<typeof githubSession> | undefined> {
    if (providerId !== 'github') return undefined;
    const auth = await getGithubAuth();
    if (!auth) return undefined;
    currentGithubSession = githubSession(auth, scopes.length ? scopes : ['repo', 'gist']);
    return currentGithubSession;
  },
  onDidChangeSessions: authSessions.event,
};

export function registerCommand(name: string, callback: (...args: unknown[]) => unknown): Disposable {
  return commandsApi.registerCommand(name, callback);
}

export function executeCommand(name: string, ...args: unknown[]): Promise<unknown> {
  return commandRegistry.execute(name, ...args);
}
