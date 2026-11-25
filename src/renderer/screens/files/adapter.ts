/**
 * Files data adapter: the only place the Files screen talks to the engine.
 *
 * The engine answers the messages typed below (FilesRequest / FilesReply, see ./protocol-requests.md and
 * src/engine/unify/requests). With a real host bridge the adapter only ever shows what the engine sends: no
 * reply means an empty listing or an error, never sample files. The mock workspace (the Figma
 * "20 · Files + Editor" tree) is served only when there is no host bridge at all (vite dev, previews).
 *
 * Contents search (Ctrl+Shift+F) is `searchFileContents` → `contentMatches`, one ContentMatch per occurrence; the
 * mock scans the mock files with `scanText`, which the Knowledge mock reuses.
 *
 * Agent edits also come from the existing `viewState.diffs` (SidebarDiff: path, additions, deletions), so tree
 * rows and tabs show +N −M as soon as an agent touches a file, whatever the source of the listing.
 */
import { createSignal } from 'solid-js';
import { bridge, hasHostBridge, post } from '../../bridge';
import { readPersisted, writePersisted } from '../../persist';
import { onHostMessage, viewState } from '../../store';
import type { SidebarHostMessage, SidebarProject, SidebarWebviewMessage } from '../../protocol';

// ---------------------------------------------------------------------------------------------------------------
// Contract (mirrors protocol-requests.md)

export interface FileEdit {
  additions: number;
  deletions: number;
}

export interface FileEntry {
  name: string;
  /** Workspace-relative, forward slashes: "src/toolpacks/registry.ts". */
  path: string;
  kind: 'file' | 'dir';
  /** Set when an agent changed the file in the current chat(s) and the change is not reviewed yet. */
  edited?: FileEdit;
}

/** Lines an agent changed, so the editor can tint them. Line numbers are 1-based in the current content. */
export interface FileLineChanges {
  added: number[];
  /** Removed lines, shown above `afterLine + 1` (0 = top of the file). */
  removed: { afterLine: number; lines: string[] }[];
}

export interface FileDocument {
  path: string;
  content: string;
  /** Monaco language id; the adapter guesses from the extension when missing. */
  language?: string;
  /** Opaque version (mtime or hash); writeFile sends it back to detect conflicts. */
  version: string;
  changes?: FileLineChanges;
}

/** One occurrence of a contents-search query (Ctrl+Shift+F). */
export interface ContentMatch {
  /** Workspace-relative, forward slashes. */
  path: string;
  /** 1-based line of the occurrence. */
  line: number;
  /** 1-based column in `text`. */
  column: number;
  /** Length of the occurrence in characters. */
  length: number;
  /** The whole line, cut to 300 characters. */
  text: string;
}

export interface ContentSearchResult {
  query: string;
  matches: ContentMatch[];
  /** True when the engine stopped at `limit` occurrences. */
  truncated: boolean;
}

export interface ContentSearchOptions {
  caseSensitive?: boolean;
  limit?: number;
}

export type WriteResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'conflict'; current: FileDocument }
  | { ok: false; reason: 'error'; message: string };

export type FilesRequest =
  | { type: 'listDir'; requestId: string; path: string }
  | { type: 'readFile'; requestId: string; path: string }
  | { type: 'writeFile'; requestId: string; path: string; content: string; version: string }
  | { type: 'findFiles'; requestId: string; query: string; limit?: number }
  | { type: 'searchFileContents'; requestId: string; query: string; caseSensitive?: boolean; limit?: number }
  | { type: 'createEntry'; requestId: string; path: string; kind: 'file' | 'dir' }
  | { type: 'renameEntry'; requestId: string; from: string; to: string }
  | { type: 'deleteEntry'; requestId: string; path: string }
  | { type: 'copyEntry'; requestId: string; from: string; toFolder: string }
  | { type: 'importEntries'; requestId: string; /** Absolute paths on disk (dropped from the OS). */ sources: string[]; toFolder: string };

