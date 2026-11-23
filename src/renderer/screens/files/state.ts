/**
 * Files screen state shared by the panel (tree) and the editor (tabs): open folders, open tabs, the active
 * file, loaded folder listings and loaded documents. UI choices persist through persist.ts.
 */
import { createSignal } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import { readPersisted, writePersisted } from '../../persist';
import { engineEdits, listDir, onFileChanged, parentPath, readFile, type FileDocument, type FileEdit, type FileEntry } from './adapter';

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

function persistTabs(): void {
  writePersisted('files.tabs', tabs());
  writePersisted('files.active', activePath());
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
  setDocuments(produce(store => delete store[path]));
  persistTabs();
}

export function activateTab(path: string): void {
  setActivePathSignal(path);
  persistTabs();
}

export async function loadDocument(path: string, force = false): Promise<void> {
  if (!force && documents[path]) return;
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
