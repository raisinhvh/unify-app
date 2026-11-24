/**
 * The pack setup checklist (`setup.json` in an installed pack folder) and the install-script runner shared with
 * the Hub installer.
 *
 * A pack's install script does every step it can by itself; `setup.json` lists every step, automatic or not, so
 * the UI can show a "Finish setup" checklist. Automatic steps use the last script result (or a `check.exists`
 * path, or a `check.command` program); manual steps are ticked by the user. Steps that name a package (`install`)
 * are installed by Unify itself with winget, brew or pip (hub/packages.ts). Ticks, the last script result and the
 * last package results live in `<packDir>/setup-state.json`, next to the pack.
 *
 * Everything here is plain Node: the shim host is imported only to post progress notices, so tests can point the
 * functions at a temporary folder instead of the user's installed packs.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendLog, postToRenderer } from '../../shim/vscode/host';
import { findCommand, installPackage, isValidPackageId, packageCommandFor, type PackageCommand } from './packages';
import type {
  PackSetupCheck,
  PackSetupDefinition,
  PackSetupInstall,
  PackSetupState,
  PackSetupStep,
  PackSetupStepDefinition,
  PackSetupStepStatus,
} from './types';

import { INSTALL_SCRIPT_NAMES, UNINSTALL_SCRIPT_NAMES } from './scripts';

export { INSTALL_SCRIPT_NAMES, PACK_SCRIPT_NAMES, UNINSTALL_SCRIPT_NAMES } from './scripts';

/** Scripts build Python environments and download tools (Sound, Imaging), so a pack script gets ten minutes. */
export const PACK_SCRIPT_TIMEOUT = 600_000;

interface RunRecord {
  ok: boolean;
  lastLine?: string;
  at?: number;
}

interface PackSetupStateFile {
  ticks: Record<string, boolean>;
  script?: RunRecord;
  /** The last package install per step id. */
  packages?: Record<string, RunRecord>;
}

export interface PackScriptResult {
  ok: boolean;
  /** The last non-empty output line, or the error when the script wrote nothing. */
  lastLine?: string;
  /** Why the script failed; empty when it succeeded. */
  error?: string;
  output: string;
}

function emptyStateFile(): PackSetupStateFile {
  return { ticks: {} };
}

function stateFileFor(packDir: string): string {
  return path.join(packDir, 'setup-state.json');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readStateFile(packDir: string): Promise<PackSetupStateFile> {
  let text: string;
  try {
    text = await fsp.readFile(stateFileFor(packDir), 'utf8');
  } catch {
    return emptyStateFile();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A corrupt state file only loses ticks; it must not break the checklist.
    return emptyStateFile();
  }
  if (!parsed || typeof parsed !== 'object') return emptyStateFile();
  const record = parsed as { ticks?: unknown; script?: unknown; packages?: unknown };
  const ticks: Record<string, boolean> = {};
  if (record.ticks && typeof record.ticks === 'object' && !Array.isArray(record.ticks)) {
    for (const [id, value] of Object.entries(record.ticks as Record<string, unknown>)) {
      if (value === true) ticks[id] = true;
    }
  }
  const script = parseRunRecord(record.script);
  const packages: Record<string, RunRecord> = {};
  if (record.packages && typeof record.packages === 'object' && !Array.isArray(record.packages)) {
    for (const [id, value] of Object.entries(record.packages as Record<string, unknown>)) {
      const parsedRecord = parseRunRecord(value);
      if (parsedRecord) packages[id] = parsedRecord;
    }
  }
  return {
    ticks,
    ...(script ? { script } : {}),
    ...(Object.keys(packages).length ? { packages } : {}),
  };
}

function parseRunRecord(value: unknown): RunRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as { ok?: unknown; lastLine?: unknown; at?: unknown };
  if (typeof record.ok !== 'boolean') return undefined;
  return {
    ok: record.ok,
    ...(typeof record.lastLine === 'string' ? { lastLine: record.lastLine } : {}),
    ...(typeof record.at === 'number' ? { at: record.at } : {}),
  };
}

