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
 * Ctrl/⌘ F (anywhere in the Files screen or its pane, components/FindBar onFindShortcuts): Monaco's own find widget
 * on the active file or diff (prefilled from the selection); in the plain view, the app's FindBar over the code.
 * A contents-search match (reveal with columns) selects exactly the matched text.
 *
 * Organic motion: a tab opened for a file the agent just created types its name in, a deleted file's tab sweeps
 * its name out before it closes, and the plain view's lines are EditedLines (removed lines sweep and collapse,
 * added lines wipe in). Monaco gets one minimal edit, so an agent edit only touches the text it changed.
 */
import { createEffect, createMemo, createSignal, For, getOwner, Index, on, onCleanup, onMount, runWithOwner, Show, untrack, type JSX } from 'solid-js';
import {
  createFindController,
  domFindSurface,
  findAll,
  FindBar,
  Icon,
  IconButton,
  Menu,
  onFindShortcuts,
  selectedFindText,
  type MenuEntry,
} from '../../components';
import { pressable, Presence, flipList } from '../../motion';
import { EditedLines, RetypeText } from '../../motion/organic';
import { feature, setFeature } from '../../store/features';
import { currentTheme } from '../../theme';
import { baseName, languageFor, openExternally, writeFile, type FileLineChanges } from './adapter';
import { FileDelta } from './FilesPanel';
import {
  activateTab,
  activePath,
  closeTab,
  createdRecently,
  deletingTabs,
  diffTabs,
  documents,
  editFor,
  isDiffKey,
  listingEdit,
  loadDocument,
  reveal,
  setDocuments,
  setDraft,
  setReveal,
  tabs,
  type OpenDocument,
} from './state';
import type { Monaco } from './monaco';
import type * as MonacoApi from 'monaco-editor';
import './files.css';

// ---------------------------------------------------------------------------------------------------------------
// Tabs

/** The file a tab is about: its own key for a file tab, the diffed file for a diff tab. */
function tabFilePath(key: string): string {
  return isDiffKey(key) ? (diffTabs[key]?.path ?? key.slice('diff:'.length)) : key;
}

