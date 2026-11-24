/**
 * Workspace files for the Files screen: one folder per request, safe workspace-relative paths, versioned
 * writes that detect an external edit, and a recursive watcher that pushes `fileChanged`.
 *
 * The watcher can cover several project roots, honours each root's `.gitignore`, and always skips
 * `node_modules`, `.git`, the project `.unify` folder and Unify's own data home. It is optional:
 * `fs.watch(..., { recursive: true })` exists on Windows and macOS but not on every Linux Node build, so a
 * failure only means no live notifications (the screen still reads on demand).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { FSWatcher } from 'node:fs';
import * as path from 'node:path';
import { unifyHome } from '../settings';
import { GitIgnore } from './gitignore';
import {
  FileDocument,
  FileEntry,
  FilesReply,
  UnifyReply,
} from './types';
import { relativeToWorkspace, resolveInside } from './state';

/** Folders the tree and search never descend into (same list as Unify's instruction walker). */
export const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', '.venv', 'venv', '.next', '.turbo', '.npm-cache', '.system',
]);

const MAX_SEARCH_FILES = 20_000;
const MAX_SEARCH_DEPTH = 12;
const CHANGE_DEBOUNCE_MS = 200;
/** The screen refuses binary and very large files; answer `filesError` instead of shipping garbage. */
const MAX_READ_BYTES = 2 * 1024 * 1024;

const languageByExtension: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html',
  luau: 'lua', lua: 'lua', py: 'python', rs: 'rust', go: 'go',
  yml: 'yaml', yaml: 'yaml', sh: 'shell', ps1: 'powershell',
};

export function languageFor(file: string): string {
  const extension = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  return languageByExtension[extension] ?? 'plaintext';
}

/** Opaque version of a file's contents; writes send it back so an outside edit can be detected. */
export function contentVersion(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function statOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

function requireWorkspace(root: string | undefined): string {
  if (!root) throw new Error('Open a project folder first.');
  if (!statOrUndefined(root)?.isDirectory()) throw new Error('The project folder is no longer available.');
  return root;
}

/** Reads a workspace file into the screen's FileDocument shape. */
export function readWorkspaceFile(root: string | undefined, relativePath: string): FileDocument {
  const base = requireWorkspace(root);
  const file = resolveInside(base, relativePath);
  const info = statOrUndefined(file);
  if (!info || !info.isFile()) throw new Error(`No file at ${relativePath || '.'}.`);
  if (info.size > MAX_READ_BYTES) throw new Error('Files larger than 2 MB are not shown in the editor.');
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 8_000).includes(0)) throw new Error('Binary files are not shown in the editor.');
  const content = bytes.toString('utf8');
  return {
    path: relativeToWorkspace(base, file),
    content,
    language: languageFor(file),
    version: contentVersion(content),
  };
}

/** Lists one directory; entries are already workspace-relative so the screen can expand lazily. */
export function listWorkspaceDirectory(root: string | undefined, relativePath: string): FileEntry[] {
  const base = requireWorkspace(root);
  const directory = resolveInside(base, relativePath || '');
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    throw new Error(`No folder at ${relativePath || '.'}.`);
  }
  const entries: FileEntry[] = [];
  for (const entry of dirents) {
    if (entry.isSymbolicLink()) continue;
    const isDirectory = entry.isDirectory();
    if (!isDirectory && !entry.isFile()) continue;
    if (isDirectory && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    entries.push({
      name: entry.name,
      path: relativeToWorkspace(base, full),
      kind: isDirectory ? 'dir' : 'file',
    });
    rememberPath(relativeToWorkspace(base, full));
  }
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/**
 * Writes a file when its current version matches `version` (the empty version creates a new file).
 * Returns the new version, or the current document when someone else changed the file first.
 */
export function writeWorkspaceFile(
  root: string | undefined,
  relativePath: string,
  content: string,
  version: string,
): { ok: true; version: string } | { ok: false; conflict: FileDocument } {
  const base = requireWorkspace(root);
  const file = resolveInside(base, relativePath);
  const info = statOrUndefined(file);
  if (info?.isDirectory()) throw new Error(`${relativePath} is a folder.`);
  if (info) {
    const currentContent = fs.readFileSync(file, 'utf8');
    const current: FileDocument = {
      path: relativeToWorkspace(base, file),
      content: currentContent,
      language: languageFor(file),
      version: contentVersion(currentContent),
    };
    if (version !== current.version) return { ok: false, conflict: current };
  } else if (version) {
    return {
      ok: false,
      conflict: { path: relativePath, content: '', language: languageFor(file), version: '' },
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  rememberPath(relativeToWorkspace(base, file));
  return { ok: true, version: contentVersion(content) };
}

/** Resolves a path for create/rename/delete: inside the project, never the project folder itself. */
function entryPath(base: string, relativePath: string): string {
  const file = resolveInside(base, relativePath);
  if (file === path.resolve(base)) throw new Error('Pick a file or folder inside the project.');
  const name = path.basename(file);
  if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)) throw new Error(`"${name}" is not a valid name.`);
  return file;
}

/** Creates an empty file or a folder (with any missing parents). Fails when something is already there. */
export function createWorkspaceEntry(root: string | undefined, relativePath: string, kind: 'file' | 'dir'): string {
  const base = requireWorkspace(root);
  const file = entryPath(base, relativePath);
  if (statOrUndefined(file)) throw new Error(`${relativeToWorkspace(base, file)} already exists.`);
  if (kind === 'dir') fs.mkdirSync(file, { recursive: true });
  else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '', { encoding: 'utf8', flag: 'wx' });
  }
  const relative = relativeToWorkspace(base, file);
  rememberPath(relative);
  return relative;
}

