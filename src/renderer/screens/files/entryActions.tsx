/**
 * Files tree actions: new file / new folder, rename and delete.
 *
 *   hover delete   a trash button in a row's trailing cell; the first click arms it ("Delete?"), a second deletes
 *   right-click    New file… / New folder… (in that folder, or beside a file), Rename…, Delete
 *   name input     new entries type their name in a row at the top of the folder; rename edits the row's label
 *
 * Deletes go to the OS trash / Recycle Bin when the bridge can (Electron); otherwise they are permanent and ask
 * first. One context menu serves the whole tree; the row that opened it is its anchor.
 */
import { createSignal, onCleanup, Show, type JSX } from 'solid-js';
import { Icon, Menu, type MenuEntry } from '../../components';
import { absoluteEntryPath, canReveal, deletesToTrash, droppedPaths, parentPath, revealEntry, type FileEntry } from './adapter';
import {
  clipboard, copyIntoFolder, createFileEntry, deleteFileEntry, importIntoFolder, invalidEntryName, moveIntoFolder, openDirs,
  pasteInto, renameFileEntry, setClipboard, setDirOpen,
} from './state';

// ---------------------------------------------------------------------------------------------------------------
// Shared state

export type Editing =
  | { mode: 'new'; folder: string; kind: 'file' | 'dir' }
  | { mode: 'rename'; path: string; kind: 'file' | 'dir'; name: string };

const [editing, setEditing] = createSignal<Editing | undefined>();
export { editing };

const [actionError, setActionError] = createSignal('');
export { actionError };
let errorTimer = 0;

function showError(error: unknown): void {
  window.clearTimeout(errorTimer);
  setActionError(error instanceof Error ? error.message : String(error));
  errorTimer = window.setTimeout(() => setActionError(''), 6000);
}

export function startNewEntry(folder: string, kind: 'file' | 'dir'): void {
  setActionError('');
  if (folder && !openDirs().includes(folder)) setDirOpen(folder, true);
  setEditing({ mode: 'new', folder, kind });
}

export function startRename(entry: FileEntry): void {
  setActionError('');
  setEditing({ mode: 'rename', path: entry.path, kind: entry.kind, name: entry.name });
}

