/** workspace, documents, edits, file watching and the virtual file system. */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { Disposable, EventEmitter } from './events';
import { WorkspaceConfiguration, onConfigurationUpdated } from './state';
import { Position, Range, RelativePattern, Selection, Uri } from './uri';

export { WorkspaceConfiguration };

export interface TextLine {
  lineNumber: number;
  text: string;
  range: Range;
}

export class TextDocument {
  public readonly fileName: string;
  public readonly uri: Uri;
  public readonly isUntitled = false;
  public isDirty = false;
  public readonly version = 1;
  public readonly eol = 1;
  private textValue: string;

  public constructor(uri: Uri, text: string) {
    this.uri = uri;
    this.fileName = uri.fsPath;
    this.textValue = text;
  }

  public get lineCount(): number {
    return this.textValue.split(/\r\n|\r|\n/).length;
  }

  public getText(range?: Range): string {
    if (!range) return this.textValue;
    return this.textValue.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }

  public positionAt(offset: number): Position {
    const bounded = Math.max(0, Math.min(offset, this.textValue.length));
    const before = this.textValue.slice(0, bounded);
    const lines = before.split(/\r\n|\r|\n/);
    return new Position(lines.length - 1, lines[lines.length - 1].length);
  }

  public offsetAt(position: Position): number {
    const lines = this.textValue.split(/(?<=\n)|(?<=\r)(?!\n)/);
    let offset = 0;
    for (let index = 0; index < position.line && index < lines.length; index += 1) offset += lines[index].length;
    return Math.min(offset + Math.max(0, position.character), this.textValue.length);
  }

  public lineAt(lineOrPosition: number | Position): TextLine {
    const lineNumber = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
    const lines = this.textValue.split(/\r\n|\r|\n/);
    const text = lines[Math.max(0, Math.min(lineNumber, lines.length - 1))] ?? '';
    return { lineNumber, text, range: new Range(lineNumber, 0, lineNumber, text.length) };
  }

  public async save(): Promise<boolean> {
    if (this.uri.scheme === 'file' && this.isDirty) {
      mkdirSync(dirname(this.uri.fsPath), { recursive: true });
      writeFileSync(this.uri.fsPath, this.textValue, 'utf8');
      this.isDirty = false;
    }
    return true;
  }

  public setText(text: string): void {
    this.textValue = text;
    this.isDirty = true;
  }

  /** Sets the text from disk without marking the document dirty. */
  public setDiskText(text: string): void {
    this.textValue = text;
    this.isDirty = false;
  }
}

interface EditOperation {
  kind: 'rename' | 'delete' | 'create' | 'insert' | 'replace';
  uri: Uri;
  target?: Uri;
  position?: Position;
  range?: Range;
  text?: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean; ignoreIfNotExists?: boolean };
}

export class WorkspaceEdit {
  public readonly operations: EditOperation[] = [];

  public insert(uri: Uri, position: Position, text: string): void {
    this.operations.push({ kind: 'insert', uri, position, text });
  }

  public replace(uri: Uri, range: Range, text: string): void {
    this.operations.push({ kind: 'replace', uri, range, text });
  }

  public deleteFile(uri: Uri, options?: EditOperation['options']): void {
    this.operations.push({ kind: 'delete', uri, options });
  }

  public createFile(uri: Uri, options?: EditOperation['options']): void {
    this.operations.push({ kind: 'create', uri, options });
  }

  public renameFile(source: Uri, target: Uri, options?: EditOperation['options']): void {
    this.operations.push({ kind: 'rename', uri: source, target, options });
  }
}

export interface WorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
}

const saveEvent = new EventEmitter<TextDocument>();
const willSaveEvent = new EventEmitter<{ document: TextDocument; reason?: number; waitUntil?(thenable: PromiseLike<unknown>): void }>();
const openDocuments: TextDocument[] = [];
const contentProviders = new Map<string, { provideTextDocumentContent(uri: Uri): string | PromiseLike<string> }>();
const fileWatchers = new Set<{ dispose(): void }>();
let workspaceFolders: WorkspaceFolder[] = [];
let trusted = true;