/** Renames or moves a file or folder inside the project. Fails when the target exists. */
export function renameWorkspaceEntry(root: string | undefined, from: string, to: string): string {
  const base = requireWorkspace(root);
  const source = entryPath(base, from);
  const target = entryPath(base, to);
  if (!statOrUndefined(source)) throw new Error(`No file at ${from}.`);
  // Case-only renames on Windows/macOS see the source as the target; allow those.
  if (statOrUndefined(target) && source.toLowerCase() !== target.toLowerCase()) throw new Error(`${relativeToWorkspace(base, target)} already exists.`);
  if ((target + path.sep).startsWith(source + path.sep)) throw new Error('A folder cannot move inside itself.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  const relative = relativeToWorkspace(base, target);
  rememberPath(relative);
  return relative;
}

/** A free path for `name` in `folder`: "a.ts", then "a copy.ts", "a copy 2.ts", … (like a file manager). */
function freeTarget(folder: string, name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let candidate = path.join(folder, name);
  for (let index = 1; statOrUndefined(candidate); index += 1) {
    candidate = path.join(folder, `${stem} copy${index > 1 ? ` ${index}` : ''}${extension}`);
  }
  return candidate;
}

function targetFolder(base: string, relativeFolder: string): string {
  const folder = resolveInside(base, relativeFolder || '');
  if (!statOrUndefined(folder)?.isDirectory()) throw new Error(`No folder at ${relativeFolder || '.'}.`);
  return folder;
}

/** Copies a file or folder into `toFolder` (project-relative, '' = root); a taken name gets " copy". */
export function copyWorkspaceEntry(root: string | undefined, from: string, toFolder: string): string {
  const base = requireWorkspace(root);
  const source = entryPath(base, from);
  if (!statOrUndefined(source)) throw new Error(`No file at ${from}.`);
  const folder = targetFolder(base, toFolder);
  if ((folder + path.sep).startsWith(source + path.sep)) throw new Error('A folder cannot be copied into itself.');
  const target = freeTarget(folder, path.basename(source));
  fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
  const relative = relativeToWorkspace(base, target);
  rememberPath(relative);
  return relative;
}

/** Copies files or folders from anywhere on disk (dropped from the OS) into `toFolder`. */
export function importWorkspaceEntries(root: string | undefined, sources: string[], toFolder: string): string[] {
  const base = requireWorkspace(root);
  const folder = targetFolder(base, toFolder);
  const copied: string[] = [];
  for (const source of sources) {
    if (typeof source !== 'string' || !path.isAbsolute(source) || !statOrUndefined(source)) throw new Error(`Cannot read ${source}.`);
    const resolved = path.resolve(source);
    if ((folder + path.sep).startsWith(resolved + path.sep)) throw new Error('A folder cannot be copied into itself.');
    const target = freeTarget(folder, path.basename(resolved));
    fs.cpSync(resolved, target, { recursive: true, errorOnExist: true, force: false });
    const relative = relativeToWorkspace(base, target);
    rememberPath(relative);
    copied.push(relative);
  }
  return copied;
}

/** Deletes a file or folder for good (the screen prefers the OS trash and uses this only without one). */
export function deleteWorkspaceEntry(root: string | undefined, relativePath: string): void {
  const base = requireWorkspace(root);
  const file = entryPath(base, relativePath);
  if (!statOrUndefined(file)) throw new Error(`No file at ${relativePath}.`);
  fs.rmSync(file, { recursive: true, force: true });
}

/** Substring search over workspace-relative paths; directory names are ignored. */
export function findWorkspaceFiles(root: string | undefined, query: string, limit = 50): string[] {
  const base = requireWorkspace(root);
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const max = Math.min(Math.max(1, Math.trunc(limit) || 50), 500);
  const matches: string[] = [];
  let visited = 0;
  const walk = (directory: string, depth: number): void => {
    if (matches.length >= max * 4 || visited >= MAX_SEARCH_FILES || depth > MAX_SEARCH_DEPTH) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      const relative = relativeToWorkspace(base, full);
      if (relative.toLowerCase().includes(needle)) {
        matches.push(relative);
        rememberPath(relative);
      }
    }
  };
  walk(base, 0);
  return matches
    .sort((a, b) => {
      const aName = a.slice(a.lastIndexOf('/') + 1).toLowerCase();
      const bName = b.slice(b.lastIndexOf('/') + 1).toLowerCase();
      const aStarts = aName.startsWith(needle) ? 0 : 1;
      const bStarts = bName.startsWith(needle) ? 0 : 1;
      return aStarts - bStarts || a.length - b.length || a.localeCompare(b);
    })
    .slice(0, max);
}

