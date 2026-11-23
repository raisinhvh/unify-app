/**
 * Editor bridge.
 *
 * The renderer's Files editor owns what is open. It posts `editorState`, and
 * this module mirrors it into the VS Code window API the engine reads:
 * `window.activeTextEditor`, `window.visibleTextEditors`, `window.tabGroups`
 * and the change events. Documents read their text from disk when asked, so an
 * agent's editor context always sees the current file.
 *
 * Protocol positions are 1-based (Monaco's convention, like `openFile`);
 * VS Code objects are 0-based, so the conversion lives here.
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { EventEmitter } from './events';
import { Position, Range, Selection, Uri } from './uri';
import { TextDocument } from './workspace';

export interface EditorStateSelection {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface EditorStateMessage {
  type: 'editorState';
  active: {
    path: string;
    line?: number;
    column?: number;
    selection?: EditorStateSelection;
  } | null;
  open: string[];
  dirty?: string[];
}

export class TabInputText {
  public constructor(public readonly uri: Uri) {}
}

export interface TextEditorLike {
  document: TextDocument;
  selection: Selection;
  selections: Selection[];
  revealRange(range: Range, revealType?: number): void;
  edit(callback: (edit: unknown) => void): Promise<boolean>;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.css': 'css',
  '.go': 'go',
  '.h': 'c',
  '.hpp': 'cpp',
  '.htm': 'html',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'javascriptreact',
  '.md': 'markdown',
  '.mjs': 'javascript',
  '.php': 'php',
  '.ps1': 'powershell',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.scss': 'scss',
  '.sh': 'shellscript',
  '.sql': 'sql',
  '.svg': 'xml',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.vue': 'vue',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

/** A document whose text follows the file on disk. */
export class EditorTextDocument extends TextDocument {
  public readonly languageId: string;

  public constructor(uri: Uri, languageId: string) {
    super(uri, readFromDisk(uri.fsPath));
    this.languageId = languageId;
  }

  public override get lineCount(): number {
    this.reloadFromDisk();
    return super.lineCount;
  }

  public override getText(range?: Range): string {
    this.reloadFromDisk();
    return super.getText(range);
  }

  public reloadFromDisk(): void {
    this.setDiskText(readFromDisk(this.uri.fsPath));
  }
}

function readFromDisk(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function languageIdFor(path: string): string {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] || 'plaintext';
}

const documents = new Map<string, EditorTextDocument>();
const editors = new Map<string, TextEditorLike>();
const dirtyPaths = new Set<string>();
let openPaths: string[] = [];
let activePath: string | undefined;
let activeEditor: TextEditorLike | undefined;

const activeChanged = new EventEmitter<TextEditorLike | undefined>();
const visibleChanged = new EventEmitter<TextEditorLike[]>();
const selectionChanged = new EventEmitter<{ textEditor: TextEditorLike; selections: Selection[]; kind?: number }>();

export const onDidChangeActiveTextEditor = activeChanged.event;
export const onDidChangeVisibleTextEditors = visibleChanged.event;
export const onDidChangeTextEditorSelection = selectionChanged.event;

function documentFor(path: string): EditorTextDocument {
  const key = path.toLowerCase();
  let document = documents.get(key);
  if (!document) {
    const uri = Uri.file(path);
    document = new EditorTextDocument(uri, languageIdFor(path));
    documents.set(key, document);
  }
  document.isDirty = dirtyPaths.has(path.toLowerCase());
  return document;
}

function emptySelection(): Selection {
  return new Selection(new Position(0, 0), new Position(0, 0));
}

function selectionFrom(state: EditorStateMessage['active']): Selection {
  if (!state) return emptySelection();
  const cursor = new Position(Math.max(0, (state.line ?? 1) - 1), Math.max(0, (state.column ?? 1) - 1));
  if (!state.selection) return new Selection(cursor, cursor);
  const start = new Position(Math.max(0, state.selection.startLine - 1), Math.max(0, state.selection.startColumn - 1));
  const end = new Position(Math.max(0, state.selection.endLine - 1), Math.max(0, state.selection.endColumn - 1));
  return new Selection(start, end);
}

function editorFor(path: string, selection?: Selection): TextEditorLike {
  const key = path.toLowerCase();
  let editor = editors.get(key);
  if (!editor) {
    const document = documentFor(path);
    editor = {
      document,
      selection: emptySelection(),
      selections: [emptySelection()],
      revealRange(): void {
        // The Files editor has no way to scroll yet; opening is enough.
      },
      async edit(): Promise<boolean> {
        return true;
      },
    };
    editors.set(key, editor);
  } else {
    editor.document = documentFor(path);
  }
  if (selection) {
    editor.selection = selection;
    editor.selections = [selection];
  }
  return editor;
}

/** Creates an editor for a document the engine opened itself (`showTextDocument`). */
export function createEditor(document: TextDocument, selection?: Selection): TextEditorLike {
  const editor = editorFor(document.uri.fsPath, selection);
  editor.document = document;
  return editor;
}

export function activeTextEditor(): TextEditorLike | undefined {
  return activeEditor;
}

export function visibleTextEditors(): TextEditorLike[] {
  return openPaths.map(path => editorFor(path));
}

export function tabGroups(): { all: { tabs: { input: TabInputText }[] }[] } {
  if (!openPaths.length) return { all: [] };
  return { all: [{ tabs: openPaths.map(path => ({ input: new TabInputText(Uri.file(path)) })) }] };
}

/**
 * Applies the latest renderer state. Called from the shim's message bridge, so
 * engine message handlers never need to know the editor exists.
 */
export function applyEditorState(message: EditorStateMessage): void {
  if (!message || typeof message !== 'object') return;
  const open = Array.isArray(message.open) ? message.open.filter(path => typeof path === 'string' && path) : [];
  const dirty = Array.isArray(message.dirty) ? message.dirty.filter(path => typeof path === 'string' && path) : [];
  const previousOpen = openPaths;
  const previousActive = activePath;
  const previousSelection = activeEditor ? serialiseSelection(activeEditor.selection) : '';

  openPaths = open;
  dirtyPaths.clear();
  for (const path of dirty) dirtyPaths.add(path.toLowerCase());
  for (const document of documents.values()) document.isDirty = dirtyPaths.has(document.uri.fsPath.toLowerCase());

  const nextSelection = selectionFrom(message.active);
  if (message.active?.path) {
    activePath = message.active.path;
    // The active file is visible even if the renderer forgot to list it.
    if (!openPaths.some(path => path.toLowerCase() === activePath!.toLowerCase())) openPaths = [message.active.path, ...openPaths];
    const editor = editorFor(message.active.path, nextSelection);
    activeEditor = editor;
  } else {
    activePath = undefined;
    activeEditor = undefined;
  }

  const openKey = previousOpen.join('\u0000');
  const nextKey = openPaths.join('\u0000');
  if (previousActive !== activePath) activeChanged.fire(activeEditor);
  if (openKey !== nextKey) visibleChanged.fire(visibleTextEditors());
  if (activeEditor && (previousActive !== activePath || previousSelection !== serialiseSelection(activeEditor.selection))) {
    selectionChanged.fire({ textEditor: activeEditor, selections: activeEditor.selections });
  }
}

function serialiseSelection(selection: Selection): string {
  return `${selection.start.line}:${selection.start.character}:${selection.end.line}:${selection.end.character}`;
}

/** Test/debug helper: the state the shim currently mirrors. */
export function editorSnapshot(): { active?: string; open: string[]; dirty: string[] } {
  return { active: activePath, open: [...openPaths], dirty: [...dirtyPaths] };
}
