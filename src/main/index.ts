/**
 * Electron main process for Unify.
 *
 * Boots the VS Code shim, activates the unmodified agent engine against it, and
 * bridges the engine's sidebar provider to a BrowserWindow over IPC and a
 * loopback asset server (used by the legacy sidebar for its media).
 */
import {
  app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, Notification, safeStorage, screen, shell,
  type BrowserWindowConstructorOptions, type OpenDialogOptions,
} from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { activate, deactivate } from '../engine/extension';
import { getSidebarHtml, initialSidebarState } from '../engine/sidebar/view';
import { configureGithubSecretStore } from '../engine/unify/github';
import { installMediaProtocol, registerMediaSchemes } from './mediaProtocol';
import { registerGitIpc } from './git';
import { killAllTerminals, registerTerminalIpc } from './terminal';
import { checkForUpdatesNow, startUpdater, stopUpdater } from './updater';
import {
  bootWebview, configureNotifications, prepareUnify, receiveRendererMessage, setUiAdapter, shimSetupStatus,
  type UiAdapter, type UiRequest,
} from '../shim/vscode/index';
import { appendLog } from '../shim/vscode/host';
import { readJson, SecretStorageLike, writeJson } from '../shim/vscode/state';
import { Uri } from '../shim/vscode/uri';
import { createTextEditor, openTextDocument } from '../shim/vscode/workspace';

interface CliOptions {
  project?: string;
  screenshot?: string;
  screenshotDelay: number;
  legacy: boolean;
  keepOpen: boolean;
}

const stateRoot = process.env.UNIFY_HOME ? resolve(process.env.UNIFY_HOME) : join(homedir(), '.unify');
const logsPath = join(stateRoot, 'logs');
const windowStatePath = join(stateRoot, 'window.json');
const rendererStatePath = join(stateRoot, 'renderer-state.json');

try {
  mkdirSync(logsPath, { recursive: true });
} catch {
  // A missing log folder must not stop the app; appendLog tolerates it.
}

function mainLog(line: string): void {
  try {
    appendLog(line, 'main');
  } catch {
    // Logging must never block startup.
  }
}

const activeNotifications = new Set<Notification>();

/**
 * OS notification used by `window.unify.notify()` in the renderer and by the
 * engine's `vscode.env.notify()` through the shim's notification adapter.
 */
function showNotification(title: string, body?: string): void {
  if (!Notification.isSupported()) {
    mainLog(`notifications unsupported on this system: ${title}`);
    return;
  }
  try {
    const notification = new Notification({ title, body });
    activeNotifications.add(notification);
    notification.once('close', () => activeNotifications.delete(notification));
    notification.once('failed', () => activeNotifications.delete(notification));
    notification.show();
  } catch (error) {
    mainLog(`notification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseCli(argv: string[]): CliOptions {
  const valueAfter = (flag: string): string | undefined => {
    const index = argv.findIndex(argument => argument === flag || argument.startsWith(`${flag}=`));
    if (index < 0) return undefined;
    const argument = argv[index];
    if (argument.startsWith(`${flag}=`)) return argument.slice(flag.length + 1);
    return argv[index + 1];
  };
  const delay = Number(valueAfter('--screenshot-delay'));
  return {
    project: valueAfter('--project'),
    screenshot: valueAfter('--screenshot'),
    screenshotDelay: Number.isFinite(delay) && delay > 0 ? delay : 4000,
    legacy: argv.includes('--legacy') || process.env.UNIFY_LEGACY === '1',
    keepOpen: argv.includes('--keep-open'),
  };
}

const cli = parseCli(process.argv.slice(1));
const isDev = process.env.UNIFY_DEV === '1' && !cli.legacy;
const devUrl = process.env.UNIFY_DEV_URL || 'http://localhost:5173';

interface WindowState { project?: string }
const savedWindowState = readJson<WindowState>(windowStatePath, {});

function resolveProject(): string {
  const candidate = cli.project || savedWindowState.project;
  if (candidate && existsSync(candidate) && statSync(candidate).isDirectory()) return resolve(candidate);
  if (candidate) mainLog(`Ignoring missing project folder: ${candidate}`);
  if (app.isPackaged) return app.getPath('documents');
  return process.cwd();
}

const projectPath = resolveProject();
const extensionPath = app.getAppPath();
const stateFallback = join(stateRoot, 'storage');
const globalStoragePath = stateFallback;
mkdirSync(globalStoragePath, { recursive: true });

let mainWindow: BrowserWindow | undefined;
let windowLoaded = false;
let legacyHtml = '';
let assetOrigin = '';
let assetToken = randomBytes(24).toString('hex');
const bufferedMessages: unknown[] = [];
const pendingUi = new Map<string, (result: unknown) => void>();
const promptResolvers = new Map<string, (value: string | undefined) => void>();
let rendererState: unknown;

/** Chats shown in their own windows, keyed by chat id, plus each window's load state and message buffer. */
const popoutWindows = new Map<string, BrowserWindow>();
const popoutLoaded = new Map<string, boolean>();
const popoutMessages = new Map<string, unknown[]>();

/* ------------------------------------------------------------------ */
/* Secrets                                                             */
/* ------------------------------------------------------------------ */

class FileSecrets implements SecretStorageLike {
  private values: Record<string, string>;

  public constructor(private readonly path: string) {
    this.values = readJson<Record<string, string>>(path, {});
  }

  public async get(key: string): Promise<string | undefined> {
    const stored = this.values[key];
    if (!stored) return undefined;
    try {
      if (stored.startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
      }
      if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8');
    } catch (error) {
      mainLog(`Could not decrypt ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }

  public async store(key: string, value: string): Promise<void> {
    if (safeStorage.isEncryptionAvailable()) {
      this.values[key] = `enc:${safeStorage.encryptString(value).toString('base64')}`;
    } else {
      // No OS keychain (for example a Linux box without a keyring): keep the
      // value readable instead of silently losing the account.
      this.values[key] = `plain:${Buffer.from(value, 'utf8').toString('base64')}`;
    }
    writeJson(this.path, this.values);
  }

  public async delete(key: string): Promise<void> {
    delete this.values[key];
    writeJson(this.path, this.values);
  }
}

/* ------------------------------------------------------------------ */
/* Asset server (legacy webview media + native prompt page)            */
/* ------------------------------------------------------------------ */

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
};