export function configureWorkspace(options: { projectPath?: string; workspaceMemento: unknown }): void {
  workspaceFolders = options.projectPath
    ? [{ uri: Uri.file(options.projectPath), name: basename(options.projectPath) || options.projectPath, index: 0 }]
    : [];
  trusted = true;
}

export function setWorkspaceFolders(paths: string[]): void {
  workspaceFolders = paths.map((path, index) => ({ uri: Uri.file(path), name: basename(path) || path, index }));
}

export function workspaceFolderPath(): string | undefined {
  return workspaceFolders[0]?.uri.fsPath;
}

export function getTextDocument(uri: Uri): TextDocument {
  const existing = openDocuments.find(document => document.uri.toString() === uri.toString());
  if (existing) return existing;
  let text = '';
  if (uri.scheme === 'file') {
    try { text = readFileSync(uri.fsPath, 'utf8'); } catch { text = ''; }
  } else {
    const provider = contentProviders.get(uri.scheme);
    if (provider) {
      const content = provider.provideTextDocumentContent(uri);
      text = typeof content === 'string' ? content : '';
    }
  }
  const document = new TextDocument(uri, text);
  openDocuments.push(document);
  return document;
}

export async function openTextDocument(uriOrPath: Uri | string): Promise<TextDocument> {
  return getTextDocument(typeof uriOrPath === 'string' ? Uri.file(uriOrPath) : uriOrPath);
}

function globToRegExp(glob: string): RegExp {
  let pattern = glob.replace(/\\/g, '/');
  if (pattern.startsWith('**/')) pattern = pattern.slice(3);
  if (pattern.startsWith('./')) pattern = pattern.slice(2);
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\{([^}]+)\}/g, (_match, group: string) => `(?:${group.split(',').join('|')})`)
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${body}$`, 'i');
}

const DEFAULT_EXCLUDES = ['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '.next', '.turbo', '.npm-cache'];

function walkFiles(base: string, maxResults: number, excluded: Set<string>, results: string[]): void {
  if (results.length >= maxResults) return;
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (results.length >= maxResults) return;
    const full = join(base, entry.name);
    if (entry.isDirectory()) {
      if (excluded.has(entry.name)) continue;
      walkFiles(full, maxResults, excluded, results);
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
}

/** Implements the subset of workspace.findFiles the engine uses (`**` include plus a brace exclude). */
export async function findFiles(include: string | RelativePattern, exclude?: string | null, maxResults = 2000): Promise<Uri[]> {
  const base = typeof include === 'string' ? workspaceFolderPath() : include.base;
  const pattern = typeof include === 'string' ? include : include.pattern;
  if (!base) return [];
  const excluded = new Set(DEFAULT_EXCLUDES);
  if (typeof exclude === 'string') {
    const names = exclude.match(/\{([^}]+)\}/);
    if (names) for (const name of names[1].split(',')) excluded.add(name.trim());
  }
  const paths: string[] = [];
  walkFiles(base, maxResults, excluded, paths);
  const matcher = globToRegExp(pattern);
  return paths
    .map(path => relative(base, path).replace(/\\/g, '/'))
    .filter(path => matcher.test(path))
    .slice(0, maxResults)
    .map(path => Uri.file(join(base, path)));
}

export interface FileSystemWatcherLike extends Disposable {
  onDidCreate(listener: (uri: Uri) => void): Disposable;
  onDidChange(listener: (uri: Uri) => void): Disposable;
  onDidDelete(listener: (uri: Uri) => void): Disposable;
}

function createWatcher(pattern: string | RelativePattern): FileSystemWatcherLike {
  const base = typeof pattern === 'string' ? workspaceFolderPath() : pattern.base;
  const glob = typeof pattern === 'string' ? pattern : pattern.pattern;
  const created = new EventEmitter<Uri>();
  const changed = new EventEmitter<Uri>();
  const deleted = new EventEmitter<Uri>();
  let watcher: ReturnType<typeof watch> | undefined;
  let timer: NodeJS.Timeout | undefined;
  if (base && existsSync(base)) {
    try {
      const matcher = globToRegExp(glob);
      watcher = watch(base, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, '/');
        if (!matcher.test(rel)) return;
        // A save often produces several events; one debounce keeps the sync calm.
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const uri = Uri.file(join(base, rel));
          if (eventType === 'rename') {
            if (existsSync(uri.fsPath)) created.fire(uri); else deleted.fire(uri);
          } else {
            changed.fire(uri);
          }
        }, 150);
      });
      watcher.on('error', () => undefined);
    } catch {
      watcher = undefined;
    }
  }
  const subscription = {
    onDidCreate: created.event,
    onDidChange: changed.event,
    onDidDelete: deleted.event,
    dispose(): void {
      if (timer) clearTimeout(timer);
      watcher?.close();
      created.dispose();
      changed.dispose();
      deleted.dispose();
      fileWatchers.delete(subscription);
    },
  };
  fileWatchers.add(subscription);
  return subscription;
}

const configChanged = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();
export const onDidChangeConfiguration = configChanged.event;

/** Fires the engine's configuration listener after an external settings change. */
export function fireConfigurationChanged(changedKeys: string[]): void {
  configChanged.fire({
    affectsConfiguration: (section: string) => changedKeys.some(key => key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`)),
  });
}

