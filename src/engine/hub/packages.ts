/**
 * System packages a pack's setup steps name (`install` in setup.json): which installer fits this platform, the
 * exact command Unify runs (shown to the user before it runs), finding a program after it was installed, and
 * running the installer.
 *
 * Installers: Windows `winget`, macOS `brew`, then `pip --user` on any platform. Windows installers usually add
 * their folder to the PATH saved in the registry, which this process does not see until it restarts, so lookups
 * read the saved PATH too and `refreshPath` merges it into `process.env.PATH` after an install.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PackSetupInstall } from './types';

/** Installers download and can wait on a UAC prompt, so one package gets ten minutes. */
export const PACKAGE_INSTALL_TIMEOUT = 600_000;

export interface PackageCommand {
  manager: 'winget' | 'brew' | 'pip';
  id: string;
  /** What the user is shown, e.g. `winget install --id ImageMagick.ImageMagick --exact`. */
  display: string;
}

export interface PackageResult {
  ok: boolean;
  /** The last non-empty output line, or the reason it failed. */
  lastLine?: string;
}

const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._+\-[\],=<>@/]*$/;

/** The installer this platform uses for a step's package, or undefined when none of its ids fit. */
export function packageCommandFor(install: PackSetupInstall | undefined, platform: NodeJS.Platform = process.platform): PackageCommand | undefined {
  if (!install) return undefined;
  if (platform === 'win32' && install.winget) {
    return { manager: 'winget', id: install.winget, display: `winget install --id ${install.winget} --exact` };
  }
  if (platform === 'darwin' && install.brew) {
    return { manager: 'brew', id: install.brew, display: `brew install ${install.brew}` };
  }
  if (install.pip) {
    return { manager: 'pip', id: install.pip, display: `python -m pip install --user "${install.pip}"` };
  }
  return undefined;
}

export function isValidPackageId(id: string): boolean {
  return PACKAGE_ID.test(id);
}

let savedWindowsPath: { value: string[]; at: number } | undefined;

/** The Machine + User PATH saved in the registry (Windows only), cached for a few seconds. */
function windowsSavedPath(): string[] {
  if (process.platform !== 'win32') return [];
  if (savedWindowsPath && Date.now() - savedWindowsPath.at < 5_000) return savedWindowsPath.value;
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  const value = result.status === 0 ? result.stdout.split(';').map(item => item.trim()).filter(Boolean) : [];
  savedWindowsPath = { value, at: Date.now() };
  return value;
}

function wingetLinks(): string[] {
  const local = process.env.LOCALAPPDATA;
  return process.platform === 'win32' && local ? [path.join(local, 'Microsoft', 'WinGet', 'Links')] : [];
}

/** Where `pip install --user` puts programs; usually not on PATH. */
function pythonUserScripts(): string[] {
  if (process.platform !== 'win32') return [path.join(os.homedir(), '.local', 'bin')];
  const dirs: string[] = [];
  const bases = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'Python'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'),
  ].filter((item): item is string => !!item);
  for (const base of bases) {
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^Python3/i.test(entry.name)) dirs.push(path.join(base, entry.name, 'Scripts'));
      }
    } catch {
      // No Python installed there.
    }
  }
  return dirs;
}

function searchDirs(): string[] {
  const current = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  const extra = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  return [...new Set([...current, ...windowsSavedPath(), ...wingetLinks(), ...extra, ...pythonUserScripts()])];
}

/**
 * Whether a program file is there. Windows app execution aliases (winget, python in WindowsApps) are reparse
 * points that `stat` can't open (EACCES), so `existsSync` says no; `lstat` reads the link itself.
 */
function programExists(candidate: string): boolean {
  if (existsSync(candidate)) return true;
  if (process.platform !== 'win32') return false;
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Where a program is, looking in PATH, the saved Windows PATH and installer folders. */
export function findCommand(name: string): string | undefined {
  if (!name || /[\\/]/.test(name)) return undefined;
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const hasExtension = process.platform === 'win32' && extensions.some(ext => name.toLowerCase().endsWith(ext.toLowerCase()));
  for (const dir of searchDirs()) {
    for (const ext of hasExtension ? [''] : extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (programExists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Adds folders from the saved Windows PATH to this process, so packs started later find new programs. */
export function refreshPath(): void {
  if (process.platform !== 'win32') return;
  savedWindowsPath = undefined;
  const key = Object.keys(process.env).find(name => name.toLowerCase() === 'path') ?? 'Path';
  const current = (process.env[key] ?? '').split(';').filter(Boolean);
  const known = new Set(current.map(item => item.toLowerCase()));
  const added = [...windowsSavedPath(), ...wingetLinks()].filter(item => !known.has(item.toLowerCase()));
  if (added.length) process.env[key] = [...current, ...added].join(';');
}

function lastLine(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^[-\\|/ ]+$/.test(line));
  return lines.length ? lines[lines.length - 1].slice(0, 500) : undefined;
}

function run(command: string, args: string[], timeout: number): Promise<{ code: number | null; output: string; error?: string }> {
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null, `The installer took longer than ${Math.round(timeout / 60_000)} minutes.`);
    }, timeout);
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-16_000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', error => finish(null, error.message));
    child.once('close', code => finish(code));
  });
}

