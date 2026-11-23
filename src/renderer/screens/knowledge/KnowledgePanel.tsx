/**
 * The Knowledge side panel (Figma 21 · Knowledge 306:2710, left column).
 *
 *   header     "Knowledge" + search + New (Rule / Skill / Memory note / Import skill folder)
 *   scope      Global | This project
 *   Rules      one file per rule
 *   Skills     one folder per skill with its files; "Drop a skill folder" row (click to pick, or drag in)
 *   Memory     topic folders with notes
 *
 * Rules, skills and memory are one system: every item opens in the same document view on the right.
 * Dragging a folder anywhere over the panel lights the drop row; dropping imports it as a skill.
 */
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { Icon, IconButton, Menu, TreeFolder, TreeItem, type MenuEntry } from '../../components';
import { AnimatedList, Collapse, createSpring } from '../../motion';
import { importSkillFolder, knowledgeItems, saveKnowledge, type ImportedFile, type KnowledgeItem, type KnowledgeKind } from './adapter';
import { Segmented } from './Segmented';
import { openFolders, scope, select, selection, setFocusTitle, setFolderOpen, setMode, setScope } from './state';
import './knowledge.css';

// ---------------------------------------------------------------------------------------------------------------
// Folder drop reading

const textExtensions = /\.(md|mdx|txt|json|jsonc|ya?ml|toml|ts|tsx|js|mjs|cjs|py|lua|luau|sh|ps1|css|html|svg|csv|xml)$/i;
const skippedFolders = new Set(['node_modules', '.git', '__pycache__']);
const maxFiles = 300;

async function readFileContent(file: File): Promise<Pick<ImportedFile, 'content' | 'encoding'>> {
  if (textExtensions.test(file.name) || file.type.startsWith('text/')) return { content: await file.text() };
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let index = 0; index < buffer.length; index += 0x8000) binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
  return { content: btoa(binary), encoding: 'base64' };
}

async function readEntry(entry: FileSystemEntry, prefix: string, out: ImportedFile[]): Promise<void> {
  if (out.length >= maxFiles) return;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ path: prefix + file.name, ...(await readFileContent(file)) });
    return;
  }
  if (skippedFolders.has(entry.name)) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, out);
  }
}

/** Files of a dropped folder, relative to it. */
async function readDroppedFolder(entry: FileSystemDirectoryEntry): Promise<ImportedFile[]> {
  const files: ImportedFile[] = [];
  await readEntry(entry, '', files);
  const root = `${entry.name}/`;
  return files.map(file => ({ ...file, path: file.path.startsWith(root) ? file.path.slice(root.length) : file.path }));
}

/** Files picked through <input webkitdirectory>: webkitRelativePath is "folder/SKILL.md". */
async function readPickedFolder(list: FileList): Promise<{ name: string; files: ImportedFile[] }> {
  const all = [...list].slice(0, maxFiles);
  const name = all[0]?.webkitRelativePath.split('/')[0] ?? 'skill';
  const files: ImportedFile[] = [];
  for (const file of all) {
    const path = file.webkitRelativePath.split('/').slice(1).join('/');
    if (path.split('/').some(part => skippedFolders.has(part))) continue;
    files.push({ path, ...(await readFileContent(file)) });
  }
  return { name, files };
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

function ItemRow(props: { item: KnowledgeItem; file?: string; label?: string; class?: string }): JSX.Element {
  const selected = () => selection()?.id === props.item.id && selection()?.file === props.file;
  // organic: an item an agent creates or renames should type its name in (backspace + retype on rename).
  return (
    <TreeItem
      class={`knowledge-file${props.class ? ' ' + props.class : ''}`}
      leading={<Icon name="file" size={14} />}
      label={props.label ?? props.item.name}
      selected={selected()}
      title={props.label ?? props.item.name}
      onClick={() => select({ id: props.item.id, file: props.file })}
    />
  );
}

interface SkillFolderNode {
  name: string;
  files: string[];
}

/** SKILL.md and loose files first, then one folder per subfolder (one level deep, like Figma). */
function skillTree(files: string[]): { loose: string[]; folders: SkillFolderNode[] } {
  const loose: string[] = [];
  const folders = new Map<string, string[]>();
  for (const file of files) {
    const slash = file.indexOf('/');
    if (slash < 0) loose.push(file);
    else folders.set(file.slice(0, slash), [...(folders.get(file.slice(0, slash)) ?? []), file]);
  }
  loose.sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));
  return { loose, folders: [...folders].map(([name, list]) => ({ name, files: list })) };
}

