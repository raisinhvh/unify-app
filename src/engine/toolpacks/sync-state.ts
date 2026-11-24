/**
 * Hub toolpacks this PC has the files for but does not have working: a failed install, a folder with no compiled
 * pack, or a pack that failed to load. Toolpacks are never synced between PCs; each PC installs its own.
 *
 * Install failures are remembered per pack in `.install-errors.json` inside the toolpacks folder.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toolpackIdFor } from '../hub/ids';
import type { SidebarToolpack } from '../sidebar/view';

const INSTALL_ERRORS_FILE = '.install-errors.json';

/** A Hub pack as `installedHubPacks` records it (`unify/requests/toolpacks.ts`). */
export interface HubPackRecord {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  icon?: string;
}

export interface ToolpackListOptions {
  /** The toolpacks folder (`<global storage>/toolpacks`). */
  dir: string;
  /** The registry's packs (`ToolpackRegistry.list()`). */
  installed: SidebarToolpack[];
  /** Packs installed from the Hub, keyed by Hub id. */
  hub?: Record<string, HubPackRecord>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) as unknown; } catch { return undefined; }
}

/** The description and enabled flag from a pack folder's `meta.json`, whether or not the pack compiled. */
export function readPackMeta(folder: string): { description?: string; enabled?: boolean } {
  const stored = readJson(join(folder, 'meta.json'));
  if (!isRecord(stored)) return {};
  return {
    description: typeof stored.description === 'string' ? stored.description : undefined,
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : undefined,
  };
}

/** Install failures by toolpack id: the message of the last failed install. */
export function readInstallErrors(dir: string): Record<string, string> {
  const stored = readJson(join(dir, INSTALL_ERRORS_FILE));
  if (!isRecord(stored)) return {};
  return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function writeInstallErrors(dir: string, errors: Record<string, string>): void {
  const file = join(dir, INSTALL_ERRORS_FILE);
  if (!Object.keys(errors).length) { rmSync(file, { force: true }); return; }
  mkdirSync(dir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(errors, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}

/** Remembers why a pack failed to install, so the toolpacks screen can show it. */
export function setInstallError(dir: string, id: string, message: string): void {
  writeInstallErrors(dir, { ...readInstallErrors(dir), [id]: message });
}

/** Forgets a failure once the pack installed. */
export function clearInstallError(dir: string, id: string): void {
  const errors = readInstallErrors(dir);
  if (!Object.hasOwn(errors, id)) return;
  delete errors[id];
  writeInstallErrors(dir, errors);
}

/**
 * The toolpacks screen's list. Registry packs come first; a Hub pack that failed to load is marked `needsInstall`.
 * Then come Hub packs whose folder still holds `pack.ts` but that the registry does not have, with `needsInstall`.
 * A Hub pack is listed only while its folder exists, so a removed one does not come back.
 */
export function listToolpacks(options: ToolpackListOptions): SidebarToolpack[] {
  const errors = readInstallErrors(options.dir);
  const hub = new Map<string, HubPackRecord>();
  for (const pack of Object.values(options.hub ?? {})) {
    try { hub.set(toolpackIdFor(pack.id), pack); } catch { /* Not a valid folder name, so it cannot be installed. */ }
  }
  const result: SidebarToolpack[] = [];
  const listed = new Set<string>();
  for (const pack of options.installed) {
    listed.add(pack.id);
    if (pack.state === 'error' && hub.has(pack.id)) result.push({ ...pack, needsInstall: true, installError: errors[pack.id] ?? pack.error });
    else result.push(pack);
  }
  for (const id of hub.keys()) {
    if (listed.has(id)) continue;
    const folder = join(options.dir, id);
    if (!existsSync(join(folder, 'pack.ts'))) continue;
    const meta = readPackMeta(folder);
    const error = errors[id];
    result.push({
      id,
      description: meta.description ?? hub.get(id)?.description ?? '',
      enabled: meta.enabled !== false,
      state: error ? 'error' : 'stopped',
      status: '',
      ...(error ? { error } : {}),
      tools: [],
      logs: [],
      needsInstall: true,
      ...(error ? { installError: error } : {}),
    });
  }
  return result;
}