async function writeStateFile(packDir: string, state: PackSetupStateFile): Promise<void> {
  await fsp.mkdir(packDir, { recursive: true });
  const file = stateFileFor(packDir);
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, file);
}

/** Records the outcome of the last install-script run, where the checklist reads it. */
export async function recordPackScriptResult(packDir: string, ok: boolean, lastLine?: string): Promise<void> {
  const state = await readStateFile(packDir);
  state.script = { ok, ...(lastLine ? { lastLine } : {}), at: Date.now() };
  await writeStateFile(packDir, state);
}

/** Ticks or unticks a manual step; ticks persist in `<packDir>/setup-state.json`. */
export async function setPackSetupStepDone(packDir: string, stepId: string, done: boolean): Promise<void> {
  if (!stepId.trim()) throw new Error('Choose a setup step first.');
  const state = await readStateFile(packDir);
  if (done) state.ticks[stepId] = true;
  else delete state.ticks[stepId];
  await writeStateFile(packDir, state);
}

function lastOutputLine(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return last ? last.slice(0, 500) : undefined;
}

function commandFor(script: string, packDir: string, unifyHome: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined {
  const file = path.join(packDir, script);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UNIFY_PACK_DIR: packDir,
    UNIFY_HOME: unifyHome,
  };
  if (script.endsWith('.js')) {
    // Under Electron `process.execPath` is the Electron binary; this makes it behave as Node.
    env.ELECTRON_RUN_AS_NODE = '1';
    return { command: process.execPath, args: [file], env };
  }
  if (script.endsWith('.ps1')) {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return { command: powershell, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], env };
  }
  if (script.endsWith('.sh')) {
    return { command: 'bash', args: [file], env };
  }
  return undefined;
}

function runScriptProcess(
  packDir: string,
  script: string,
  unifyHome: string,
): Promise<PackScriptResult> {
  const kind = UNINSTALL_SCRIPT_NAMES.includes(script) ? 'uninstall' : 'install';
  const invocation = commandFor(script, packDir, unifyHome);
  if (!invocation) {
    return Promise.resolve({ ok: false, lastLine: `Unsupported ${kind} script "${script}".`, error: `Unsupported ${kind} script "${script}".`, output: '' });
  }
  return new Promise(resolve => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: packDir,
      env: invocation.env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const finish = (ok: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lastLine = lastOutputLine(output) ?? error;
      resolve({ ok, ...(lastLine ? { lastLine } : {}), ...(error ? { error } : {}), output });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false, `The ${kind} script took longer than ${Math.round(PACK_SCRIPT_TIMEOUT / 1000)}s.`);
    }, PACK_SCRIPT_TIMEOUT);
    child.stdout?.on('data', chunk => { if (output.length < 16_000) output += chunk.toString(); });
    child.stderr?.on('data', chunk => { if (output.length < 16_000) output += chunk.toString(); });
    child.once('error', error => finish(false, error.message));
    child.once('close', code => {
      if (code === 0) finish(true);
      else finish(false, `The ${kind} script exited with code ${code}${output ? `: ${output.slice(-2000)}` : '.'}`);
    });
  });
}

/**
 * Runs one install script in the pack folder with a hard timeout and records the result in `setup-state.json`.
 * A failure is returned, not thrown, so both the installer and the checklist decide how to report it.
 */
export async function runPackInstallScript(
  packDir: string,
  script: string,
  options: { unifyHome?: string } = {},
): Promise<PackScriptResult> {
  const unifyHome = options.unifyHome || process.env.UNIFY_HOME || path.join(os.homedir(), '.unify');
  const result = await runScriptProcess(packDir, script, unifyHome);
  await recordPackScriptResult(packDir, result.ok, result.lastLine)
    .catch(error => appendLog(`Could not save the install script result for ${packDir}: ${errorMessage(error)}`));
  return result;
}

