/**
 * Paths and small JSON stores shared by the Unify request handlers.
 *
 * Everything here is plain Node: no `vscode` import, so tests can point `dshHome`/`unifyRoot` at a temporary
 * folder and the same code runs inside the Electron shim. The defaults match the shim's paths:
 * state root `~/.dsh/unify`, global storage `~/.dsh/unify/storage`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UnifyRequestContext } from './types';

export interface RequestPaths {
  workspaceRoot: string | undefined;
  /** DSH's shared home: rules, skills, memory, accounts. */
  dshHome: string;
  /** Unify's own state: settings, setup, providers, knowledge metadata. */
  unifyRoot: string;
  /** Extension globalStorage inside Unify. */
  storageRoot: string;
  /** Installed toolpacks (`storage/toolpacks`). */
  toolpacksDir: string;
  /** DSH's shared agent skills (`~/.agents`). */
  agentsHome: string;
  settingsFile: string;
  stateFile: string;
  providersFile: string;
  toolpacksFile: string;
  knowledgeFile: string;
  setupFile: string;
}

export function requestPaths(context: UnifyRequestContext): RequestPaths {
  const dshHome = path.resolve(context.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const unifyRoot = path.resolve(context.unifyRoot || process.env.UNIFY_HOME || path.join(dshHome, 'unify'));
  const storageRoot = path.join(unifyRoot, 'storage');
  return {
    workspaceRoot: context.workspaceRoot ? path.resolve(context.workspaceRoot) : undefined,
    dshHome,
    unifyRoot,
    storageRoot,
    toolpacksDir: path.join(storageRoot, 'toolpacks'),
    agentsHome: path.resolve(process.env.AGENTS_HOME || path.join(os.homedir(), '.agents')),
    settingsFile: path.join(unifyRoot, 'settings.json'),
    stateFile: path.join(unifyRoot, 'state.json'),
    providersFile: path.join(unifyRoot, 'providers.json'),
    toolpacksFile: path.join(unifyRoot, 'toolpacks.json'),
    knowledgeFile: path.join(unifyRoot, 'knowledge.json'),
    setupFile: path.join(unifyRoot, 'setup.json'),
  };
}

/** Reads a JSON file, returning `fallback` for a missing or malformed file. */
export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Writes JSON atomically so a crash cannot leave a truncated file. */
export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolves a workspace-relative path, rejecting anything that escapes the workspace (absolute paths,
 * `..` segments, drive letters or a NUL byte).
 */
export function resolveInside(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) throw new Error('Invalid file path.');
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error('Invalid file path.');
  if (normalized.split('/').some(part => part === '..')) throw new Error('Invalid file path.');
  const resolved = path.resolve(root, ...normalized.split('/').filter(Boolean));
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('Invalid file path.');
  return resolved;
}

/** Workspace-relative path with forward slashes. */
export function relativeToWorkspace(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/** "Don't edit project.json" -> "dont-edit-project-json". */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'untitled';
}

/** Title-cased fallback name for ids like "roblox-studio". */
export function titleFromId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

export function posix(base: string, file: string): string {
  return path.relative(base, file).split(path.sep).join('/');
}
