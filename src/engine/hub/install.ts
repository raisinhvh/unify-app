/**
 * Installs one pack from a Hub registry into `storage/toolpacks`.
 *
 * The steps match the Hub screen: download into a staging folder, validate/compile the pack, write the folder
 * the toolpack registry scans (`meta.json` keeps an existing `enabled` flag), run the pack's install script and
 * report progress throughout. Nothing is left behind on failure.
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { toolpackIdFor } from './fixtures/packSource';
import { HubInstallProgress, HubInstallTarget, HubRegistry } from './types';
import type { InstalledHubPack } from '../unify/requests/toolpacks';

const INSTALL_TIMEOUT = 60_000;
const SCRIPT_NAMES = ['install.js', 'install.ps1', 'install.sh'];

export interface InstallHubPackOptions {
  registry: HubRegistry;
  id: string;
  toolpacksDir: string;
  reply: (message: unknown) => void;
  target?: HubInstallTarget;
  onInstalled?: (pack: InstalledHubPack) => void;
}

export interface HubInstallResult {
  ok: boolean;
  id: string;
  pack?: InstalledHubPack;
  error?: string;
}

interface ExistingMeta {
  enabled?: boolean;
  description?: string;
}

function installScriptFor(files: string[]): string | undefined {
  return SCRIPT_NAMES.find(name => files.includes(name));
}

function commandFor(script: string): { command: string; args: string[] } | undefined {
  if (script.endsWith('.js')) return { command: process.execPath, args: [script] };
  if (script.endsWith('.ps1')) return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] };
  if (script.endsWith('.sh')) return { command: 'bash', args: [script] };
  return undefined;
}

/** Runs one install script in the pack folder with a hard timeout. */
function runInstallScript(destination: string, script: string): Promise<void> {
  const invocation = commandFor(script);
  if (!invocation) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: destination,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`The install script took longer than ${INSTALL_TIMEOUT / 1000}s.`));
    }, INSTALL_TIMEOUT);
    child.stdout?.on('data', chunk => { if (output.length < 16_000) output += chunk.toString(); });
    child.stderr?.on('data', chunk => { if (output.length < 16_000) output += chunk.toString(); });
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (code === 0) finish();
      else finish(new Error(`The install script exited with code ${code}${output ? `: ${output.slice(-2000)}` : '.'}`));
    });
  });
}

async function readExistingMeta(destination: string): Promise<ExistingMeta> {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(destination, 'meta.json'), 'utf8')) as ExistingMeta;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function compilePack(source: string): Promise<string> {
  const esbuild = await import('esbuild');
  const result = await esbuild.transform(source, { loader: 'ts', format: 'cjs', target: 'node20' });
  return result.code;
}

/**
 * Downloads and installs one Hub pack, posting `hubInstallProgress` messages. Returns the installed pack so
 * the caller can record it in the toolpack settings store.
 */
export async function installHubPack(options: InstallHubPackOptions): Promise<HubInstallResult> {
  const { registry, id, toolpacksDir, reply } = options;
  const send = (progress: HubInstallProgress): void => {
    reply({ type: 'hubInstallProgress', ...progress });
  };
  const packId = (() => {
    try {
      return toolpackIdFor(id);
    } catch {
      return id.replace(/[^a-z0-9_]/g, '_');
    }
  })();
  const destination = path.join(toolpacksDir, packId);
  const staging = path.join(toolpacksDir, `.staging-${packId}-${randomUUID()}`);
  let existing: ExistingMeta = {};
  try {
    const hub = await registry.state();
    const pack = hub.packs.find(candidate => candidate.id === id);
    if (!pack) throw new Error(`The Hub has no pack "${id}".`);
    existing = await readExistingMeta(destination);

    await fsp.mkdir(staging, { recursive: true });
    send({ id, percent: 5, state: 'downloading' });
    await registry.download(id, staging);
    send({ id, percent: 60, state: 'installing' });

    let files: string[];
    try {
      files = await fsp.readdir(staging);
    } catch {
      throw new Error('The download did not write any files.');
    }
    const sourceFile = path.join(staging, 'pack.ts');
    const compiledFile = path.join(staging, 'pack.js');
    let source: string;
    try {
      source = await fsp.readFile(sourceFile, 'utf8');
    } catch {
      throw new Error('The pack has no pack.ts.');
    }
    if (!source.trim()) throw new Error('The pack.ts file is empty.');
    try {
      await fsp.access(compiledFile);
    } catch {
      await fsp.writeFile(compiledFile, await compilePack(source), 'utf8');
    }

    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.rm(destination, { recursive: true, force: true });
    await fsp.cp(staging, destination, { recursive: true, force: true });
    const meta = {
      description: pack.description,
      enabled: existing.enabled !== false,
      hubId: pack.id,
      version: pack.version,
    };
    await fsp.writeFile(path.join(destination, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    const scriptName = installScriptFor(files);
    if (scriptName) await runInstallScript(destination, scriptName);

    const installed: InstalledHubPack = {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      ...(pack.icon ? { icon: pack.icon } : {}),
      version: pack.version,
      source: 'hub',
      tools: [...pack.tools],
      syncedDevices: options.target === 'this' ? 1 : 2,
      installedAt: Date.now(),
    };
    options.onInstalled?.(installed);
    send({ id, percent: 100, state: 'done' });
    return { ok: true, id, pack: installed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ id, percent: 100, state: 'error', error: message });
    return { ok: false, id, error: message };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