// Writes through workspace.getConfiguration().update() reach the same listener
// the engine registered for VS Code's settings editor.
onConfigurationUpdated(key => fireConfigurationChanged([key]));

export async function applyEdit(edit: WorkspaceEdit): Promise<boolean> {
  try {
    const buffers = new Map<string, string>();
    const deleted = new Set<string>();
    const read = (uri: Uri): string => {
      const key = uri.fsPath;
      if (buffers.has(key)) return buffers.get(key)!;
      if (deleted.has(key)) return '';
      try { return readFileSync(key, 'utf8'); } catch { return ''; }
    };
    const write = (uri: Uri, text: string): void => {
      buffers.set(uri.fsPath, text);
      deleted.delete(uri.fsPath);
      const document = openDocuments.find(item => item.uri.toString() === uri.toString());
      if (document) { document.setText(text); document.isDirty = false; }
    };

    for (const operation of edit.operations) {
      const path = operation.uri.fsPath;
      if (operation.kind === 'rename' && operation.target) {
        const target = operation.target.fsPath;
        if (existsSync(target) && !operation.options?.overwrite) return false;
        mkdirSync(dirname(target), { recursive: true });
        renameSync(path, target);
      } else if (operation.kind === 'delete') {
        if (existsSync(path)) rmSync(path, { force: true });
        else if (operation.options?.ignoreIfNotExists === false) return false;
        deleted.add(path);
      } else if (operation.kind === 'create') {
        if (existsSync(path) && !operation.options?.ignoreIfExists) return false;
        write(operation.uri, read(operation.uri));
      } else if (operation.kind === 'insert') {
        const text = read(operation.uri);
        const offset = new TextDocument(operation.uri, text).offsetAt(operation.position!);
        write(operation.uri, text.slice(0, offset) + (operation.text ?? '') + text.slice(offset));
      } else if (operation.kind === 'replace') {
        const text = read(operation.uri);
        const document = new TextDocument(operation.uri, text);
        const start = document.offsetAt(operation.range!.start);
        const end = document.offsetAt(operation.range!.end);
        write(operation.uri, text.slice(0, start) + (operation.text ?? '') + text.slice(end));
      }
    }

    for (const [path, text] of buffers) {
      const document = openDocuments.find(item => item.uri.fsPath.toLowerCase() === path.toLowerCase()) ?? new TextDocument(Uri.file(path), text);
      willSaveEvent.fire({ document });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, 'utf8');
      document.isDirty = false;
      saveEvent.fire(document);
    }
    return true;
  } catch {
    return false;
  }
}

