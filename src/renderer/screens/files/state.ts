/**
 * Files screen state shared by the panel (tree) and the editor (tabs): open folders, open tabs, the active
 * file, loaded folder listings and loaded documents. UI choices persist through persist.ts.
 */
import { createSignal } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import { readPersisted, writePersisted } from '../../persist';
import { navigate } from '../../router';
import type { SidebarProject } from '../../protocol';
import {
  baseName,
  copyEntry,
  createEntry,
  deleteEntry,
  importEntries,
  renameEntry,
  engineEdits,
  filesProject,
  listDir,
  onEditorRequest,
  onFileChanged,
  parentPath,
  readFile,
  relativePath,
  setFilesProject,
  workspace,
  type FileDocument,
  type FileEdit,
  type FileEntry,
} from './adapter';

// ---------------------------------------------------------------------------------------------------------------
// Folders

const [openDirs, setOpenDirsSignal] = createSignal<string[]>(readPersisted('files.openDirs', ['src', 'src/mcp', 'src/toolpacks']));
export { openDirs };

export function setDirOpen(path: string, open: boolean): void {
  const next = openDirs().filter(item => item !== path);
  if (open) {
    next.push(path);
    void loadDir(path);
  }
  setOpenDirsSignal(next);
  writePersisted('files.openDirs', next);
}

export function collapseAllDirs(): void {
  setOpenDirsSignal([]);
  writePersisted('files.openDirs', []);
}

const [listings, setListings] = createStore<Record<string, FileEntry[]>>({});
export { listings };

const loading = new Set<string>();

export async function loadDir(path: string, force = false): Promise<void> {
  if (loading.has(path) || (!force && listings[path])) return;
  loading.add(path);
  try {
    const entries = await listDir(path);
    // reconcile keeps row identity, so a refreshed listing animates only what changed.
    setListings(path, reconcile(entries, { key: 'path' }));
  } finally {
    loading.delete(path);
  }
}

export async function refreshTree(): Promise<void> {
  await Promise.all(['', ...openDirs()].map(path => loadDir(path, true)));
}

/** Agent edit for a path: the engine's diff list wins over what the listing said. */
export function editFor(path: string, fromListing?: FileEdit): FileEdit | undefined {
  const fromEngine = engineEdits().get(path);
  const edit = fromEngine ?? fromListing;
  return edit && (edit.additions || edit.deletions) ? edit : undefined;
}

export function listingEdit(path: string): FileEdit | undefined {
  const entries = listings[parentPath(path)];
  return entries?.find(entry => entry.path === path)?.edited;
}

// ---------------------------------------------------------------------------------------------------------------
// Tabs and documents

const [tabs, setTabsSignal] = createSignal<string[]>(
  readPersisted('files.tabs', ['src/toolpacks/registry.ts', 'src/toolpacks/types.ts', 'src/mcp/delegateServer.ts']),
);
const [activePath, setActivePathSignal] = createSignal<string | undefined>(readPersisted('files.active', 'src/toolpacks/registry.ts'));
export { tabs, activePath };

export interface OpenDocument extends FileDocument {
  /** Unsaved text, when it differs from `content`. */
  draft?: string;
  saving?: boolean;
  error?: string;
}

const [documents, setDocuments] = createStore<Record<string, OpenDocument>>({});
export { documents, setDocuments };

/** A review diff the engine asked to show (`editorDiff`). Lives in a tab keyed `diff:<path>`; never persisted. */
export interface DiffTab {
  title: string;
  /** Workspace-relative path the diff is about. */
  path: string;
  /** Base text (before the agent's edit). */
  leftText: string;
  /** Edited text. */
  rightText: string;
  leftLabel?: string;
  rightLabel?: string;
}

const diffPrefix = 'diff:';

/** Tab key of a path's diff tab. */
export function diffKey(path: string): string {
  return diffPrefix + path;
}

/** True when a tab key names a diff tab rather than a file. */
export function isDiffKey(key: string | undefined): key is string {
  return key !== undefined && key.startsWith(diffPrefix);
}

const [diffTabs, setDiffTabs] = createStore<Record<string, DiffTab>>({});
export { diffTabs };

