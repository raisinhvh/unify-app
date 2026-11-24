/**
 * File references in chat text (`src/main/index.ts:42`, `src/x.ts#L10-L20`, markdown links to paths): parsing,
 * and opening them in the workspace's Files pane.
 *
 * Opening: the Files pane (a singleton) is focused when it is on screen, or added beside the focused pane when not.
 * It shows the chat's project, switching to it first when it shows another one, then opens the file at the line.
 * Pop-out windows have no pane grid, so there (and for files outside any known project) the OS opens the file.
 */
import { popoutChatId, post } from '../bridge';
import type { SidebarProject } from '../protocol';
import { navigate, route } from '../router';
import { isNoFolder, knownProjects } from '../screens/chats/projects';
import { filesProject, workspace } from '../screens/files/adapter';
import { openFileAt, switchFilesProject } from '../screens/files/state';
import { viewState } from '../store';
import { feature } from '../store/features';
import { openPane } from './layout';

export interface FileReference {
  /** As written: relative to the project, or absolute. Forward slashes. */
  path: string;
  line?: number;
  endLine?: number;
  column?: number;
}

/** Extensions that make a bare name (no folder) count as a file: `package.json`, `README.md`. */
const fileExtensions = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'md', 'mdx', 'css', 'scss', 'less', 'html',
  'htm', 'vue', 'svelte', 'lua', 'luau', 'py', 'rs', 'go', 'java', 'kt', 'cs', 'c', 'h', 'cpp', 'hpp', 'rb', 'php',
  'swift', 'sh', 'ps1', 'bat', 'yml', 'yaml', 'toml', 'ini', 'xml', 'svg', 'txt', 'env', 'lock', 'sql', 'graphql',
  'gitignore', 'dockerfile', 'rbxmx', 'rbxlx',
]);

/** Product names that look like files. */
const notFiles = new Set(['node.js', 'next.js', 'nuxt.js', 'vue.js', 'three.js', 'express.js', 'd3.js', 'chart.js', 'react.js', 'deno.js', 'socket.io']);

// path, then :line, :line:col, :line-end, or #Lline, #Lline-Lend
const referencePattern =
  /^((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?[\w@.$+\-\\/ ]*?[\w@$+\-]\.[A-Za-z][\w]{0,9})(?::(\d+)(?:-(\d+)|:(\d+))?|#L(\d+)(?:-L?(\d+))?)?$/;

/** Parses inline code or a link target as a file reference; undefined for anything else (identifiers, URLs...). */
export function parseFileReference(text: string): FileReference | undefined {
  const value = text.trim();
  if (!value || value.length > 300 || /:\/\//.test(value) || /^(mailto|tel|data|javascript):/i.test(value)) return undefined;
  const match = referencePattern.exec(value);
  if (!match) return undefined;
  const path = match[1].replace(/\\/g, '/');
  // Spaces only inside a path with folders (bare "a b.ts" is too likely to be prose).
  if (path.includes(' ') && !path.includes('/')) return undefined;
  const hasFolder = path.includes('/');
  const hasLine = !!(match[2] || match[5]);
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  // `this.packs`, `console.log`: a bare dotted name only counts with a known extension or a line number.
  if (!hasFolder && !hasLine && !fileExtensions.has(extension)) return undefined;
  if (!hasFolder && hasLine && !fileExtensions.has(extension)) return undefined;
  if (!hasFolder && !hasLine && notFiles.has(path.toLowerCase())) return undefined;
  const line = Number(match[2] || match[5]) || undefined;
  const endLine = Number(match[3] || match[6]) || undefined;
  const column = Number(match[4]) || undefined;
  return { path, line, endLine, column };
}

const normal = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const isAbsolute = (path: string) => /^([A-Za-z]:)?\//.test(path);

function within(root: string, path: string): boolean {
  return !!root && normal(path).startsWith(`${normal(root)}/`);
}

/** The project a chat runs in, when it has a real folder. */
export function chatProject(chatId: string | undefined): SidebarProject | undefined {
  if (!chatId) return undefined;
  const project = viewState.sessions.find(session => session.id === chatId)?.project;
  return project && !isNoFolder(project) ? project : undefined;
}

/** Opens a reference in the Files pane (see the file comment). */
export function openFileReference(reference: FileReference, project?: SidebarProject): void {
  let target = project;
  let path = reference.path.replace(/^\.\//, '');
  const current = filesProject() ?? (workspace().root ? { name: workspace().name, path: workspace().root } : undefined);

  if (isAbsolute(path)) {
    // An absolute path picks its project: the chat's, the one on screen, or any known one that contains it.
    const owner = [target, current, ...knownProjects()].find(item => item && within(item.path, path));
    if (!owner) {
      openWithSystem(reference);
      return;
    }
    target = owner;
    path = path.slice(owner.path.replace(/[\\/]+$/, '').length + 1);
  }

  if (popoutChatId() || !feature('editor.enabled')) {
    openWithSystem({ ...reference, path: target ? joinPath(target.path, path) : path });
    return;
  }

  if (target && (!current || normal(current.path) !== normal(target.path))) {
    if (!switchFilesProject(target)) return;
  }
  if (route() !== 'chats') navigate('chats');
  openPane('files');
  openFileAt(path, reference.line, reference.endLine);
}

/** Shows a project folder in the Files pane (focused, or added beside), switching it to that project first. */
export function openProjectInFiles(project: SidebarProject): void {
  if (popoutChatId() || !feature('editor.enabled') || isNoFolder(project)) return;
  if (!switchFilesProject(project)) return;
  if (route() !== 'chats') navigate('chats');
  openPane('files');
}

function joinPath(root: string, path: string): string {
  return isAbsolute(path) ? path : `${root.replace(/[\\/]+$/, '')}/${path}`;
}

function openWithSystem(reference: FileReference): void {
  post({ type: 'openFile', path: reference.path, line: reference.line, column: reference.column });
}