export type FilesReply =
  | { type: 'entryDone'; requestId: string; path: string; /** importEntries: every copied path. */ paths?: string[] }
  | { type: 'workspaceState'; root: string; name: string }
  | { type: 'dirListing'; requestId: string; path: string; entries: FileEntry[] }
  | { type: 'fileContent'; requestId: string; file: FileDocument }
  | { type: 'fileSaved'; requestId: string; path: string; version: string }
  | { type: 'fileConflict'; requestId: string; current: FileDocument }
  | { type: 'fileMatches'; requestId: string; query: string; paths: string[] }
  | { type: 'contentMatches'; requestId: string; query: string; matches: ContentMatch[]; truncated: boolean }
  | { type: 'filesError'; requestId: string; message: string }
  /** Pushed when a file changes on disk (agent edit, external editor). The screen re-reads open files. */
  | { type: 'fileChanged'; /** The watched project folder the path is relative to. */ root?: string; path: string; kind: 'changed' | 'created' | 'deleted'; edited?: FileEdit };

/** The engine asks the Files editor to open a file or a diff (shim `showTextDocument` / `vscode.diff`). */
export type EditorRequest = Extract<SidebarHostMessage, { type: 'editorOpen' } | { type: 'editorDiff' }>;

// ---------------------------------------------------------------------------------------------------------------
// Transport

const replyTimeout = 10000;
/** Dev previews only: no host bridge means no engine, so the mock workspace answers instead. */
const useMock = !hasHostBridge();
const pending = new Map<string, (reply: FilesReply) => void>();
const changeListeners = new Set<(change: Extract<FilesReply, { type: 'fileChanged' }>) => void>();
const editorListeners = new Set<(request: EditorRequest) => void>();
const [workspace, setWorkspace] = createSignal<{ root: string; name: string }>({ root: '', name: '' });
export { workspace };

/** The project folder picked on the Files screen; undefined means the folder the app has open. */
const [filesProject, setFilesProjectSignal] = createSignal<SidebarProject | undefined>(
  readPersisted<SidebarProject | undefined>('files.project', undefined),
);
export { filesProject };

/** Use state.ts's switchFilesProject, which also clears the tree and tabs of the previous project. */
export function setFilesProject(project: SidebarProject | undefined): void {
  setFilesProjectSignal(project);
  writePersisted('files.project', project);
  if (project && !useMock) setWorkspace({ root: project.path, name: project.name });
}

function samePath(first: string, second: string): boolean {
  const normal = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normal(first) === normal(second);
}

let nextId = 0;

onHostMessage(raw => {
  if (raw.type === 'editorOpen' || raw.type === 'editorDiff') {
    for (const listener of editorListeners) listener(raw);
    return;
  }
  const message = raw as unknown as FilesReply;
  if (message.type === 'workspaceState') {
    setWorkspace({ root: message.root, name: message.name });
    return;
  }
  if (message.type === 'fileChanged') {
    // The engine watches every project the screen has shown; only the one on screen matters.
    if (message.root && workspace().root && !samePath(message.root, workspace().root)) return;
    for (const listener of changeListeners) listener(message);
    return;
  }
  if ('requestId' in message && pending.has(message.requestId)) {
    pending.get(message.requestId)!(message);
    pending.delete(message.requestId);
  }
});

type RequestBody<T> = T extends { requestId: string } ? Omit<T, 'requestId'> : never;

function request(body: RequestBody<FilesRequest>): Promise<FilesReply | undefined> {
  const requestId = `files:${Date.now()}:${nextId++}`;
  return new Promise(resolve => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      resolve(undefined);
    }, replyTimeout);
    pending.set(requestId, reply => {
      window.clearTimeout(timer);
      resolve(reply);
    });
    const project = filesProject()?.path;
    post({ ...body, requestId, ...(project ? { project } : {}) } as unknown as SidebarWebviewMessage);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Public API

/** Agent edits from the engine's diff list, keyed by workspace-relative path. */
export function engineEdits(): Map<string, FileEdit> {
  const result = new Map<string, FileEdit>();
  for (const diff of viewState.diffs) {
    if (diff.state === 'rejected') continue;
    const path = relativePath(diff.path);
    const current = result.get(path) ?? { additions: 0, deletions: 0 };
    current.additions += diff.additions ?? 0;
    current.deletions += diff.deletions ?? 0;
    result.set(path, current);
  }
  return result;
}

/** An empty folder when the engine fails or does not answer; the tree shows it as empty, not as sample files. */
export async function listDir(path: string): Promise<FileEntry[]> {
  if (useMock) return sortEntries(mock.listDir(path));
  const reply = await request({ type: 'listDir', path });
  if (reply?.type === 'dirListing') return sortEntries(reply.entries);
  console.warn(`[files] listDir "${path}" failed: ${reply?.type === 'filesError' ? reply.message : 'the engine did not answer'}`);
  return [];
}