/** The Python a pip package needs when none is installed, or undefined on platforms without an installer. */
export function pythonCommandFor(platform: NodeJS.Platform = process.platform): PackageCommand | undefined {
  if (platform === 'win32') return packageCommandFor({ winget: 'Python.Python.3.12' }, platform);
  if (platform === 'darwin') return packageCommandFor({ brew: 'python@3.12' }, platform);
  return undefined;
}

/** Whether a package command installs Python itself (a pack may list Python as its own step). */
export function isPythonPackage(command: PackageCommand): boolean {
  if (command.manager === 'winget') return /^Python\.Python\./i.test(command.id);
  if (command.manager === 'brew') return /^python(@|$)/i.test(command.id);
  return false;
}

/** Python installs winget puts outside PATH until the process restarts (per user, then for all users). */
function windowsPythonInstalls(): string[] {
  if (process.platform !== 'win32') return [];
  const bases = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'),
    process.env.ProgramFiles,
  ].filter((item): item is string => !!item);
  const found: string[] = [];
  for (const base of bases) {
    try {
      const entries = readdirSync(base, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^Python3\d*$/i.test(entry.name))
        .map(entry => entry.name)
        .sort()
        .reverse();
      for (const name of entries) {
        const candidate = path.join(base, name, 'python.exe');
        if (existsSync(candidate)) found.push(candidate);
      }
    } catch {
      // No Python installed there.
    }
  }
  return found;
}

/** A Python 3 that can run pip: the `py` launcher first on Windows. */
function findPython(): { command: string; prefix: string[] } | undefined {
  const candidates: { name: string; prefix: string[] }[] = process.platform === 'win32'
    ? [{ name: 'py', prefix: ['-3'] }, { name: 'python', prefix: [] }]
    : [{ name: 'python3', prefix: [] }, { name: 'python', prefix: [] }];
  for (const candidate of candidates) {
    const found = findCommand(candidate.name);
    // The Microsoft Store stub named python.exe only opens the Store.
    if (found && !/WindowsApps/i.test(found)) return { command: found, prefix: candidate.prefix };
  }
  const installed = windowsPythonInstalls()[0];
  return installed ? { command: installed, prefix: [] } : undefined;
}

/** Whether a Python 3 that can run pip is installed. */
export function hasPython(): boolean {
  return !!findPython();
}

/** Runs one package install. Failures are returned, never thrown. */
export async function installPackage(command: PackageCommand, timeout = PACKAGE_INSTALL_TIMEOUT): Promise<PackageResult> {
  if (!isValidPackageId(command.id)) return { ok: false, lastLine: `"${command.id}" is not a valid package id.` };
  let program: string | undefined;
  let args: string[];
  if (command.manager === 'winget') {
    program = findCommand('winget');
    if (!program) return { ok: false, lastLine: 'winget was not found. Install "App Installer" from the Microsoft Store, then try again.' };
    args = ['install', '--id', command.id, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];
  } else if (command.manager === 'brew') {
    program = findCommand('brew');
    if (!program) return { ok: false, lastLine: 'Homebrew was not found. Install it from https://brew.sh, then try again.' };
    args = ['install', command.id];
  } else {
    const python = findPython();
    if (!python) return { ok: false, lastLine: 'Python 3 was not found. Install it, then try again.' };
    program = python.command;
    args = [...python.prefix, '-m', 'pip', 'install', '--user', '--upgrade', command.id];
  }
  const result = await run(program, args, timeout);
  refreshPath();
  // winget exits non-zero when the package is already installed and has no upgrade.
  const alreadyInstalled = command.manager === 'winget' && /already installed|No available upgrade|No newer package/i.test(result.output);
  const ok = result.code === 0 || alreadyInstalled;
  const line = result.error ?? lastLine(result.output) ?? (ok ? undefined : `${command.manager} exited with code ${result.code}.`);
  return { ok, ...(line ? { lastLine: line } : {}) };
}