/** `path` is the tab key: a file path, or `diff:<path>` for a review diff. */
function Tab(props: { path: string; closing: boolean; onClose: () => void; onExited: () => void }): JSX.Element {
  const active = () => activePath() === props.path;
  const diff = () => isDiffKey(props.path);
  const dirty = () => documents[props.path]?.draft !== undefined;
  const typeIn = untrack(() => !isDiffKey(props.path) && createdRecently(props.path));
  return (
    <div class="files-tab-slot" data-flip={props.path}>
      <Presence when={!props.closing} from={0.9} origin="center left" onExited={props.onExited}>
        <div
          class="files-tab"
          classList={{ active: active() }}
          role="tab"
          aria-selected={active()}
          title={diff() ? (diffTabs[props.path]?.title ?? tabFilePath(props.path)) : props.path}
          ref={element => pressable(element, 0.97)}
          onClick={() => activateTab(props.path)}
          onAuxClick={event => {
            if (event.button === 1) props.onClose();
          }}
        >
          <Icon name={diff() ? 'edit' : 'file'} size={14} class="files-tab-icon" />
          <span class="files-tab-name">
            <RetypeText
              value={baseName(tabFilePath(props.path))}
              typeOnMount={typeIn}
              deleting={!diff() && deletingTabs().includes(props.path)}
              onDeleted={props.onClose}
              data-motion="files-tab-name"
            />
          </span>
          <Show when={diff()}>
            <span class="files-tab-badge type-mono">diff</span>
          </Show>
          <Show when={dirty()}>
            <span class="files-tab-dirty" aria-label="Unsaved" />
          </Show>
          <button
            type="button"
            class="files-tab-close"
            aria-label={`Close ${baseName(tabFilePath(props.path))}${diff() ? ' diff' : ''}`}
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

type KeyedLine = PlainLine & { key: string };

/** Above this many cells (old × new changed lines) the middle of a change is re-keyed without matching. */
const lineMatchLimit = 1_000_000;

/**
 * Keeps line keys stable across content changes, so EditedLines only animates what changed: the shared head and
 * tail keep their keys and the middle is matched by text (longest common subsequence). A line that turns into a
 * removed diff row keeps its key too, so it stays in place and turns red instead of leaving and coming back.
 */
function createLineKeys(): (lines: PlainLine[]) => KeyedLine[] {
  let previous: KeyedLine[] = [];
  let counter = 0;
  const freshKey = () => {
    counter += 1;
    return `line-${counter}`;
  };
  return lines => {
    const keys = new Array<string | undefined>(lines.length);
    let head = 0;
    while (head < lines.length && head < previous.length && lines[head].text === previous[head].text) {
      keys[head] = previous[head].key;
      head += 1;
    }
    let tail = 0;
    while (
      tail < lines.length - head &&
      tail < previous.length - head &&
      lines[lines.length - 1 - tail].text === previous[previous.length - 1 - tail].text
    ) {
      keys[lines.length - 1 - tail] = previous[previous.length - 1 - tail].key;
      tail += 1;
    }
    const oldMiddle = previous.slice(head, previous.length - tail);
    const newMiddle = lines.slice(head, lines.length - tail);
    if (oldMiddle.length && newMiddle.length && oldMiddle.length * newMiddle.length <= lineMatchLimit) {
      const columns = newMiddle.length + 1;
      const common = new Uint32Array((oldMiddle.length + 1) * columns);
      for (let oldIndex = oldMiddle.length - 1; oldIndex >= 0; oldIndex -= 1) {
        for (let newIndex = newMiddle.length - 1; newIndex >= 0; newIndex -= 1) {
          common[oldIndex * columns + newIndex] =
            oldMiddle[oldIndex].text === newMiddle[newIndex].text
              ? common[(oldIndex + 1) * columns + newIndex + 1] + 1
              : Math.max(common[(oldIndex + 1) * columns + newIndex], common[oldIndex * columns + newIndex + 1]);
        }
      }
      let oldIndex = 0;
      let newIndex = 0;
      while (oldIndex < oldMiddle.length && newIndex < newMiddle.length) {
        if (oldMiddle[oldIndex].text === newMiddle[newIndex].text) {
          keys[head + newIndex] = oldMiddle[oldIndex].key;
          oldIndex += 1;
          newIndex += 1;
        } else if (common[(oldIndex + 1) * columns + newIndex] >= common[oldIndex * columns + newIndex + 1]) {
          oldIndex += 1;
        } else {
          newIndex += 1;
        }
      }
    }
    previous = lines.map((line, index) => ({ ...line, key: keys[index] ?? freshKey() }));
    return previous;
  };
}

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

/** `onRoot` receives the scrolling view (and undefined on unmount), for the plain view's FindBar. */
function PlainCode(props: { document: OpenDocument; onRoot?: (root: HTMLElement | undefined) => void }): JSX.Element {
  onCleanup(() => props.onRoot?.(undefined));
  return (
    <div
      ref={element => props.onRoot?.(element)}
      class="files-plain type-mono"
      role="textbox"
      aria-readonly="true"
      aria-label={props.document.path}
    >
      {/* Keyed by path: another file mounts fresh lines instead of animating one file into the other. */}
      <Show when={props.document.path} keyed>
        {path => <PlainLines document={props.document} path={path} />}
      </Show>
    </div>
  );
}

/** `path` only names which file these lines belong to; PlainCode remounts this when it changes. */
function PlainLines(props: { document: OpenDocument; path: string }): JSX.Element {
  const keyLines = createLineKeys();
  const lines = createMemo(() => keyLines(plainLines(props.document.draft ?? props.document.content, props.document.changes)));
  return (
    <>
      <EditedLines each={lines()} key={line => line.key} class="files-plain-lines" lineClass="files-plain-row">
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
      </EditedLines>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Monaco

/** Replaces only the span between the shared head and tail of the old and new text, as one edit. */
function replaceChangedText(model: MonacoApi.editor.ITextModel, next: string): void {
  const current = model.getValue();
  let head = 0;
  while (head < current.length && head < next.length && current[head] === next[head]) head += 1;
  let tail = 0;
  while (
    tail < current.length - head &&
    tail < next.length - head &&
    current[current.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1;
  }
  const start = model.getPositionAt(head);
  const end = model.getPositionAt(current.length - tail);
  model.applyEdits([
    {
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
      text: next.slice(head, next.length - tail),
    },
  ]);
}

/** Registers the mounted editor's find for Ctrl+F; returns the unregister. */
type RegisterFind = (find: () => void) => () => void;

/** Focuses the editor and opens Monaco's find widget (it prefills from the selection itself). */
function openMonacoFind(editor: MonacoApi.editor.ICodeEditor): void {
  editor.focus();
  void editor.getAction('actions.find')?.run();
}

function MonacoCode(props: { path: string; onSave: () => void; registerFind: RegisterFind }): JSX.Element {
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
    const codeEditor = editor;
    const unregisterFind = props.registerFind(() => openMonacoFind(codeEditor));

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
          // Monaco draws its own lines (EditedLines cannot drive them): one minimal edit keeps scroll and the
          // untouched lines in place, and the change tints mark what the agent changed.
          replaceChangedText(model, document.content);
        }
        show(path);
      });
      // A range the engine asked for (editorOpen): select and centre it once this file is shown, then clear it.
      createEffect(() => {
        const request = reveal();
        if (!request || request.path !== props.path || !editor || !monaco) return;
        const document = documents[request.path];
        if (!document || document.error) return;
        show(request.path);
        const model = editor.getModel();
        if (shownPath !== request.path || !model) return;
        const last = model.getLineCount();
        const start = Math.min(request.startLine, last);
        const end = Math.min(request.endLine, last);
        // With columns (a contents-search match) exactly the matched text, otherwise the whole lines.
        const exact = request.startColumn !== undefined && request.endColumn !== undefined;
        const range = exact
          ? new monaco.Range(start, request.startColumn!, end, request.endColumn!)
          : new monaco.Range(start, 1, end, model.getLineMaxColumn(end));
        editor.setSelection(range);
        editor.revealRangeInCenter(range, monaco.editor.ScrollType.Smooth);
        editor.focus();
        setReveal(undefined);
      });
      createEffect(() => editor?.updateOptions({ minimap: { enabled: feature<boolean>('editor.minimap') } }));
      createEffect(on(currentTheme, () => module.defineUnifyTheme(), { defer: true }));
      onCleanup(unregisterFind);
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
// Review diff (editorDiff)

/** Below this card width the diff is drawn inline instead of side by side (px). */
const sideBySideBreakpoint = 720;

/**
 * A read-only Monaco diff editor for diff tabs: base (left) against the agent's edit (right). One editor serves
 * every diff tab; each tab keeps its own pair of models (and scroll), disposed when the tab closes.
 */
function DiffCode(props: { tabKey: string; registerFind: RegisterFind }): JSX.Element {
  const [ready, setReady] = createSignal(false);
  const owner = getOwner();
  let host!: HTMLDivElement;
  let editor: MonacoApi.editor.IStandaloneDiffEditor | undefined;
  let disposed = false;
  const models = new Map<string, MonacoApi.editor.IDiffEditorModel>();
  const viewStates = new Map<string, MonacoApi.editor.IDiffEditorViewState | null>();
  let shownKey: string | undefined;

  onMount(async () => {
    const module = await import('./monaco');
    if (disposed) return;
    const monaco = module.prepareMonaco();
    const diffEditor = monaco.editor.createDiffEditor(host, {
      ...module.editorFont(),
      theme: 'unify',
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: sideBySideBreakpoint,
      enableSplitViewResizing: true,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      renderOverviewRuler: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 4,
      glyphMargin: false,
      folding: false,
      renderLineHighlight: 'none',
      stickyScroll: { enabled: false },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      guides: { indentation: false },
      smoothScrolling: true,
      fixedOverflowWidgets: true,
    });
    editor = diffEditor;
    const unregisterFind = props.registerFind(() => openMonacoFind(diffEditor.getModifiedEditor()));

    const createModel = (text: string, language: string) => {
      const model = monaco.editor.createModel(text, language);
      model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
      return model;
    };

    runWithOwner(owner, () => {
      createEffect(() => {
        const key = props.tabKey;
        const diff = diffTabs[key];
        if (!diff) return;
        const leftText = diff.leftText;
        const rightText = diff.rightText;
        let pair = models.get(key);
        if (!pair) {
          const language = languageFor(diff.path);
          pair = { original: createModel(leftText, language), modified: createModel(rightText, language) };
          models.set(key, pair);
        } else {
          // Re-opened with newer content: replace both sides in place.
          if (pair.original.getValue() !== leftText) pair.original.setValue(leftText);
          if (pair.modified.getValue() !== rightText) pair.modified.setValue(rightText);
        }
        if (shownKey !== key) {
          if (shownKey) viewStates.set(shownKey, diffEditor.saveViewState());
          diffEditor.setModel(pair);
          const saved = viewStates.get(key);
          if (saved) diffEditor.restoreViewState(saved);
          shownKey = key;
        }
      });
      createEffect(on(currentTheme, () => module.defineUnifyTheme(), { defer: true }));
      onCleanup(unregisterFind);
      // Drop models of closed diff tabs (detach first when it is the one on screen).
      createEffect(() => {
        const open = new Set(tabs());
        for (const [key, pair] of models) {
          if (open.has(key)) continue;
          if (shownKey === key) {
            diffEditor.setModel(null);
            shownKey = undefined;
          }
          pair.original.dispose();
          pair.modified.dispose();
          models.delete(key);
          viewStates.delete(key);
        }
      });
    });
    setReady(true);
  });

  onCleanup(() => {
    disposed = true;
    editor?.dispose();
    for (const pair of models.values()) {
      pair.original.dispose();
      pair.modified.dispose();
    }
  });

  return (
    <div class="files-code">
      <div ref={host} class="files-monaco" classList={{ ready: ready() }} />
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
  let editorSection: HTMLElement | undefined;

  const current = () => (activePath() ? documents[activePath()!] : undefined);
  /** The active diff tab, when the active tab is one. */
  const currentDiff = () => (isDiffKey(activePath()) ? diffTabs[activePath()!] : undefined);
  /** The file the active tab shows (a diff tab's diffed file). */
  const activeFile = () => (activePath() ? tabFilePath(activePath()!) : undefined);
  const segments = () => (activeFile() ?? '').split('/').filter(Boolean);
  const activeEdit = () => (activeFile() ? editFor(activeFile()!, listingEdit(activeFile()!) ?? documentEdit(current())) : undefined);
  const diffStatus = () => {
    const diff = currentDiff();
    if (!diff) return '';
    return diff.leftLabel && diff.rightLabel ? `${diff.leftLabel} ↔ ${diff.rightLabel}` : 'Review';
  };

  createEffect(() => {
    const path = activePath();
    if (path) void loadDocument(path);
  });

  createEffect(on(activePath, () => setStatus('')));

  // Find (Ctrl/⌘ F): Monaco's widget while an editor is mounted, the FindBar over the plain view otherwise.
  let editorFind: (() => void) | undefined;
  const registerFind: RegisterFind = find => {
    editorFind = find;
    return () => {
      if (editorFind === find) editorFind = undefined;
    };
  };
  const [plainRoot, setPlainRoot] = createSignal<HTMLElement>();
  const plainSurface = createMemo(() => {
    const root = plainRoot();
    return root ? domFindSurface(root, { textSelector: '.files-plain-text' }) : undefined;
  });
  const plainFind = createFindController({
    surface: plainSurface,
    content: () => current()?.draft ?? current()?.content,
  });

  onFindShortcuts({
    element: () => editorSection,
    screen: '.files-screen',
    onFind: () => {
      if (editorFind) editorFind();
      else if (plainSurface()) plainFind.show({ query: selectedFindText() });
    },
  });

  // The plain view has no selection of its own: a contents-search match opens its FindBar on that occurrence.
  createEffect(() => {
    const request = reveal();
    if (!request || feature<boolean>('editor.enabled') || request.startColumn === undefined || request.endColumn === undefined) return;
    if (activePath() !== request.path) return;
    const document = documents[request.path];
    if (!document || document.error) return;
    const lines = plainLines(document.draft ?? document.content, document.changes);
    const target = lines.find(line => line.kind === 'line' && line.number === request.startLine);
    const query = target?.text.slice(request.startColumn - 1, request.endColumn - 1);
    if (!target || !query) return;
    const caseSensitive = untrack(plainFind.caseSensitive);
    let index = 0;
    for (const line of lines) {
      if (line === target) {
        index += findAll(line.text.slice(0, request.startColumn - 1), query, caseSensitive).length;
        break;
      }
      index += findAll(line.text, query, caseSensitive).length;
    }
    setReveal(undefined);
    untrack(() => plainFind.show({ query, index }));
  });

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
    { id: 'external', label: 'Open in system editor', icon: 'pop', disabled: !activeFile() },
    { kind: 'separator' },
    { id: 'close-others', label: 'Close other tabs', disabled: tabs().length < 2 },
    { id: 'close-all', label: 'Close all tabs', disabled: !tabs().length },
  ];

  const onMenu = (id: string) => {
    const path = activePath();
    const file = activeFile();
    if (id === 'save') void save();
    if (id === 'revert') revert();
    if (id === 'external' && file) openExternally(file);
    if (id === 'close-others') for (const tab of tabs()) if (tab !== path) requestClose(tab);
    if (id === 'close-all') for (const tab of tabs()) requestClose(tab);
  };

  return (
    <section ref={editorSection} class="files-editor" aria-label="Editor">
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
              <Show when={status() || diffStatus() || current()?.draft !== undefined}>
                <span class="files-status">{status() || diffStatus() || 'Edited'}</span>
              </Show>
              <FileDelta edit={activeEdit()} />
            </div>
            {/* Diff tabs always use Monaco's diff editor (read-only); `editor.enabled` only affects file tabs. */}
            <Show
              when={!isDiffKey(path())}
              fallback={
                <Show when={currentDiff()}>
                  <DiffCode
                    tabKey={path()}
                    registerFind={registerFind}
                  />
                </Show>
              }
            >
              <Show
                when={current() && !current()!.error}
                fallback={
                  <Show when={current()?.error}>
                    <p class="files-error type-label">{current()!.error}</p>
                  </Show>
                }
              >
                <Show
                  when={feature<boolean>('editor.enabled')}
                  fallback={
                    <div class="files-code">
                      <PlainCode
                        document={current()!}
                        onRoot={setPlainRoot}
                      />
                      <FindBar controller={plainFind} />
                    </div>
                  }
                >
                  <MonacoCode
                    path={path()}
                    onSave={() => void save()}
                    registerFind={registerFind}
                  />
                </Show>
              </Show>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