export function saveTextDocument(document: TextDocument): void {
  willSaveEvent.fire({ document });
  void document.save().then(() => saveEvent.fire(document));
}

export function fileSystem() {
  return {
    async readFile(uri: Uri): Promise<Uint8Array> { return readFileSync(uri.fsPath); },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      mkdirSync(dirname(uri.fsPath), { recursive: true });
      writeFileSync(uri.fsPath, content);
    },
    async createDirectory(uri: Uri): Promise<void> { mkdirSync(uri.fsPath, { recursive: true }); },
    async delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
      rmSync(uri.fsPath, { recursive: !!options?.recursive, force: true });
    },
    async rename(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> {
      if (existsSync(target.fsPath) && !options?.overwrite) throw new Error('Target exists');
      mkdirSync(dirname(target.fsPath), { recursive: true });
      renameSync(source.fsPath, target.fsPath);
    },
    async copy(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> {
      if (existsSync(target.fsPath) && !options?.overwrite) throw new Error('Target exists');
      mkdirSync(dirname(target.fsPath), { recursive: true });
      writeFileSync(target.fsPath, readFileSync(source.fsPath));
    },
    async stat(uri: Uri): Promise<{ type: number; ctime: number; mtime: number; size: number }> {
      const info = statSync(uri.fsPath);
      return { type: info.isDirectory() ? 2 : 1, ctime: info.ctimeMs, mtime: info.mtimeMs, size: info.size };
    },
    async readDirectory(uri: Uri): Promise<[string, number][]> {
      return readdirSync(uri.fsPath, { withFileTypes: true }).map(entry => [entry.name, entry.isDirectory() ? 2 : 1] as [string, number]);
    },
  };
}

export function textDocuments(): TextDocument[] {
  return openDocuments;
}

export function registerTextDocumentContentProvider(scheme: string, provider: { provideTextDocumentContent(uri: Uri): string | PromiseLike<string> }): Disposable {
  contentProviders.set(scheme, provider);
  return new Disposable(() => {
    if (contentProviders.get(scheme) === provider) contentProviders.delete(scheme);
  });
}

export function createTextEditor(document: TextDocument) {
  return {
    document,
    selection: new Selection(new Position(0, 0), new Position(0, 0)),
    selections: [new Selection(new Position(0, 0), new Position(0, 0))],
    revealRange(): void { /* No editor viewport in the shell yet. */ },
    async edit(): Promise<boolean> { return true; },
  };
}

export const workspace = {
  get workspaceFolders(): WorkspaceFolder[] | undefined { return workspaceFolders.length ? workspaceFolders : undefined; },
  get isTrusted(): boolean { return trusted; },
  get textDocuments(): TextDocument[] { return openDocuments; },
  getConfiguration(section?: string): WorkspaceConfiguration { return new WorkspaceConfiguration(section); },
  onDidChangeConfiguration: configChanged.event,
  onWillSaveTextDocument: willSaveEvent.event,
  onDidSaveTextDocument: saveEvent.event,
  onDidOpenTextDocument: new EventEmitter<TextDocument>().event,
  onDidCloseTextDocument: new EventEmitter<TextDocument>().event,
  onDidChangeWorkspaceFolders: new EventEmitter<unknown>().event,
  openTextDocument,
  applyEdit,
  findFiles,
  createFileSystemWatcher: createWatcher,
  registerTextDocumentContentProvider,
  fs: fileSystem(),
  asRelativePath(value: Uri | string): string {
    const path = value instanceof Uri ? value.fsPath : value;
    const root = workspaceFolderPath();
    return root ? relative(root, path).replace(/\\/g, '/') : path;
  },
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
    return workspaceFolders.find(folder => !relative(folder.uri.fsPath, uri.fsPath).startsWith('..'));
  },
};

export function setWorkspaceTrusted(value: boolean): void {
  trusted = value;
}