function SkillRow(props: { item: KnowledgeItem; forceOpen: boolean }): JSX.Element {
  const key = () => `skill:${props.item.id}`;
  const tree = () => skillTree(props.item.files ?? ['SKILL.md']);
  return (
    <TreeFolder
      class="knowledge-folder"
      icon="folder"
      label={props.item.name}
      open={props.forceOpen || openFolders().includes(key())}
      onToggle={open => setFolderOpen(key(), open)}
    >
      <For each={tree().loose}>
        {file => <ItemRow item={props.item} file={file === 'SKILL.md' ? undefined : file} label={file} />}
      </For>
      <For each={tree().folders}>
        {folder => {
          const folderKey = () => `${key()}/${folder.name}`;
          return (
            <TreeFolder
              class="knowledge-folder"
              icon="folder"
              label={folder.name}
              trailing={String(folder.files.length)}
              open={props.forceOpen || openFolders().includes(folderKey())}
              onToggle={open => setFolderOpen(folderKey(), open)}
            >
              <For each={folder.files}>
                {file => <ItemRow item={props.item} file={file} label={file.slice(folder.name.length + 1)} />}
              </For>
            </TreeFolder>
          );
        }}
      </For>
    </TreeFolder>
  );
}

function DropRow(props: { dragging: boolean; busy: boolean; message?: string; onPick: () => void }): JSX.Element {
  const lift = createSpring(() => (props.dragging ? 1 : 0), 'pop');
  return (
    <TreeItem
      class={props.dragging ? 'knowledge-drop dragging' : 'knowledge-drop'}
      tone="muted"
      leading={<Icon name="upload" size={14} style={{ translate: `0 ${-2 * lift()}px` }} />}
      label={props.busy ? 'Importing…' : props.message ?? (props.dragging ? 'Drop to add the skill' : 'Drop a skill folder')}
      onClick={() => props.onPick()}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Panel

export function KnowledgePanel(): JSX.Element {
  const [query, setQuery] = createSignal('');
  const [searching, setSearching] = createSignal(false);
  const [newOpen, setNewOpen] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  const [dropMessage, setDropMessage] = createSignal<string>();
  let newButton: HTMLButtonElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let folderInput: HTMLInputElement | undefined;
  let dragDepth = 0;

  const searchText = () => query().trim().toLowerCase();
  const inScope = createMemo(() =>
    knowledgeItems().filter(item => {
      if (item.scope !== scope()) return false;
      const text = searchText();
      if (!text) return true;
      return [item.name, item.description ?? '', item.folder ?? '', ...(item.files ?? [])].some(part => part.toLowerCase().includes(text));
    }),
  );
  const byKind = (kind: KnowledgeKind) => inScope().filter(item => item.kind === kind);
  const rules = createMemo(() => byKind('rule'));
  const skills = createMemo(() => byKind('skill'));
  const notes = createMemo(() => byKind('memory'));
  const topics = createMemo(() => {
    const groups = new Map<string, KnowledgeItem[]>();
    for (const note of notes()) groups.set(note.folder ?? 'notes', [...(groups.get(note.folder ?? 'notes') ?? []), note]);
    return [...groups].map(([name, items]) => ({ name, items }));
  });

  const forceOpen = () => !!searchText();
  const folderOpen = (key: string) => forceOpen() || openFolders().includes(key);

  const toggleSearch = () => {
    const next = !searching();
    setSearching(next);
    if (next) queueMicrotask(() => searchInput?.focus());
    else setQuery('');
  };

  const create = async (kind: KnowledgeKind) => {
    const names: Record<KnowledgeKind, string> = { rule: 'New rule', skill: 'new-skill', memory: 'New note' };
    const content = kind === 'skill' ? `---\nname: ${names.skill}\ndescription: \n---\n` : '';
    const item = await saveKnowledge(
      { kind, scope: scope(), name: names[kind], folder: kind === 'memory' ? 'notes' : undefined, audiences: ['everyone'] },
      content,
    );
    setFolderOpen(kind === 'rule' ? 'rules' : kind === 'skill' ? 'skills' : 'memory', true);
    if (kind === 'memory') setFolderOpen('topic:notes', true);
    if (kind === 'skill') setFolderOpen(`skill:${item.id}`, true);
    select({ id: item.id });
    setMode('edit');
    setFocusTitle(true);
  };

  const finishImport = async (name: string, files: ImportedFile[]) => {
    if (!files.some(file => file.path.toLowerCase() === 'skill.md')) {
      setDropMessage('No SKILL.md in that folder');
      window.setTimeout(() => setDropMessage(undefined), 2400);
      return;
    }
    setImporting(true);
    try {
      const item = await importSkillFolder(scope(), name, files);
      setFolderOpen('skills', true);
      setFolderOpen(`skill:${item.id}`, true);
      select({ id: item.id });
    } catch (error) {
      setDropMessage(error instanceof Error ? error.message : String(error));
      window.setTimeout(() => setDropMessage(undefined), 2400);
    } finally {
      setImporting(false);
    }
  };

  const hasFiles = (event: DragEvent) => !!event.dataTransfer && [...event.dataTransfer.types].includes('Files');

  const onDragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
    setFolderOpen('skills', true);
  };

  const onDragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setDragging(false);
  };

  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);
    const entry = [...(event.dataTransfer?.items ?? [])].map(item => item.webkitGetAsEntry()).find(item => item?.isDirectory);
    if (!entry) {
      setDropMessage('Drop a folder, not a file');
      window.setTimeout(() => setDropMessage(undefined), 2400);
      return;
    }
    setImporting(true);
    void readDroppedFolder(entry as FileSystemDirectoryEntry)
      .then(files => finishImport(entry.name, files))
      .finally(() => setImporting(false));
  };

  const newItems: MenuEntry[] = [
    { kind: 'group', label: 'New' },
    { id: 'rule', label: 'Rule', icon: 'file', hint: 'always followed' },
    { id: 'skill', label: 'Skill', icon: 'folder', hint: 'loaded when relevant' },
    { id: 'memory', label: 'Memory note', icon: 'knowledge' },
    { kind: 'separator' },
    { id: 'import', label: 'Import skill folder…', icon: 'upload' },
  ];

  return (
    <aside
      class="side-panel knowledge-panel"
      classList={{ dragging: dragging() }}
      aria-label="Knowledge"
      onDragEnter={onDragEnter}
      onDragOver={event => {
        if (hasFiles(event)) {
          event.preventDefault();
          event.dataTransfer!.dropEffect = 'copy';
        }
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header class="knowledge-panel-header">
        <h2 class="type-heading">Knowledge</h2>
        <div class="knowledge-panel-actions">
          <IconButton icon="search" label="Search knowledge" active={searching()} onClick={toggleSearch} />
          <IconButton ref={newButton} icon="plus" label="New" active={newOpen()} onClick={() => setNewOpen(!newOpen())} />
        </div>
      </header>
      <Menu
        anchor={newButton}
        open={newOpen()}
        onClose={() => setNewOpen(false)}
        onSelect={id => {
          if (id === 'import') folderInput?.click();
          else void create(id as KnowledgeKind);
        }}
        items={newItems}
        placement="bottom-end"
        class="knowledge-new-menu"
      />
      <input
        ref={element => {
          folderInput = element;
          element.setAttribute('webkitdirectory', '');
        }}
        type="file"
        multiple
        hidden
        onChange={event => {
          const list = event.currentTarget.files;
          if (!list?.length) return;
          setImporting(true);
          void readPickedFolder(list)
            .then(picked => finishImport(picked.name, picked.files))
            .finally(() => setImporting(false));
          event.currentTarget.value = '';
        }}
      />
      <Collapse open={searching()}>
        <label class="knowledge-search">
          <Icon name="search" size={14} />
          <input
            ref={searchInput}
            type="search"
            placeholder="Search rules, skills and memory"
            value={query()}
            onInput={event => setQuery(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') toggleSearch();
            }}
          />
        </label>
      </Collapse>
      <Segmented
        class="knowledge-scope"
        label="Scope"
        value={scope()}
        onChange={setScope}
        options={[
          { value: 'global', label: 'Global' },
          { value: 'project', label: 'This project' },
        ]}
      />
      <div class="knowledge-tree">
        <TreeFolder
          class="knowledge-section"
          icon="folder"
          label="Rules"
          trailing={String(rules().length)}
          open={folderOpen('rules')}
          onToggle={open => setFolderOpen('rules', open)}
        >
          <AnimatedList each={rules()} key={item => item.id}>
            {item => <ItemRow item={item()} />}
          </AnimatedList>
        </TreeFolder>

        <TreeFolder
          class="knowledge-section"
          icon="folder"
          label="Skills"
          trailing={String(skills().length)}
          open={folderOpen('skills')}
          onToggle={open => setFolderOpen('skills', open)}
        >
          <AnimatedList each={skills()} key={item => item.id}>
            {item => <SkillRow item={item()} forceOpen={forceOpen()} />}
          </AnimatedList>
          <DropRow dragging={dragging()} busy={importing()} message={dropMessage()} onPick={() => folderInput?.click()} />
        </TreeFolder>

        <TreeFolder
          class="knowledge-section"
          icon="folder"
          label="Memory"
          trailing={String(notes().length)}
          open={folderOpen('memory')}
          onToggle={open => setFolderOpen('memory', open)}
        >
          <AnimatedList each={topics()} key={topic => topic.name}>
            {topic => (
              <TreeFolder
                class="knowledge-folder"
                icon="folder"
                label={topic().name}
                trailing={String(topic().items.length)}
                open={folderOpen(`topic:${topic().name}`)}
                onToggle={open => setFolderOpen(`topic:${topic().name}`, open)}
              >
                <AnimatedList each={topic().items} key={item => item.id}>
                  {item => <ItemRow item={item()} />}
                </AnimatedList>
              </TreeFolder>
            )}
          </AnimatedList>
        </TreeFolder>

        <Show when={searchText() && !inScope().length}>
          <p class="knowledge-empty type-caption">Nothing matches “{query().trim()}”</p>
        </Show>
      </div>
    </aside>
  );
}