async function firstExisting(packDir: string, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    try {
      await fsp.access(path.join(packDir, name));
      return name;
    } catch {
      // Try the next supported name.
    }
  }
  return undefined;
}

/** The install script in a pack folder, if it ships one. */
export function findInstallScript(packDir: string): Promise<string | undefined> {
  return firstExisting(packDir, INSTALL_SCRIPT_NAMES);
}

/** The uninstall script in a pack folder, if it ships one. */
export function findUninstallScript(packDir: string): Promise<string | undefined> {
  return firstExisting(packDir, UNINSTALL_SCRIPT_NAMES);
}

/**
 * Runs the pack's uninstall script, if it has one, with a progress notice; the caller deletes the pack folder
 * afterwards whatever the result, so a failure is reported (notice and log), not thrown. Returns undefined when
 * the pack has no uninstall script.
 */
export async function runPackUninstallScript(
  packDir: string,
  options: { packName?: string; unifyHome?: string } = {},
): Promise<PackScriptResult | undefined> {
  const script = await findUninstallScript(packDir);
  if (!script) return undefined;
  const name = options.packName ?? path.basename(packDir);
  const unifyHome = options.unifyHome || process.env.UNIFY_HOME || path.join(os.homedir(), '.unify');
  const id = `pack-uninstall-${randomUUID()}`;
  const title = `Removing ${name}`;
  postToRenderer({ type: 'progressNotice', id, title, message: `Running ${script}`, state: 'running' });
  const result = await runScriptProcess(packDir, script, unifyHome);
  appendLog(`${name} ${script} -> ${result.ok ? 'ok' : 'failed'}${result.lastLine ? `: ${result.lastLine}` : ''}`);
  postToRenderer({
    type: 'progressNotice',
    id,
    title,
    ...(result.lastLine ? { message: result.lastLine } : {}),
    state: result.ok ? 'done' : 'error',
  });
  return result;
}

function expandTokens(value: string, packDir: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (token, name: string) => {
    if (name === 'PACK') return packDir;
    if (name === 'HOME') return os.homedir();
    const environment = process.env[name];
    return environment !== undefined ? environment : token;
  });
}

