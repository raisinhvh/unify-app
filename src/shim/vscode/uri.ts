/** URI and text geometry types used by the engine. */
import { normalize, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export class Uri {
  public readonly scheme: string;
  public readonly authority: string;
  public readonly path: string;
  public readonly query: string;
  public readonly fragment: string;

  private constructor(scheme: string, authority: string, path: string, query = '', fragment = '') {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  public static file(path: string): Uri {
    const absolute = resolve(path);
    // VS Code exposes a leading slash and forward slashes on Windows: /c:/folder/file.
    const normalized = absolute.split(sep).join('/');
    return new Uri('file', '', normalized.startsWith('/') ? normalized : `/${normalized}`);
  }

  public static parse(value: string): Uri {
    try {
      const url = new URL(value);
      return new Uri(url.protocol.replace(/:$/, ''), url.host, decodeURIComponent(url.pathname), url.search.replace(/^\?/, ''), url.hash.replace(/^#/, ''));
    } catch {
      return Uri.file(value);
    }
  }

  public static joinPath(base: Uri, ...segments: string[]): Uri {
    const parts = [base.path.replace(/\/+$/, ''), ...segments.map(segment => segment.replace(/^\/+|\/+$/g, ''))];
    const joined = parts.filter(Boolean).join('/');
    if (base.scheme === 'file') {
      const platformPath = process.platform === 'win32' ? joined.replace(/^\/([A-Za-z]:)/, '$1') : joined;
      return Uri.file(platformPath);
    }
    return new Uri(base.scheme, base.authority, joined.startsWith('/') ? joined : `/${joined}`, base.query, base.fragment);
  }

  public get fsPath(): string {
    if (this.scheme !== 'file') return this.path;
    if (process.platform === 'win32') return this.path.replace(/^\//, '').replace(/\//g, '\\');
    return this.path;
  }

  public with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path, change.query ?? this.query, change.fragment ?? this.fragment);
  }

  public toString(): string {
    const suffix = `${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
    if (this.scheme === 'file') {
      // A double slash keeps the drive letter intact: file:///c:/folder.
      return `file://${this.path}${suffix}`;
    }
    return `${this.scheme}://${this.authority}${this.path}${suffix}`;
  }

  public toJSON(): string {
    return this.toString();
  }
}

export class Position {
  public constructor(public readonly line: number, public readonly character: number) {}

  public isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }

  public isAfter(other: Position): boolean {
    return this.line > other.line || (this.line === other.line && this.character > other.character);
  }

  public translate(lineDelta = 0, characterDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }

  public with(line = this.line, character = this.character): Position {
    return new Position(line, character);
  }

  public isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;

  public constructor(startLineOrStart: number | Position, startCharacterOrEnd?: number | Position, endLine?: number, endCharacter?: number) {
    if (startLineOrStart instanceof Position && startCharacterOrEnd instanceof Position) {
      this.start = startLineOrStart;
      this.end = startCharacterOrEnd;
    } else {
      this.start = new Position(startLineOrStart as number, startCharacterOrEnd as number);
      this.end = new Position(endLine ?? 0, endCharacter ?? 0);
    }
  }

  public get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }

  public with(start = this.start, end = this.end): Range {
    return new Range(start, end);
  }
}

export class Selection extends Range {
  public readonly anchor: Position;
  public readonly active: Position;

  public constructor(anchor: Position, active: Position) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }

  public get isReversed(): boolean {
    return this.anchor.isAfter?.(this.active) ?? false;
  }
}

export class RelativePattern {
  public readonly base: string;
  public readonly pattern: string;

  public constructor(base: Uri | { fsPath: string }, pattern: string) {
    this.base = base instanceof Uri ? base.fsPath : base.fsPath;
    this.pattern = pattern;
  }
}