/* ---------------------------------------------------------------------------------------------------------------
 * Fuzzy workspace search for `@` mentions
 */

/** One project-relative match; folders end in `/`. */
export interface WorkspaceSearchResult {
  path: string;
  kind: 'file' | 'folder';
}

/** Search-only ignores on top of the tree's list: build output and Unify's own data folder. */
const SEARCH_IGNORED = new Set([...IGNORED_DIRECTORIES, 'out', 'coverage', '.unify']);
const SEARCH_CACHE_MS = 10_000;

interface SearchEntry extends WorkspaceSearchResult {
  modified: number;
}

interface SearchCache {
  at: number;
  entries: SearchEntry[];
}

const searchCaches = new Map<string, SearchCache>();

function modifiedAt(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * One walk of the project, cached briefly: `@` typing sends a request per keystroke, and the file
 * list changes far more slowly than the query.
 */
function searchEntries(root: string): SearchEntry[] {
  const cached = searchCaches.get(root);
  const now = Date.now();
  if (cached && now - cached.at < SEARCH_CACHE_MS) return cached.entries;
  const entries: SearchEntry[] = [];
  const ignore = new GitIgnore(root);
  ignore.refresh();
  let visited = 0;
  const walk = (directory: string, depth: number): void => {
    if (visited >= MAX_SEARCH_FILES || depth > MAX_SEARCH_DEPTH) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents) {
      if (visited >= MAX_SEARCH_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      const relative = relativeToWorkspace(root, full);
      if (entry.isDirectory()) {
        if (SEARCH_IGNORED.has(entry.name) || ignore.ignores(relative, true)) continue;
        visited += 1;
        entries.push({ path: `${relative}/`, kind: 'folder', modified: modifiedAt(full) });
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || ignore.ignores(relative, false)) continue;
      visited += 1;
      entries.push({ path: relative, kind: 'file', modified: modifiedAt(full) });
    }
  };
  walk(root, 0);
  if (searchCaches.size >= 8) searchCaches.clear();
  searchCaches.set(root, { at: now, entries });
  return entries;
}

/** Whether `needle` appears in `haystack` in order, but not necessarily contiguously. */
function isSubsequence(haystack: string, needle: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return !needle.length;
}

/**
 * Fuzzy project search for `@` mentions: a file-name prefix beats a file-name substring, which
 * beats a path substring, which beats a subsequence. Shorter paths win ties; folders are included.
 * An empty query lists recently modified files.
 */
export function searchWorkspaceFiles(root: string | undefined, query: string, limit = 50): WorkspaceSearchResult[] {
  const base = requireWorkspace(root);
  const max = Math.min(Math.max(1, Math.trunc(limit) || 50), 500);
  const entries = searchEntries(base);
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return entries
      .filter(entry => entry.kind === 'file')
      .sort((a, b) => b.modified - a.modified || a.path.length - b.path.length || a.path.localeCompare(b.path))
      .slice(0, max)
      .map(({ path: file, kind }) => ({ path: file, kind }));
  }
  const ranked: { entry: SearchEntry; tier: number }[] = [];
  for (const entry of entries) {
    const lower = entry.path.toLowerCase();
    const name = lower.replace(/\/$/, '').slice(lower.replace(/\/$/, '').lastIndexOf('/') + 1);
    const tier = name.startsWith(needle) ? 0
      : name.includes(needle) ? 1
        : lower.includes(needle) ? 2
          : isSubsequence(lower, needle) ? 3
            : -1;
    if (tier !== -1) ranked.push({ entry, tier });
  }
  return ranked
    .sort((a, b) => a.tier - b.tier || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
    .slice(0, max)
    .map(({ entry }) => ({ path: entry.path, kind: entry.kind }));
}

/* ---------------------------------------------------------------------------------------------------------------
 * File change notifications
 */

interface WatchState {
  watcher: FSWatcher;
  timers: Map<string, NodeJS.Timeout>;
  known: Set<string>;
  ignore: GitIgnore;
}

const watchers = new Map<string, WatchState>();
let activeReply: UnifyReply | undefined;

/** The dispatcher points this at the newest reply callback so pushes reach the live webview. */
export function setActiveUnifyReply(reply: UnifyReply | undefined): void {
  activeReply = reply;
}

function rememberPath(relative: string): void {
  for (const state of watchers.values()) state.known.add(relative);
}

function normaliseRoots(roots: string | string[] | undefined): string[] {
  const list = Array.isArray(roots) ? roots : roots ? [roots] : [];
  const resolved: string[] = [];
  for (const root of list) {
    if (typeof root !== 'string' || !root) continue;
    const full = path.resolve(root);
    if (resolved.includes(full) || !statOrUndefined(full)?.isDirectory()) continue;
    resolved.push(full);
  }
  return resolved;
}

/** Folders every root skips, besides those `.gitignore` names. */
function skippedSegment(segment: string): boolean {
  return IGNORED_DIRECTORIES.has(segment) || segment === '.unify';
}

/** Whether a changed root-relative path is outside what the Files screen shows. */
function isIgnored(root: string, relative: string, isDirectory: boolean): boolean {
  const segments = relative.split('/').filter(Boolean);
  if (!segments.length) return false;
  if (segments.some(skippedSegment)) return true;
  const full = path.resolve(root, ...segments);
  const home = path.resolve(unifyHome());
  if (full === home || full.startsWith(home + path.sep)) return true;
  const state = watchers.get(root);
  if (!state) return false;
  state.ignore.refresh();
  // A file inside an ignored folder is ignored too; check every ancestor as a directory.
  let prefix = '';
  for (const segment of segments.slice(0, -1)) {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    if (state.ignore.ignores(prefix, true)) return true;
  }
  return state.ignore.ignores(relative, isDirectory);
}

/**
 * Starts watching each project root once. Safe to call for every files request; an already-watched root keeps
 * its watcher and only the reply sink is replaced.
 */
export function watchWorkspace(roots: string | string[] | undefined, reply?: UnifyReply): void {
  if (reply) activeReply = reply;
  for (const root of normaliseRoots(roots)) {
    if (watchers.has(root)) continue;
    let watcher: FSWatcher;
    try {
      watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) return;
        const relative = filename.toString().replace(/\\/g, '/');
        scheduleChange(root, relative);
      });
    } catch {
      // Recursive watching is unavailable on this platform; files still read on demand.
      continue;
    }
    watcher.on('error', () => {
      watcher.close();
      watchers.delete(root);
    });
    watchers.set(root, { watcher, timers: new Map(), known: new Set(), ignore: new GitIgnore(root) });
  }
}

