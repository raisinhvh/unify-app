/**
 * Ctrl+Shift+F content search for the Files and Knowledge screens: literal text matching with line/column
 * positions the screens can jump to. Workspace files go through the batch search machinery (ripgrep with the
 * repository's .gitignore, else the built-in scanner); knowledge items reuse the same per-line matcher.
 */
import { resolve } from 'node:path';
import { searchContentLines } from '../../runtime/batch';
import type { ContentMatch } from './types';

/** Matches a request returns unless it asks for another limit. */
export const DEFAULT_CONTENT_LIMIT = 500;
const MAX_CONTENT_LIMIT = 5_000;
/** Longest snippet kept around a match; positions stay inside it. */
const MAX_TEXT_CHARS = 300;
/** How much text before a match a shifted window keeps, so the match is not at its very edge. */
const WINDOW_LEAD = 100;
/** Matches past this position in one line are not searched; minified files are not useful to the screen. */
const MAX_LINE_SCAN = 2_000;

/** One literal occurrence in a line: 1-based column, match length, and the line cut to a 300-char window. */
export interface TextMatch {
  line: number;
  column: number;
  length: number;
  text: string;
}

/** The actual match cap for a request: a missing, invalid or non-positive limit means the default. */
export function contentMatchLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return DEFAULT_CONTENT_LIMIT;
  return Math.min(Math.floor(limit), MAX_CONTENT_LIMIT);
}

/** The snippet for a match: the whole line, or a 300-char window around a match past the cut. */
function windowAround(line: string, column: number): { text: string; column: number } {
  if (line.length <= MAX_TEXT_CHARS) return { text: line, column };
  const start = column <= MAX_TEXT_CHARS ? 0 : Math.max(0, column - WINDOW_LEAD - 1);
  const clipped = Math.min(start, Math.max(0, line.length - MAX_TEXT_CHARS));
  return { text: line.slice(clipped, clipped + MAX_TEXT_CHARS), column: column - clipped };
}

/** Every non-overlapping literal occurrence of `query` in one line, with the query's original length. */
export function lineTextMatches(line: string, query: string, caseSensitive = false): Omit<TextMatch, 'line'>[] {
  if (!query) return [];
  const scanned = line.slice(0, MAX_LINE_SCAN);
  const haystack = caseSensitive ? scanned : scanned.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: Omit<TextMatch, 'line'>[] = [];
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const window = windowAround(line, index + 1);
    matches.push({ column: window.column, length: query.length, text: window.text });
    index = haystack.indexOf(needle, index + needle.length);
  }
  return matches;
}

/** Every occurrence of the query in a text, line by line, up to `limit`; `truncated` says more existed. */
export function textMatches(
  content: string,
  query: string,
  options: { caseSensitive?: boolean; limit?: number } = {},
): { matches: TextMatch[]; truncated: boolean } {
  const limit = contentMatchLimit(options.limit);
  const matches: TextMatch[] = [];
  if (!query.trim()) return { matches, truncated: false };
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const found of lineTextMatches(lines[index], query, options.caseSensitive === true)) {
      if (matches.length >= limit) return { matches, truncated: true };
      matches.push({ line: index + 1, ...found });
    }
  }
  return { matches, truncated: false };
}

/** Literal content search through the open workspace; paths are workspace-relative with forward slashes. */
export async function searchWorkspaceContents(
  root: string | undefined,
  query: string,
  options: { caseSensitive?: boolean; limit?: number } = {},
): Promise<{ matches: ContentMatch[]; truncated: boolean }> {
  const limit = contentMatchLimit(options.limit);
  if (!root || !query.trim()) return { matches: [], truncated: false };
  const result = await searchContentLines(resolve(root), query, {
    caseSensitive: options.caseSensitive === true,
    limit,
    timeoutMs: 5_000,
  });
  const matches: ContentMatch[] = [];
  for (const hit of result.hits) {
    for (const found of lineTextMatches(hit.text, query, options.caseSensitive === true)) {
      if (matches.length >= limit) return { matches, truncated: true };
      matches.push({ path: hit.path, line: hit.line, ...found });
    }
  }
  return { matches, truncated: result.truncated };
}