function persistTabs(): void {
  const fileTabs = tabs().filter(key => !isDiffKey(key));
  const active = activePath();
  writePersisted('files.tabs', fileTabs);
  // A diff tab is gone after a restart, so the last file tab stands in for it.
  writePersisted('files.active', isDiffKey(active) ? fileTabs[fileTabs.length - 1] : active);
}

/** Opens (or refreshes, when the path already has one) a diff tab. `activate` false only adds it. */
export function openDiff(diff: DiffTab, activate = true): void {
  const key = diffKey(diff.path);
  setDiffTabs(key, reconcile({ ...diff }));
  if (!tabs().includes(key)) setTabsSignal([...tabs(), key]);
  if (activate) setActivePathSignal(key);
  persistTabs();
}

/** A line range FilesEditor's Monaco scrolls to and selects once the file is shown, then clears. */
export interface RevealRequest {
  path: string;
  startLine: number;
  endLine: number;
}

const [reveal, setReveal] = createSignal<RevealRequest | undefined>();
export { reveal, setReveal };

/** Opens a file and asks the editor to reveal a line range in it (1-based, inclusive). */
export function openFileAt(path: string, startLine?: number, endLine?: number): void {
  openFile(path);
  setReveal(startLine ? { path, startLine, endLine: Math.max(startLine, endLine ?? startLine) } : undefined);
}

// ---------------------------------------------------------------------------------------------------------------
// Organic hand-off: files the agent just created (their tab types its name in) and deleted files whose tab is
// playing its select-all sweep before it closes.

/** How long after a 'created' change a newly mounted tab still counts as new (ms). */
const createdWindow = 4000;

/** Longest a deleted file's tab waits for its sweep before it closes anyway (editor not mounted, offscreen). */
const deleteFallback = 1500;

const createdAt = new Map<string, number>();

export function createdRecently(path: string): boolean {
  const at = createdAt.get(path);
  return at !== undefined && performance.now() - at < createdWindow;
}

const [deletingTabs, setDeletingTabs] = createSignal<string[]>([]);
export { deletingTabs };

function markTabDeleting(path: string): void {
  if (!deletingTabs().includes(path)) setDeletingTabs([...deletingTabs(), path]);
  window.setTimeout(() => {
    if (deletingTabs().includes(path)) closeTab(path);
  }, deleteFallback);
}

function unmarkTabDeleting(path: string): void {
  if (deletingTabs().includes(path)) setDeletingTabs(deletingTabs().filter(item => item !== path));
}

export function openFile(path: string): void {
  if (!tabs().includes(path)) setTabsSignal([...tabs(), path]);
  setActivePathSignal(path);
  persistTabs();
  void loadDocument(path);
}

/** Removes a tab after its exit animation. Picks the right-hand neighbour (or left) as the new active tab. */
export function closeTab(path: string): void {
  const list = tabs();
  const index = list.indexOf(path);
  if (index < 0) return;
  const next = list.filter(item => item !== path);
  unmarkTabDeleting(path);
  setTabsSignal(next);
  if (activePath() === path) setActivePathSignal(next[Math.min(index, next.length - 1)]);
  if (isDiffKey(path)) setDiffTabs(produce(store => delete store[path]));
  else setDocuments(produce(store => delete store[path]));
  persistTabs();
}

export function activateTab(path: string): void {
  setActivePathSignal(path);
  persistTabs();
}

export async function loadDocument(path: string, force = false): Promise<void> {
  if (isDiffKey(path) || (!force && documents[path])) return;
  try {
    const file = await readFile(path);
    setDocuments(path, reconcile({ ...file }));
  } catch (error) {
    setDocuments(path, { path, content: '', version: '', error: error instanceof Error ? error.message : String(error) });
  }
}

export function setDraft(path: string, text: string): void {
  const document = documents[path];
  if (!document) return;
  setDocuments(path, 'draft', text === document.content ? undefined : text);
}

// ---------------------------------------------------------------------------------------------------------------
// Create, rename, delete (the tree's context menu and hover delete)

/** True for `path` itself and anything inside it. */
function within(key: string, path: string): boolean {
  return key === path || key.startsWith(path + '/');
}

function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

