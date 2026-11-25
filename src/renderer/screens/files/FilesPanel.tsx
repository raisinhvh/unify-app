/**
 * The Files side panel (Figma 20 · Files + Editor 306:1623, left column).
 *
 *   header   "Files" + new (file / folder at the root) + search + more
 *   actions  hover a row for its delete button; right-click for New file / New folder / Cut / Copy / Paste /
 *            Duplicate / Copy path / Reveal / Rename / Delete; keys Ctrl+C/X/V/D, Delete, F2 on the focused row;
 *            drag rows into folders to move them (Ctrl to copy), drop files from the OS to copy them in
 *            (entryActions.tsx; deletes go to the OS trash when the bridge can)
 *   project  which project folder the tree is (name + path); opens the recent-projects picker to switch
 *   search   folds open under the header with a Files | Contents switch. Files matches paths across the workspace
 *            (adapter.findFiles); Contents (Ctrl/⌘ Shift F, also the switch) searches the text of every file
 *            (adapter.searchFileContents, debounced, Aa = match case): results grouped by file, one row per
 *            occurrence with the match marked; clicking one opens the file with exactly that text selected
 *   tree     the workspace as folders and files with guide lines; folders load when first opened
 *
 * Files an agent changed show +N −M on their row (rolling counters). Click opens the file in a tab; the selected
 * row is the active tab. Built for the Shell's side-panel slot (`.side-panel`), like ChatsPanel.
 *
 * Organic motion (motion.organic.*): a file that appears types its name in, a deleted one gets a select-all sweep
 * before its row collapses, and a rename (one entry leaves and one arrives in the same refresh) backspaces and
 * retypes the name while the row glides to its new place.
 */
import { createEffect, createMemo, createSignal, For, on, onMount, Show, untrack, type Accessor, type JSX } from 'solid-js';
import {
  createContentSearch,
  Icon,
  IconButton,
  MatchCaseToggle,
  MatchSnippet,
  Menu,
  onFindShortcuts,
  TreeFolder,
  TreeItem,
  type MenuEntry,
} from '../../components';
import { AnimatedList, Collapse, Presence } from '../../motion';
import { OrganicList, RetypeText, RollingNumber, type OrganicRow } from '../../motion/organic';
import { ProjectSwitch } from '../chats/ProjectSwitch';
import { Segmented } from '../knowledge/Segmented';
import {
  contentSearchLimit,
  filesProject,
  findFiles,
  openExternally,
  searchFileContents,
  workspace,
  type ContentMatch,
  type ContentSearchResult,
  type FileEdit,
  type FileEntry,
} from './adapter';
import {
  activePath,
  collapseAllDirs,
  editFor,
  isCut,
  listings,
  loadDir,
  openDirs,
  openFile,
  openFileAt,
  refreshTree,
  setDirOpen,
  switchFilesProject,
} from './state';
import {
  actionError, createDeleteButton, dropFolder, editing, EntryMenu, isRenaming, NewEntryRow, onTreeKeyDown, openEntryMenu, registerRow,
  RenameInput, rowDragProps, startNewEntry, treeDropProps,
} from './entryActions';
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

/** A row's trailing cell: its +N −M (if any) and the hover delete button sharing one spot. */
function RowTrailing(props: { edit?: FileEdit; button: JSX.Element }): JSX.Element {
  return (
    <span class="files-row-trailing">
      <span class="files-row-info">
        <FileDelta edit={props.edit} />
      </span>
      {props.button}
    </span>
  );
}

/** Row classes shared by file and folder rows: hover-delete armed, dimmed while cut. */
function entryClass(base: string, path: string, armed: boolean): string {
  return `${base} files-entry${armed ? ' delete-armed' : ''}${isCut(path) ? ' cut' : ''}`;
}

function FileRow(props: { entry: FileEntry; row: OrganicRow; typeIn: boolean }): JSX.Element {
  const edit = () => editFor(props.entry.path, props.entry.edited);
  const remove = createDeleteButton(() => props.entry);
  let element: HTMLButtonElement | undefined;
  return (
    <TreeItem
      {...rowDragProps(() => props.entry)}
      ref={node => {
        element = node;
        registerRow(node, () => props.entry);
      }}
      class={entryClass('files-file', props.entry.path, remove.armed())}
      leading={<Icon name="file" size={14} />}
      label={
        <Show when={!isRenaming(props.entry.path)} fallback={<RenameInput entry={props.entry} />}>
          <EntryName name={props.entry.name} row={props.row} typeIn={props.typeIn} />
        </Show>
      }
      trailing={<RowTrailing edit={edit()} button={remove.button} />}
      selected={activePath() === props.entry.path}
      title={props.entry.path}
      onClick={() => openFile(props.entry.path)}
      onContextMenu={event => openEntryMenu(event, element, props.entry)}
      onPointerLeave={remove.disarm}
    />
  );
}

