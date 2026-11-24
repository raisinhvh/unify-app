import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { conflictName } from '../runtime/memory';

/** `unify.*` settings that travel with the config, read from and written to user settings only. */
export const SYNCED_SETTINGS = [
  'models', 'subagents', 'nameModel', 'reviewModel', 'summaryModel', 'deciderModel', 'explorerModel', 'smartAutoRanks', 'mcpServers', 'accessibility',
  'checkpointHint', 'keepAliveMax', 'experimental.autoCompact', 'experimental.autoCompactTokens', 'experimental.batching', 'experimental.trimTools',
  'features.activityRail', 'features.autoName', 'features.shareRules', 'features.editorContext', 'features.reduceMotion', 'features.reviewAgent', 'features.fileSummaries',
  'features.smartAuto', 'features.voice', 'voice.commands',
  'updates.check', 'updates.repository', 'runtime.mirror', 'runtime.maxWorkspaceFiles', 'runtime.maxWorkspaceBytes',
] as const;

/** `unify.*` settings that stay on each PC because they hold paths to programs installed on it. */
export const LOCAL_SETTINGS = ['runtime.nodePath', 'runtime.cursorAgentPath', 'runtime.claudePath', 'runtime.codexPath', 'runtime.gitPath', 'runtime.processPriority', 'runtime.powershellSpeedups', 'runtime.rustTools', 'memory.enabled'] as const;

export const GIST_FILE = 'unify-config.json';
export const GIST_DESCRIPTION = 'Unify config (synced by Unify; API keys and MCP secrets are not included)';

/** `memory` is the global memory folder on this PC, when one is set. */
export interface SyncRoots {
  /** Unify's data home: the same folder as `unifyHome()`. */
  unifyHome?: string;
  agentsHome: string;
  memory?: string;
}
export interface SyncFile { data: string; encoding?: 'base64' }
/** Toolpacks are never part of it: each PC installs and configures its own. */
export interface ConfigBundle {
  format: 'unify-config';
  version: 1;
  settings: Record<string, unknown>;
  /** Keyed by `unify/AGENTS.md`, `unify/skills/...`, `agents/skills/...` or `memory/...`. */
  files: Record<string, SyncFile>;
}
export interface AccountRef { id: string; provider: string; label: string }

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_DEPTH = 8;
/** Memory is notes, scripts and images, so it may be larger and deeper than rules and skills. */
const MAX_MEMORY_FILE_BYTES = 10 * 1024 * 1024;
const MAX_MEMORY_BYTES = 50 * 1024 * 1024;
const MAX_MEMORY_FILES = 5000;
const MAX_MEMORY_DEPTH = 16;
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__']);

/** JSON with sorted keys and without undefined members, so equal configs hash equally. */
export function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(entry => entry === undefined ? null : sort(entry));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item).sort().filter(key => (item as Record<string, unknown>)[key] !== undefined)
      .map(key => [key, sort((item as Record<string, unknown>)[key])]));
  };
  return JSON.stringify(sort(value));
}

export function hashBundle(bundle: ConfigBundle): string {
  return createHash('sha256').update(stableJson(bundle)).digest('hex');
}

export function serializeBundle(bundle: ConfigBundle): string {
  return JSON.stringify(JSON.parse(stableJson(bundle)), null, 2) + '\n';
}

export function parseBundle(text: string): ConfigBundle {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('The GitHub config is not valid JSON.'); }
  return validateBundle(value);
}

export function validateBundle(value: unknown): ConfigBundle {
  const bundle = value as Partial<ConfigBundle> | null;
  if (!bundle || bundle.format !== 'unify-config') throw new Error('The GitHub config is not a Unify config.');
  if (bundle.version !== 1) throw new Error(`The GitHub config uses version ${String(bundle.version)}; update Unify to read it.`);
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  if (!record(bundle.settings) || !record(bundle.files)) throw new Error('The GitHub config is incomplete.');
  const files: Record<string, SyncFile> = {};
  for (const [path, file] of Object.entries(bundle.files)) {
    if (!record(file) || typeof file.data !== 'string' || (file.encoding !== undefined && file.encoding !== 'base64')) throw new Error(`The GitHub config has an invalid file: ${path}`);
    syncPath({ unifyHome: '/d', agentsHome: '/a', memory: '/m' }, path);
    files[path] = file as SyncFile;
  }
  // Configs from older builds also carried toolpacks; those stay on each PC now and are dropped here.
  return { format: 'unify-config', version: 1, settings: bundle.settings, files };
}