/** Checks a typed name: one path segment per level, no `..`, nothing empty. Returns an error message or ''. */
export function invalidEntryName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'Type a name.';
  const parts = trimmed.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return 'That name is not a valid path.';
  if (parts.some(part => /[<>:"|?*]/.test(part))) return 'Names cannot contain < > : " | ? *';
  return '';
}

/** Creates `name` (may hold subfolders, "src/new.ts") in `folder`; opens a new file in a tab. */
export async function createFileEntry(folder: string, name: string, kind: 'file' | 'dir'): Promise<string> {
  const path = await createEntry(joinPath(folder, name.trim().replace(/\\/g, '/')), kind);
  createdAt.set(path, performance.now());
  // Open every folder on the way so the new row is visible.
  const parents: string[] = [];
  for (let parent = parentPath(path); parent; parent = parentPath(parent)) parents.unshift(parent);
  for (const parent of parents) if (!openDirs().includes(parent)) setDirOpen(parent, true);
  await Promise.all(['', ...parents].map(parent => loadDir(parent, true)));
  if (kind === 'file') openFile(path);
  else setDirOpen(path, true);
  return path;
}

/** Renames an entry in place (same folder). Open tabs, folders and listings under it follow the new path. */
export async function renameFileEntry(path: string, name: string): Promise<string> {
  return moveFileEntry(path, joinPath(parentPath(path), name.trim()));
}

/** Moves an entry into another folder ('' = root), keeping its name. */
export async function moveIntoFolder(path: string, folder: string): Promise<string> {
  if (parentPath(path) === folder) return path;
  if (within(folder, path)) throw new Error('A folder cannot move inside itself.');
  const moved = await moveFileEntry(path, joinPath(folder, baseName(path)));
  await revealInTree(moved);
  return moved;
}

/** Copies an entry into a folder ('' = root); a taken name becomes "name copy". */
export async function copyIntoFolder(path: string, folder: string): Promise<string> {
  const copied = await copyEntry(path, folder);
  createdAt.set(copied, performance.now());
  await revealInTree(copied);
  return copied;
}

/** Copies files dropped from the OS into a folder. */
export async function importIntoFolder(sources: string[], folder: string): Promise<string[]> {
  const copied = await importEntries(sources, folder);
  for (const path of copied) createdAt.set(path, performance.now());
  await revealInTree(copied[0] ?? joinPath(folder, 'x'));
  return copied;
}

/** Opens the folders above `path` and refreshes their listings so its row shows. */
async function revealInTree(path: string): Promise<void> {
  const parents: string[] = [];
  for (let parent = parentPath(path); parent; parent = parentPath(parent)) parents.unshift(parent);
  for (const parent of parents) if (!openDirs().includes(parent)) setDirOpen(parent, true);
  await Promise.all(['', ...parents].map(parent => loadDir(parent, true)));
}

/** Cut / copy clipboard of the tree (paths in this project). */
const [clipboard, setClipboard] = createSignal<{ mode: 'cut' | 'copy'; paths: string[] } | undefined>();
export { clipboard, setClipboard };

export function isCut(path: string): boolean {
  const current = clipboard();
  return current?.mode === 'cut' && current.paths.includes(path);
}

/** Pastes the clipboard into a folder: copies, or moves after a cut (the clipboard then empties). */
export async function pasteInto(folder: string): Promise<void> {
  const current = clipboard();
  if (!current) return;
  if (current.mode === 'cut') setClipboard(undefined);
  for (const path of current.paths) {
    if (current.mode === 'copy') await copyIntoFolder(path, folder);
    else await moveIntoFolder(path, folder);
  }
}

/** Moves or renames an entry to `target` (project-relative). Open tabs, folders and listings follow it. */
export async function moveFileEntry(path: string, target: string): Promise<string> {
  if (target === path) return path;
  const unsaved = tabs().filter(key => within(key, path) && documents[key]?.draft !== undefined);
  if (unsaved.length) throw new Error(`Save or discard your changes in ${unsaved.join(', ')} first.`);
  const renamed = await renameEntry(path, target);
  const move = (key: string) => (within(key, path) ? renamed + key.slice(path.length) : key);
  const nextTabs = tabs().map(move);
  setDocuments(produce(store => {
    for (const key of Object.keys(store)) {
      if (!within(key, path)) continue;
      store[move(key)] = { ...store[key], path: move(key) };
      delete store[key];
    }
  }));
  setTabsSignal(nextTabs);
  if (activePath() && within(activePath()!, path)) setActivePathSignal(move(activePath()!));
  persistTabs();
  const dirs = openDirs().map(move);
  setOpenDirsSignal(dirs);
  writePersisted('files.openDirs', dirs);
  setListings(produce(store => { for (const key of Object.keys(store)) if (within(key, path)) delete store[key]; }));
  await Promise.all([...new Set([parentPath(path), parentPath(renamed)])].map(folder => loadDir(folder, true)));
  for (const dir of dirs) if (within(dir, renamed)) void loadDir(dir, true);
  return renamed;
}

/** Deletes an entry (OS trash when available). Its tabs close; unsaved text in them asks first. */
export async function deleteFileEntry(path: string): Promise<boolean> {
  const unsaved = tabs().filter(key => within(key, path) && documents[key]?.draft !== undefined);
  if (unsaved.length && !window.confirm(`Discard unsaved changes in ${unsaved.join(', ')}?`)) return false;
  await deleteEntry(path);
  for (const key of tabs().filter(key => within(key, path) || within(key, diffKey(path)))) closeTab(key);
  const dirs = openDirs().filter(dir => !within(dir, path));
  setOpenDirsSignal(dirs);
  writePersisted('files.openDirs', dirs);
  setListings(produce(store => { for (const key of Object.keys(store)) if (within(key, path)) delete store[key]; }));
  await loadDir(parentPath(path), true);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Project

/**
 * Shows another project folder. Paths are project-relative, so the previous project's folders, tabs and documents
 * are dropped (tabs with unsaved text keep the switch from happening; returns false then).
 */
export function switchFilesProject(project: SidebarProject): boolean {
  const current = filesProject()?.path ?? workspace().root;
  const normal = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (current && normal(current) === normal(project.path)) return true;
  const unsaved = tabs().filter(key => documents[key]?.draft !== undefined);
  if (unsaved.length && !window.confirm(`Discard unsaved changes in ${unsaved.join(', ')}?`)) return false;
  setFilesProject(project);
  setTabsSignal([]);
  setActivePathSignal(undefined);
  persistTabs();
  setDocuments(produce(store => { for (const key of Object.keys(store)) delete store[key]; }));
  setDiffTabs(produce(store => { for (const key of Object.keys(store)) delete store[key]; }));
  setListings(produce(store => { for (const key of Object.keys(store)) delete store[key]; }));
  collapseAllDirs();
  void loadDir('', true);
  return true;
}

/** Diffs of one group arrive back-to-back; one arriving this soon after its group's last keeps the first active. */
const groupWindow = 1500;

let lastGroup: { id: string; at: number } | undefined;

// The engine opens a file (optionally at a range) or a review diff: show it in the Files screen.
onEditorRequest(request => {
  navigate('files');
  if (request.type === 'editorOpen') {
    openFileAt(relativePath(request.path), request.startLine, request.endLine);
    return;
  }
  const now = performance.now();
  const sameGroup = request.group !== undefined && lastGroup?.id === request.group && now - lastGroup.at < groupWindow;
  lastGroup = request.group !== undefined ? { id: request.group, at: now } : undefined;
  const path = relativePath(request.path || request.rightPath || request.leftPath);
  openDiff(
    {
      title: request.title,
      path,
      leftText: request.leftText,
      rightText: request.rightText,
      leftLabel: request.leftLabel,
      rightLabel: request.rightLabel,
    },
    !sameGroup,
  );
});

// An agent (or another editor) changed a file: refresh its folder and, when open and clean, its content.
onFileChanged(change => {
  void loadDir(parentPath(change.path), true);
  const document = documents[change.path];
  if (change.kind === 'deleted') {
    // The tab sweeps its name out (FilesEditor's Tab), then closes; the tree row sweeps through OrganicList.
    if (document && document.draft === undefined) markTabDeleting(change.path);
    return;
  }
  if (change.kind === 'created') {
    createdAt.set(change.path, performance.now());
    unmarkTabDeleting(change.path);
  }
  if (document && document.draft === undefined) void loadDocument(change.path, true);
});
