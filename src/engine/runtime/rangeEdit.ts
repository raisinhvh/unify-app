import { createHash } from 'node:crypto';

/**
 * Range reads and edits: `read_file ranges` returns line numbers and a short hash per range;
 * `edit_range` replaces exactly those lines after checking that hash (or the expected text) still matches.
 * Both the read format and the edit check use `rangeHash`, so a hash from a read round-trips.
 */
export const RANGE_HASH_LENGTH = 12;
/** Extra lines shown before and after each requested range. */
export const RANGE_CONTEXT_LINES = 2;

export interface LineRange { startLine: number; endLine: number }

export interface RangeEditRequest extends LineRange {
  /** The exact current text of the lines, or the 12-hex hash returned by a range read. */
  expected?: string;
  replacement: string;
}

export type RangeEditResult =
  | { ok: true; text: string; startLine: number; endLine: number }
  | { ok: false; error: string };

/** The short hash of lines `startLine`–`endLine` (1-based, inclusive). Lines are joined with "\n". */
export function rangeHash(lines: string[], startLine: number, endLine: number): string {
  const start = Math.max(1, Math.floor(startLine));
  const end = Math.min(lines.length, Math.floor(endLine));
  const text = end < start ? '' : lines.slice(start - 1, end).join('\n');
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, RANGE_HASH_LENGTH);
}

/** A valid 1-based range: whole numbers, start at least 1, end at least start. */
export function isLineRange(value: unknown): value is LineRange {
  if (!value || typeof value !== 'object') return false;
  const range = value as Record<string, unknown>;
  const start = Number(range.startLine);
  const end = Number(range.endLine);
  return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start;
}

/** Sorts ranges and merges overlapping or touching ones. */
export function mergeLineRanges(ranges: LineRange[]): LineRange[] {
  const sorted = ranges
    .filter(isLineRange)
    .map(range => ({ startLine: Math.floor(range.startLine), endLine: Math.floor(range.endLine) }))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, range.endLine);
    else merged.push({ ...range });
  }
  return merged;
}

/** The file's dominant line ending, or "\n" when it has none. */
function eolOf(fileText: string): string {
  const crlf = (fileText.match(/\r\n/g) ?? []).length;
  const lf = (fileText.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

interface LinePart { text: string; eol: string }

/** Lines as `read_file` counts them, each with its own ending ('' for an unterminated last line). */
function linePartsOf(fileText: string): LinePart[] {
  const parts = fileText.split(/(\r?\n)/);
  const lineParts: LinePart[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    lineParts.push({ text: parts[index], eol: index + 1 < parts.length ? parts[index + 1] : '' });
  }
  return lineParts;
}

/** Up to `limit` lines, with an ellipsis when the range is longer, for an error message. */
function showLines(lines: string[], startLine: number, endLine: number, limit = 24): string {
  const from = Math.max(1, Math.min(startLine, lines.length + 1));
  const to = Math.min(lines.length, Math.max(endLine, from));
  if (to < from) return '(nothing there)';
  const shown = lines.slice(from - 1, to);
  const clipped = shown.length > limit ? `${shown.slice(0, limit).join('\n')}\n[... ${shown.length - limit} more lines]` : shown.join('\n');
  return clipped;
}

function isHash(expected: string): boolean {
  return new RegExp(`^[0-9a-fA-F]{${RANGE_HASH_LENGTH}}$`).test(expected);
}

/** Every 1-based start where a window of `count` lines matches the expected text or hash. */
function findMatchingWindows(lines: string[], count: number, expected: string, hash: boolean): number[] {
  const found: number[] = [];
  for (let start = 1; start + count - 1 <= lines.length; start += 1) {
    const matches = hash ? rangeHash(lines, start, start + count - 1) === expected : lines.slice(start - 1, start + count - 1).join('\n') === expected;
    if (matches) found.push(start);
  }
  return found;
}

/**
 * Replaces exactly lines `startLine`–`endLine` with `replacement`.
 * `expected` guards against a stale read: if it is the 12-hex hash from a read, the hash must match;
 * otherwise it is compared with the exact text of the lines (line endings normalised to "\n").
 * On a mismatch the whole file is searched once for a unique window with the same number of lines as
 * `expected` (or as the range for a hash); only one match re-anchors.
 */
export function applyRangeEdit(fileText: string, request: RangeEditRequest): RangeEditResult {
  const lineParts = linePartsOf(fileText);
  const lines = lineParts.map(part => part.text);
  const eol = eolOf(fileText);
  const start = Math.floor(Number(request.startLine));
  const end = Math.floor(Number(request.endLine));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return { ok: false, error: 'startLine and endLine must be whole numbers with 1 <= startLine <= endLine.' };
  }
  if (end > lines.length) {
    return { ok: false, error: `Lines ${start}-${end} are past the end of the file (${lines.length} lines). Current lines ${start}-${Math.min(end, lines.length)}:\n${showLines(lines, start, lines.length)}` };
  }
  const replacement = typeof request.replacement === 'string' ? request.replacement : '';
  const requestedText = lines.slice(start - 1, end).join('\n');
  let targetStart = start;
  let targetEnd = end;
  const rawExpected = typeof request.expected === 'string' ? request.expected : undefined;
  if (rawExpected !== undefined && rawExpected.length > 0) {
    const hash = isHash(rawExpected);
    const expected = hash ? rawExpected.toLowerCase() : rawExpected.replace(/\r\n/g, '\n').replace(/\n$/, '');
    const matchesNow = hash ? rangeHash(lines, start, end) === expected : requestedText === expected;
    if (!matchesNow) {
      const count = hash ? end - start + 1 : expected.split('\n').length;
      const found = findMatchingWindows(lines, count, expected, hash);
      if (found.length === 1) {
        targetStart = found[0];
        targetEnd = targetStart + count - 1;
      } else if (found.length === 0) {
        return { ok: false, error: `Expected ${hash ? `hash ${expected}` : 'text'} is stale: it does not match lines ${start}-${end} and no other place in the file has exactly that ${count}-line text. Current lines ${start}-${end}:\n${showLines(lines, start, end)}` };
      } else {
        const places = found.slice(0, 6).map(item => `${item}-${item + count - 1}`).join(', ');
        return { ok: false, error: `Expected ${hash ? `hash ${expected}` : 'text'} appears in ${found.length} places (lines ${places}${found.length > 6 ? ', …' : ''}); refusing to guess. Include more context or read the file again. Current lines ${start}-${end}:\n${showLines(lines, start, end)}` };
      }
    }
  }
  const replacementParts = replacement.replace(/\r\n/g, '\n').split('\n');
  // A trailing newline in the replacement ends the last line instead of adding an empty one.
  if (replacementParts.length > 1 && replacementParts[replacementParts.length - 1] === '') replacementParts.pop();
  const replacementLines = replacement === '' ? [] : replacementParts;
  // Splice only the target lines, so every untouched line keeps its own ending.
  const replacedLastEol = lineParts[targetEnd - 1].eol;
  const pieces: string[] = [lineParts.slice(0, targetStart - 1).map(part => part.text + part.eol).join('')];
  for (let index = 0; index < replacementLines.length; index += 1) {
    const correspondingEol = lineParts[targetStart - 1 + index]?.eol;
    const ending = index === replacementLines.length - 1 ? replacedLastEol : correspondingEol || eol;
    pieces.push(replacementLines[index], ending);
  }
  pieces.push(lineParts.slice(targetEnd).map(part => part.text + part.eol).join(''));
  return { ok: true, text: pieces.join(''), startLine: targetStart, endLine: targetStart + replacementLines.length - 1 };
}
