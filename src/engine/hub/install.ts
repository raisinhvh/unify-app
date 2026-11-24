/**
 * Installs one pack from a Hub registry into `storage/toolpacks`.
 *
 * The steps match the Hub screen: download into a staging folder, validate/compile the pack, write the folder
 * the toolpack registry scans (`meta.json` keeps an existing `enabled` flag), run the pack's install script and
 * report progress throughout. Nothing is left behind on failure.
 *
 * Nothing a pack brings runs without explicit user consent, asked in two steps before any pack folder is installed:
 * 1. A pack with an install or uninstall script returns `needsScriptConsent` with both scripts until the request
 *    has `allowScript: true`.
 * 2. A pack whose setup.json installs programs (winget/brew/pip, plus Python when a pip package needs it) returns
 *    `needsDependencyConsent` with every package and its exact command until the request has `packages`: the
 *    optional step ids the user ticked (required ones are always installed).
 */
import { existsSync, promises as fsp } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { toolpackIdFor } from './ids';
import { INSTALL_SCRIPT_NAMES, UNINSTALL_SCRIPT_NAMES } from './scripts';
import { installSetupPackages, pendingPackages, readPackSetup, runPackInstallScript } from './setup';
import { HubInstallPackage, HubInstallProgress, HubInstallRequest, HubRegistry, PackSetupState } from './types';
import type { InstalledHubPack } from '../unify/requests/toolpacks';
/** The most of an install script the consent screen is sent; longer scripts are truncated with a note. */
const MAX_SCRIPT_TEXT_BYTES = 64 * 1024;

/** Limits an install script to what the UI can show, ending with how many bytes the file really has. */
function scriptTextForUi(text: string): string {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= MAX_SCRIPT_TEXT_BYTES) return text;
  const note = `\n(truncated, ${totalBytes} bytes total)`;
  const budget = MAX_SCRIPT_TEXT_BYTES - Buffer.byteLength(note, 'utf8');
  let truncated = Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8');
  // A multi-byte character cut at the boundary becomes U+FFFD; drop it rather than exceed the cap.
  while (Buffer.byteLength(truncated, 'utf8') > budget) truncated = truncated.slice(0, -1);
  return `${truncated}${note}`;
}

export interface InstallHubPackOptions extends HubInstallRequest {
  registry: HubRegistry;
  toolpacksDir: string;
  /** Unify's data home, passed to the install script as `UNIFY_HOME`. */
  unifyHome?: string;
  reply: (message: unknown) => void;
  onInstalled?: (pack: InstalledHubPack) => void;
  /** `scriptHash` of the scripts the user agreed to at the last install: the same scripts are not asked again. */
  consentedScriptHash?: string;
  /**
   * Auto-update: never asks. New or changed scripts answer `needsScriptConsent`, missing required programs answer
   * `needsDependencyConsent`; otherwise it installs without any optional program.
   */
  unattended?: boolean;
}

/** One stable hash of a pack's install and uninstall scripts (name and text), stored with the install record. */
export function packScriptHash(
  scriptName: string | undefined,
  scriptText: string | undefined,
  uninstallScriptName: string | undefined,
  uninstallScriptText: string | undefined,
): string {
  return createHash('sha256')
    .update([scriptName ?? '', scriptText ?? '', uninstallScriptName ?? '', uninstallScriptText ?? ''].join('\0'))
    .digest('hex');
}

export interface HubInstallResult {
  ok: boolean;
  id: string;
  pack?: InstalledHubPack;
  error?: string;
  /** The pack ships an install script and the request did not consent to running it. */
  needsScriptConsent?: boolean;
  /** The install script the user must agree to run. */
  scriptName?: string;
  scriptText?: string;
  /** The script that runs when the pack is removed, shown on the same consent. */
  uninstallScriptName?: string;
  uninstallScriptText?: string;
  /** The pack's setup installs programs and the request did not say which (`packages`); sent with `packages`. */
  needsDependencyConsent?: boolean;
  /** Programs the pack's setup would install on this machine (required and optional), with the exact command. */
  packages?: HubInstallPackage[];
  /** The pack's setup checklist, when it ships a `setup.json`. */
  setup?: PackSetupState | null;
}

interface ExistingMeta {
  enabled?: boolean;
  description?: string;
  hubId?: string;
}

function installScriptFor(files: string[]): string | undefined {
  return INSTALL_SCRIPT_NAMES.find(name => files.includes(name));
}

function uninstallScriptFor(files: string[]): string | undefined {
  return UNINSTALL_SCRIPT_NAMES.find(name => files.includes(name));
}

