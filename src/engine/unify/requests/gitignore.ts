/**
 * A small `.gitignore` matcher for the Files watcher.
 *
 * Git's full syntax is large; this covers the patterns projects actually use: comments, blank lines, `!`
 * negation (last match wins), a leading `/` (anchored to the root), a trailing `/` (directories only), `**`,
 * `*` and `?`. Patterns without a slash match a name at any depth, as Git does.
 */
import * as fs from 'node:fs';

interface IgnoreRule {
  negate: boolean;
  directoryOnly: boolean;
  expression: RegExp;
}

export class GitIgnore {
  private rules: IgnoreRule[] = [];
  private mtime = -1;

  public constructor(private readonly root: string) {}

  /** Reads `<root>/.gitignore` again when its mtime changed; a missing file means nothing is ignored. */
  public refresh(): void {
    const file = `${this.root}/.gitignore`;
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      this.rules = [];
      this.mtime = -1;
      return;
    }
    if (mtime === this.mtime) return;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      // The file vanished between stat and read; keep the old rules.
      return;
    }
    this.rules = text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(compileRule)
      .filter((rule): rule is IgnoreRule => !!rule);
    this.mtime = mtime;
  }

  /** Whether a root-relative path (forward slashes) is ignored; check directories with `isDirectory`. */
  public ignores(relativePath: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (rule.expression.test(relativePath)) ignored = !rule.negate;
    }
    return ignored;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Globs one path segment or a whole pattern, `**` spans separators. */
function globBody(glob: string): string {
  let output = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          output += '(?:.*/)?';
        } else {
          output += '.*';
        }
      } else {
        output += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      output += '[^/]';
      continue;
    }
    output += escapeRegExp(character);
  }
  return output;
}

function compileRule(line: string): IgnoreRule | undefined {
  let pattern = line;
  const negate = pattern.startsWith('!');
  if (negate) pattern = pattern.slice(1);
  if (!pattern) return undefined;
  const directoryOnly = pattern.endsWith('/');
  if (directoryOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.slice(1);
  if (!pattern) return undefined;
  const body = globBody(pattern);
  // A pattern with no slash matches that name at any depth; anything else is relative to the root.
  const source = anchored || pattern.includes('/')
    ? `^${body}$`
    : `(?:^|/)${body}$`;
  return { negate, directoryOnly, expression: new RegExp(source) };
}