function toPlatformPath(value: string): string {
  return value.replace(/\//g, path.sep);
}

function isUrl(value: string): boolean {
  if (path.isAbsolute(toPlatformPath(value))) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

/** Resolves a setup path; relative paths are taken from the pack folder. */
function setupPath(value: string, packDir: string): string {
  const normalized = toPlatformPath(value);
  return path.isAbsolute(normalized) ? normalized : path.resolve(packDir, normalized);
}

/** Expands a displayed path, converting forward slashes only when the value really is a path. */
function displayedPath(value: string, packDir: string): string {
  const expanded = expandTokens(value, packDir);
  if (isUrl(expanded)) return expanded;
  const normalized = toPlatformPath(expanded);
  return path.isAbsolute(normalized) ? normalized : expanded;
}

function parseStep(raw: unknown, index: number, name: string): PackSetupStepDefinition {
  const fail = (detail: string): never => {
    throw new Error(`The setup.json in "${name}" has an invalid step at index ${index}: ${detail}`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('the step must be an object.');
  const step = raw as Record<string, unknown>;
  if (typeof step.id !== 'string' || !step.id.trim()) fail('"id" must be a non-empty string.');
  if (typeof step.title !== 'string' || !step.title.trim()) fail('"title" must be a non-empty string.');
  if (step.kind !== 'auto' && step.kind !== 'manual') fail('"kind" must be "auto" or "manual".');
  for (const key of ['detail', 'copy', 'open'] as const) {
    if (step[key] !== undefined && typeof step[key] !== 'string') fail(`"${key}" must be a string.`);
  }
  let check: PackSetupCheck | undefined;
  if (step.check !== undefined) {
    if (!step.check || typeof step.check !== 'object' || Array.isArray(step.check)) fail('"check" must be an object.');
    const { exists, command } = step.check as Record<string, unknown>;
    const paths = Array.isArray(exists) ? exists : [exists];
    if (exists !== undefined && (!paths.length || paths.some(item => typeof item !== 'string' || !item.trim()))) {
      fail('"check.exists" must be a path or a list of paths.');
    }
    if (command !== undefined && (typeof command !== 'string' || !/^[A-Za-z0-9._+-]+$/.test(command))) {
      fail('"check.command" must be a bare program name.');
    }
    if (exists === undefined && command === undefined) fail('"check" needs "exists" or "command".');
    check = {
      ...(exists !== undefined ? { exists: exists as string | string[] } : {}),
      ...(typeof command === 'string' ? { command } : {}),
    };
  }
  let install: PackSetupInstall | undefined;
  if (step.install !== undefined) {
    if (!step.install || typeof step.install !== 'object' || Array.isArray(step.install)) fail('"install" must be an object.');
    const record = step.install as Record<string, unknown>;
    install = {};
    for (const manager of ['winget', 'brew', 'pip'] as const) {
      const id = record[manager];
      if (id === undefined) continue;
      if (typeof id !== 'string' || !isValidPackageId(id)) fail(`"install.${manager}" must be a package id.`);
      install[manager] = id as string;
    }
    if (!Object.keys(install).length) fail('"install" needs "winget", "brew" or "pip".');
  }
  if (step.optional !== undefined && typeof step.optional !== 'boolean') fail('"optional" must be true or false.');
  let platforms: string[] | undefined;
  if (step.platforms !== undefined) {
    if (!Array.isArray(step.platforms) || step.platforms.some(item => typeof item !== 'string')) {
      fail('"platforms" must be an array of platform names.');
    }
    platforms = step.platforms as string[];
  }
  return {
    id: step.id,
    title: step.title,
    ...(typeof step.detail === 'string' ? { detail: step.detail } : {}),
    kind: step.kind,
    ...(typeof step.copy === 'string' ? { copy: step.copy } : {}),
    ...(typeof step.open === 'string' ? { open: step.open } : {}),
    ...(check ? { check } : {}),
    ...(install ? { install } : {}),
    ...(step.optional === true ? { optional: true } : {}),
    ...(platforms ? { platforms } : {}),
  };
}

function parseDefinition(raw: unknown, name: string): PackSetupDefinition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`The setup.json in "${name}" must contain a "steps" array.`);
  }
  const steps = (raw as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) throw new Error(`The setup.json in "${name}" must contain a "steps" array.`);
  return { steps: steps.map((step, index) => parseStep(step, index, name)) };
}

/** Whether a step's check passes; undefined when it has no check. `missing` says what was not found. */
function checkStep(definition: PackSetupStepDefinition, packDir: string): { passed: boolean; missing?: string } | undefined {
  const check = definition.check;
  if (!check) return undefined;
  if (check.exists) {
    const paths = (Array.isArray(check.exists) ? check.exists : [check.exists])
      .map(item => setupPath(expandTokens(item, packDir), packDir));
    if (paths.some(item => existsSync(item))) return { passed: true };
    if (!check.command) return { passed: false, missing: `${paths[0]} was not found.` };
  }
  if (check.command) {
    if (findCommand(check.command)) return { passed: true };
    return { passed: false, missing: `${check.command} was not found.` };
  }
  return { passed: false };
}

function evaluateStep(definition: PackSetupStepDefinition, state: PackSetupStateFile, packDir: string): PackSetupStep {
  const detail = definition.detail ? expandTokens(definition.detail, packDir) : undefined;
  const copy = definition.copy ? displayedPath(definition.copy, packDir) : undefined;
  const open = definition.open ? displayedPath(definition.open, packDir) : undefined;
  const install = packageCommandFor(definition.install);
  const checked = checkStep(definition, packDir);
  const ticked = state.ticks[definition.id] === true;
  const packageRun = state.packages?.[definition.id];
  let status: PackSetupStepStatus;
  let error: string | undefined;
  if (checked) {
    if (checked.passed) status = 'done';
    else if (definition.kind === 'manual') status = ticked ? 'done' : 'todo';
    else if (definition.optional && !(packageRun && !packageRun.ok)) status = 'todo';
    else {
      status = 'failed';
      error = packageRun && !packageRun.ok && packageRun.lastLine ? packageRun.lastLine : checked.missing;
    }
  } else if (install) {
    // A package without a check is done once its install worked.
    if (packageRun?.ok) status = 'done';
    else if (definition.kind === 'manual') status = ticked ? 'done' : 'todo';
    else if (definition.optional && !packageRun) status = 'todo';
    else {
      status = 'failed';
      error = packageRun?.lastLine || 'Not installed yet.';
    }
  } else if (definition.kind === 'auto') {
    if (state.script?.ok) status = 'done';
    else {
      status = 'failed';
      error = state.script?.lastLine || 'The install script has not run successfully yet.';
    }
  } else {
    status = ticked ? 'done' : 'todo';
  }
  return {
    id: definition.id,
    title: definition.title,
    ...(detail ? { detail } : {}),
    kind: definition.kind,
    ...(copy ? { copy } : {}),
    ...(open ? { open } : {}),
    status,
    ...(error ? { error } : {}),
    ...(install ? { install: install.display } : {}),
    ...(definition.optional ? { optional: true } : {}),
  };
}

/** A pack's parsed `setup.json`, or `null` when it has none; a malformed file throws a clear error. */
async function readDefinition(packDir: string, name: string): Promise<PackSetupDefinition | null> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(packDir, 'setup.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read setup.json in "${name}": ${errorMessage(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`The setup.json in "${name}" is not valid JSON: ${errorMessage(error)}`);
  }
  return parseDefinition(raw, name);
}