function allowedRoots(): string[] {
  const roots = [extensionPath, stateRoot, globalStoragePath, projectPath];
  if (process.env.TEMP) roots.push(resolve(process.env.TEMP));
  return roots.map(root => resolve(root).toLowerCase());
}

function isAllowed(target: string): boolean {
  const lower = resolve(target).toLowerCase();
  return allowedRoots().some(root => lower === root || lower.startsWith(root + sep));
}

function decodeBase64Url(value: string): string | undefined {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

function assetUrlFor(filePath: string): string {
  return `${assetOrigin}/asset/${assetToken}/${Buffer.from(filePath, 'utf8').toString('base64url')}`;
}

function serveFile(requestUrl: URL, response: ServerResponse): void {
  const segments = requestUrl.pathname.split('/').filter(Boolean);
  // /asset/<token>/<base64-root>[/child...]
  if (segments.length < 3 || segments[0] !== 'asset' || segments[1] !== assetToken) {
    response.writeHead(403).end('forbidden');
    return;
  }
  const root = decodeBase64Url(segments[2]);
  if (!root) {
    response.writeHead(400).end('bad path');
    return;
  }
  const child = segments.slice(3).map(segment => decodeURIComponent(segment)).join(sep);
  const target = resolve(child ? join(root, child) : root);
  if (!isAllowed(target)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  let info;
  try {
    info = statSync(target);
  } catch {
    response.writeHead(404).end('not found');
    return;
  }
  if (!info.isFile()) {
    response.writeHead(404).end('not a file');
    return;
  }
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': String(info.size),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  createReadStream(target).pipe(response);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

/**
 * VS Code injects its theme variables into every webview. The legacy sidebar
 * still reads them, so the shell provides the Unify palette under the same
 * names.
 */
const THEME_CSS = `:root {
  color-scheme: dark;
  --vscode-font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
  --vscode-editor-font-family: "Cascadia Code", "Consolas", ui-monospace, monospace;
  --vscode-foreground: #e8e2da;
  --vscode-descriptionForeground: #a89e93;
  --vscode-sideBar-background: #0D0B09;
  --vscode-sideBarSectionHeader-background: #171310;
  --vscode-editor-background: #0D0B09;
  --vscode-editorWidget-background: #171310;
  --vscode-panel-border: #2a241f;
  --vscode-contrastBorder: transparent;
  --vscode-focusBorder: #e8792b;
  --vscode-icon-foreground: #cfc6bb;
  --vscode-input-background: #171310;
  --vscode-input-foreground: #f3ede6;
  --vscode-input-border: #3a332c;
  --vscode-dropdown-background: #171310;
  --vscode-dropdown-foreground: #f3ede6;
  --vscode-dropdown-border: #3a332c;
  --vscode-button-background: #e8792b;
  --vscode-button-foreground: #140d08;
  --vscode-button-hoverBackground: #f08a42;
  --vscode-button-secondaryBackground: #221c17;
  --vscode-button-secondaryForeground: #f3ede6;
  --vscode-button-secondaryHoverBackground: #2c241d;
  --vscode-list-hoverBackground: #1c1713;
  --vscode-list-activeSelectionBackground: #2a211a;
  --vscode-list-activeSelectionForeground: #fff8f0;
  --vscode-list-inactiveSelectionBackground: #221c17;
  --vscode-toolbar-hoverBackground: #221c17;
  --vscode-badge-background: #e8792b;
  --vscode-badge-foreground: #140d08;
  --vscode-progressBar-background: #e8792b;
  --vscode-charts-blue: #5aa7ff;
  --vscode-charts-purple: #b58cff;
  --vscode-charts-yellow: #e2b93d;
  --vscode-errorForeground: #ff8a7a;
  --vscode-editorWarning-foreground: #e2b93d;
  --vscode-editor-inactiveSelectionBackground: #221c17;
  --vscode-inputValidation-errorBackground: #3a1714;
  --vscode-inputValidation-errorBorder: #8f3a2e;
  --vscode-textCodeBlock-background: #171310;
  --vscode-textLink-foreground: #7fb0ff;
  --vscode-gitDecoration-addedResourceForeground: #7bc47f;
  --vscode-gitDecoration-deletedResourceForeground: #e06c75;
  --vscode-testing-iconPassed: #7bc47f;
  --vscode-testing-iconFailed: #e06c75;
}`;

/** Adds the theme stylesheet to engine HTML before its own stylesheet. */
function withTheme(html: string): string {
  const link = '<link rel="stylesheet" href="/theme.css">';
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], `${head[0]}${link}`);
  return link + html;
}

function inputPage(requestUrl: URL): string {
  const prompt = requestUrl.searchParams.get('prompt') || '';
  const value = requestUrl.searchParams.get('value') || '';
  const password = requestUrl.searchParams.get('password') === '1';
  const id = requestUrl.searchParams.get('id') || '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Unify</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:18px; background:#0D0B09; color:#e8e2da; font:14px "Segoe UI",system-ui,sans-serif; }
  label { display:block; margin-bottom:8px; color:#b9b0a5; }
  input { width:100%; box-sizing:border-box; padding:9px 10px; border-radius:7px; border:1px solid #3a332c;
          background:#171310; color:#f3ede6; font:inherit; }
  .row { display:flex; gap:8px; justify-content:flex-end; margin-top:14px; }
  button { padding:7px 16px; border-radius:7px; border:1px solid #3a332c; background:#221c17; color:#f3ede6; font:inherit; cursor:pointer; }
  button.primary { background:#e8792b; border-color:#e8792b; color:#140d08; font-weight:600; }
</style></head><body>
<form method="POST" action="/ui/input-submit?token=${encodeURIComponent(assetToken)}&id=${encodeURIComponent(id)}">
  <label for="value">${escapeHtml(prompt) || 'Enter a value'}</label>
  <input id="value" name="value" type="${password ? 'password' : 'text'}" value="${escapeHtml(value)}" autofocus autocomplete="off">
  <div class="row"><button type="submit" name="cancel" value="1" formnovalidate>Cancel</button><button class="primary" type="submit">OK</button></div>
</form>
</body></html>`;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectBody);
  });
}

function startAssetServer(): Promise<void> {
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    try {
      if (requestUrl.pathname === '/health') {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      if (requestUrl.pathname === '/theme.css') {
        response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
        response.end(THEME_CSS);
        return;
      }
      if (requestUrl.pathname === '/legacy') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(withTheme(legacyHtml || '<html><body>Unify engine is starting.</body></html>'));
        return;
      }
      if (requestUrl.pathname === '/ui/input') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(inputPage(requestUrl));
        return;
      }
      if (requestUrl.pathname === '/ui/input-submit') {
        if (requestUrl.searchParams.get('token') !== assetToken) {
          response.writeHead(403).end('forbidden');
          return;
        }
        const id = requestUrl.searchParams.get('id') || '';
        const body = await readBody(request);
        const form = new URLSearchParams(body);
        const cancelled = form.get('cancel') === '1';
        const value = cancelled ? undefined : form.get('value') ?? '';
        promptResolvers.get(id)?.(value);
        promptResolvers.delete(id);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><script>window.close()</script>');
        return;
      }
      if (requestUrl.pathname.startsWith('/asset/')) {
        serveFile(requestUrl, response);
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    } catch (error) {
      mainLog(`asset server: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) response.writeHead(500).end('server error');
      else response.end();
    }
  });
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      assetOrigin = `http://127.0.0.1:${port}`;
      mainLog(`asset server listening on ${assetOrigin}`);
      resolveListen();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Native UI fallback                                                  */
/* ------------------------------------------------------------------ */

function promptWindow(options: { prompt: string; value: string; password: boolean }): Promise<string | undefined> {
  if (!assetOrigin) return Promise.resolve(undefined);
  const id = randomBytes(6).toString('hex');
  const query = new URLSearchParams({
    token: assetToken,
    id,
    prompt: options.prompt,
    value: options.value,
    password: options.password ? '1' : '0',
  });
  const prompt = new BrowserWindow({
    parent: mainWindow,
    modal: !!mainWindow,
    width: 580,
    height: 230,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#0D0B09',
    title: 'Unify',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  prompt.setMenu(null);
  const answer = new Promise<string | undefined>(resolveAnswer => promptResolvers.set(id, resolveAnswer));
  prompt.on('closed', () => {
    const pending = promptResolvers.get(id);
    if (pending) {
      promptResolvers.delete(id);
      pending(undefined);
    }
  });
  void prompt.loadURL(`${assetOrigin}/ui/input?${query.toString()}`);
  return answer;
}

function asStringArray(items: unknown[]): string[] {
  return items.map(item => typeof item === 'string' ? item : String((item as { label?: unknown })?.label ?? ''));
}

/** Quotes a value for a POSIX shell (used by `bash -lc` and Terminal's `do script`). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Escapes a value for a double-quoted AppleScript string literal. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Quotes one argument for cmd.exe (only used with `windowsVerbatimArguments`). */
function cmdArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function nativeUi(): UiAdapter {
  return {
    async showMessage(level, message, detail, items = [], modal = false) {
      const buttons = items.length ? [...items, 'Cancel'] : ['OK'];
      const result = await dialog.showMessageBox(mainWindow!, {
        type: level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info',
        message,
        detail,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true,
        modal,
      });
      if (!items.length) return undefined;
      return result.response < items.length ? items[result.response] : undefined;
    },
    async showInput(options) {
      return promptWindow({
        prompt: String(options.prompt ?? options.title ?? ''),
        value: options.value === undefined ? '' : String(options.value),
        password: options.password === true,
      });
    },
    async showQuickPick(items, options) {
      const labels = asStringArray(items);
      if (!labels.length) return undefined;
      if (labels.length > 6) {
        // Too many buttons for a native message box; the renderer normally
        // answers first, so this is only a last resort.
        return undefined;
      }
      const placeholder = String((options as { placeHolder?: string })?.placeHolder ?? 'Choose an option');
      const result = await dialog.showMessageBox(mainWindow!, {
        type: 'question',
        message: placeholder,
        buttons: [...labels, 'Cancel'],
        defaultId: 0,
        cancelId: labels.length,
        noLink: true,
      });
      return result.response < labels.length ? items[result.response] : undefined;
    },
    async showOpenDialog(options) {
      const canSelectMany = options.canSelectMany === true;
      const canSelectFiles = options.canSelectFiles !== false;
      const canSelectFolders = options.canSelectFolders === true;
      const openOptions: OpenDialogOptions = {
        title: typeof options.title === 'string' ? options.title : undefined,
        defaultPath: typeof options.defaultUri === 'object' && options.defaultUri
          ? (options.defaultUri as Uri).fsPath
          : undefined,
        properties: [
          ...(canSelectMany ? ['multiSelections' as const] : []),
          ...(canSelectFolders && !canSelectFiles ? ['openDirectory' as const] : []),
          ...(canSelectFolders && canSelectFiles ? ['openFile' as const, 'openDirectory' as const] : ['openFile' as const]),
        ],
      };
      const picked = await dialog.showOpenDialog(mainWindow!, openOptions);
      if (picked.canceled) return undefined;
      return picked.filePaths.map(path => Uri.file(path));
    },
    async openExternal(target) {
      await shell.openExternal(target.toString());
      return true;
    },
    async showTextDocument(uri) {
      return createTextEditor(await openTextDocument(uri));
    },
    createTerminal(options) {
      const cwd = options.cwd || projectPath;
      const name = options.name || 'Terminal';
      let showTimer: NodeJS.Timeout | undefined;

      const launch = (command: string, args: string[], verbatim = false): void => {
        try {
          const child = spawn(command, args, {
            cwd,
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
            windowsVerbatimArguments: verbatim,
          });
          child.on('error', error => mainLog(`terminal: ${error.message}`));
        } catch (error) {
          mainLog(`terminal: ${error instanceof Error ? error.message : String(error)}`);
        }
      };

      /** Opens a terminal in `cwd`; with `text`, that terminal runs it and stays open. */
      const open = (text?: string): void => {
        if (process.platform === 'win32') {
          if (!text) {
            launch('cmd.exe', ['/c', 'start', cmdArgument(name), 'cmd.exe'], true);
            return;
          }
          // Passing the commands through a batch file keeps quoting and
          // special characters out of cmd.exe's command line.
          const scriptPath = join(tmpdir(), `unify-terminal-${randomBytes(6).toString('hex')}.cmd`);
          writeFileSync(scriptPath, `@echo off\r\ncd /d "${cwd}"\r\n${text}\r\n`, 'utf8');
          launch('cmd.exe', ['/c', 'start', cmdArgument(name), 'cmd.exe', '/k', cmdArgument(scriptPath)], true);
        } else if (process.platform === 'darwin') {
          if (!text) {
            launch('open', ['-a', 'Terminal', cwd]);
            return;
          }
          const command = `cd ${shellQuote(cwd)}; ${text}`;
          launch('osascript', ['-e', `tell application "Terminal" to do script ${appleScriptString(command)}`]);
        } else if (!text) {
          launch('x-terminal-emulator', []);
        } else {
          const command = `cd ${shellQuote(cwd)} && ${text}; exec bash`;
          launch('x-terminal-emulator', ['-e', 'bash', '-lc', command]);
        }
      };

      const cancelPendingShow = (): void => {
        if (!showTimer) return;
        clearTimeout(showTimer);
        showTimer = undefined;
      };

      return {
        name,
        show() {
          cancelPendingShow();
          // A sendText right after show() should fill the only window that opens,
          // so the bare terminal waits a moment for it.
          showTimer = setTimeout(() => {
            showTimer = undefined;
            open();
          }, 150);
        },
        sendText(text: string) {
          cancelPendingShow();
          open(text);
        },
        dispose() {
          cancelPendingShow();
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Renderer bridge                                                     */
/* ------------------------------------------------------------------ */

/** Sends a message to the main window, buffering it until that window has loaded. */
function sendToMainWindow(message: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!windowLoaded) {
    bufferedMessages.push(message);
    return;
  }
  mainWindow.webContents.send('unify:message', message);
}

/**
 * Engine messages go to the main window and to every loaded pop-out. A pop-out
 * that is still loading keeps its own buffer until `did-finish-load`.
 */
function sendToRenderer(message: unknown): void {
  sendToMainWindow(message);
  for (const [chatId, window] of popoutWindows) {
    if (window.isDestroyed()) continue;
    if (!popoutLoaded.get(chatId)) {
      popoutMessages.get(chatId)?.push(message);
      continue;
    }
    window.webContents.send('unify:message', message);
  }
}

/**
 * Delivers a UI request on both channels: `unify:message` keeps the legacy
 * sidebar working, and `unify:ui-request` is what the preload's
 * `onUiRequest()` listener subscribes to. Pop-outs never answer UI requests,
 * so these go to the main window only.
 */
function sendUiRequest(request: UiRequest): void {
  sendToMainWindow({ type: 'uiRequest', request });
  if (!mainWindow || mainWindow.isDestroyed() || !windowLoaded) return;
  mainWindow.webContents.send('unify:ui-request', request);
}

/** Sends the engine messages a freshly loaded pop-out buffered while loading. */
function flushPopoutMessages(chatId: string): void {
  const window = popoutWindows.get(chatId);
  if (!window || window.isDestroyed()) return;
  for (const message of popoutMessages.get(chatId)?.splice(0) ?? []) {
    window.webContents.send('unify:message', message);
  }
}

function flushRendererMessages(): void {
  if (mainWindow) {
    for (const message of bufferedMessages.splice(0)) mainWindow.webContents.send('unify:message', message);
  }
  for (const chatId of popoutWindows.keys()) {
    if (popoutLoaded.get(chatId)) flushPopoutMessages(chatId);
  }
}

/** Tells the main window which chats currently have a pop-out (the preload forwards this). */
function announcePopouts(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('unify:popouts', [...popoutWindows.keys()]);
}

function closePopouts(): void {
  for (const window of [...popoutWindows.values()]) {
    if (!window.isDestroyed()) window.close();
  }
}

function persistRendererState(): void {
  writeJson(rendererStatePath, { value: rendererState ?? null });
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

/** Options every Unify shell window shares (main window and pop-outs). */
function shellWindowOptions(): BrowserWindowConstructorOptions {
  return {
    show: false,
    // macOS keeps its traffic lights, inset into the custom drag strip; the
    // other platforms draw their own window buttons in the renderer.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 16 } }
      : { frame: false }),
    backgroundColor: '#0D0B09',
    title: 'Unify',
    icon: join(extensionPath, 'build', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only needs `electron` (no Node built-ins), so the shell can
      // run sandboxed like Electron recommends.
      sandbox: true,
      spellcheck: false,
    },
  };
}

/** Chrome shared by every shell window: external links and the maximize state the renderer draws. */
function attachWindowChrome(window: BrowserWindow): void {
  if (process.platform !== 'darwin') window.setMenu(null);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.on('maximize', () => window.webContents.send('unify:maximized', true));
  window.on('unmaximize', () => window.webContents.send('unify:maximized', false));
}

function loadShell(window: BrowserWindow): Promise<void> {
  if (isDev) {
    mainLog(`loading dev renderer ${devUrl}`);
    return window.loadURL(devUrl);
  }
  const built = join(extensionPath, 'dist', 'renderer', 'index.html');
  if (!cli.legacy && existsSync(built)) {
    mainLog(`loading built renderer ${built}`);
    return window.loadFile(built);
  }
  mainLog(`loading legacy sidebar ${assetOrigin}/legacy`);
  return window.loadURL(`${assetOrigin}/legacy?token=${assetToken}`);
}

/** Loads the same renderer in pop-out mode, with `?popout=<chatId>` in its URL. */
function loadPopoutShell(window: BrowserWindow, chatId: string): Promise<void> {
  if (isDev) {
    const separator = devUrl.includes('?') ? '&' : '?';
    const url = `${devUrl}${separator}popout=${encodeURIComponent(chatId)}`;
    mainLog(`loading dev pop-out ${url}`);
    return window.loadURL(url);
  }
  const built = join(extensionPath, 'dist', 'renderer', 'index.html');
  mainLog(`loading pop-out renderer ${built} for ${chatId}`);
  return window.loadFile(built, { query: { popout: chatId } });
}

/**
 * Opens a chat in its own window, or focuses the window already showing it.
 * The legacy sidebar has no pop-out mode, so it only logs there.
 */
function openPopout(chatId: string): void {
  const existing = popoutWindows.get(chatId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }
  const built = join(extensionPath, 'dist', 'renderer', 'index.html');
  if (cli.legacy || (!isDev && !existsSync(built))) {
    mainLog(`pop-out windows need the built renderer; ignoring ${chatId}`);
    return;
  }

  const mainBounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : undefined;
  const window = new BrowserWindow({
    ...shellWindowOptions(),
    width: 560,
    height: 760,
    minWidth: 380,
    minHeight: 420,
    ...(mainBounds ? { x: mainBounds.x + 48, y: mainBounds.y + 48 } : {}),
  });
  attachWindowChrome(window);
  window.once('ready-to-show', () => window.show());
  popoutWindows.set(chatId, window);
  popoutLoaded.set(chatId, false);
  popoutMessages.set(chatId, []);
  announcePopouts();

  window.webContents.on('did-finish-load', () => {
    popoutLoaded.set(chatId, true);
    flushPopoutMessages(chatId);
    mainLog(`pop-out loaded ${window.webContents.getURL()}`);
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    mainLog(`pop-out preload failed (${preloadPath}): ${error.message}`);
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    mainLog(`pop-out failed to load (${code} ${description}) ${url}`);
  });
  window.on('closed', () => {
    // A stale close event must not remove a newer window for the same chat.
    if (popoutWindows.get(chatId) !== window) return;
    popoutWindows.delete(chatId);
    popoutLoaded.delete(chatId);
    popoutMessages.delete(chatId);
    announcePopouts();
  });
  loadPopoutShell(window, chatId).catch(error => {
    mainLog(`pop-out load failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function createApplicationMenu(): void {
  // macOS needs an application menu for Quit/Hide and an Edit menu so the
  // standard copy/paste shortcuts work. Windows and Linux keep the frameless
  // shell's custom title bar and no menu.
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...shellWindowOptions(),
    width: 1320,
    height: 900,
    minWidth: 900,
    minHeight: 620,
  });
  attachWindowChrome(window);
  window.once('ready-to-show', () => window.show());
  window.webContents.on('did-finish-load', () => {
    windowLoaded = true;
    flushRendererMessages();
    mainLog(`shell loaded ${window.webContents.getURL()}`);
    if (process.env.UNIFY_DEBUG_BRIDGE === '1') {
      void window.webContents.executeJavaScript('typeof window.unify')
        .then(kind => mainLog(`preload bridge: ${kind}`))
        .catch(error => mainLog(`preload bridge check failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    mainLog(`preload failed (${preloadPath}): ${error.message}`);
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    mainLog(`shell failed to load (${code} ${description}) ${url}`);
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined;
      // Pop-outs are views of the same engine; closing the shell closes them.
      closePopouts();
    }
  });
  return window;
}

async function captureScreenshot(window: BrowserWindow): Promise<void> {
  await new Promise(resolveDelay => setTimeout(resolveDelay, cli.screenshotDelay));
  try {
    const image = await window.webContents.capturePage();
    const target = resolve(cli.screenshot!);
    mkdirSync(join(target, '..'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(target, image.toPNG());
    console.log(`SCREENSHOT ${target}`);
    mainLog(`screenshot written to ${target}`);
  } catch (error) {
    console.error(`SCREENSHOT_FAILED ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!cli.keepOpen) {
    setTimeout(() => app.quit(), 400);
  }
}

/**
 * Screenshot of the primary display for the composer's attachment flow.
 * Every visible Unify window is hidden for a moment so the app does not cover
 * what the user is trying to capture, then shown again in `finally`.
 */
async function capturePrimaryScreen(): Promise<{ dataUrl: string; width: number; height: number } | undefined> {
  const windows = [
    ...(mainWindow && !mainWindow.isDestroyed() ? [mainWindow] : []),
    ...[...popoutWindows.values()].filter(window => !window.isDestroyed()),
  ];
  const hidden: BrowserWindow[] = [];
  try {
    for (const window of windows) {
      if (window.isVisible() && !window.isMinimized()) {
        window.hide();
        hidden.push(window);
      }
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));

    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    });
    const source = sources.find(item => String(item.display_id) === String(display.id)) ?? sources[0];
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) return undefined;
    const size = source.thumbnail.getSize();
    return { dataUrl: source.thumbnail.toDataURL(), width: size.width, height: size.height };
  } catch (error) {
    mainLog(`screen capture failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    for (const window of hidden) {
      if (!window.isDestroyed()) window.show();
    }
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function installIpc(): void {
  ipcMain.on('unify:post', (_event, message: unknown) => {
    receiveRendererMessage(message);
  });
  ipcMain.on('unify:window', (event, action: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    if (action === 'minimize') window.minimize();
    else if (action === 'maximize') {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    } else if (action === 'close') window.close();
  });
  ipcMain.handle('unify:is-maximized', event => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
  ipcMain.handle('unify:pick-folder', async () => {
    if (!mainWindow) return undefined;
    const picked = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Open project folder' });
    return picked.canceled ? undefined : picked.filePaths[0];
  });
  // Files screen "Delete": moves a project entry to the OS trash / Recycle Bin, so it can be restored.
  const projectItem = (root: unknown, relative: unknown): string => {
    if (typeof root !== 'string' || typeof relative !== 'string' || !root || !relative) throw new Error('Invalid path.');
    const parts = relative.replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length || parts.some(part => part === '..' || part.includes(':')) || relative.includes('\0')) throw new Error('Invalid path.');
    const base = resolve(root);
    const target = resolve(base, ...parts);
    if (!target.startsWith(base + sep)) throw new Error('Invalid path.');
    if (!existsSync(target)) throw new Error(`Nothing at ${relative}.`);
    return target;
  };
  ipcMain.handle('unify:trash-item', async (_event, root: unknown, relative: unknown) => {
    await shell.trashItem(projectItem(root, relative));
  });
  // Files screen "Reveal in File Explorer": opens the OS file manager with the entry selected.
  ipcMain.handle('unify:reveal-item', (_event, root: unknown, relative: unknown) => {
    shell.showItemInFolder(projectItem(root, relative));
  });
  ipcMain.on('unify:set-project', (_event, nextPath: unknown) => {
    if (typeof nextPath !== 'string' || !nextPath) return;
    writeJson(windowStatePath, { ...savedWindowState, project: resolve(nextPath) });
    mainLog(`switching project to ${nextPath}`);
    app.relaunch();
    app.exit(0);
  });
  ipcMain.on('unify:open-external', (_event, url: unknown) => {
    if (typeof url === 'string' && /^https?:|^mailto:/.test(url)) void shell.openExternal(url);
  });
  ipcMain.on('unify:notify', (_event, payload: { title?: unknown; body?: unknown }) => {
    const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
    if (!title) return;
    const body = typeof payload.body === 'string' && payload.body.trim() ? payload.body.trim() : undefined;
    showNotification(title, body);
  });
  ipcMain.on('unify:state-get', event => {
    event.returnValue = rendererState;
  });
  ipcMain.on('unify:state-set', (event, value: unknown) => {
    // A pop-out is a second view of the main window's state; never let it
    // persist a state the main window did not choose.
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return;
    rendererState = value;
    persistRendererState();
  });
  ipcMain.on('unify:project-path', event => {
    event.returnValue = projectPath;
  });
  ipcMain.on('unify:popout', (_event, chatId: unknown) => {
    if (typeof chatId !== 'string' || !chatId) return;
    openPopout(chatId);
  });
  ipcMain.handle('unify:popouts-get', () => [...popoutWindows.keys()]);
  ipcMain.handle('unify:capture-screen', () => capturePrimaryScreen());
  ipcMain.handle('unify:pick-context-folder', async event => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const options: OpenDialogOptions = {
      title: 'Add a folder as context',
      defaultPath: projectPath,
      properties: ['openDirectory'],
    };
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    return picked.canceled ? undefined : picked.filePaths[0];
  });
  ipcMain.handle('unify:setup-status', () => shimSetupStatus());
  ipcMain.handle('unify:check-for-updates', () => checkForUpdatesNow());
  ipcMain.on('unify:ui-response', (_event, payload: { id?: string; result?: unknown }) => {
    if (!payload?.id) return;
    pendingUi.get(payload.id)?.(payload.result);
    pendingUi.delete(payload.id);
  });
  registerTerminalIpc(() => projectPath);
  registerGitIpc(() => projectPath);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function requestUiFromRenderer(request: UiRequest): Promise<unknown> {
  return new Promise(resolveRequest => {
    const timer = setTimeout(() => {
      pendingUi.delete(request.id);
      resolveRequest(undefined);
    }, 1200);
    pendingUi.set(request.id, result => {
      clearTimeout(timer);
      resolveRequest(result);
    });
    sendUiRequest(request);
  });
}

async function boot(): Promise<void> {
  createApplicationMenu();
  app.setAppUserModelId('dev.unify.app');

  try {
    installMediaProtocol();
  } catch (error) {
    mainLog(`media protocol failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  await startAssetServer();

  const secrets = new FileSecrets(join(stateRoot, 'secrets.json'));
  configureGithubSecretStore(secrets);
  const { context, setup } = prepareUnify({
    extensionPath,
    stateRoot,
    globalStoragePath,
    projectPath,
    packageDefaults: readPackageDefaults(),
    secrets,
    logsPath,
  });
  setUiAdapter(nativeUi());
  configureNotifications(showNotification);
  installIpc();

  rendererState = readJson<{ value?: unknown }>(rendererStatePath, {}).value;

  mainWindow = createWindow();

  try {
    activate(context);
  } catch (error) {
    mainLog(`engine activate failed: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`);
  }

  try {
    const html = await bootWebview({
      post: message => sendToRenderer(message),
      requestUi: requestUiFromRenderer,
      cspSource: assetOrigin,
      asWebviewUri: uri => Uri.parse(assetUrlFor(uri.fsPath)),
    });
    legacyHtml = html || fallbackLegacyHtml();
  } catch (error) {
    mainLog(`could not resolve the sidebar provider: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`);
    legacyHtml = fallbackLegacyHtml();
  }

  mainLog(`setup: needsSetup=${setup.needsSetup} accounts=${setup.importedAccounts} oauth=${setup.importedOAuthAccounts} missing=${setup.missing.length} sources=${setup.sources.join(', ')}`);

  await loadShell(mainWindow);
  if (cli.screenshot) void captureScreenshot(mainWindow);
  startUpdater({ notify: showNotification });
}

function readPackageDefaults(): Record<string, unknown> {
  try {
    const packageJson = JSON.parse(readFileSync(join(extensionPath, 'package.json'), 'utf8')) as {
      contributes?: { configuration?: { properties?: Record<string, unknown> } };
    };
    return packageJson.contributes?.configuration?.properties ?? {};
  } catch (error) {
    mainLog(`could not read package.json defaults: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function fallbackLegacyHtml(): string {
  const state = initialSidebarState();
  state.mediaBase = assetUrlFor(join(globalStoragePath, 'media'));
  return getSidebarHtml({ cspSource: assetOrigin }, state, {
    stylesheet: assetUrlFor(join(extensionPath, 'media', 'sidebar.css')),
    script: assetUrlFor(join(extensionPath, 'media', 'sidebar.js')),
    font: assetUrlFor(join(extensionPath, 'media', 'MaterialSymbolsRounded.woff2')),
    markdown: assetUrlFor(join(extensionPath, 'media', 'markdown-it.min.js')),
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  try {
    registerMediaSchemes();
  } catch (error) {
    mainLog(`media schemes failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    boot().catch(error => {
      mainLog(`fatal boot error: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`);
      dialog.showErrorBox('Unify could not start', error instanceof Error ? error.message : String(error));
      app.quit();
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !mainWindow) {
      mainWindow = createWindow();
      void loadShell(mainWindow);
    }
  });

  let shuttingDown = false;
  app.on('before-quit', event => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopUpdater();
    event.preventDefault();
    const saved = deactivate();
    Promise.resolve(saved)
      .catch(() => undefined)
      .finally(() => {
        persistRendererState();
        killAllTerminals();
        app.exit(0);
      });
    // Never hang shutdown on a stuck engine save.
    setTimeout(() => app.exit(0), 3000);
  });

  // app.exit() skips will-quit, so before-quit also kills terminals; this covers any other quit path.
  app.on('will-quit', () => killAllTerminals());

  app.on('window-all-closed', () => {
    // macOS apps stay running with no windows, as the platform expects.
    if (process.platform !== 'darwin') app.quit();
  });
}