async function readExistingMeta(destination: string): Promise<ExistingMeta> {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(destination, 'meta.json'), 'utf8')) as ExistingMeta;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Guards the destination before any `rm`: it must be a child of the toolpacks folder, never the folder itself. */
function assertInsideToolpacksDir(toolpacksDir: string, destination: string): void {
  const relative = path.relative(path.resolve(toolpacksDir), path.resolve(destination));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to install "${destination}" outside the toolpacks folder.`);
  }
}

/** Refuses to replace a folder that belongs to a different Hub pack; folders without `hubId` are older installs. */
function assertSameHubPack(existing: ExistingMeta, packId: string, hubId: string): void {
  if (existing.hubId && existing.hubId !== hubId) {
    throw new Error(
      `The toolpack folder "${packId}" belongs to Hub pack "${existing.hubId}", not "${hubId}".`,
    );
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
  if (!id.trim()) throw new Error('Cannot install a pack with an empty id.');
  const send = (progress: HubInstallProgress): void => {
    reply({ type: 'hubInstallProgress', ...progress });
  };
  const packId = (() => {
    try {
      return toolpackIdFor(id);
    } catch {
      const fallback = id.replace(/[^a-z0-9_]/g, '_');
      if (!fallback) throw new Error('Cannot install a pack with an empty id.');
      return fallback;
    }
  })();
  const destination = path.join(toolpacksDir, packId);
  assertInsideToolpacksDir(toolpacksDir, destination);
  const staging = path.join(toolpacksDir, `.staging-${packId}-${randomUUID()}`);
  let existing: ExistingMeta = {};
  try {
    const hub = await registry.state();
    const pack = hub.packs.find(candidate => candidate.id === id);
    if (!pack) throw new Error(`The Hub has no pack "${id}".`);
    existing = await readExistingMeta(destination);
    assertSameHubPack(existing, packId, pack.id);

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
    const scriptName = installScriptFor(files);
    const uninstallScriptName = uninstallScriptFor(files);
    const scriptText = scriptName ? await fsp.readFile(path.join(staging, scriptName), 'utf8') : undefined;
    const uninstallScriptText = uninstallScriptName ? await fsp.readFile(path.join(staging, uninstallScriptName), 'utf8') : undefined;
    const scriptHash = scriptName || uninstallScriptName
      ? packScriptHash(scriptName, scriptText, uninstallScriptName, uninstallScriptText)
      : undefined;
    // An update whose scripts are exactly the ones the user already agreed to does not ask again.
    const alreadyConsented = scriptHash !== undefined && scriptHash === options.consentedScriptHash;
    const allowScript = alreadyConsented || (options.allowScript === true && !options.unattended);
    if (scriptHash !== undefined && !allowScript) {
      return {
        ok: false,
        id,
        needsScriptConsent: true,
        ...(scriptName ? { scriptName } : {}),
        ...(scriptText !== undefined ? { scriptText: scriptTextForUi(scriptText) } : {}),
        ...(uninstallScriptName ? { uninstallScriptName } : {}),
        ...(uninstallScriptText !== undefined ? { uninstallScriptText: scriptTextForUi(uninstallScriptText) } : {}),
      };
    }
    const packages = files.includes('setup.json')
      ? await pendingPackages(staging, pack.name, undefined, { includeOptional: true })
      : [];
    const requiredPending = packages.some(item => !item.optional);
    const askForPackages = options.unattended ? requiredPending : options.packages === undefined;
    if (packages.length && askForPackages) {
      return {
        ok: false,
        id,
        needsDependencyConsent: true,
        packages: packages.map(item => ({
          stepId: item.stepId,
          title: item.title,
          command: item.command.display,
          ...(item.optional ? { optional: true } : {}),
          ...(item.neededBy ? { neededBy: item.neededBy } : {}),
        })),
      };
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
    // The pack's data folder (keys the user pasted, a built Python environment, downloaded tools) survives updates.
    const dataDir = path.join(destination, 'data');
    const keptData = path.join(toolpacksDir, `.data-${packId}-${randomUUID()}`);
    const keep = existsSync(dataDir) && !files.includes('data');
    if (keep) await fsp.rename(dataDir, keptData);
    try {
      await fsp.rm(destination, { recursive: true, force: true });
      await fsp.cp(staging, destination, { recursive: true, force: true });
    } finally {
      if (keep) {
        await fsp.mkdir(destination, { recursive: true });
        await fsp.rename(keptData, dataDir);
      }
    }
    const meta = {
      description: pack.description,
      enabled: existing.enabled !== false,
      hubId: pack.id,
      version: pack.version,
    };
    await fsp.writeFile(path.join(destination, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    // Missing required programs (ImageMagick, ffmpeg, Python, ...) first, since the script may need them; the
    // checklist shows any that failed.
    if (packages.length) {
      send({ id, percent: 70, state: 'installing' });
      await installSetupPackages(destination, pack.name, undefined, options.unattended ? [] : options.packages ?? []);
    }
    if (scriptName) {
      send({ id, percent: 85, state: 'installing' });
      const result = await runPackInstallScript(destination, scriptName, { unifyHome: options.unifyHome });
      // With a setup.json the pack stays installed and its checklist shows the failed step and how to fix it.
      if (!result.ok && !files.includes('setup.json')) throw new Error(result.error ?? 'The install script failed.');
    }

    const installed: InstalledHubPack = {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      ...(pack.icon ? { icon: pack.icon } : {}),
      version: pack.version,
      source: 'hub',
      tools: [...pack.tools],
      installedAt: Date.now(),
      updatedAt: pack.updatedAt,
      ...(scriptHash ? { scriptHash } : {}),
    };
    options.onInstalled?.(installed);
    const setup = await readPackSetup(destination, packId, pack.name);
    send({ id, percent: 100, state: 'done' });
    return { ok: true, id, pack: installed, setup };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ id, percent: 100, state: 'error', error: message });
    return { ok: false, id, error: message };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