function onThisPlatform(step: PackSetupStepDefinition): boolean {
  return !step.platforms || step.platforms.includes(process.platform);
}

export interface PendingPackage {
  stepId: string;
  title: string;
  command: PackageCommand;
}

/**
 * Packages the pack's setup would install on this machine: required steps (or just `stepId`) with a package for
 * this platform whose check does not pass yet. The Hub shows these commands before it installs anything.
 */
export async function pendingPackages(packDir: string, name: string, stepId?: string): Promise<PendingPackage[]> {
  const definition = await readDefinition(packDir, name);
  if (!definition) return [];
  const pending: PendingPackage[] = [];
  for (const step of definition.steps) {
    if (!onThisPlatform(step)) continue;
    if (stepId ? step.id !== stepId : step.optional) continue;
    const command = packageCommandFor(step.install);
    if (!command) continue;
    if (checkStep(step, packDir)?.passed) continue;
    pending.push({ stepId: step.id, title: step.title, command });
  }
  return pending;
}

/**
 * Installs the pending packages (see `pendingPackages`) one at a time, each with a progress notice, and records
 * every result in `setup-state.json`. Failures are recorded, not thrown; the checklist shows them.
 */
export async function installSetupPackages(packDir: string, name: string, stepId?: string): Promise<void> {
  const pending = await pendingPackages(packDir, name, stepId);
  if (stepId && !pending.length) {
    const definition = await readDefinition(packDir, name);
    const step = definition?.steps.find(item => item.id === stepId);
    if (!step || !packageCommandFor(step.install)) throw new Error('This setup step has nothing to install on this computer.');
    return;
  }
  for (const item of pending) {
    const id = `pack-package-${randomUUID()}`;
    const title = `${name}: ${item.title}`;
    postToRenderer({ type: 'progressNotice', id, title, message: item.command.display, state: 'running' });
    const result = await installPackage(item.command);
    appendLog(`${item.command.display} -> ${result.ok ? 'ok' : 'failed'}${result.lastLine ? `: ${result.lastLine}` : ''}`);
    const state = await readStateFile(packDir);
    state.packages = { ...state.packages, [item.stepId]: { ok: result.ok, ...(result.lastLine ? { lastLine: result.lastLine } : {}), at: Date.now() } };
    await writeStateFile(packDir, state)
      .catch(error => appendLog(`Could not save the package result for ${packDir}: ${errorMessage(error)}`));
    postToRenderer({
      type: 'progressNotice',
      id,
      title,
      message: result.ok ? 'Installed' : result.lastLine ?? 'The install failed.',
      state: result.ok ? 'done' : 'error',
    });
  }
}

