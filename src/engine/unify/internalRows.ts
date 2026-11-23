/**
 * Friendly labels for generic file tools used on Unify's own data.
 *
 * Agents sometimes read or save memory and earlier conversation with an ordinary Read, Grep, Write or Edit instead
 * of the dedicated tool. The row then says what the call really did ("Checking memory") instead of showing a path
 * into the app's data folder. Everything else, including every user project file, is left alone.
 *
 * The classifier is pure: it works on the call's tool name and input plus the places the app keeps data, and never
 * touches the file system.
 */
import * as os from 'node:os';
import { posix } from 'node:path';
import type { SidebarInternalTool } from '../sidebar/view';
import { getUnifyFeature } from './settings';

export interface InternalToolCall {
  tool: string;
  input: unknown;
}

export interface InternalToolPlaces {
  /** Unify's data folder, as `unifyHome()` returns it. */
  dataHome: string;
  /** The working copies the agent can edit. */
  projectRoots: string[];
  /** A global memory vault outside the data folder, when the user set one. */
  globalVault?: string;
  /** The platform whose path rules apply; tests inject one, production uses the running platform. */
  platform?: NodeJS.Platform;
}

/** Project folders that belong to the app rather than the user's project. */
const PROJECT_DATA_FOLDERS = ['.unify'];

/** File tools whose calls can describe an app-data job. Dedicated tools are never in these sets. */
const READ_TOOLS = new Set(['read', 'readfile', 'view', 'viewimage', 'notebookread', 'listdir', 'ls']);
const SEARCH_TOOLS = new Set(['grep', 'search', 'codebasesearch', 'glob', 'findfiles']);
const WRITE_TOOLS = new Set(['write', 'writefile', 'edit', 'multiedit', 'fileedit', 'strreplace', 'applypatch', 'notebookedit']);

/** Input fields that hold a path. `pattern` and `glob` only count when the value looks like a path. */
const PATH_FIELDS = ['file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'file', 'filename', 'directory', 'dir', 'folder', 'cwd', 'root'];
const LOOSE_PATH_FIELDS = ['pattern', 'glob', 'query'];

const LABELS: Record<SidebarInternalTool['kind'], string> = {
  'history.refresh': 'Refreshing earlier conversation',
  'memory.read': 'Checking memory',
  'memory.write': 'Saving to memory',
};

type DataSite = 'transcript' | 'memory';

/** The only app-data folders Unify uses, matched directly under a data root rather than at any depth. */
const APP_DATA_SITES: Record<string, DataSite> = {
  memory: 'memory',
  'global-memory': 'memory',
  transcripts: 'transcript',
};

export function isFriendlyRowsEnabled(): boolean {
  return getUnifyFeature('chat.friendlyInternalRows');
}

function compactKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The tool name without an MCP prefix or a trailing "Read <path>" argument. */
function bareToolName(tool: string): string {
  const trimmed = tool.trim();
  const mcp = trimmed.match(/^mcp__.+?__(.+)$/);
  const bare = mcp ? mcp[1] : trimmed;
  return bare.split(/\s+/)[0] || '';
}

function toolAction(tool: string): 'read' | 'write' | undefined {
  const key = compactKey(bareToolName(tool));
  if (WRITE_TOOLS.has(key)) return 'write';
  if (READ_TOOLS.has(key) || SEARCH_TOOLS.has(key)) return 'read';
  return undefined;
}

function normalizePath(value: string, platform: NodeJS.Platform): string {
  let path = value.trim();
  if (path.length >= 2 && ((path[0] === '"' && path.endsWith('"')) || (path[0] === '\'' && path.endsWith('\'')))) {
    path = path.slice(1, -1);
  }
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      path = path.replace(/^file:\/\/\/?/i, '');
    }
  }
  path = path.replace(/\\/g, '/').replace(/^\/\/\?\//, '');
  if (path === '~') {
    path = os.homedir().replace(/\\/g, '/');
  } else if (path.startsWith('~/')) {
    path = `${os.homedir().replace(/\\/g, '/')}${path.slice(1)}`;
  }
  // Git-bash writes a drive as "/c/Users" and a file URL leaves it as "/C:/Users".
  if (platform === 'win32') {
    path = path.replace(/^\/([A-Za-z]):?\//, '$1:/');
  }
  // Collapsing ".." matters: "proj/.unify/../src/x" is a project file, not app data.
  const unc = path.startsWith('//') && !path.startsWith('///');
  const normalized = posix.normalize(path);
  path = unc && !normalized.startsWith('//') ? `/${normalized}` : normalized;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function compareKey(value: string, platform: NodeJS.Platform): string {
  const key = normalizePath(value, platform);
  return platform === 'win32' ? key.toLowerCase() : key;
}

function placesPlatform(places: InternalToolPlaces): NodeJS.Platform {
  return places.platform || process.platform;
}

function isUnder(pathKey: string, rootKey: string): boolean {
  return !!rootKey && (pathKey === rootKey || pathKey.startsWith(`${rootKey}/`));
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || value.startsWith('~');
}

/** Every path the call mentions, in input order, without duplicates. */
function callPaths(input: unknown, platform: NodeJS.Platform): string[] {
  const paths: string[] = [];
  const add = (value: string): void => {
    const path = normalizePath(value, platform);
    if (path && !paths.some(item => compareKey(item, platform) === compareKey(path, platform))) {
      paths.push(path);
    }
  };
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) {
      return paths;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return callPaths(parsed, platform);
    } catch {
      // A plain detail is the path itself ("C:\project\.unify\memory\INDEX.md").
      if (looksLikePath(text)) {
        add(text);
      }
      return paths;
    }
  }
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 4) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const field of PATH_FIELDS) {
      const text = record[field];
      if (typeof text === 'string' && text.trim()) {
        add(text);
      }
    }
    for (const field of LOOSE_PATH_FIELDS) {
      const text = record[field];
      if (typeof text === 'string' && looksLikePath(text)) {
        add(text);
      }
    }
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === 'object') visit(nested, depth + 1);
    }
  };
  visit(input, 0);
  return paths;
}