function DirRow(props: { entry: FileEntry; row: OrganicRow; typeIn: boolean }): JSX.Element {
  const open = () => openDirs().includes(props.entry.path);
  const remove = createDeleteButton(() => props.entry);
  let element: HTMLButtonElement | undefined;
  return (
    <TreeFolder
      class={dropFolder() === props.entry.path ? 'files-dir drop-target' : 'files-dir'}
      rowClass={entryClass('', props.entry.path, remove.armed()).trim()}
      rowRef={node => {
        element = node;
        registerRow(node, () => props.entry);
      }}
      rowProps={rowDragProps(() => props.entry)}
      icon="folder"
      label={
        <Show when={!isRenaming(props.entry.path)} fallback={<RenameInput entry={props.entry} />}>
          <EntryName name={props.entry.name} row={props.row} typeIn={props.typeIn} />
        </Show>
      }
      trailing={<RowTrailing button={remove.button} />}
      title={props.entry.path}
      open={open()}
      onToggle={next => setDirOpen(props.entry.path, next)}
      onContextMenu={event => openEntryMenu(event, element, props.entry)}
      onPointerLeave={remove.disarm}
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
    const added = list.filter(entry => !known.has(entry.path));
    if (previous.length && removed.length === 1 && added.length === 1 && removed[0].kind === added[0].kind) {
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
  const adding = () => {
    const current = editing();
    return current?.mode === 'new' && current.folder === props.path ? current : undefined;
  };
  return (
    <>
    <Show when={adding()}>
      {current => <NewEntryRow folder={props.path} kind={current().kind} />}
    </Show>
    <OrganicList each={entries()} key={item => item.id}>
      {(item, row) => {
        const typeIn = row.created && untrack(primed);
        return (
          <Show
            when={item().entry.kind === 'dir'}
            fallback={<FileRow entry={item().entry} row={row} typeIn={typeIn} />}
          >
            <DirRow entry={item().entry} row={row} typeIn={typeIn} />
          </Show>
        );
      }}
    </OrganicList>
    </>
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

/** One file's occurrences in a contents search, in the engine's order. */
interface FileMatches {
  path: string;
  matches: ContentMatch[];
}

function groupByFile(matches: readonly ContentMatch[]): FileMatches[] {
  const groups = new Map<string, FileMatches>();
  for (const match of matches) {
    let group = groups.get(match.path);
    if (!group) {
      group = { path: match.path, matches: [] };
      groups.set(match.path, group);
    }
    group.matches.push(match);
  }
  return [...groups.values()];
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Contents search results: a collapsible row per file, a row per occurrence under it. */
function ContentResults(props: { result: ContentSearchResult | undefined; searching: boolean }): JSX.Element {
  const groups = createMemo(() => groupByFile(props.result?.matches ?? []));
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = createSignal<string>();
  const setFileOpen = (path: string, open: boolean) => {
    const next = new Set(collapsed());
    if (open) next.delete(path);
    else next.add(path);
    setCollapsed(next);
  };
  const summary = () => {
    const result = props.result;
    if (!result?.matches.length) return '';
    if (result.truncated) return `Showing first ${contentSearchLimit} matches`;
    return `${plural(result.matches.length, 'result')} in ${plural(groups().length, 'file')}`;
  };
  return (
    <div class="files-results files-content-results" classList={{ stale: props.searching && !!props.result }}>
      <Show
        when={props.result}
        fallback={
          <Show when={props.searching}>
            <p class="files-empty type-caption">Searching…</p>
          </Show>
        }
      >
        {result => (
          <Show
            when={result().matches.length}
            fallback={<p class="files-empty type-caption">No results</p>}
          >
            <p class="files-results-summary type-caption">{summary()}</p>
          </Show>
        )}
      </Show>
      <AnimatedList each={groups()} key={group => group.path}>
        {group => {
          const path = () => group().path;
          const name = () => path().slice(path().lastIndexOf('/') + 1);
          const folder = () => path().slice(0, Math.max(0, path().lastIndexOf('/')));
          return (
            <TreeFolder
              class="files-match-file"
              icon="file"
              label={
                <>
                  <span class="files-match-name">{name()}</span>
                  <Show when={folder()}>
                    <span class="files-match-folder">{folder()}</span>
                  </Show>
                </>
              }
              trailing={<span class="files-match-count">{group().matches.length}</span>}
              title={path()}
              open={!collapsed().has(path())}
              onToggle={open => setFileOpen(path(), open)}
            >
              <For each={group().matches}>
                {match => {
                  const key = `${match.path}:${match.line}:${match.column}`;
                  return (
                    <TreeItem
                      class="files-match"
                      label={
                        <MatchSnippet
                          class="type-mono"
                          text={match.text}
                          column={match.column}
                          length={match.length}
                        />
                      }
                      selected={picked() === key}
                      title={`${match.path}:${match.line}`}
                      onClick={() => {
                        setPicked(key);
                        openFileAt(match.path, match.line, match.line, match.column, match.column + match.length);
                      }}
                    />
                  );
                }}
              </For>
            </TreeFolder>
          );
        }}
      </AnimatedList>
    </div>
  );
}

/** What the search area searches: file paths, or the text inside files. */
type SearchMode = 'files' | 'contents';

const searchModes: { value: SearchMode; label: string }[] = [
  { value: 'files', label: 'Files' },
  { value: 'contents', label: 'Contents' },
];

export function FilesPanel(): JSX.Element {
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [searchMode, setSearchMode] = createSignal<SearchMode>('files');
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [newOpen, setNewOpen] = createSignal(false);
  let moreButton: HTMLButtonElement | undefined;
  let newButton: HTMLButtonElement | undefined;
  let tree: HTMLDivElement | undefined;
  let panel: HTMLElement | undefined;

  const newItems: MenuEntry[] = [
    { id: 'file', label: 'New file', icon: 'file' },
    { id: 'dir', label: 'New folder', icon: 'folder' },
  ];
  const onNew = (id: string) => {
    setNewOpen(false);
    // Searching hides the tree, where the name is typed.
    if (searching()) toggleSearch();
    startNewEntry('', id === 'dir' ? 'dir' : 'file');
    tree?.scrollTo({ top: 0 });
  };
  let searchInput: HTMLInputElement | undefined;

  onMount(() => {
    void loadDir('');
    for (const path of openDirs()) void loadDir(path);
  });

  /** The search button: opens the filename search, or closes the search area. */
  const toggleSearch = () => {
    const next = !searching();
    setSearching(next);
    if (next) {
      setSearchMode('files');
      queueMicrotask(() => searchInput?.focus());
    } else {
      setQuery('');
    }
  };

  /** Ctrl/⌘ Shift F: the search area in contents mode, its text selected to type over. */
  const openContentsSearch = () => {
    setSearching(true);
    setSearchMode('contents');
    queueMicrotask(() => {
      searchInput?.focus();
      searchInput?.select();
    });
  };

  onFindShortcuts({
    element: () => panel,
    screen: '.files-screen',
    onFindAll: openContentsSearch,
  });

  const contents = createContentSearch({
    query,
    caseSensitive,
    enabled: () => searching() && searchMode() === 'contents',
    run: (text, matchCase) => searchFileContents(text, { caseSensitive: matchCase }),
  });

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
    <aside ref={panel} class="side-panel files-panel" aria-label="Files">
      <header class="files-panel-header">
        <h2 class="type-heading">Files</h2>
        <div class="files-panel-actions">
          <IconButton ref={newButton} icon="plus" label="New file or folder" active={newOpen()} onClick={() => setNewOpen(!newOpen())} />
          <IconButton icon="search" label="Find a file" active={searching()} onClick={toggleSearch} />
          <IconButton ref={moreButton} icon="more" label="More" active={menuOpen()} onClick={() => setMenuOpen(!menuOpen())} />
        </div>
      </header>
      <ProjectSwitch
        class="files-project"
        path={filesProject()?.path ?? (workspace().root || undefined)}
        name={filesProject()?.name ?? (workspace().name || undefined)}
        onSelect={project => void switchFilesProject(project)}
      />
      <Menu anchor={moreButton} open={menuOpen()} onClose={() => setMenuOpen(false)} onSelect={onMenu} items={menuItems()} placement="bottom-end" />
      <Menu anchor={newButton} open={newOpen()} onClose={() => setNewOpen(false)} onSelect={onNew} items={newItems} placement="bottom-end" />
      <EntryMenu />
      <Collapse open={!!actionError()}>
        <p class="files-action-error type-caption" role="alert">{actionError()}</p>
      </Collapse>
      <Collapse open={searching()}>
        <div class="files-search-area">
          <Segmented
            class="files-search-modes"
            label="Search in"
            value={searchMode()}
            options={searchModes}
            onChange={mode => {
              setSearchMode(mode);
              searchInput?.focus();
            }}
          />
          <label class="files-search">
            <Icon name="search" size={14} />
            <input
              ref={searchInput}
              type="search"
              placeholder={searchMode() === 'contents' ? 'Search in files' : 'Find a file'}
              value={query()}
              onInput={event => setQuery(event.currentTarget.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') toggleSearch();
              }}
            />
            <Presence when={searchMode() === 'contents'} from={0.9} origin="center right">
              <MatchCaseToggle
                active={caseSensitive()}
                onChange={setCaseSensitive}
              />
            </Presence>
          </label>
        </div>
      </Collapse>
      <div
        {...treeDropProps}
        class="files-tree"
        classList={{ 'drop-root': dropFolder() === '' }}
        ref={tree}
        onKeyDown={onTreeKeyDown}
        // Right-click on empty space: new file or folder at the project root.
        onContextMenu={event => {
          if (event.target === event.currentTarget) openEntryMenu(event, newButton);
        }}
      >
        <Show
          when={!query().trim()}
          fallback={
            <Show
              when={searchMode() === 'contents'}
              fallback={<SearchResults query={query()} />}
            >
              <ContentResults
                result={contents.result()}
                searching={contents.searching()}
              />
            </Show>
          }
        >
          <DirChildren path="" />
        </Show>
      </div>
    </aside>
  );
}
