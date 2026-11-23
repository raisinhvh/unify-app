/**
 * The editor card of the Files screen (Figma 20 · Files + Editor 306:1623, middle column).
 *
 *   tabs         open files; the active tab is raised with a close ×; unsaved files get a dot
 *   breadcrumb   the path, last segment brighter; save state and the file's delta on the right
 *   code         Monaco, themed from the CSS variables (./monaco.ts), 12/18 code font. Agent-changed lines
 *                are tinted: added lines green with "+", removed lines shown in red above where they were.
 *
 * Feature `editor.enabled` off: a plain read-only code view replaces Monaco (same metrics, same tints).
 * Feature `editor.minimap` toggles the minimap live. Ctrl/⌘ S saves through the adapter.
 */
import { createEffect, createSignal, For, getOwner, Index, on, onCleanup, onMount, runWithOwner, Show, type JSX } from 'solid-js';
import { Icon, IconButton, Menu, type MenuEntry } from '../../components';
import { pressable, Presence, flipList } from '../../motion';
import { feature, setFeature } from '../../store/features';
import { currentTheme } from '../../theme';
import { baseName, openExternally, writeFile, type FileLineChanges } from './adapter';
import { FileDelta } from './FilesPanel';
import { activateTab, activePath, closeTab, documents, editFor, listingEdit, loadDocument, setDocuments, setDraft, tabs, type OpenDocument } from './state';
import type { Monaco } from './monaco';
import type * as MonacoApi from 'monaco-editor';
import './files.css';

// ---------------------------------------------------------------------------------------------------------------
// Tabs