/**
 * Three-way merge of two configs that both changed since `base`, the GitHub copy as of the last sync. Each setting
 * and file is taken from whichever side changed it. Items both sides changed differently are conflicts and come
 * from `prefer`.
 */
export function mergeBundles(base: ConfigBundle, local: ConfigBundle, remote: ConfigBundle, prefer: 'local' | 'remote' = 'remote'): { bundle: ConfigBundle; conflicts: string[] } {
  const conflicts: string[] = [];
  const noteConflicts: string[] = [];
  // A memory note both PCs changed is not a conflict to settle: the GitHub version stays and this PC's is kept beside it.
  const keepBothNotes = (files: Record<string, SyncFile>): Record<string, SyncFile> => {
    for (const key of noteConflicts) if (Object.hasOwn(local.files, key)) files[conflictName(key)] = local.files[key];
    for (const key of noteConflicts) if (Object.hasOwn(remote.files, key)) files[key] = remote.files[key]; else delete files[key];
    return files;
  };
  const merge = <T>(label: (key: string) => string, b: Record<string, T>, l: Record<string, T>, r: Record<string, T>, notes = false): Record<string, T> => {
    const merged: Record<string, T> = {};
    for (const key of [...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].sort()) {
      const [was, mine, theirs] = [b, l, r].map(side => Object.hasOwn(side, key) ? stableJson(side[key]) : undefined);
      let pick = was === theirs && mine !== theirs ? l : r;
      if (was !== mine && was !== theirs && mine !== theirs) {
        if (notes && key.startsWith('memory/')) { noteConflicts.push(key); continue; }
        conflicts.push(label(key)); pick = prefer === 'local' ? l : r;
      }
      if (Object.hasOwn(pick, key)) merged[key] = pick[key];
    }
    return merged;
  };
  return {
    bundle: {
      format: 'unify-config', version: 1,
      settings: merge(key => `setting unify.${key}`, base.settings, local.settings, remote.settings),
      files: keepBothNotes(merge(key => key.replace(/^unify\//, '~/.unify/').replace(/^agents\//, '~/.agents/'), base.files, local.files, remote.files, true)),
    },
    conflicts,
  };
}

const homeOf = (roots: SyncRoots): string => {
  const home = roots.unifyHome;
  if (!home) throw new Error('The sync roots have no data home.');
  return home;
};

/** Maps a bundle path to an absolute path, rejecting anything outside the synced locations. */
export function syncPath(roots: SyncRoots, path: string): string {
  const parts = path.split('/');
  const bad = (): never => { throw new Error(`Refusing to sync unexpected path: ${path}`); };
  if (parts[0] === 'memory') {
    if (!roots.memory || parts.length < 2) bad();
    for (const part of parts.slice(1)) if (!part || part.startsWith('.') || /[\\:*?"<>|\0]/.test(part)) bad();
    const file = resolve(roots.memory!, ...parts.slice(1));
    if (!file.startsWith(resolve(roots.memory!) + sep)) bad();
    return file;
  }
  const root = parts[0] === 'unify' ? homeOf(roots) : parts[0] === 'agents' ? roots.agentsHome : bad();
  const isRules = parts[0] === 'unify' && parts.length === 2 && parts[1] === 'AGENTS.md';
  if (!isRules && (parts[1] !== 'skills' || parts.length < 4)) bad();
  for (const part of parts.slice(1)) {
    if (!part || part.startsWith('.') || SKIPPED_DIRS.has(part) || /[\\:*?"<>|\0]/.test(part)) bad();
  }
  const file = resolve(root, ...parts.slice(1));
  if (!file.startsWith(resolve(root) + sep)) bad();
  return file;
}

export function encode(buffer: Buffer): SyncFile {
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer) ? { data: text } : { data: buffer.toString('base64'), encoding: 'base64' };
}

export const decode = (file: SyncFile): Buffer => file.encoding === 'base64' ? Buffer.from(file.data, 'base64') : Buffer.from(file.data, 'utf8');

/** Global rules and skills on this PC, keyed like `ConfigBundle.files`. */
export async function collectFiles(roots: SyncRoots): Promise<Record<string, SyncFile>> {
  const files: Record<string, SyncFile> = {};
  let count = 0;
  let bytes = 0;
  const add = async (path: string, file: string): Promise<void> => {
    // The current home is read first, so an old copy never replaces a file Unify has.
    if (Object.hasOwn(files, path)) return;
    const buffer = await fs.readFile(file);
    if (buffer.length > MAX_FILE_BYTES) throw new Error(`${path} is larger than 1 MB, so it cannot be synced.`);
    bytes += buffer.length;
    if (++count > MAX_FILES || bytes > MAX_TOTAL_BYTES) throw new Error('Rules and skills are too large to sync (limit 2000 files or 20 MB).');
    files[path] = encode(buffer);
  };
  const walk = async (directory: string, path: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name) || /[\\:*?"<>|]/.test(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < MAX_DEPTH) await walk(full, `${path}/${entry.name}`, depth + 1); }
      else if (entry.isFile() && depth > 0) await add(`${path}/${entry.name}`, full);
    }
  };
  const home = homeOf(roots);
  const rules = join(home, 'AGENTS.md');
  try {
    if ((await fs.lstat(rules)).isFile()) await add('unify/AGENTS.md', rules);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await walk(join(home, 'skills'), 'unify/skills', 0);
  await walk(join(roots.agentsHome, 'skills'), 'agents/skills', 0);
  if (roots.memory) Object.assign(files, await collectMemory(roots.memory));
  return files;
}

/** The global memory folder, keyed `memory/<path>`. Hidden entries (.obsidian, .trash, .git) and symlinks are left out. */
async function collectMemory(root: string): Promise<Record<string, SyncFile>> {
  const files: Record<string, SyncFile> = {};
  let count = 0;
  let bytes = 0;
  const walk = async (directory: string, path: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'node_modules' || /[\\:*?"<>|]/.test(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < MAX_MEMORY_DEPTH) await walk(full, `${path}/${entry.name}`, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const buffer = await fs.readFile(full);
      if (buffer.length > MAX_MEMORY_FILE_BYTES) throw new Error(`Memory file ${path.slice('memory/'.length)}/${entry.name} is larger than 10 MB, so it cannot be synced.`);
      bytes += buffer.length;
      if (++count > MAX_MEMORY_FILES || bytes > MAX_MEMORY_BYTES) throw new Error('Global memory is too large to sync (limit 5000 files or 50 MB).');
      files[`${path}/${entry.name}`] = encode(buffer);
    }
  };
  await walk(root, 'memory', 0);
  return files;
}

/** Makes this PC's global rules and skills match `files`: writes changed files and deletes ones the bundle lacks. */
export async function applyFiles(roots: SyncRoots, files: Record<string, SyncFile>): Promise<void> {
  const targets = Object.keys(files).map(path => [path, syncPath(roots, path)] as const);
  const local = await collectFiles(roots);
  for (const path of Object.keys(local)) {
    if (Object.hasOwn(files, path)) continue;
    const file = syncPath(roots, path);
    await fs.rm(file, { force: true });
    // Prune folders the deletion emptied, stopping at the skills or memory root.
    const stop = path.startsWith('memory/') ? resolve(roots.memory!) : resolve(path.startsWith('unify/') ? homeOf(roots) : roots.agentsHome, 'skills');
    for (let folder = dirname(file); folder.startsWith(stop + sep); folder = dirname(folder)) {
      try { await fs.rmdir(folder); } catch { break; }
    }
  }
  for (const [path, file] of targets) {
    const data = decode(files[path]);
    if (local[path] && decode(local[path]).equals(data)) continue;
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }
}

type Pair = { name?: unknown; value?: unknown };
const pairs = (value: unknown): Pair[] | undefined => Array.isArray(value) ? value.filter((item): item is Pair => !!item && typeof item === 'object') : undefined;

/** Blanks MCP `env` and `headers` values, which commonly hold API keys. */
export function stripMcpSecrets(servers: unknown): unknown {
  if (!Array.isArray(servers)) return servers;
  const blank = (value: unknown): unknown => {
    const list = pairs(value);
    if (list) return list.map(item => ({ ...item, value: '' }));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).map(key => [key, '']));
    return value;
  };
  return servers.map(server => {
    if (!server || typeof server !== 'object') return server;
    const next = { ...(server as Record<string, unknown>) };
    if (next.env !== undefined) next.env = blank(next.env);
    if (next.headers !== undefined) next.headers = blank(next.headers);
    return next;
  });
}

/** Refills blanked MCP secrets from this PC's servers with the same name. */
export function restoreMcpSecrets(remote: unknown, local: unknown): unknown {
  if (!Array.isArray(remote)) return remote;
  const locals = new Map((Array.isArray(local) ? local : []).filter(item => item && typeof item === 'object' && typeof item.name === 'string')
    .map(item => [item.name as string, item as Record<string, unknown>]));
  const fill = (value: unknown, previous: unknown): unknown => {
    const list = pairs(value);
    if (list) {
      const old = new Map((pairs(previous) || []).map(item => [item.name, item.value]));
      return list.map(item => item.value === '' && old.has(item.name) ? { ...item, value: old.get(item.name) } : item);
    }
    if (value && typeof value === 'object' && previous && typeof previous === 'object' && !Array.isArray(previous)) {
      const old = previous as Record<string, unknown>;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === '' && Object.hasOwn(old, key) ? old[key] : item]));
    }
    return value;
  };
  return remote.map(server => {
    if (!server || typeof server !== 'object') return server;
    const next = { ...(server as Record<string, unknown>) };
    const previous = typeof next.name === 'string' ? locals.get(next.name) : undefined;
    if (!previous) return next;
    if (next.env !== undefined) next.env = fill(next.env, previous.env);
    if (next.headers !== undefined) next.headers = fill(next.headers, previous.headers);
    return next;
  });
}

/** Account fields older builds wrote on a model. Models are provider-scoped now, so they carry none. */
const LEGACY_MODEL_ACCOUNT_KEYS = ['account', 'accountLabel'] as const;

/** A model entry without `account` / `accountLabel`; the same object when it has neither. */
export function stripModelAccount(model: Record<string, unknown>): Record<string, unknown> {
  if (!LEGACY_MODEL_ACCOUNT_KEYS.some(key => key in model)) return model;
  const rest = { ...model };
  for (const key of LEGACY_MODEL_ACCOUNT_KEYS) delete rest[key];
  return rest;
}

/**
 * Models are per provider, not per account: account ids and labels belong to one PC, so they never go to
 * the synced settings. Old bundles from other PCs are cleaned the same way when they come back down.
 */
export function portableModels(models: unknown, _accounts?: AccountRef[]): unknown {
  if (!Array.isArray(models)) return models;
  return models.map(model => model && typeof model === 'object' ? stripModelAccount(model as Record<string, unknown>) : model);
}

/** Config Sync's download side: strips the same account fields as `portableModels`. */
export function localModels(models: unknown, _accounts?: AccountRef[]): unknown {
  return portableModels(models);
}

/**
 * Model entries as Unify uses them: no account fields, and one entry per provider + backend + name. A duplicate
 * folds into the first copy, which stays enabled if any copy was. `changed` says whether anything was dropped or
 * rewritten, so the caller persists the cleaned list only then.
 */
export function normalizeModels(models: unknown[]): { models: Record<string, unknown>[]; changed: boolean } {
  const seen = new Map<string, Record<string, unknown>>();
  let changed = false;
  for (const item of models) {
    if (!item || typeof item !== 'object') { changed = true; continue; }
    const model = stripModelAccount(item as Record<string, unknown>);
    if (model !== item) changed = true;
    const key = JSON.stringify([model.provider, model.backend, model.name]);
    const first = seen.get(key);
    if (!first) {
      seen.set(key, { ...model, enabled: model.enabled !== false });
      continue;
    }
    changed = true;
    first.enabled = first.enabled !== false || model.enabled !== false;
  }
  return { models: [...seen.values()], changed };
}

/** Account lookups shared by API-key and OAuth registries. */
export interface AccountSource<T extends { id: string; provider: string; label: string }> {
  get(id: string): T | undefined;
  list(): T[];
  getDefault(provider: string): T | undefined;
}

/** The account a model uses: its provider's default account. A model names a provider, never an account. */
export function accountForModel<T extends { id: string; provider: string; label: string }>(
  accounts: AccountSource<T>, model: { provider: string },
): T | undefined {
  return accounts.getDefault(model.provider);
}

export interface GistInfo { id: string; url: string; updatedAt: string }
type Fetch = typeof fetch;
const API = 'https://api.github.com';

async function github(token: string, path: string, init: RequestInit = {}, fetchImpl: Fetch = fetch): Promise<Response> {
  return fetchImpl(`${API}${path}`, {
    ...init,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'unify', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
}

async function failure(response: Response, action: string): Promise<Error> {
  let detail = '';
  try { detail = String(((await response.json()) as { message?: unknown }).message || ''); } catch { /* no body */ }
  return new Error(`GitHub ${action} failed (HTTP ${response.status}${detail ? `: ${detail}` : ''}).`);
}

const info = (gist: Record<string, unknown>): GistInfo => ({ id: String(gist.id), url: String(gist.html_url), updatedAt: String(gist.updated_at) });

/** Finds the signed-in user's Unify config gist, if one exists. */
export async function findConfigGist(token: string, fetchImpl: Fetch = fetch): Promise<GistInfo | undefined> {
  for (let page = 1; page <= 10; page++) {
    const response = await github(token, `/gists?per_page=100&page=${page}`, {}, fetchImpl);
    if (!response.ok) throw await failure(response, 'gist lookup');
    const gists = await response.json() as Record<string, unknown>[];
    const found = gists.find(gist => gist.files && typeof gist.files === 'object' && Object.hasOwn(gist.files, GIST_FILE)
      && typeof gist.description === 'string' && gist.description.startsWith('Unify config'));
    if (found) return info(found);
    if (gists.length < 100) return undefined;
  }
  return undefined;
}

/** Reads the config from a gist. Returns undefined when the gist no longer exists. */
export async function readConfigGist(token: string, id: string, fetchImpl: Fetch = fetch): Promise<{ gist: GistInfo; bundle: ConfigBundle } | undefined> {
  const response = await github(token, `/gists/${encodeURIComponent(id)}`, {}, fetchImpl);
  if (response.status === 404) return undefined;
  if (!response.ok) throw await failure(response, 'gist download');
  const gist = await response.json() as Record<string, unknown>;
  const file = (gist.files as Record<string, { content?: unknown; truncated?: unknown; raw_url?: unknown }> | undefined)?.[GIST_FILE];
  if (!file) throw new Error(`The gist has no ${GIST_FILE}.`);
  let content = typeof file.content === 'string' ? file.content : '';
  if (file.truncated) {
    // Files over 1 MB are truncated in API responses; the raw URL has the full text.
    const raw = new URL(String(file.raw_url));
    if (raw.protocol !== 'https:' || raw.hostname !== 'gist.githubusercontent.com') throw new Error('Unexpected gist download address.');
    const full = await fetchImpl(raw.href, { signal: AbortSignal.timeout(20_000) });
    if (!full.ok) throw await failure(full, 'gist download');
    content = await full.text();
  }
  return { gist: info(gist), bundle: parseBundle(content) };
}

/** Creates a secret gist, or updates `id`. Returns undefined when `id` no longer exists. */
export async function writeConfigGist(token: string, id: string | undefined, bundle: ConfigBundle, fetchImpl: Fetch = fetch): Promise<GistInfo | undefined> {
  const body = JSON.stringify({ description: GIST_DESCRIPTION, ...(id ? {} : { public: false }), files: { [GIST_FILE]: { content: serializeBundle(bundle) } } });
  const response = await github(token, id ? `/gists/${encodeURIComponent(id)}` : '/gists', { method: id ? 'PATCH' : 'POST', body }, fetchImpl);
  if (id && response.status === 404) return undefined;
  if (!response.ok) throw await failure(response, 'gist upload');
  return info(await response.json() as Record<string, unknown>);
}

/** The private repository that holds the synced config, one per GitHub account. */
export const SYNC_REPO = 'unify-sync';
const MARKER = 'unify-sync.json';
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9.]{0,80}$/;
const README = `# Unify sync

Unify keeps your config here so all your computers share it. API keys, account sign-ins and MCP secret values are never stored here.

- \`settings/\`: one file per \`unify.*\` setting
- \`unify/\` and \`agents/\`: global rules and skills
- \`memory/\`: your global memory (notes, conventions and scripts)

Every sync is a commit, so the history shows what changed and when. Edits made here directly reach Unify on its next sync.
`;

const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(JSON.parse(stableJson(value)), null, 2) + '\n');

/** The repository's files for a config: what a sync commits. */
export function bundleToTree(bundle: ConfigBundle): Map<string, Buffer> {
  const tree = new Map<string, Buffer>([[MARKER, json({ format: 'unify-sync', version: 1 })], ['README.md', Buffer.from(README)]]);
  for (const [key, value] of Object.entries(bundle.settings)) tree.set(`settings/${key}.json`, json(value));
  for (const [path, file] of Object.entries(bundle.files)) tree.set(path, decode(file));
  return tree;
}

/**
 * Reads a config back from the repository's files. Undefined for an empty repository; files Unify does not know are
 * ignored, including the `toolpacks/` folder older builds wrote (the next sync removes it).
 */
export function treeToBundle(tree: Map<string, Buffer>): ConfigBundle | undefined {
  const marker = tree.get(MARKER);
  if (!marker) {
    if (!tree.size) return undefined;
    throw new Error(`The ${SYNC_REPO} repository was not made by Unify (it has no ${MARKER}).`);
  }
  let format: { format?: unknown; version?: unknown };
  try { format = JSON.parse(marker.toString('utf8')); } catch { throw new Error(`${MARKER} in the sync repository is not valid JSON.`); }
  if (format.format !== 'unify-sync') throw new Error(`${MARKER} in the sync repository is not a Unify sync marker.`);
  if (format.version !== 1) throw new Error(`The sync repository uses version ${String(format.version)}; update Unify to read it.`);
  const bundle: ConfigBundle = { format: 'unify-config', version: 1, settings: {}, files: {} };
  const parse = (path: string, data: Buffer): unknown => {
    try { return JSON.parse(data.toString('utf8')); } catch { throw new Error(`${path} in the sync repository is not valid JSON.`); }
  };
  for (const [path, data] of tree) {
    const parts = path.split('/');
    if (parts[0] === 'settings' && parts.length === 2 && parts[1].endsWith('.json')) {
      const key = parts[1].slice(0, -'.json'.length);
      if (SETTING_KEY.test(key)) bundle.settings[key] = parse(path, data);
    } else if (parts[0] === 'unify' || parts[0] === 'agents' || parts[0] === 'memory') {
      // Hidden files added on GitHub directly (an .obsidian folder, say) are skipped, as Unify skips them locally.
      if (parts.slice(1).some(part => part.startsWith('.'))) continue;
      bundle.files[path] = encode(data);
    }
  }
  return validateBundle(bundle);
}

/** A commit message naming what changed between two configs. */
export function describeChanges(before: ConfigBundle | undefined, after: ConfigBundle, from: string): string {
  const empty: ConfigBundle = { format: 'unify-config', version: 1, settings: {}, files: {} };
  const was = before ?? empty;
  const changed = (label: (key: string) => string, b: Record<string, unknown>, a: Record<string, unknown>): string[] =>
    [...new Set([...Object.keys(b), ...Object.keys(a)])].sort().filter(key => stableJson(b[key]) !== stableJson(a[key])).map(label);
  const items = [
    ...changed(key => `unify.${key}`, was.settings, after.settings),
    ...changed(key => key, was.files, after.files),
  ];
  const shown = items.slice(0, 3).join(', ');
  const summary = !items.length ? 'No changes' : items.length > 3 ? `${shown} and ${items.length - 3} more` : shown;
  return `Sync from ${from}: ${summary}`;
}

export interface RepoInfo { fullName: string; url: string; cloneUrl: string }

const repoInfo = (repo: Record<string, unknown>): RepoInfo => {
  if (repo.private !== true) throw new Error(`${String(repo.full_name)} is public. The sync repository must be private, so Unify will not use it.`);
  const cloneUrl = new URL(String(repo.clone_url));
  if (cloneUrl.protocol !== 'https:' || cloneUrl.hostname !== 'github.com') throw new Error('Unexpected sync repository address.');
  return { fullName: String(repo.full_name), url: String(repo.html_url), cloneUrl: cloneUrl.href };
};

/** The signed-in user's sync repository, if it exists. */
export async function findSyncRepo(token: string, owner: string, fetchImpl: Fetch = fetch): Promise<RepoInfo | undefined> {
  const response = await github(token, `/repos/${encodeURIComponent(owner)}/${SYNC_REPO}`, {}, fetchImpl);
  if (response.status === 404) return undefined;
  if (!response.ok) throw await failure(response, 'repository lookup');
  return repoInfo(await response.json() as Record<string, unknown>);
}

/** Creates the private sync repository under the signed-in user. */
export async function createSyncRepo(token: string, fetchImpl: Fetch = fetch): Promise<RepoInfo> {
  const body = JSON.stringify({
    name: SYNC_REPO, private: true, has_issues: false, has_projects: false, has_wiki: false, auto_init: false,
    description: 'Unify settings, rules, skills and memory, synced between computers',
  });
  const response = await github(token, '/user/repos', { method: 'POST', body }, fetchImpl);
  if (!response.ok) throw await failure(response, 'repository creation');
  return repoInfo(await response.json() as Record<string, unknown>);
}
