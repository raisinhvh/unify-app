import { spawn, execFile, ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { terminateProcessTree } from '../runtime/cancellation';
import type { LaunchSpec } from './types';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** Splits raw output into clean log lines: ANSI removed, empty lines dropped. */
export function cleanLines(text: string): string[] {
  return text
    .replace(ANSI, '')
    .split(/[\r\n]+/)
    .filter(line => line.trim().length > 0);
}

/** Turns a byte stream into lines, keeping a partial last line until it completes. */
function lineReader(onLine: (line: string) => void): { push(chunk: Buffer): void; flush(): void } {
  // Keeps a multi-byte character split across two chunks intact.
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return {
    push(chunk) {
      pending += decoder.write(chunk);
      const cut = Math.max(pending.lastIndexOf('\n'), pending.lastIndexOf('\r'));
      if (cut < 0) return;
      const complete = pending.slice(0, cut + 1);
      pending = pending.slice(cut + 1);
      for (const line of cleanLines(complete)) onLine(line);
    },
    flush() {
      pending += decoder.end();
      for (const line of cleanLines(pending)) onLine(line);
      pending = '';
    },
  };
}

/** Writes the spec's files and starts the process. Never uses a shell. */
export function spawnServer(
  spec: LaunchSpec,
  onLine: (line: string) => void,
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void,
): ChildProcessWithoutNullStreams {
  for (const file of spec.files ?? []) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, 'utf8');
  }
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: 'pipe',
    windowsHide: true,
    shell: false,
  });
  const out = lineReader(onLine);
  const err = lineReader(onLine);
  child.stdout.on('data', chunk => out.push(chunk));
  child.stderr.on('data', chunk => err.push(chunk));
  child.stdin.on('error', () => undefined);
  let exited = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    out.flush();
    err.flush();
    onExit(code, signal);
  };
  child.on('error', error => {
    onLine(`Could not start: ${error.message}`);
    finish(null, null);
  });
  child.on('close', finish);
  return child;
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export interface StopOptions {
  /** 'signal' (default): SIGTERM / taskkill without /F. 'stdin-eof': close stdin (PolyStrata's --owner-fd 0). */
  method?: 'signal' | 'stdin-eof';
  /** Kill the whole tree when the grace period runs out (default true). Off = resolve and let it finish exiting by itself. */
  force?: boolean;
}

function askToQuit(child: ChildProcessWithoutNullStreams, method: 'signal' | 'stdin-eof'): void {
  if (method === 'stdin-eof') {
    child.stdin.end();
    return;
  }
  if (process.platform === 'win32' && child.pid) {
    const asker = spawn('taskkill', ['/PID', String(child.pid), '/T'], { windowsHide: true, stdio: 'ignore' });
    asker.on('error', () => undefined);
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
}

function forceKill(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32') {
    terminateProcessTree(child);
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Asks the process to quit, then kills the whole tree after `graceMs` (unless force is off). Resolves once it has exited. */
export function gracefulStop(child: ChildProcessWithoutNullStreams, graceMs: number, options: StopOptions = {}): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise<void>(resolve => {
    let forced: NodeJS.Timeout | undefined;
    let giveUp: NodeJS.Timeout | undefined;
    const finish = () => {
      if (forced) clearTimeout(forced);
      if (giveUp) clearTimeout(giveUp);
      resolve();
    };
    child.once('exit', finish);
    askToQuit(child, options.method ?? 'signal');
    forced = setTimeout(() => {
      if (hasExited(child) || options.force === false) return finish();
      forceKill(child);
      // Never hang forever if the exit event is lost.
      giveUp = setTimeout(finish, 3000);
    }, graceMs);
  });
}

/** True when nothing is listening on the port. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** The first free port from `preferred` upward that is not in `taken`. */
export async function pickPort(preferred: number, taken: Set<number>): Promise<number> {
  for (let port = preferred; port < 65535 && port < preferred + 200; port += 1) {
    if (taken.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  return preferred;
}

function pidFile(runDir: string): string {
  return join(runDir, 'server.pid');
}

/** Remembers the pid and image name so a crashed Unify can clean up later. */
export function writePidFile(runDir: string, pid: number, imageName: string): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(pidFile(runDir), JSON.stringify({ pid, imageName }), 'utf8');
}

export function removePidFile(runDir: string): void {
  rmSync(pidFile(runDir), { force: true });
}

function commandOutput(command: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    execFile(command, args, { windowsHide: true, timeout: 10_000 }, (error, stdout) => resolve(error ? '' : String(stdout)));
  });
}

/** The image name of a live process, or '' when the pid is not running. */
async function runningImage(pid: number): Promise<string> {
  if (process.platform === 'win32') {
    const text = await commandOutput('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const match = /^"([^"]+)","(\d+)"/m.exec(text);
    return match && Number(match[2]) === pid ? match[1] : '';
  }
  return (await commandOutput('ps', ['-p', String(pid), '-o', 'comm='])).trim();
}

/** Force-kills a server left over from a previous run, when the pid still belongs to the same program. */
export async function killOrphan(runDir: string): Promise<boolean> {
  let recorded: { pid?: number; imageName?: string };
  try {
    recorded = JSON.parse(readFileSync(pidFile(runDir), 'utf8'));
  } catch {
    return false;
  }
  removePidFile(runDir);
  if (!recorded.pid || !recorded.imageName) return false;
  const image = await runningImage(recorded.pid);
  if (!image || image.toLowerCase() !== recorded.imageName.toLowerCase()) return false;
  if (process.platform === 'win32') {
    await commandOutput('taskkill', ['/PID', String(recorded.pid), '/T', '/F']);
  } else {
    try {
      process.kill(recorded.pid, 'SIGKILL');
    } catch {
      // Gone already.
    }
  }
  return true;
}
