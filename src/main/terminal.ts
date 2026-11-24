/**
 * Integrated terminals: node-pty shell sessions owned by the WebContents that created them.
 *
 * The renderer picks a session id (its pane id). Output is batched per session and sent back on
 * `unify:term-data`; the shell's exit arrives on `unify:term-exit`. Sessions die with their WebContents
 * (destroyed, reloaded, or crashed), so a reload never leaves orphaned shells behind.
 *
 * node-pty is a native module: it is loaded lazily inside the create handler, so a missing build only
 * breaks terminals, not the app.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

interface Disposable {
  dispose(): void;
}

interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): PtyProcess;
}

interface Session {
  id: string;
  pty: PtyProcess;
  pending: string;
  flushTimer?: ReturnType<typeof setTimeout>;
  subscriptions: Disposable[];
}

/** `cwd` is the folder the shell actually started in (the requested one, else the project, else home). */
type TerminalResult = { ok: true; shell: string; cwd: string } | { ok: false; error: string };

const FLUSH_MS = 8;
const MAX_ID_LENGTH = 200;
const MAX_DIMENSION = 1000;
const MAX_INPUT_LENGTH = 1024 * 1024;

const sessions = new Map<WebContents, Map<string, Session>>();
const tracked = new WeakSet<WebContents>();
let nodePty: NodePtyModule | undefined;

function loadNodePty(): NodePtyModule {
  if (!nodePty) nodePty = require('node-pty') as NodePtyModule;
  return nodePty;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_DIMENSION;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs an IPC handler body so that nothing it throws escapes into Electron. */
function guard(label: string, body: () => void): void {
  try {
    body();
  } catch (error) {
    console.error(`[unify] terminal ${label} failed: ${describe(error)}`);
  }
}

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.UNIFY_SHELL || findOnPath('pwsh.exe') || 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveCwd(requested: unknown, getProjectPath: () => string | undefined): string {
  if (typeof requested === 'string' && requested && isDirectory(requested)) return requested;
  let project: string | undefined;
  try {
    project = getProjectPath();
  } catch {
    project = undefined;
  }
  if (project && isDirectory(project)) return project;
  return homedir();
}

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

function sessionsFor(owner: WebContents): Map<string, Session> {
  let map = sessions.get(owner);
  if (!map) {
    map = new Map();
    sessions.set(owner, map);
  }
  return map;
}

function send(owner: WebContents, channel: string, ...args: unknown[]): void {
  if (owner.isDestroyed()) return;
  owner.send(channel, ...args);
}

function disposeSession(session: Session): void {
  if (session.flushTimer) clearTimeout(session.flushTimer);
  session.flushTimer = undefined;
  for (const subscription of session.subscriptions) subscription.dispose();
  session.subscriptions = [];
  try {
    session.pty.kill();
  } catch {
    // The shell already exited.
  }
}

function killSession(owner: WebContents, id: string): void {
  const map = sessions.get(owner);
  const session = map?.get(id);
  if (!map || !session) return;
  map.delete(id);
  disposeSession(session);
}

function killAllFor(owner: WebContents): void {
  const map = sessions.get(owner);
  if (!map) return;
  for (const id of [...map.keys()]) killSession(owner, id);
}

/** Sends pending output for the session, if any. */
function flush(owner: WebContents, session: Session): void {
  if (session.flushTimer) clearTimeout(session.flushTimer);
  session.flushTimer = undefined;
  if (!session.pending) return;
  const data = session.pending;
  session.pending = '';
  send(owner, 'unify:term-data', session.id, data);
}

function queueData(owner: WebContents, session: Session, data: string): void {
  session.pending += data;
  if (session.flushTimer) return;
  session.flushTimer = setTimeout(() => flush(owner, session), FLUSH_MS);
}

/** Starts the lifecycle hooks for a WebContents once: its sessions die with it. */
function track(owner: WebContents): void {
  if (tracked.has(owner)) return;
  tracked.add(owner);
  owner.once('destroyed', () => {
    killAllFor(owner);
    sessions.delete(owner);
  });
  owner.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) killAllFor(owner);
  });
  owner.on('render-process-gone', () => killAllFor(owner));
}

function createSession(owner: WebContents, payload: Record<string, unknown>, getProjectPath: () => string | undefined): TerminalResult {
  const id = payload.id as string;
  const cols = payload.cols as number;
  const rows = payload.rows as number;
  track(owner);
  killSession(owner, id);

  const shell = resolveShell();
  const cwd = resolveCwd(payload.cwd, getProjectPath);
  const pty = loadNodePty().spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: buildEnv(),
  });

  const session: Session = { id, pty, pending: '', subscriptions: [] };
  session.subscriptions.push(pty.onData(data => queueData(owner, session, data)));
  session.subscriptions.push(
    pty.onExit(({ exitCode }) => {
      // A killed or replaced session is no longer in the map; its exit is not reported.
      if (sessions.get(owner)?.get(id) !== session) return;
      flush(owner, session);
      sessions.get(owner)?.delete(id);
      for (const subscription of session.subscriptions) subscription.dispose();
      session.subscriptions = [];
      send(owner, 'unify:term-exit', id, typeof exitCode === 'number' ? exitCode : -1);
    }),
  );
  sessionsFor(owner).set(id, session);
  return { ok: true, shell: shell.file, cwd };
}

/** Installs the `unify:term-*` IPC channels. `getProjectPath` supplies the default working directory. */
export function registerTerminalIpc(getProjectPath: () => string | undefined): void {
  ipcMain.handle('unify:term-create', (event: IpcMainInvokeEvent, payload: unknown): TerminalResult => {
    const fail = (error: string): TerminalResult => ({ ok: false, error });
    if (!payload || typeof payload !== 'object') return fail('Invalid terminal request.');
    const request = payload as Record<string, unknown>;
    if (!isId(request.id)) return fail('Invalid terminal id.');
    if (!isDimension(request.cols) || !isDimension(request.rows)) return fail('Invalid terminal size.');
    try {
      return createSession(event.sender, request, getProjectPath);
    } catch (error) {
      console.error(`[unify] terminal create failed: ${describe(error)}`);
      return fail(`Could not start a terminal: ${describe(error)}`);
    }
  });

  ipcMain.on('unify:term-input', (event: IpcMainEvent, id: unknown, data: unknown) => {
    guard('input', () => {
      if (!isId(id) || typeof data !== 'string' || data.length > MAX_INPUT_LENGTH) return;
      sessions.get(event.sender)?.get(id)?.pty.write(data);
    });
  });

  ipcMain.on('unify:term-resize', (event: IpcMainEvent, id: unknown, cols: unknown, rows: unknown) => {
    guard('resize', () => {
      if (!isId(id) || !isDimension(cols) || !isDimension(rows)) return;
      sessions.get(event.sender)?.get(id)?.pty.resize(cols, rows);
    });
  });

  ipcMain.on('unify:term-kill', (event: IpcMainEvent, id: unknown) => {
    guard('kill', () => {
      if (!isId(id)) return;
      killSession(event.sender, id);
    });
  });
}

/** Kills every terminal session (app quit). */
export function killAllTerminals(): void {
  for (const owner of [...sessions.keys()]) killAllFor(owner);
}