export async function readFile(path: string): Promise<FileDocument> {
  if (useMock) return withLanguage(mock.readFile(path));
  const reply = await request({ type: 'readFile', path });
  if (reply?.type === 'fileContent') return withLanguage(reply.file);
  throw new Error(reply?.type === 'filesError' ? reply.message : 'The engine did not answer');
}

export async function writeFile(path: string, content: string, version: string): Promise<WriteResult> {
  if (useMock) return mock.writeFile(path, content);
  const reply = await request({ type: 'writeFile', path, content, version });
  if (reply?.type === 'fileSaved') return { ok: true, version: reply.version };
  if (reply?.type === 'fileConflict') return { ok: false, reason: 'conflict', current: withLanguage(reply.current) };
  return { ok: false, reason: 'error', message: reply?.type === 'filesError' ? reply.message : 'The engine did not answer' };
}

export async function findFiles(query: string, limit = 50): Promise<string[]> {
  if (useMock) return mock.findFiles(query).slice(0, limit);
  const reply = await request({ type: 'findFiles', query, limit });
  if (reply?.type === 'fileMatches') return reply.paths;
  return [];
}

/** Default and engine cap for contents search occurrences. */
export const contentSearchLimit = 500;

/** Every literal occurrence of `query` in the project's text files (Ctrl+Shift+F). Empty when the engine fails. */
export async function searchFileContents(query: string, options: ContentSearchOptions = {}): Promise<ContentSearchResult> {
  const limit = options.limit ?? contentSearchLimit;
  if (useMock) return mock.searchContents(query, !!options.caseSensitive, limit);
  const reply = await request({ type: 'searchFileContents', query, caseSensitive: options.caseSensitive, limit });
  if (reply?.type === 'contentMatches') return { query: reply.query, matches: reply.matches, truncated: reply.truncated };
  if (reply?.type === 'filesError') console.warn(`[files] searchFileContents failed: ${reply.message}`);
  return { query, matches: [], truncated: false };
}

/**
 * Every literal occurrence of `query` in `text` as { line, column, length, text } rows (1-based), the same shape the
 * engine sends. Shared by the mocks of both screens.
 */
export function scanText(
  text: string,
  query: string,
  caseSensitive: boolean,
  limit: number,
): { line: number; column: number; length: number; text: string }[] {
  const results: { line: number; column: number; length: number; text: string }[] = [];
  if (!query) return results;
  const needle = caseSensitive ? query : query.toLowerCase();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length && results.length < limit; index += 1) {
    const haystack = caseSensitive ? lines[index] : lines[index].toLowerCase();
    let from = haystack.indexOf(needle);
    while (from >= 0 && results.length < limit) {
      results.push({
        line: index + 1,
        column: from + 1,
        length: query.length,
        text: lines[index].slice(0, 300),
      });
      from = haystack.indexOf(needle, from + needle.length);
    }
  }
  return results;
}

function entryResult(reply: FilesReply | undefined): string {
  if (reply?.type === 'entryDone') return reply.path;
  throw new Error(reply?.type === 'filesError' ? reply.message : 'The engine did not answer');
}

/** Creates an empty file or a folder; resolves with its project-relative path. */
export async function createEntry(path: string, kind: 'file' | 'dir'): Promise<string> {
  if (useMock) return mock.create(path, kind);
  return entryResult(await request({ type: 'createEntry', path, kind }));
}

/** Renames or moves a file or folder inside the project; resolves with the new path. */
export async function renameEntry(from: string, to: string): Promise<string> {
  if (useMock) return mock.rename(from, to);
  return entryResult(await request({ type: 'renameEntry', from, to }));
}

/** Copies a file or folder into `toFolder` ('' = root); a taken name becomes "name copy.ext". Resolves the new path. */
export async function copyEntry(from: string, toFolder: string): Promise<string> {
  if (useMock) return mock.copy(from, toFolder);
  return entryResult(await request({ type: 'copyEntry', from, toFolder }));
}

/** Copies files dropped from the OS (absolute paths) into `toFolder`. Resolves the new project-relative paths. */
export async function importEntries(sources: string[], toFolder: string): Promise<string[]> {
  if (useMock) return sources.map(source => mock.create(`${toFolder ? `${toFolder}/` : ''}${source.replace(/\\/g, '/').split('/').pop()}`, 'file'));
  const reply = await request({ type: 'importEntries', sources, toFolder });
  entryResult(reply);
  return reply?.type === 'entryDone' ? reply.paths ?? [reply.path] : [];
}