function siteInRoot(pathKey: string, rootKey: string): DataSite | undefined {
  if (!isUnder(pathKey, rootKey)) {
    return undefined;
  }
  const [first] = pathKey.slice(rootKey.length).split('/').filter(Boolean);
  return first ? APP_DATA_SITES[first] : undefined;
}

/** The app-data folder a path lies in, or undefined for the user's own files. */
function dataSite(path: string, places: InternalToolPlaces): DataSite | undefined {
  const platform = placesPlatform(places);
  const key = compareKey(path, platform);
  if (!key) {
    return undefined;
  }
  const home = compareKey(os.homedir(), platform);
  const vaultKey = places.globalVault ? compareKey(places.globalVault, platform) : '';
  // A vault at the home folder, or one that contains a working copy, would swallow the user's files.
  const vaultCoversProjects = !!vaultKey
    && places.projectRoots.some(root => isUnder(compareKey(root, platform), vaultKey));
  if (vaultKey && vaultKey !== home && !vaultCoversProjects && isUnder(key, vaultKey)) {
    return 'memory';
  }
  const dataHome = compareKey(places.dataHome, platform);
  for (const root of places.projectRoots) {
    for (const folder of PROJECT_DATA_FOLDERS) {
      const site = siteInRoot(key, `${compareKey(root, platform)}/${folder}`);
      if (site) {
        return site;
      }
    }
  }
  if (dataHome) {
    const site = siteInRoot(key, dataHome);
    if (site) {
      return site;
    }
  }
  // A path relative to the working copy still names the app folder.
  const relativePath = normalizePath(path, platform).replace(/^\.\//, '');
  const relative = platform === 'win32' ? relativePath.toLowerCase() : relativePath;
  for (const folder of PROJECT_DATA_FOLDERS) {
    const prefix = `${folder}/`;
    if (!relative.startsWith(prefix)) {
      continue;
    }
    const [first] = relative.slice(prefix.length).split('/');
    const site = APP_DATA_SITES[first];
    if (site) {
      return site;
    }
  }
  return undefined;
}

/** "notes/conventions.md" becomes "conventions"; a folder has no note name. */
function noteName(path: string, platform: NodeJS.Platform): string | undefined {
  const base = normalizePath(path, platform).split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  return base.slice(0, dot) || undefined;
}

/**
 * The friendly row for a generic file call on app data, or undefined when the call is about project files.
 * Batch calls are classified one child at a time, so each child can carry its own label.
 */
export function classifyInternalTool(call: InternalToolCall, places: InternalToolPlaces): SidebarInternalTool | undefined {
  const action = toolAction(call.tool);
  if (!action) {
    return undefined;
  }
  const platform = placesPlatform(places);
  const paths = callPaths(call.input, platform);
  // The call is app-data work only when every path it mentions is app data; one project file makes it ordinary.
  const sites: Array<{ path: string; site: DataSite }> = [];
  for (const path of paths) {
    const site = dataSite(path, places);
    if (!site) {
      return undefined;
    }
    sites.push({ path, site });
  }
  if (!sites.length) {
    return undefined;
  }
  const memory = sites.filter(item => item.site === 'memory');
  if (memory.length) {
    const detail = memory.length === 1 ? noteName(memory[0].path, platform) : undefined;
    const kind = action === 'write' ? 'memory.write' : 'memory.read';
    return { kind, label: LABELS[kind], ...(detail ? { detail } : {}) };
  }
  // Only reading earlier conversation is friendly; writing to transcript parts is not a labelled job.
  if (action === 'read' && sites.every(item => item.site === 'transcript')) {
    return { kind: 'history.refresh', label: LABELS['history.refresh'] };
  }
  return undefined;
}