function scheduleChange(root: string, relative: string): void {
  const state = watchers.get(root);
  if (!state) return;
  const existing = state.timers.get(relative);
  if (existing) clearTimeout(existing);
  state.timers.set(relative, setTimeout(() => {
    state.timers.delete(relative);
    const base = path.resolve(root);
    const full = path.resolve(base, ...relative.split('/'));
    if (full !== base && !full.startsWith(base + path.sep)) return;
    const info = statOrUndefined(full);
    if (isIgnored(root, relative, !!info?.isDirectory())) return;
    if (info?.isDirectory()) return;
    const wasKnown = state.known.has(relative);
    if (!info) {
      state.known.delete(relative);
      activeReply?.({ type: 'fileChanged', root: base, path: relative, kind: 'deleted' } satisfies FilesReply);
      return;
    }
    state.known.add(relative);
    activeReply?.({
      type: 'fileChanged',
      root: base,
      path: relative,
      kind: wasKnown ? 'changed' : 'created',
    } satisfies FilesReply);
  }, CHANGE_DEBOUNCE_MS));
}

/** Closes every watcher; the extension calls this on deactivate and tests on teardown. */
export function disposeUnifyRequestWatchers(): void {
  for (const state of watchers.values()) {
    for (const timer of state.timers.values()) clearTimeout(timer);
    state.watcher.close();
  }
  watchers.clear();
  activeReply = undefined;
}
