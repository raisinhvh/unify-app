/**
 * The bridge between the engine (running as a bundled library) and the
 * Electron shell. The shim owns no windows or dialogs itself; main installs
 * adapters here so the same engine can also run in tests.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Disposable, EventEmitter } from './events';
import { setupStatusSnapshot } from './setup';
import { Uri } from './uri';

export interface WebviewOptions {
  enableScripts?: boolean;
  retainContextWhenHidden?: boolean;
  localResourceRoots?: Uri[];
}

export interface WebviewLike {
  html: string;
  options: WebviewOptions;
  cspSource: string;
  asWebviewUri(uri: Uri): Uri;
  postMessage(message: unknown): Thenable<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => void): Disposable;
  onDidDispose?(listener: () => void): Disposable;
}

export interface WebviewViewLike {
  viewType: string;
  webview: WebviewLike;
  visible: boolean;
  onDidDispose(listener: () => void): Disposable;
  onDidChangeVisibility?(listener: () => void): Disposable;
  show?(): void;
}

interface ProviderRegistration {
  viewType: string;
  provider: { resolveWebviewView(view: WebviewViewLike): void | PromiseLike<void>; dispose?(): void };
  options?: unknown;
}

export interface RendererBridge {
  /** Sends an engine message to the renderer window. */
  post(message: unknown): void;
  /** Asks the renderer to show UI; resolves undefined when it does not implement it. */
  requestUi?(request: UiRequest): Promise<unknown>;
}

export interface UiRequest {
  id: string;
  kind: 'message' | 'input' | 'quickPick' | 'openDialog';
  level?: 'info' | 'warning' | 'error';
  message?: string;
  detail?: string;
  items?: string[];
  options?: Record<string, unknown>;
}

export interface UiResult {
  choice?: string;
  value?: string;
  paths?: string[];
}

export interface UiAdapter {
  showMessage(level: 'info' | 'warning' | 'error', message: string, detail?: string, items?: string[], modal?: boolean): Promise<string | undefined>;
  showInput(options: Record<string, unknown>): Promise<string | undefined>;
  showQuickPick(items: unknown[], options?: Record<string, unknown>): Promise<unknown>;
  showOpenDialog(options: Record<string, unknown>): Promise<Uri[] | undefined>;
  openExternal(target: Uri): Promise<boolean>;
  showTextDocument(uri: Uri, options?: Record<string, unknown>): Promise<TextEditorLike>;
  createTerminal(options: { name?: string; cwd?: string }): TerminalLike;
}

export interface TextEditorLike {
  document: unknown;
  selection: unknown;
  selections: unknown[];
  revealRange(range: unknown, revealType?: number): void;
  edit(callback: (edit: unknown) => void): Promise<boolean>;
}

export interface TerminalLike {
  name: string;
  show(): void;
  sendText(text: string, addNewLine?: boolean): void;
  dispose(): void;
}

let bridge: RendererBridge | undefined;
let ui: UiAdapter | undefined;
let notifier: DesktopNotifier | undefined;
let logFile = '';
let cspSource = 'https://unify.local';
let asWebviewUri = (uri: Uri): Uri => uri;
const pendingMessages: unknown[] = [];

export function configureBridge(next: RendererBridge | undefined): void {
  bridge = next;
  if (bridge) {
    for (const message of pendingMessages.splice(0)) bridge.post(message);
  }
}

export function configureUi(next: UiAdapter): void {
  ui = next;
}

/**
 * Sends an OS notification. Main installs the adapter (Electron's
 * `Notification`); the shim itself has no Electron import, so tests just see
 * the call disappear into the log.
 */
export type DesktopNotifier = (title: string, body?: string) => void;

export function configureNotifications(next: DesktopNotifier | undefined): void {
  notifier = next;
}

/** The engine-side hook behind `vscode.env.notify(title, body)`. */
export function showDesktopNotification(title: string, body?: string): void {
  if (!notifier) {
    appendLog(`notification (no OS adapter): ${title}${body ? ` - ${body}` : ''}`);
    return;
  }
  try {
    notifier(title, body);
  } catch (error) {
    appendLog(`notification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function configureOutput(paths: { logFile: string }): void {
  logFile = paths.logFile;
  try {
    mkdirSync(join(paths.logFile, '..'), { recursive: true });
  } catch {
    // Logging should never stop startup.
  }
}

export function configureWebview(options: { cspSource: string; asWebviewUri(uri: Uri): Uri }): void {
  cspSource = options.cspSource;
  asWebviewUri = options.asWebviewUri;
}

export function postToRenderer(message: unknown): void {
  if (bridge) bridge.post(message);
  else pendingMessages.push(message);
}

const windowStateChanged = new EventEmitter<{ focused: boolean; active: boolean }>();

export function fireWindowState(focused: boolean): void {
  windowStateChanged.fire({ focused, active: focused });
}

export const onDidChangeWindowState = windowStateChanged.event;

export function appendLog(line: string, channel = 'engine'): void {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${new Date().toISOString()} [${channel}] ${line}\n`, 'utf8');
  } catch {
    // Best-effort logging only.
  }
}

