/**
 * The Files side panel (Figma 20 · Files + Editor 306:1623, left column).
 *
 *   header   "Files" + search + more
 *   search   folds open under the header; matches file paths across the workspace (adapter.findFiles)
 *   tree     the workspace as folders and files with guide lines; folders load when first opened
 *
 * Files an agent changed show +N −M on their row. Click opens the file in a tab; the selected row is the
 * active tab. Built for the Shell's side-panel slot (`.side-panel`), like ChatsPanel.
 */
import { createEffect, createSignal, onMount, Show, type JSX } from 'solid-js';
import { Icon, IconButton, Menu, TreeFolder, TreeItem, type MenuEntry } from '../../components';
import { AnimatedList, Collapse } from '../../motion';
import { findFiles, openExternally, type FileEdit, type FileEntry } from './adapter';
import { activePath, collapseAllDirs, editFor, listings, loadDir, openDirs, openFile, refreshTree, setDirOpen } from './state';
import './files.css';

/** "+18 −4" in add/del colours. Shared with tabs and the breadcrumb. */
export function FileDelta(props: { edit: FileEdit | undefined }): JSX.Element {
  // organic: when an agent edits again, these numbers should roll like an odometer (motion.organic.counters).
  return (
    <Show when={props.edit}>
      {edit => (
        <span class="files-delta">
          <Show when={edit().additions > 0}>
            <span class="files-add">+{edit().additions}</span>
          </Show>
          <Show when={edit().deletions > 0}>
            <span class="files-del">−{edit().deletions}</span>
          </Show>
        </span>
      )}
    </Show>
  );
}

function FileRow(props: { entry: FileEntry }): JSX.Element {
  const edit = () => editFor(props.entry.path, props.entry.edited);
  // organic: a file the agent creates should type its name in; a rename backspaces and retypes it.
  return (
    <TreeItem
      class="files-file"
      leading={<Icon name="file" size={14} />}
      label={props.entry.name}
      trailing={edit() ? <FileDelta edit={edit()} /> : undefined}
      selected={activePath() === props.entry.path}
      title={props.entry.path}
      onClick={() => openFile(props.entry.path)}
    />
  );
}

function DirRow(props: { entry: FileEntry }): JSX.Element {
  const open = () => openDirs().includes(props.entry.path);
  return (
    <TreeFolder
      class="files-dir"
      icon="folder"
      label={props.entry.name}
      open={open()}
      onToggle={next => setDirOpen(props.entry.path, next)}
    >
      <DirChildren path={props.entry.path} />
    </TreeFolder>
  );
}

function DirChildren(props: { path: string }): JSX.Element {
  onMount(() => void loadDir(props.path));
  const entries = () => listings[props.path] ?? [];
  // organic: rows the agent deletes should get a select-all sweep before AnimatedList collapses them.
  return (
    <AnimatedList each={entries()} key={entry => entry.path}>
      {entry => (
        <Show when={entry().kind === 'dir'} fallback={<FileRow entry={entry()} />}>
          <DirRow entry={entry()} />
        </Show>
      )}
    </AnimatedList>
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