/** Absolute paths of files dropped from the OS; empty outside Electron or for non-disk files. */
export function droppedPaths(files: FileList | undefined | null): string[] {
  const toPath = bridge().pathForFile;
  if (!files) return [];
  if (useMock) return [...files].map(file => file.name);
  if (!toPath) return [];
  return [...files].map(file => toPath(file)).filter(Boolean);
}

export function canReveal(): boolean {
  return !!bridge().revealItem && !!workspace().root;
}

/** Shows the entry selected in the OS file manager. */
export function revealEntry(path: string): void {
  const reveal = bridge().revealItem;
  if (reveal && workspace().root) void reveal(workspace().root, path);
}

/** The entry's absolute path, for "Copy path". */
export function absoluteEntryPath(path: string): string {
  const root = workspace().root.replace(/[\\/]+$/, '');
  if (!root) return path;
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root}${separator}${path.split('/').join(separator)}`;
}

/** True when deletes go to the OS trash (Electron); otherwise they are permanent. */
export function deletesToTrash(): boolean {
  return useMock || (!!bridge().trashItem && !!workspace().root);
}

/** Moves a file or folder to the OS trash, or deletes it for good when there is no trash (see deletesToTrash). */
export async function deleteEntry(path: string): Promise<void> {
  if (useMock) return mock.remove(path);
  const trash = bridge().trashItem;
  const root = workspace().root;
  if (trash && root) {
    await trash(root, path);
    return;
  }
  entryResult(await request({ type: 'deleteEntry', path }));
}

export function onFileChanged(listener: (change: Extract<FilesReply, { type: 'fileChanged' }>) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** `editorOpen` / `editorDiff` from the engine. Paths are as sent (absolute or relative); see relativePath. */
export function onEditorRequest(listener: (request: EditorRequest) => void): () => void {
  editorListeners.add(listener);
  return () => editorListeners.delete(listener);
}

/** Opens the file in the OS / external editor (existing engine message). */
export function openExternally(path: string, line?: number): void {
  post({ type: 'openFile', path: absolutePath(path), line });
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

/** Workspace-relative with forward slashes; a path outside the workspace comes back absolute (slashes fixed). */
export function relativePath(path: string): string {
  const normal = path.replace(/\\/g, '/');
  const root = workspace().root.replace(/\\/g, '/').replace(/\/$/, '');
  if (root && normal.toLowerCase().startsWith(root.toLowerCase() + '/')) return normal.slice(root.length + 1);
  return normal.replace(/^\.\//, '');
}

function absolutePath(path: string): string {
  const root = workspace().root.replace(/\\/g, '/').replace(/\/$/, '');
  return root ? `${root}/${path}` : path;
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

const languageByExtension: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  luau: 'lua',
  lua: 'lua',
  py: 'python',
  rs: 'rust',
  go: 'go',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  ps1: 'powershell',
};

export function languageFor(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return languageByExtension[extension] ?? 'plaintext';
}

function withLanguage(file: FileDocument): FileDocument {
  return file.language ? file : { ...file, language: languageFor(file.path) };
}

// ---------------------------------------------------------------------------------------------------------------
// Mock workspace (Figma 306:1623). Only when there is no host bridge (`useMock`).

const registrySource = `import { ToolpackManifest, ToolDefinition } from "./types";
import { startWorker } from "./worker";

export class ToolpackRegistry {
  private packs = new Map<string, ToolpackManifest>();

  register(manifest: ToolpackManifest): void {
    if (this.packs.has(manifest.id)) {
      this.unregister(manifest.id);
    }
    this.packs.set(manifest.id, manifest);
    startWorker(manifest);
  }

  // Tools from disabled packs never reach the agent
  enabledTools(): ToolDefinition[] {
    return [...this.packs.values()]
      .filter((pack) => pack.enabled)
      .flatMap((pack) => pack.tools.filter((tool) => tool.enabled));
  }

  unregister(id: string): void {
    const pack = this.packs.get(id);
    if (!pack) return;
    pack.worker?.dispose();
    this.packs.delete(id);
  }

  find(toolName: string): ToolDefinition | undefined {
    for (const pack of this.packs.values()) {
      const tool = pack.tools.find((t) => t.name === toolName);
      if (tool) return tool;
    }
    return undefined;
  }
}

