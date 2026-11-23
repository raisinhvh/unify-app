/**
 * The Files side panel (Figma 20 · Files + Editor 306:1623, left column).
 *
 *   header   "Files" + search + more
 *   search   folds open under the header; matches file paths across the workspace (adapter.findFiles)
 *   tree     the workspace as folders and files with guide lines; folders load when first opened
 *
 * Files an agent changed show +N −M on their row (rolling counters). Click opens the file in a tab; the selected
 * row is the active tab. Built for the Shell's side-panel slot (`.side-panel`), like ChatsPanel.
 *
 * Organic motion (motion.organic.*): a file that appears types its name in, a deleted one gets a select-all sweep
 * before its row collapses, and a rename (one entry leaves and one arrives in the same refresh) backspaces and
 * retypes the name while the row glides to its new place.
 */
import { createEffect, createMemo, createSignal, on, onMount, Show, untrack, type Accessor, type JSX } from 'solid-js';
import { Icon, IconButton, Menu, TreeFolder, TreeItem, type MenuEntry } from '../../components';
import { AnimatedList, Collapse } from '../../motion';
import { OrganicList, RetypeText, RollingNumber, type OrganicRow } from '../../motion/organic';
import { findFiles, openExternally, type FileEdit, type FileEntry } from './adapter';
import { activePath, collapseAllDirs, editFor, listings, loadDir, openDirs, openFile, refreshTree, setDirOpen } from './state';
import './files.css';

/** "+18 −4" in add/del colours. Shared with tabs and the breadcrumb. */
export function FileDelta(props: { edit: FileEdit | undefined }): JSX.Element {
  return (
    <Show when={props.edit}>
      {edit => (
        <span class="files-delta">
          <Show when={edit().additions > 0}>
            <span class="files-add">
              <RollingNumber value={`+${edit().additions}`} data-motion="files-additions" />
            </span>
          </Show>
          <Show when={edit().deletions > 0}>
            <span class="files-del">
              <RollingNumber value={`−${edit().deletions}`} data-motion="files-deletions" />
            </span>
          </Show>
        </span>
      )}
    </Show>
  );
}

/** The row's name: types in when created, retypes on rename, sweeps out when deleted. */
function EntryName(props: { name: string; row: OrganicRow; typeIn: boolean }): JSX.Element {
  // Every listing refresh rebuilds the keyed entries; only a real name change may reach RetypeText (each retype
  // claims one of the few organic slots, so spurious ones would make a new row's type-in land instantly).
  const name = createMemo(() => props.name);
  return (
    <RetypeText
      value={name()}
      typeOnMount={props.typeIn}
      deleting={props.row.leaving()}
      onDeleted={props.row.swept}
      data-motion="files-tree-name"
    />
  );
}

function FileRow(props: { entry: FileEntry; row: OrganicRow; typeIn: boolean }): JSX.Element {
  const edit = () => editFor(props.entry.path, props.entry.edited);
  return (
    <TreeItem
      class="files-file"
      leading={<Icon name="file" size={14} />}
      label={<EntryName name={props.entry.name} row={props.row} typeIn={props.typeIn} />}
      trailing={edit() ? <FileDelta edit={edit()} /> : undefined}
      selected={activePath() === props.entry.path}
      title={props.entry.path}
      onClick={() => openFile(props.entry.path)}
    />
  );
}

function DirRow(props: { entry: FileEntry; row: OrganicRow; typeIn: boolean }): JSX.Element {
  const open = () => openDirs().includes(props.entry.path);
  return (
    <TreeFolder
      class="files-dir"
      icon="folder"
      label={<EntryName name={props.entry.name} row={props.row} typeIn={props.typeIn} />}
      open={open()}
      onToggle={next => setDirOpen(props.entry.path, next)}
    >
      <DirChildren path={props.entry.path} />
    </TreeFolder>
  );
}

interface KeyedEntry {
  /** Stable row key: survives a rename, so the name retypes instead of the row being replaced. */
  id: string;
  entry: FileEntry;
}

/**
 * Gives each entry a key that outlives a rename. A refresh where exactly one entry of a kind leaves and one of
 * the same kind arrives is read as a rename: the new path inherits the old key.
 */