/**
 * Reads one pack's checklist. Returns `null` when the pack has no `setup.json`; a malformed file throws a clear
 * error instead of showing an empty checklist.
 */
export async function readPackSetup(packDir: string, packId: string, name: string): Promise<PackSetupState | null> {
  const definition = await readDefinition(packDir, name);
  if (!definition) return null;
  const state = await readStateFile(packDir);
  const steps = definition.steps
    .filter(onThisPlatform)
    .map(step => evaluateStep(step, state, packDir));
  // Optional steps never hold setup back from "complete"; they stay listed until done.
  const pending = steps.filter(step => step.status !== 'done' && !step.optional).length;
  const hasPackages = definition.steps.some(step => onThisPlatform(step) && !step.optional && !!packageCommandFor(step.install));
  const canRerunScript = hasPackages || !!(await findInstallScript(packDir));
  return { id: packId, name, steps, pending, canRerunScript };
}

/**
 * Installs any required package that is still missing, then runs the pack's install script again (scripts may
 * need those programs, e.g. Python for the Sound pack), showing a progress notice for its duration. The caller
 * reports the refreshed checklist from `readPackSetup`.
 */
export async function rerunPackSetupScript(
  packDir: string,
  options: { packName?: string; unifyHome?: string } = {},
): Promise<void> {
  const name = options.packName ?? path.basename(packDir);
  const script = await findInstallScript(packDir);
  const packages = await pendingPackages(packDir, name);
  if (!script && !packages.length) {
    if ((await readPackSetup(packDir, path.basename(packDir), name))?.canRerunScript) return;
    throw new Error(`The pack "${name}" has no install script to run.`);
  }
  await installSetupPackages(packDir, name);
  if (script) await runScriptWithNotice(packDir, script, name, options.unifyHome);
}

async function runScriptWithNotice(packDir: string, script: string, name: string, unifyHome?: string): Promise<void> {
  const options = { unifyHome };
  const id = `pack-setup-${randomUUID()}`;
  const title = `Setting up ${name}`;
  postToRenderer({ type: 'progressNotice', id, title, message: `Running ${script}`, state: 'running' });
  const result = await runPackInstallScript(packDir, script, { unifyHome: options.unifyHome });
  postToRenderer({
    type: 'progressNotice',
    id,
    title,
    ...(result.lastLine ? { message: result.lastLine } : {}),
    state: result.ok ? 'done' : 'error',
  });
}

/**
 * Opens a step's URL, folder or file. The extension passes `vscode.env.openExternal`, which handles both file
 * URIs and web URLs; without it, the platform's default opener is used.
 */
export async function openSetupTarget(
  target: string,
  openExternal?: (url: string) => void | Promise<void>,
  packDir?: string,
): Promise<void> {
  const value = target.trim();
  if (!value) throw new Error('This setup step has nothing to open.');
  const pathValue = packDir ? setupPath(value, packDir) : value;
  const resolved = isUrl(value) ? value : toPlatformPath(pathValue);
  if (openExternal) {
    await openExternal(isUrl(resolved) ? resolved : pathToFileURL(resolved).href);
    return;
  }
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', resolved] : [resolved];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
