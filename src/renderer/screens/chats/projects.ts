/**
 * Chat grouping and captions for the Chats tree and the Home project picker.
 *
 *   projectGroups()   sessions grouped by project folder, most recently used project first
 *   chatTime(id)      "0:42" while running (elapsed), otherwise "4m", "1h", "Mon", "12 Mar"
 *   selectedProject() the project new chats from Home start in (renderer-local, persisted)
 */
import { createRoot, createMemo, createSignal } from 'solid-js';
import { readPersisted, writePersisted } from '../../persist';
import type { SidebarProject, SidebarSession } from '../../protocol';
import { isRunning, viewState } from '../../store';
import { runStartedAt } from '../../store/runClock';

export interface ProjectGroup {
  key: string;
  project: SidebarProject | undefined;
  sessions: SidebarSession[];
  updatedAt: number;
}

const looseKey = '__chats__';

export const projectGroups = createRoot(() => createMemo<ProjectGroup[]>(() => {
  const groups = new Map<string, ProjectGroup>();
  for (const session of viewState.sessions) {
    const key = session.project?.path || looseKey;
    let group = groups.get(key);
    if (!group) {
      group = { key, project: session.project, sessions: [], updatedAt: 0 };
      groups.set(key, group);
    }
    group.sessions.push(session);
    group.updatedAt = Math.max(group.updatedAt, session.updatedAt || 0);
  }
  for (const group of groups.values()) {
    group.sessions.sort((first, second) => (second.updatedAt || 0) - (first.updatedAt || 0));
  }
  return [...groups.values()].sort((first, second) => second.updatedAt - first.updatedAt);
}));

/** The last two path segments, as Figma shows them ("Programs/Unify"). */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join('/');
}

/** Parent folder name ("Programs" for …/Programs/Unify). */
export function parentFolder(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

export function projectName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Ticks every second so running rows count up. */
const [now, setNow] = createSignal(Date.now());
window.setInterval(() => setNow(Date.now()), 1000);

export function relativeAge(at: number | undefined, current = now()): string {
  if (!at) return '';
  const minutes = Math.max(0, Math.floor((current - at) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const date = new Date(at);
  if (hours < 24 * 6) return weekdays[date.getDay()];
  if (hours < 24 * 13) return '1w';
  return `${date.getDate()} ${months[date.getMonth()]}`;
}

export function elapsed(since: number, current = now()): string {
  const seconds = Math.max(0, Math.floor((current - since) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function chatTime(session: SidebarSession): string {
  if (isRunning(session.id)) {
    const started = runStartedAt(session.id);
    if (started) return elapsed(started);
  }
  return relativeAge(session.updatedAt);
}

/* Home's project. */

const [selectedProject, setSelectedProjectSignal] = createSignal<SidebarProject | undefined>(
  readPersisted<SidebarProject | undefined>('project', undefined),
);

/** Folders opened through "Open folder…" that have no chats yet. */
const [extraProjects, setExtraProjects] = createSignal<SidebarProject[]>(readPersisted<SidebarProject[]>('extraProjects', []));

export { selectedProject };

/** Home's "No folder" choice: chats start in their own empty scratch folder instead of a project. */
export const noFolderProject: SidebarProject = { name: 'No folder', path: '' };

export function isNoFolder(project: SidebarProject | undefined): boolean {
  return !!project && !project.path;
}

/** The newSession fields that start a chat in `project` (or with no folder). */
export function newSessionTarget(project: SidebarProject | undefined): { project?: SidebarProject; noFolder?: boolean } {
  if (isNoFolder(project)) return { noFolder: true };
  return project ? { project } : {};
}

export function selectProject(project: SidebarProject): void {
  setSelectedProjectSignal(project);
  writePersisted('project', project);
  rememberProject(project);
}

/** Adds a folder opened through "Open folder…" to the recent projects, if it is not there yet. */
export function rememberProject(project: SidebarProject): void {
  if (isNoFolder(project)) return;
  const known = knownProjects().some(item => item.path === project.path);
  if (!known) {
    const next = [project, ...extraProjects()].slice(0, 20);
    setExtraProjects(next);
    writePersisted('extraProjects', next);
  }
}

export interface KnownProject extends SidebarProject {
  usedAt: number;
}

/** Every project the user has worked in, most recent first. */
export function knownProjects(): KnownProject[] {
  const byPath = new Map<string, KnownProject>();
  for (const group of projectGroups()) {
    if (group.project) byPath.set(group.project.path, { ...group.project, usedAt: group.updatedAt });
  }
  for (const project of extraProjects()) {
    if (!byPath.has(project.path)) byPath.set(project.path, { ...project, usedAt: 0 });
  }
  return [...byPath.values()].sort((first, second) => second.usedAt - first.usedAt);
}