const registrations = new Map<string, ProviderRegistration>();
let resolvedView: WebviewViewLike | undefined;
let viewHtml = '';
const viewMessageListeners = new Set<(message: unknown) => void>();

export function registerWebviewViewProvider(viewType: string, provider: ProviderRegistration['provider'], options?: unknown): Disposable {
  registrations.set(viewType, { viewType, provider, options });
  return new Disposable(() => {
    if (registrations.get(viewType)?.provider === provider) registrations.delete(viewType);
  });
}

export function webviewViewTypes(): string[] {
  return [...registrations.keys()];
}

export function hasWebviewProvider(viewType = 'unify.sidebar'): boolean {
  return registrations.has(viewType);
}

export class FakeWebview implements WebviewLike {
  public html = '';
  public options: WebviewOptions = {};
  private readonly listeners = new Set<(message: unknown) => void>();
  private readonly disposeListeners = new Set<() => void>();

  public get cspSource(): string {
    return cspSource;
  }

  public asWebviewUri(uri: Uri): Uri {
    return asWebviewUri(uri);
  }

  public postMessage(message: unknown): Promise<boolean> {
    postToRenderer(message);
    return Promise.resolve(true);
  }

  public onDidReceiveMessage(listener: (message: unknown) => void): Disposable {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  }

  public onDidDispose(listener: () => void): Disposable {
    this.disposeListeners.add(listener);
    return new Disposable(() => this.disposeListeners.delete(listener));
  }

  public receive(message: unknown): void {
    for (const listener of [...this.listeners]) listener(message);
  }

  public dispose(): void {
    for (const listener of [...this.disposeListeners]) listener();
    this.disposeListeners.clear();
    this.listeners.clear();
  }
}

export class FakeWebviewView implements WebviewViewLike {
  public readonly webview = new FakeWebview();
  public visible = true;
  private readonly disposeListeners = new Set<() => void>();

  public constructor(public readonly viewType: string) {}

  public onDidDispose(listener: () => void): Disposable {
    this.disposeListeners.add(listener);
    return new Disposable(() => this.disposeListeners.delete(listener));
  }

  public onDidChangeVisibility(): Disposable {
    return new Disposable(() => undefined);
  }

  public show(): void {
    this.visible = true;
  }

  public dispose(): void {
    this.webview.dispose();
    for (const listener of [...this.disposeListeners]) listener();
    this.disposeListeners.clear();
  }
}

/** Resolves the registered sidebar provider exactly as VS Code would. */
export async function resolveWebviewView(viewType = 'unify.sidebar'): Promise<{ view: FakeWebviewView; html: string } | undefined> {
  const registration = registrations.get(viewType);
  if (!registration) return undefined;
  if (resolvedView instanceof FakeWebviewView && resolvedView.viewType === viewType) {
    return { view: resolvedView, html: viewHtml };
  }
  const view = new FakeWebviewView(viewType);
  // Capture the HTML the provider assigns and forward live messages to main.
  resolvedView = view;
  await registration.provider.resolveWebviewView(view);
  viewHtml = view.webview.html;
  return { view, html: viewHtml };
}

/** Delivers a renderer message to the engine's webview listener. */
export function dispatchWebviewMessage(message: unknown): boolean {
  if (!(resolvedView instanceof FakeWebviewView)) return false;
  resolvedView.webview.receive(message);
  return true;
}

export function currentWebviewHtml(): string {
  return viewHtml;
}

export function disposeWebviewViews(): void {
  if (resolvedView instanceof FakeWebviewView) resolvedView.dispose();
  resolvedView = undefined;
}

export function setupStatus(): ReturnType<typeof setupStatusSnapshot> {
  return setupStatusSnapshot();
}

/** Sends the setup summary to the renderer; safe before the window loads. */
export function postSetupStatus(): void {
  postToRenderer({ type: 'setupStatus', ...setupStatus() });
}

let requestSequence = 0;

/** Asks the renderer for UI, then falls back to the native adapter. */
export async function requestUi(request: Omit<UiRequest, 'id'>): Promise<UiResult | undefined> {
  if (bridge?.requestUi) {
    const id = `ui-${++requestSequence}`;
    try {
      const answer = await Promise.race([
        bridge.requestUi({ ...request, id }),
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1500)),
      ]);
      if (answer && typeof answer === 'object') return answer as UiResult;
    } catch {
      // The renderer is optional; native UI below always works.
    }
  }
  return undefined;
}

export function nativeUi(): UiAdapter | undefined {
  return ui;
}

/** Creates an output channel that appends to the engine log. */
export function outputChannel(name: string) {
  return {
    name,
    append(value: string) { appendLog(value, name); },
    appendLine(value: string) { appendLog(value, name); },
    replace(value: string) { appendLog(value, name); },
    clear() { appendLog('--- cleared ---', name); },
    show() { appendLog('(output shown)', name); },
    hide() { /* Nothing to hide in the bundled engine. */ },
    dispose() { /* The log file outlives the channel. */ },
  };
}