function stableEntries(entries: Accessor<readonly FileEntry[]>): Accessor<KeyedEntry[]> {
  const idByPath = new Map<string, string>();
  // A plain copy: the listing is a store array that reconcile mutates in place.
  let previous: Pick<FileEntry, 'path' | 'kind'>[] = [];
  return createMemo(() => {
    const list = entries();
    const present = new Set(list.map(entry => entry.path));
    const known = new Set(previous.map(entry => entry.path));
    const removed = previous.filter(entry => !present.has(entry.path));
    const added = list.filter(entry => !known.has(entry.path));    if (previous.length && removed.length === 1 && added.length === 1 && removed[0].kind === added[0].kind) {
      const inherited = idByPath.get(removed[0].path);
      if (inherited) idByPath.set(added[0].path, inherited);
    }
    for (const entry of removed) idByPath.delete(entry.path);
    previous = list.map(entry => ({ path: entry.path, kind: entry.kind }));
    return list.map(entry => {
      let id = idByPath.get(entry.path);
      if (!id) {
        id = entry.path;
        idByPath.set(entry.path, id);
      }
      return { id, entry };
    });
  });
}

function DirChildren(props: { path: string }): JSX.Element {
  createEffect(on(() => props.path, path => void loadDir(path)));
  const entries = stableEntries(() => listings[props.path] ?? []);
  // Rows in the first listing are placed; only entries that arrive in a later refresh type their names in.
  const [primed, setPrimed] = createSignal(false);
  createEffect(() => {
    if (listings[props.path] && !untrack(primed)) queueMicrotask(() => setPrimed(true));
  });
  return (
    <OrganicList each={entries()} key={item => item.id}>
      {(item, row) => {
        const typeIn = row.created && untrack(primed);        return (
          <Show
            when={item().entry.kind === 'dir'}
            fallback={<FileRow entry={item().entry} row={row} typeIn={typeIn} />}
          >
            <DirRow entry={item().entry} row={row} typeIn={typeIn} />
          </Show>
        );
      }}
    </OrganicList>
  );
}

function SearchResults(props: { query: string }): JSX.Element {
  const [paths, setPaths] = createSignal<string[]>([]);
  createEffect(() => {
    const query = props.query;
    void findFiles(query).then(result => {
      if (query === props.query) setPaths(result);
    });
  });
  return (
    <div class="files-results">
      <AnimatedList each={paths()} key={path => path}>
        {path => {
          const name = () => path().slice(path().lastIndexOf('/') + 1);
          const folder = () => path().slice(0, Math.max(0, path().lastIndexOf('/')));
          return (
            <TreeItem
              class="files-file"
              leading={<Icon name="file" size={14} />}
              label={name()}
              trailing={folder()}
              selected={activePath() === path()}
              onClick={() => openFile(path())}
            />
          );
        }}
      </AnimatedList>
      <Show when={props.query.trim() && !paths().length}>
        <p class="files-empty type-caption">No files match</p>
      </Show>
    </div>
  );
}

export function FilesPanel(): JSX.Element {
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [menuOpen, setMenuOpen] = createSignal(false);
  let moreButton: HTMLButtonElement | undefined;
  let searchInput: HTMLInputElement | undefined;

  onMount(() => {
    void loadDir('');
    for (const path of openDirs()) void loadDir(path);
  });

  const toggleSearch = () => {
    const next = !searching();
    setSearching(next);
    if (next) queueMicrotask(() => searchInput?.focus());
    else setQuery('');
  };

  const menuItems = (): MenuEntry[] => [
    { id: 'collapse', label: 'Collapse folders' },
    { id: 'refresh', label: 'Refresh', icon: 'refresh' },
    { kind: 'separator' },
    { id: 'external', label: 'Open in system editor', icon: 'pop', disabled: !activePath() },
  ];

  const onMenu = (id: string) => {
    if (id === 'collapse') collapseAllDirs();
    if (id === 'refresh') void refreshTree();
    if (id === 'external' && activePath()) openExternally(activePath()!);
  };

  return (
    <aside class="side-panel files-panel" aria-label="Files">
      <header class="files-panel-header">
        <h2 class="type-heading">Files</h2>
        <div class="files-panel-actions">
          <IconButton icon="search" label="Find a file" active={searching()} onClick={toggleSearch} />
          <IconButton ref={moreButton} icon="more" label="More" active={menuOpen()} onClick={() => setMenuOpen(!menuOpen())} />
        </div>
      </header>
      <Menu anchor={moreButton} open={menuOpen()} onClose={() => setMenuOpen(false)} onSelect={onMenu} items={menuItems()} placement="bottom-end" />
      <Collapse open={searching()}>
        <label class="files-search">
          <Icon name="search" size={14} />
          <input
            ref={searchInput}
            type="search"
            placeholder="Find a file"
            value={query()}
            onInput={event => setQuery(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') toggleSearch();
            }}
          />
        </label>
      </Collapse>
      <div class="files-tree">
        <Show
          when={!query().trim()}
          fallback={<SearchResults query={query()} />}
        >
          <DirChildren path="" />
        </Show>
      </div>
    </aside>
  );
}