export const registry = new ToolpackRegistry();
`;

const typesSource = `export interface ToolDefinition {
  name: string;
  description: string;
  enabled: boolean;
  inputSchema: Record<string, unknown>;
}

export interface ToolpackManifest {
  id: string;
  name: string;
  enabled: boolean;
  tools: ToolDefinition[];
  worker?: { dispose(): void };
}
`;

const mockTree: Record<string, { name: string; kind: 'file' | 'dir'; edited?: FileEdit }[]> = {
  '': [
    { name: 'src', kind: 'dir' },
    { name: 'media', kind: 'dir' },
    { name: 'scripts', kind: 'dir' },
    { name: 'package.json', kind: 'file' },
    { name: 'README.md', kind: 'file' },
    { name: 'tsconfig.json', kind: 'file' },
  ],
  src: [
    { name: 'delegate', kind: 'dir' },
    { name: 'mcp', kind: 'dir' },
    { name: 'toolpacks', kind: 'dir' },
    { name: 'extension.ts', kind: 'file' },
    { name: 'view.ts', kind: 'file' },
  ],
  'src/delegate': [
    { name: 'host.ts', kind: 'file' },
    { name: 'brief.ts', kind: 'file' },
  ],
  'src/mcp': [
    { name: 'delegateServer.ts', kind: 'file', edited: { additions: 12, deletions: 0 } },
    { name: 'tools.ts', kind: 'file' },
  ],
  'src/toolpacks': [
    { name: 'registry.ts', kind: 'file', edited: { additions: 18, deletions: 4 } },
    { name: 'types.ts', kind: 'file', edited: { additions: 4, deletions: 2 } },
    { name: 'worker.ts', kind: 'file' },
  ],
  media: [
    { name: 'icon.png', kind: 'file' },
    { name: 'sidebar.css', kind: 'file' },
  ],
  scripts: [{ name: 'release.mjs', kind: 'file' }],
};

const mockContent = new Map<string, string>([
  ['src/toolpacks/registry.ts', registrySource],
  ['src/toolpacks/types.ts', typesSource],
  ['README.md', '# Unify\n\nAgents for your desktop.\n'],
  ['package.json', '{\n  "name": "unify",\n  "version": "1.1.5",\n  "main": "./out/extension.js"\n}\n'],
]);

const mockChanges: Record<string, FileLineChanges> = {
  'src/toolpacks/registry.ts': {
    added: [8, 9, 10, 25],
    removed: [
      { afterLine: 7, lines: ['    if (this.packs.has(manifest.id)) return;'] },
      { afterLine: 24, lines: ['    pack.worker?.terminate();'] },
    ],
  },
  'src/toolpacks/types.ts': {
    added: [13],
    removed: [{ afterLine: 12, lines: ['  worker?: Worker;'] }],
  },
};

const mockVersions = new Map<string, number>();

const mock = {
  listDir(path: string): FileEntry[] {
    return (mockTree[path] ?? []).map(entry => ({ ...entry, path: path ? `${path}/${entry.name}` : entry.name }));
  },
  readFile(path: string): FileDocument {
    const content = mockContent.get(path) ?? `// ${baseName(path)}\n// (dev mock: the engine does not serve file contents yet)\n`;
    return {
      path,
      content,
      version: String(mockVersions.get(path) ?? 1),
      changes: mockChanges[path],
    };
  },
  writeFile(path: string, content: string): WriteResult {
    mockContent.set(path, content);
    const version = (mockVersions.get(path) ?? 1) + 1;
    mockVersions.set(path, version);
    delete mockChanges[path];
    return { ok: true, version: String(version) };
  },
  findFiles(query: string): string[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const all: string[] = [];
    for (const [folder, entries] of Object.entries(mockTree)) {
      for (const entry of entries) {
        if (entry.kind === 'file') all.push(folder ? `${folder}/${entry.name}` : entry.name);
      }
    }
    return all.filter(path => path.toLowerCase().includes(needle));
  },
  searchContents(query: string, caseSensitive: boolean, limit: number): ContentSearchResult {
    const matches: ContentMatch[] = [];
    for (const [folder, entries] of Object.entries(mockTree)) {
      for (const entry of entries) {
        if (entry.kind !== 'file' || matches.length >= limit) continue;
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        const content = mock.readFile(path).content;
        for (const hit of scanText(content, query, caseSensitive, limit - matches.length)) matches.push({ path, ...hit });
      }
    }
    return {
      query,
      matches,
      truncated: matches.length >= limit,
    };
  },
  create(path: string, kind: 'file' | 'dir'): string {
    const folder = parentPath(path);
    const entries = mockTree[folder] ?? [];
    if (entries.some(entry => entry.name === baseName(path))) throw new Error(`${path} already exists.`);
    mockTree[folder] = [...entries, { name: baseName(path), kind }];
    if (kind === 'dir') mockTree[path] = [];
    else mockContent.set(path, '');
    return path;
  },
  rename(from: string, to: string): string {
    const entry = (mockTree[parentPath(from)] ?? []).find(item => item.name === baseName(from));
    if (!entry) throw new Error(`No file at ${from}.`);
    mockTree[parentPath(from)] = mockTree[parentPath(from)].filter(item => item !== entry);
    mockTree[parentPath(to)] = [...(mockTree[parentPath(to)] ?? []), { ...entry, name: baseName(to) }];
    if (mockContent.has(from)) {
      mockContent.set(to, mockContent.get(from)!);
      mockContent.delete(from);
    }
    return to;
  },
  copy(from: string, toFolder: string): string {
    const entry = (mockTree[parentPath(from)] ?? []).find(item => item.name === baseName(from));
    if (!entry) throw new Error(`No file at ${from}.`);
    const taken = new Set((mockTree[toFolder] ?? []).map(item => item.name));
    const dot = entry.name.lastIndexOf('.');
    const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name;
    const extension = dot > 0 ? entry.name.slice(dot) : '';
    let name = entry.name;
    for (let index = 1; taken.has(name); index += 1) name = `${stem} copy${index > 1 ? ` ${index}` : ''}${extension}`;
    const to = toFolder ? `${toFolder}/${name}` : name;
    mockTree[toFolder] = [...(mockTree[toFolder] ?? []), { name, kind: entry.kind }];
    if (mockContent.has(from)) mockContent.set(to, mockContent.get(from)!);
    if (entry.kind === 'dir') mockTree[to] = [...(mockTree[from] ?? [])];
    return to;
  },
  remove(path: string): void {
    mockTree[parentPath(path)] = (mockTree[parentPath(path)] ?? []).filter(item => item.name !== baseName(path));
    mockContent.delete(path);
  },
};

