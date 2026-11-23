/**
 * Files data adapter: the only place the Files screen talks to the engine.
 *
 * The engine does not list folders or read/write files yet. The messages it needs are specified in
 * ./protocol-requests.md and typed below (FilesRequest / FilesReply). Until the engine answers them, the
 * adapter serves a mock workspace (the Figma "20 · Files + Editor" tree), so the screen works in vite dev and
 * in the app. Once the backend implements the messages, nothing in the components changes.
 *
 * How it picks: with the dev mock bridge it goes straight to the mock. With a real host it sends the request
 * and falls back to the mock when no reply arrives within `replyTimeout` (remembered for the session).
 *
 * Agent edits also come from the existing `viewState.diffs` (SidebarDiff: path, additions, deletions), so tree
 * rows and tabs show +N −M as soon as an agent touches a file, whatever the source of the listing.
 */
import { createSignal } from 'solid-js';
import { hasHostBridge, post } from '../../bridge';
import { onHostMessage, viewState } from '../../store';
import type { SidebarWebviewMessage } from '../../protocol';

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

export type WriteResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'conflict'; current: FileDocument }
  | { ok: false; reason: 'error'; message: string };

export type FilesRequest =
  | { type: 'listDir'; requestId: string; path: string }
  | { type: 'readFile'; requestId: string; path: string }
  | { type: 'writeFile'; requestId: string; path: string; content: string; version: string }
  | { type: 'findFiles'; requestId: string; query: string; limit?: number };

export type FilesReply =
  | { type: 'workspaceState'; root: string; name: string }
  | { type: 'dirListing'; requestId: string; path: string; entries: FileEntry[] }
  | { type: 'fileContent'; requestId: string; file: FileDocument }
  | { type: 'fileSaved'; requestId: string; path: string; version: string }
  | { type: 'fileConflict'; requestId: string; current: FileDocument }
  | { type: 'fileMatches'; requestId: string; query: string; paths: string[] }
  | { type: 'filesError'; requestId: string; message: string }
  /** Pushed when a file changes on disk (agent edit, external editor). The screen re-reads open files. */
  | { type: 'fileChanged'; path: string; kind: 'changed' | 'created' | 'deleted'; edited?: FileEdit };

// ---------------------------------------------------------------------------------------------------------------
// Transport

const replyTimeout = 1500;
let engineSupported: boolean | undefined = hasHostBridge() ? undefined : false;
const pending = new Map<string, (reply: FilesReply) => void>();
const changeListeners = new Set<(change: Extract<FilesReply, { type: 'fileChanged' }>) => void>();
const [workspace, setWorkspace] = createSignal<{ root: string; name: string }>({ root: '', name: 'DSH' });
export { workspace };

let nextId = 0;

onHostMessage(raw => {
  const message = raw as unknown as FilesReply;
  if (message.type === 'workspaceState') {
    setWorkspace({ root: message.root, name: message.name });
    return;
  }
  if (message.type === 'fileChanged') {
    for (const listener of changeListeners) listener(message);
    return;
  }
  if ('requestId' in message && pending.has(message.requestId)) {
    engineSupported = true;
    pending.get(message.requestId)!(message);
    pending.delete(message.requestId);
  }
});

type RequestBody<T> = T extends { requestId: string } ? Omit<T, 'requestId'> : never;

function request(body: RequestBody<FilesRequest>): Promise<FilesReply | undefined> {
  if (engineSupported === false) return Promise.resolve(undefined);
  const requestId = `files:${Date.now()}:${nextId++}`;
  return new Promise(resolve => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      if (engineSupported === undefined) engineSupported = false;
      resolve(undefined);
    }, replyTimeout);
    pending.set(requestId, reply => {
      window.clearTimeout(timer);
      resolve(reply);
    });
    post({ ...body, requestId } as unknown as SidebarWebviewMessage);
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

export async function listDir(path: string): Promise<FileEntry[]> {
  const reply = await request({ type: 'listDir', path });
  if (reply?.type === 'dirListing') return sortEntries(reply.entries);
  return sortEntries(mock.listDir(path));
}

export async function readFile(path: string): Promise<FileDocument> {
  const reply = await request({ type: 'readFile', path });
  if (reply?.type === 'fileContent') return withLanguage(reply.file);
  if (reply?.type === 'filesError') throw new Error(reply.message);
  return withLanguage(mock.readFile(path));
}

export async function writeFile(path: string, content: string, version: string): Promise<WriteResult> {
  const reply = await request({ type: 'writeFile', path, content, version });
  if (reply?.type === 'fileSaved') return { ok: true, version: reply.version };
  if (reply?.type === 'fileConflict') return { ok: false, reason: 'conflict', current: withLanguage(reply.current) };
  if (reply?.type === 'filesError') return { ok: false, reason: 'error', message: reply.message };
  return mock.writeFile(path, content);
}

export async function findFiles(query: string, limit = 50): Promise<string[]> {
  const reply = await request({ type: 'findFiles', query, limit });
  if (reply?.type === 'fileMatches') return reply.paths;
  return mock.findFiles(query).slice(0, limit);
}

export function onFileChanged(listener: (change: Extract<FilesReply, { type: 'fileChanged' }>) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
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

function relativePath(path: string): string {
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
// Mock workspace (Figma 306:1623). Dev and fallback only.

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
  ['README.md', '# DSH\n\nAgents for your editor.\n'],
  ['package.json', '{\n  "name": "dsh",\n  "version": "1.1.5",\n  "main": "./out/extension.js"\n}\n'],
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
};

/** For the dev preview: lets a test push a fake agent edit. */
export function emitMockChange(change: Extract<FilesReply, { type: 'fileChanged' }>): void {
  for (const listener of changeListeners) listener(change);
}