function Tab(props: { path: string; closing: boolean; onClose: () => void; onExited: () => void }): JSX.Element {
  const active = () => activePath() === props.path;
  const dirty = () => documents[props.path]?.draft !== undefined;
  // organic: a tab the agent opens for a new file should type its name in.
  return (
    <div class="files-tab-slot" data-flip={props.path}>
      <Presence when={!props.closing} from={0.9} origin="center left" onExited={props.onExited}>
        <div
          class="files-tab"
          classList={{ active: active() }}
          role="tab"
          aria-selected={active()}
          title={props.path}
          ref={element => pressable(element, 0.97)}
          onClick={() => activateTab(props.path)}
          onAuxClick={event => {
            if (event.button === 1) props.onClose();
          }}
        >
          <Icon name="file" size={14} class="files-tab-icon" />
          <span class="files-tab-name">{baseName(props.path)}</span>
          <Show when={dirty()}>
            <span class="files-tab-dirty" aria-label="Unsaved" />
          </Show>
          <button
            type="button"
            class="files-tab-close"
            aria-label={`Close ${baseName(props.path)}`}
            onClick={event => {
              event.stopPropagation();
              props.onClose();
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      </Presence>
    </div>
  );
}

/** Counts from the document's own changed lines, when the listing has none. */
function documentEdit(document: OpenDocument | undefined) {
  const changes = document?.changes;
  if (!changes) return undefined;
  return {
    additions: changes.added.length,
    deletions: changes.removed.reduce((total, block) => total + block.lines.length, 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Plain code view (editor off, or while Monaco loads)

type PlainLine = { kind: 'line'; number: number; text: string; added: boolean } | { kind: 'removed'; text: string };

function plainLines(content: string, changes: FileLineChanges | undefined): PlainLine[] {
  const added = new Set(changes?.added ?? []);
  const removedAfter = new Map<number, string[]>();
  for (const block of changes?.removed ?? []) removedAfter.set(block.afterLine, [...(removedAfter.get(block.afterLine) ?? []), ...block.lines]);
  const lines = content.replace(/\n$/, '').split('\n');
  const result: PlainLine[] = [];
  const pushRemoved = (after: number) => {
    for (const text of removedAfter.get(after) ?? []) result.push({ kind: 'removed', text });
  };
  pushRemoved(0);
  lines.forEach((text, index) => {
    result.push({ kind: 'line', number: index + 1, text, added: added.has(index + 1) });
    pushRemoved(index + 1);
  });
  return result;
}

function PlainCode(props: { document: OpenDocument }): JSX.Element {
  const lines = () => plainLines(props.document.draft ?? props.document.content, props.document.changes);
  return (
    <div class="files-plain type-mono" role="textbox" aria-readonly="true" aria-label={props.document.path}>
      <Index each={lines()}>
        {line => (
          <div
            class="files-plain-line"
            classList={{
              added: line().kind === 'line' && (line() as Extract<PlainLine, { kind: 'line' }>).added,
              removed: line().kind === 'removed',
            }}
          >
            <span class="files-plain-number">{line().kind === 'line' ? (line() as Extract<PlainLine, { kind: 'line' }>).number : ''}</span>
            <span class="files-plain-mark">
              {line().kind === 'removed' ? '-' : (line() as Extract<PlainLine, { kind: 'line' }>).added ? '+' : ''}
            </span>
            <span class="files-plain-text">{line().text}</span>
          </div>
        )}
      </Index>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Monaco

function MonacoCode(props: { path: string; onSave: () => void }): JSX.Element {
  const [ready, setReady] = createSignal(false);
  const owner = getOwner();
  let host!: HTMLDivElement;
  let editor: MonacoApi.editor.IStandaloneCodeEditor | undefined;
  let monaco: Monaco | undefined;
  let disposed = false;
  const models = new Map<string, MonacoApi.editor.ITextModel>();
  const viewStates = new Map<string, MonacoApi.editor.ICodeEditorViewState | null>();
  let decorations: MonacoApi.editor.IEditorDecorationsCollection | undefined;
  let zoneIds: string[] = [];
  let shownPath: string | undefined;

  const applyChanges = (changes: FileLineChanges | undefined) => {
    if (!editor || !monaco) return;
    const api = monaco;
    decorations?.set(
      (changes?.added ?? []).map(line => ({
        range: new api.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: 'files-line-add',
          marginClassName: 'files-margin-add',
          linesDecorationsClassName: 'files-mark-add',
        },
      })),
    );
    editor.changeViewZones(accessor => {
      for (const id of zoneIds) accessor.removeZone(id);
      zoneIds = (changes?.removed ?? []).map(block => {
        const content = document.createElement('div');
        content.className = 'files-zone-removed';
        const margin = document.createElement('div');
        margin.className = 'files-zone-removed-margin';
        for (const text of block.lines) {
          const line = document.createElement('div');
          line.textContent = text;
          content.append(line);
          const mark = document.createElement('div');
          mark.textContent = '-';
          margin.append(mark);
        }
        return accessor.addZone({ afterLineNumber: block.afterLine, heightInLines: block.lines.length, domNode: content, marginDomNode: margin });
      });
    });
  };

  const show = (path: string) => {
    if (!editor || !monaco) return;
    const document = documents[path];
    if (!document || document.error) return;
    let model = models.get(path);
    if (!model) {
      model = monaco.editor.createModel(document.draft ?? document.content, document.language, monaco.Uri.parse(`file:///${path}`));
      model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
      models.set(path, model);
      model.onDidChangeContent(() => setDraft(path, model!.getValue()));
    }
    if (shownPath !== path) {
      if (shownPath) viewStates.set(shownPath, editor.saveViewState());
      editor.setModel(model);
      const saved = viewStates.get(path);
      if (saved) editor.restoreViewState(saved);
      shownPath = path;
    }
    applyChanges(document.changes);
  };

  onMount(async () => {
    const module = await import('./monaco');
    if (disposed) return;
    monaco = module.prepareMonaco();
    editor = monaco.editor.create(host, {
      ...module.editorFont(),
      theme: 'unify',
      automaticLayout: true,
      minimap: { enabled: feature<boolean>('editor.minimap'), renderCharacters: false, scale: 1 },
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 4,
      lineDecorationsWidth: 16,
      glyphMargin: false,
      folding: false,
      renderLineHighlight: 'line',
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      stickyScroll: { enabled: false },
      padding: { top: 8, bottom: 8 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      guides: { indentation: false },
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      cursorBlinking: 'smooth',
      fixedOverflowWidgets: true,
    });
    decorations = editor.createDecorationsCollection();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => props.onSave());

    runWithOwner(owner, () => {
      createEffect(() => {
        const path = props.path;
        const document = documents[path];
        if (!document) return;
        // Track the fields that should re-render: a reload (content/version) and the agent's changed lines.
        void document.version;
        void document.changes;
        const model = models.get(path);
        if (model && document.draft === undefined && model.getValue() !== document.content) {
          // organic: an agent edit landing on an open file should sweep removed lines out and wipe added ones in.
          model.setValue(document.content);
        }
        show(path);
      });
      createEffect(() => editor?.updateOptions({ minimap: { enabled: feature<boolean>('editor.minimap') } }));
      createEffect(on(currentTheme, () => module.defineUnifyTheme(), { defer: true }));
      // Drop models of closed tabs.
      createEffect(() => {
        const open = new Set(tabs());
        for (const [path, model] of models) {
          if (!open.has(path)) {
            model.dispose();
            models.delete(path);
            viewStates.delete(path);
          }
        }
      });
    });
    setReady(true);
  });

  onCleanup(() => {
    disposed = true;
    editor?.dispose();
    for (const model of models.values()) model.dispose();
  });

  return (
    <div class="files-code">
      <div ref={host} class="files-monaco" classList={{ ready: ready() }} />
      <Show when={!ready() && documents[props.path]}>
        {document => <PlainCode document={document()} />}
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Editor card

export function FilesEditor(): JSX.Element {
  const [closing, setClosing] = createSignal<string[]>([]);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [status, setStatus] = createSignal<string>('');
  let moreButton: HTMLButtonElement | undefined;

  const current = () => (activePath() ? documents[activePath()!] : undefined);
  const segments = () => (activePath() ?? '').split('/').filter(Boolean);
  const activeEdit = () => (activePath() ? editFor(activePath()!, listingEdit(activePath()!) ?? documentEdit(current())) : undefined);

  createEffect(() => {
    const path = activePath();
    if (path) void loadDocument(path);
  });

  createEffect(on(activePath, () => setStatus('')));

  const requestClose = (path: string) => {
    if (!closing().includes(path)) setClosing([...closing(), path]);
  };

  const finishClose = (path: string) => {
    setClosing(closing().filter(item => item !== path));
    closeTab(path);
  };

  const save = async () => {
    const path = activePath();
    const document = path ? documents[path] : undefined;
    if (!path || !document || document.draft === undefined) return;
    const text = document.draft;
    setStatus('Saving');
    const result = await writeFile(path, text, document.version);
    if (result.ok) {
      setDocuments(path, { content: text, draft: undefined, version: result.version, changes: undefined });
      setStatus('Saved');
    } else if (result.reason === 'conflict') {
      setStatus('Changed on disk');
    } else {
      setStatus(result.message);
    }
  };

  const revert = () => {
    const path = activePath();
    if (!path) return;
    void loadDocument(path, true);
    setStatus('');
  };

  const menuItems = (): MenuEntry[] => [
    { id: 'save', label: 'Save', hint: 'Ctrl S', disabled: current()?.draft === undefined },
    { id: 'revert', label: 'Revert changes', disabled: current()?.draft === undefined },
    { kind: 'separator' },
    { id: 'external', label: 'Open in system editor', icon: 'pop', disabled: !activePath() },
    { kind: 'separator' },
    { id: 'close-others', label: 'Close other tabs', disabled: tabs().length < 2 },
    { id: 'close-all', label: 'Close all tabs', disabled: !tabs().length },
  ];

  const onMenu = (id: string) => {
    const path = activePath();
    if (id === 'save') void save();
    if (id === 'revert') revert();
    if (id === 'external' && path) openExternally(path);
    if (id === 'close-others') for (const tab of tabs()) if (tab !== path) requestClose(tab);
    if (id === 'close-all') for (const tab of tabs()) requestClose(tab);
  };

  return (
    <section class="files-editor" aria-label="Editor">
      <header class="files-tabs-row">
        <div class="files-tabs" role="tablist" ref={element => flipList(element)}>
          <For each={tabs()}>
            {path => (
              <Tab
                path={path}
                closing={closing().includes(path)}
                onClose={() => requestClose(path)}
                onExited={() => finishClose(path)}
              />
            )}
          </For>
        </div>
        <div class="files-tabs-actions">
          <IconButton
            icon="layout"
            label={feature<boolean>('editor.minimap') ? 'Hide minimap' : 'Show minimap'}
            active={feature<boolean>('editor.minimap')}
            disabled={!feature<boolean>('editor.enabled')}
            onClick={() => setFeature('editor.minimap', !feature<boolean>('editor.minimap'))}
          />
          <IconButton ref={moreButton} icon="more" label="More" active={menuOpen()} onClick={() => setMenuOpen(!menuOpen())} />
        </div>
      </header>
      <Menu anchor={moreButton} open={menuOpen()} onClose={() => setMenuOpen(false)} onSelect={onMenu} items={menuItems()} placement="bottom-end" />

      <Show
        when={activePath()}
        fallback={
          <div class="files-empty-editor">
            <Icon name="files" size={20} />
            <p class="type-label">Open a file from the tree</p>
          </div>
        }
      >
        {path => (
          <>
            <div class="files-breadcrumb type-caption">
              <span class="files-crumbs">
                <Index each={segments()}>
                  {(segment, index) => (
                    <>
                      <Show when={index > 0}>
                        <span class="files-crumb-sep">/</span>
                      </Show>
                      <span class="files-crumb" classList={{ last: index === segments().length - 1 }}>{segment()}</span>
                    </>
                  )}
                </Index>
              </span>
              <Show when={status() || current()?.draft !== undefined}>
                <span class="files-status">{status() || 'Edited'}</span>
              </Show>
              <FileDelta edit={activeEdit()} />
            </div>
            <Show
              when={current() && !current()!.error}
              fallback={
                <Show when={current()?.error}>
                  <p class="files-error type-label">{current()!.error}</p>
                </Show>
              }
            >
              <Show when={feature<boolean>('editor.enabled')} fallback={<div class="files-code"><PlainCode document={current()!} /></div>}>
                <MonacoCode path={path()} onSave={() => void save()} />
              </Show>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