/** For the dev preview: lets a test push a fake agent edit. */
export function emitMockChange(change: Extract<FilesReply, { type: 'fileChanged' }>): void {
  for (const listener of changeListeners) listener(change);
}

/** For the dev preview: adds a file to the mock tree and reports it created, as an agent's write would. */
export function mockCreateFile(path: string, content = ''): void {
  const folder = parentPath(path);
  const entries = mockTree[folder] ?? [];
  if (!entries.some(entry => entry.name === baseName(path))) {
    mockTree[folder] = [...entries, { name: baseName(path), kind: 'file' }];
  }
  mockContent.set(path, content);
  emitMockChange({ type: 'fileChanged', path, kind: 'created' });
}

/** For the dev preview: removes a file from the mock tree and reports it deleted. */
export function mockDeleteFile(path: string): void {
  const folder = parentPath(path);
  mockTree[folder] = (mockTree[folder] ?? []).filter(entry => entry.name !== baseName(path));
  mockContent.delete(path);
  emitMockChange({ type: 'fileChanged', path, kind: 'deleted' });
}

/** For the dev preview: a rename in one folder, which the engine reports as a delete and a create. */
export function mockRenameFile(from: string, to: string): void {
  const folder = parentPath(from);
  const content = mockContent.get(from) ?? '';
  mockTree[folder] = (mockTree[folder] ?? []).map(entry => (entry.name === baseName(from) ? { ...entry, name: baseName(to) } : entry));
  mockContent.delete(from);
  mockContent.set(to, content);
  emitMockChange({ type: 'fileChanged', path: from, kind: 'deleted' });
  emitMockChange({ type: 'fileChanged', path: to, kind: 'created' });
}

/** For the dev preview: replaces a file's text (and its changed lines) and reports it changed. */
export function mockEditFile(path: string, content: string, changes?: FileLineChanges): void {
  mockContent.set(path, content);
  mockVersions.set(path, (mockVersions.get(path) ?? 1) + 1);
  if (changes) mockChanges[path] = changes;
  else delete mockChanges[path];
  emitMockChange({ type: 'fileChanged', path, kind: 'changed' });
}