/** Deletes after the hover button's second click or the menu's "Delete" (permanent deletes confirm first). */
export async function deleteWithConfirm(entry: FileEntry): Promise<void> {
  if (!deletesToTrash() && !window.confirm(`Delete ${entry.path} for good? This cannot be undone.`)) return;
  try {
    await deleteFileEntry(entry.path);
  } catch (error) {
    showError(error);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Name input

/** The text box for a new name. Enter saves, Escape cancels, leaving it saves a rename and drops an empty new. */
export function NameInput(props: { value?: string; placeholder: string; onCommit: (name: string) => Promise<void> }): JSX.Element {
  const [error, setError] = createSignal('');
  let busy = false;
  let done = false;

  const commit = async (input: HTMLInputElement, fromBlur: boolean) => {
    if (busy || done) return;
    const name = input.value.trim();
    if (!name || (fromBlur && name === (props.value ?? ''))) {
      done = true;
      setEditing(undefined);
      return;
    }
    const problem = invalidEntryName(name);
    if (problem) {
      if (fromBlur) { done = true; setEditing(undefined); showError(problem); return; }
      setError(problem);
      return;
    }
    busy = true;
    try {
      await props.onCommit(name);
      done = true;
      setEditing(undefined);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (fromBlur) { done = true; setEditing(undefined); showError(failure); }
      else {
        setError(message);
        input.focus();
      }
    } finally {
      busy = false;
    }
  };

  return (
    <span class="files-name-edit">
      <input
        class="files-name-input"
        classList={{ invalid: !!error() }}
        value={props.value ?? ''}
        placeholder={props.placeholder}
        spellcheck={false}
        aria-label={props.placeholder}
        ref={element => queueMicrotask(() => {
          element.focus();
          // Select the name without its extension, like a file manager.
          const dot = element.value.lastIndexOf('.');
          element.setSelectionRange(0, dot > 0 ? dot : element.value.length);
        })}
        // The input sits inside the row's button: keep clicks and keys from toggling or opening it.
        onClick={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Enter') { event.preventDefault(); void commit(event.currentTarget, false); }
          if (event.key === 'Escape') { event.preventDefault(); done = true; setEditing(undefined); }
        }}
        onKeyUp={event => event.preventDefault()}
        onInput={() => setError('')}
        onBlur={event => void commit(event.currentTarget, true)}
      />
      <Show when={error()}>
        <span class="files-name-error type-caption">{error()}</span>
      </Show>
    </span>
  );
}

/** The row a new file or folder's name is typed into, at the top of its folder. */
export function NewEntryRow(props: { folder: string; kind: 'file' | 'dir' }): JSX.Element {
  return (
    <div class="tree-row files-new-row" classList={{ 'files-new-file': props.kind === 'file' }}>
      <Icon name={props.kind === 'dir' ? 'folder' : 'file'} size={14} />
      <NameInput
        placeholder={props.kind === 'dir' ? 'Folder name' : 'File name'}
        onCommit={async name => { await createFileEntry(props.folder, name, props.kind); }}
      />
    </div>
  );
}

/** A row's label while it is being renamed. */
export function RenameInput(props: { entry: FileEntry }): JSX.Element {
  return (
    <NameInput
      value={props.entry.name}
      placeholder="New name"
      onCommit={async name => { await renameFileEntry(props.entry.path, name); }}
    />
  );
}

export function isRenaming(path: string): boolean {
  const current = editing();
  return current?.mode === 'rename' && current.path === path;
}

// ---------------------------------------------------------------------------------------------------------------
// Hover delete

const deleteArmMs = 3000;

/**
 * A row's trash button, armed state and disarm-on-leave. Put `button` in the row's trailing cell, `armed()` on the
 * row's class (`delete-armed`) and `disarm` on the row's pointerleave.
 */
export function createDeleteButton(entry: () => FileEntry): { button: JSX.Element; armed: () => boolean; disarm: () => void } {
  const [armed, setArmed] = createSignal(false);
  let timer = 0;
  onCleanup(() => window.clearTimeout(timer));
  const disarm = () => {
    window.clearTimeout(timer);
    setArmed(false);
  };
  const onClick = (event: MouseEvent) => {
    event.stopPropagation();
    window.clearTimeout(timer);
    if (armed()) {
      setArmed(false);
      void deleteWithConfirm(entry());
      return;
    }
    setArmed(true);
    timer = window.setTimeout(() => setArmed(false), deleteArmMs);
  };
  const button = (
    <span
      class="files-row-delete"
      role="button"
      tabIndex={-1}
      aria-label={armed() ? 'Confirm delete' : `Delete ${entry().kind === 'dir' ? 'folder' : 'file'}`}
      title={armed() ? undefined : deletesToTrash() ? 'Move to trash' : 'Delete'}
      onClick={onClick}
      onPointerDown={event => event.stopPropagation()}
    >
      <Show when={armed()} fallback={<Icon name="trash" size={12} />}>
        Delete?
      </Show>
    </span>
  );
  return { button, armed, disarm };
}

// ---------------------------------------------------------------------------------------------------------------
// Context menu (one for the whole tree)

interface MenuTarget {
  anchor: HTMLElement;
  /** Undefined: the empty part of the tree (the project root). */
  entry?: FileEntry;
}

const [menuTarget, setMenuTarget] = createSignal<MenuTarget | undefined>();

/** Opens the tree's context menu on a row (or on the tree's background when `entry` is undefined). */
export function openEntryMenu(event: MouseEvent, anchor: HTMLElement | undefined, entry?: FileEntry): void {
  event.preventDefault();
  event.stopPropagation();
  if (anchor) setMenuTarget({ anchor, entry });
}

/** The folder an action on `entry` lands in: a folder itself, a file's parent, '' (root) for the background. */
export function folderFor(entry: FileEntry | undefined): string {
  return !entry ? '' : entry.kind === 'dir' ? entry.path : parentPath(entry.path);
}

/** Runs a tree action, showing a failure in the panel's error line. */
export async function runAction(action: () => Promise<unknown> | unknown): Promise<void> {
  setActionError('');
  try {
    await action();
  } catch (error) {
    showError(error);
  }
}

export function cutEntry(entry: FileEntry): void {
  setClipboard({ mode: 'cut', paths: [entry.path] });
}

export function copyEntryToClipboard(entry: FileEntry): void {
  setClipboard({ mode: 'copy', paths: [entry.path] });
}

export function pasteIntoEntry(entry: FileEntry | undefined): Promise<void> {
  return runAction(() => pasteInto(folderFor(entry)));
}

function writeText(text: string): Promise<void> {
  return runAction(() => navigator.clipboard.writeText(text));
}

export function EntryMenu(): JSX.Element {
  const items = (): MenuEntry[] => {
    const entry = menuTarget()?.entry;
    const create: MenuEntry[] = [
      { id: 'newFile', label: 'New file…', icon: 'file' },
      { id: 'newDir', label: 'New folder…', icon: 'folder' },
    ];
    const paste: MenuEntry = { id: 'paste', label: 'Paste', hint: 'Ctrl+V', disabled: !clipboard() };
    if (!entry) return [...create, { kind: 'separator' }, paste];
    return [
      ...create,
      { kind: 'separator' },
      { id: 'cut', label: 'Cut', hint: 'Ctrl+X' },
      { id: 'copy', label: 'Copy', hint: 'Ctrl+C' },
      paste,
      { id: 'duplicate', label: 'Duplicate' },
      { kind: 'separator' },
      { id: 'copyPath', label: 'Copy path' },
      { id: 'copyRelative', label: 'Copy relative path' },
      ...(canReveal() ? [{ id: 'reveal', label: 'Reveal in File Explorer', icon: 'folder' } as MenuEntry] : []),
      { kind: 'separator' },
      { id: 'rename', label: 'Rename…', icon: 'edit', hint: 'F2' },
      { id: 'delete', label: deletesToTrash() ? 'Move to trash' : 'Delete…', icon: 'trash', danger: true, hint: 'Del' },
    ];
  };

  const onSelect = (id: string) => {
    const target = menuTarget();
    setMenuTarget(undefined);
    if (!target) return;
    const entry = target.entry;
    // New entries and pastes go inside a folder, or beside a file.
    const folder = folderFor(entry);
    if (id === 'newFile') startNewEntry(folder, 'file');
    if (id === 'newDir') startNewEntry(folder, 'dir');
    if (id === 'paste') void pasteIntoEntry(entry);
    if (!entry) return;
    if (id === 'cut') cutEntry(entry);
    if (id === 'copy') copyEntryToClipboard(entry);
    if (id === 'duplicate') void runAction(() => copyIntoFolder(entry.path, parentPath(entry.path)));
    if (id === 'copyPath') void writeText(absoluteEntryPath(entry.path));
    if (id === 'copyRelative') void writeText(entry.path);
    if (id === 'reveal') revealEntry(entry.path);
    if (id === 'rename') startRename(entry);
    if (id === 'delete') void deleteWithConfirm(entry);
  };

  return (
    <Menu
      anchor={menuTarget()?.anchor}
      open={!!menuTarget()}
      onClose={() => setMenuTarget(undefined)}
      onSelect={onSelect}
      items={items()}
      placement="bottom-start"
      class="files-entry-menu"
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Keyboard (on the tree): Ctrl+C / Ctrl+X / Ctrl+V, Delete, F2, Escape clears a cut

/** Each row element's entry, so one keydown handler on the tree can act on the focused row. */
const rowEntries = new WeakMap<Element, () => FileEntry>();

export function registerRow(element: HTMLElement, entry: () => FileEntry): void {
  rowEntries.set(element, entry);
}

function rowEntry(target: EventTarget | null): FileEntry | undefined {
  const row = target instanceof Element ? target.closest('.files-entry') : null;
  return row ? rowEntries.get(row)?.() : undefined;
}

export function onTreeKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, [contenteditable="true"]')) return;
  const entry = rowEntry(target);
  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  let handled = true;
  if (command && key === 'c' && entry) copyEntryToClipboard(entry);
  else if (command && key === 'x' && entry) cutEntry(entry);
  else if (command && key === 'v' && clipboard()) void pasteIntoEntry(entry);
  else if (command && key === 'd' && entry) void runAction(() => copyIntoFolder(entry.path, parentPath(entry.path)));
  else if (event.key === 'Delete' && entry) void deleteWithConfirm(entry);
  else if (event.key === 'F2' && entry) startRename(entry);
  else if (event.key === 'Escape' && clipboard()?.mode === 'cut') setClipboard(undefined);
  else handled = false;
  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Drag and drop: drag rows to move them (hold Ctrl to copy), drop files from the OS to copy them in

const internalType = 'application/x-unify-path';
const expandDelayMs = 700;

/** The project-relative path being dragged from this tree (dragover cannot read the data itself). */
let dragging: string | undefined;
let expandTimer = 0;
let expandFolder: string | undefined;

const [dropFolder, setDropFolder] = createSignal<string | undefined>();
/** The folder a drag is over ('' = project root), for its highlight. */
export { dropFolder };

function clearDrop(): void {
  window.clearTimeout(expandTimer);
  expandFolder = undefined;
  setDropFolder(undefined);
}

/** Whether a drag can land in `folder`, and as what. Undefined: refuse (no highlight). */
function dropEffectFor(event: DragEvent, folder: string): 'move' | 'copy' | undefined {
  const types = event.dataTransfer?.types ?? [];
  if (dragging !== undefined && types.includes(internalType)) {
    const copy = event.ctrlKey || event.altKey;
    // A folder cannot go inside itself; a move into the folder it is already in does nothing.
    if (folder === dragging || folder.startsWith(`${dragging}/`)) return undefined;
    if (!copy && parentPath(dragging) === folder) return undefined;
    return copy ? 'copy' : 'move';
  }
  return types.includes('Files') ? 'copy' : undefined;
}

function over(event: DragEvent, folder: string, closedDir?: string): void {
  const effect = dropEffectFor(event, folder);
  event.stopPropagation();
  if (!effect) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    clearDrop();
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = effect;
  if (dropFolder() !== folder) setDropFolder(folder);
  // Hovering a closed folder opens it, like a file manager.
  if (expandFolder !== closedDir) {
    window.clearTimeout(expandTimer);
    expandFolder = closedDir;
    if (closedDir) expandTimer = window.setTimeout(() => setDirOpen(closedDir, true), expandDelayMs);
  }
}

async function dropInto(event: DragEvent, folder: string): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  const effect = dropEffectFor(event, folder);
  const source = dragging;
  const files = event.dataTransfer?.files;
  clearDrop();
  dragging = undefined;
  if (!effect) return;
  if (source !== undefined && event.dataTransfer?.types.includes(internalType)) {
    await runAction(() => (effect === 'copy' ? copyIntoFolder(source, folder) : moveIntoFolder(source, folder)));
    return;
  }
  const paths = droppedPaths(files);
  if (!paths.length) {
    showError('Only files and folders from disk can be dropped here.');
    return;
  }
  await runAction(() => importIntoFolder(paths, folder));
}

/** Drag props for a row: it drags itself, and takes drops into its folder (a file row: its parent folder). */
export function rowDragProps(entry: () => FileEntry): JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  return {
    get draggable() { return !isRenaming(entry().path); },
    onDragStart: event => {
      const current = entry();
      dragging = current.path;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'copyMove';
        event.dataTransfer.setData(internalType, current.path);
        event.dataTransfer.setData('text/plain', current.path);
      }
    },
    onDragEnd: () => {
      dragging = undefined;
      clearDrop();
    },
    onDragOver: event => {
      const current = entry();
      const closed = current.kind === 'dir' && !openDirs().includes(current.path) ? current.path : undefined;
      over(event, folderFor(current), closed);
    },
    onDrop: event => void dropInto(event, folderFor(entry())),
  };
}

/** Drag props for the tree's background: drops land in the project root. */
export const treeDropProps: JSX.HTMLAttributes<HTMLDivElement> = {
  onDragOver: event => over(event, ''),
  onDragLeave: event => {
    const next = event.relatedTarget as Node | null;
    if (!next || !(event.currentTarget as HTMLElement).contains(next)) clearDrop();
  },
  onDrop: event => void dropInto(event, ''),
};
