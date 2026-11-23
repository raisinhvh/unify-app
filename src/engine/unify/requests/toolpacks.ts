/**
 * Toolpacks screen settings that the sidebar protocol does not carry: per-tool switches and per-group
 * permission policies.
 *
 * Values live in `~/.dsh/unify/toolpacks.json`. The extension is expected to read them with the helpers
 * below when it builds `toolpacksState` and when it offers tools to an agent; this module deliberately does
 * not post a `toolpacksState` of its own, because it cannot see a local pack's runtime tools and a partial
 * list would drop them from the screen.
 *
 * The same file records which packs came from the Hub, so the extension can add version, glyph and source
 * to those `SidebarToolpack` entries.
 */
import { RequestPaths, isRecord, readJsonFile, writeJsonFile } from './state';
import { ToolKind, ToolPolicy } from './types';

export interface InstalledHubPack {
  id: string;
  name: string;
  description: string;
  icon?: string;
  version: string;
  source: 'hub';
  tools: string[];
  syncedDevices?: number;
  installedAt: number;
}

export interface ToolpackPackSettings {
  tools: Record<string, boolean>;
  permissions: Partial<Record<ToolKind, ToolPolicy>>;
}

interface ToolpackStore {
  packs: Record<string, ToolpackPackSettings>;
  /** Packs installed through the Hub; local packs are not listed here. */
  installed: Record<string, InstalledHubPack>;
  /** Hub install target: this device only, or the synced set. */
  syncTargets: Record<string, 'this' | 'all'>;
}

const TOOL_KINDS: ToolKind[] = ['read', 'write', 'run'];
const POLICIES: ToolPolicy[] = ['always', 'ask', 'off'];

function emptyStore(): ToolpackStore {
  return { packs: {}, installed: {}, syncTargets: {} };
}

function readStore(paths: RequestPaths): ToolpackStore {
  const stored = readJsonFile<Partial<ToolpackStore>>(paths.toolpacksFile, {});
  return {
    packs: isRecord(stored.packs) ? stored.packs as Record<string, ToolpackPackSettings> : {},
    installed: isRecord(stored.installed) ? stored.installed as Record<string, InstalledHubPack> : {},
    syncTargets: isRecord(stored.syncTargets) ? stored.syncTargets as Record<string, 'this' | 'all'> : {},
  };
}

function writeStore(paths: RequestPaths, store: ToolpackStore): void {
  writeJsonFile(paths.toolpacksFile, store);
}

function packSettings(store: ToolpackStore, id: string): ToolpackPackSettings {
  const current = store.packs[id];
  return {
    tools: isRecord(current?.tools) ? current.tools as Record<string, boolean> : {},
    permissions: isRecord(current?.permissions) ? current.permissions as Partial<Record<ToolKind, ToolPolicy>> : {},
  };
}

/** Every stored pack setting, for the extension's `toolpacksState` builder. */
export function allToolpackSettings(paths: RequestPaths): Record<string, ToolpackPackSettings> {
  return readStore(paths).packs;
}

/** Permission policy for a tool group; the screen's defaults are read `always`, write and run `ask`. */
export function toolpackPermission(paths: RequestPaths, id: string, group: ToolKind): ToolPolicy {
  const policy = readStore(paths).packs[id]?.permissions?.[group];
  if (policy && POLICIES.includes(policy)) return policy;
  return group === 'read' ? 'always' : 'ask';
}

/** Whether one tool is switched on; missing means on. */
export function toolpackToolEnabled(paths: RequestPaths, id: string, tool: string): boolean {
  const value = readStore(paths).packs[id]?.tools?.[tool];
  return value !== false;
}

/** The Hub packs recorded by an install, keyed by id. */
export function installedHubPacks(paths: RequestPaths): Record<string, InstalledHubPack> {
  return readStore(paths).installed;
}

/** Saves one per-tool switch. */
export function setToolpackToolEnabled(paths: RequestPaths, id: string, tool: string, enabled: boolean): void {
  if (!id || !tool) throw new Error('Unknown toolpack tool.');
  const store = readStore(paths);
  const settings = packSettings(store, id);
  settings.tools[tool] = !!enabled;
  store.packs[id] = settings;
  writeStore(paths, store);
}

/** Saves one group policy. */
export function setToolpackPermission(paths: RequestPaths, id: string, group: ToolKind, policy: ToolPolicy): void {
  if (!TOOL_KINDS.includes(group)) throw new Error('Unknown tool group.');
  if (!POLICIES.includes(policy)) throw new Error('Unknown tool policy.');
  const store = readStore(paths);
  const settings = packSettings(store, id);
  settings.permissions[group] = policy;
  store.packs[id] = settings;
  writeStore(paths, store);
}

/** Records a pack installed from the Hub so the extension can describe it without starting it. */
export function recordHubInstall(paths: RequestPaths, pack: InstalledHubPack, target: 'this' | 'all'): void {
  const store = readStore(paths);
  store.installed[pack.id] = pack;
  store.syncTargets[pack.id] = target;
  writeStore(paths, store);
}

/** Whether a Hub install was meant for this device only or for every signed-in device. */
export function hubInstallTarget(paths: RequestPaths, id: string): 'this' | 'all' {
  return readStore(paths).syncTargets[id] ?? 'all';
}

export interface ToolpackDecorationInput {
  id: string;
  description: string;
  enabled: boolean;
  tools: { name: string; description: string; kind?: ToolKind; enabled?: boolean }[];
  permissions?: Partial<Record<ToolKind, ToolPolicy>>;
  name?: string;
  icon?: string;
  version?: string;
  source?: 'hub' | 'local';
  syncedDevices?: number;
}

/**
 * Adds the screen's optional fields to one `SidebarToolpack`: display name, glyph, version, source, synced
 * devices, group policies and per-tool switches. The extension calls this before posting `toolpacksState`.
 */
export function decorateToolpack(paths: RequestPaths, pack: ToolpackDecorationInput): ToolpackDecorationInput & {
  permissions: Partial<Record<ToolKind, ToolPolicy>>;
  tools: { name: string; description: string; kind?: ToolKind; enabled: boolean }[];
} {
  const store = readStore(paths);
  const settings = packSettings(store, pack.id);
  const hub = store.installed[pack.id];
  const permissions: Partial<Record<ToolKind, ToolPolicy>> = { ...settings.permissions };
  for (const group of TOOL_KINDS) {
    if (!permissions[group]) permissions[group] = group === 'read' ? 'always' : 'ask';
  }
  return {
    ...pack,
    name: pack.name ?? hub?.name,
    icon: pack.icon ?? hub?.icon,
    version: pack.version ?? hub?.version,
    source: pack.source ?? (hub ? 'hub' : 'local'),
    syncedDevices: pack.syncedDevices ?? hub?.syncedDevices,
    permissions,
    tools: pack.tools.map(tool => ({
      ...tool,
      enabled: settings.tools[tool.name] ?? tool.enabled ?? true,
    })),
  };
}
