import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolpackContent } from '../toolpacks/types';
import { getUnifyFeature } from '../unify/settings';
import { isLineRange, mergeLineRanges, RANGE_CONTEXT_LINES, rangeHash } from './rangeEdit';
import type { LineRange } from './rangeEdit';
import { activeRustTool } from './rustTools';

/**
 * Advanced batching: one `batch` call on the Unify bridge runs several tool calls and returns one result.
 * Besides the bridge's own tools it offers read-only file tools that exist only inside a batch.
 */
export const BATCH_TOOL = 'batch';
export const MAX_BATCH_CALLS = 20;
export const BATCH_FILE_TOOLS = ['read_file', 'search', 'list_dir'] as const;
export type BatchFileTool = typeof BATCH_FILE_TOOLS[number];

/** Total characters a batch result may return (Claude Code cuts MCP output near 25k tokens). */
export const MAX_BATCH_CHARS = 90_000;
const MAX_FILE_BYTES = 2_000_000;
const DEFAULT_READ_LINES = 2000;
const MAX_SEARCH_FILES = 20_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_LIST_ENTRIES = 500;
const MAX_READ_RANGES = 50;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.unify', '.hg', '.svn', '__pycache__', '.venv', '.next', '.turbo']);
/** A ripgrep search still running after this long is stopped and returns what it found. */
const RIPGREP_TIMEOUT_MS = 30_000;
/** Matches collected from rg before it is stopped; only the first max_results of them (in path order) are shown. */
const RIPGREP_MAX_MATCHES = 5000;
const MAX_HIT_CHARS = 200;

/** Runs one forEach call may expand to, and how many of them run at once. */
export const MAX_FOREACH_RUNS = 50;
const FOREACH_CONCURRENCY = 4;

export const BATCH_INSTRUCTIONS = `From the first step, put two or more reads, searches or listings in one ${BATCH_TOOL} instead of separate native calls; do the same for two or more Unify or toolpack calls, including chains. Use the shell only to run commands. Read the part you are about to edit right before editing it; a ranges read counts.`;

export const BATCH_TOOL_SCHEMA = {
  name: BATCH_TOOL,
  description: `Run up to ${MAX_BATCH_CALLS} calls; one combined result, one entry per call in order. A call may name any other Unify tool (toolpack tools included), or a batch-only file tool: read_file {path, offset? (first line, 1-based), limit? (lines, default ${DEFAULT_READ_LINES}), ranges? (one or more {startLine, endLine}; 2 lines of context, merged when they overlap, with a short hash for edit_range; a ranges read counts as reading before editing)}, search {pattern (JS regex), path?, glob? (e.g. "*.ts"), ignore_case?, max_results? (default 100)}, list_dir {path?}. Paths are relative to the working copy; paths outside it ask the user first unless Unify has full access. read_file returns png, jpg and webp files as images. Calls run in parallel unless they depend on earlier ones:
- "{{N.path}}" in any argument string is part of call N's JSON result, e.g. "{{1.id}}", "{{1.nodes[0].id}}", "{{1.nodes[*].id}}" (a list). As the whole string it keeps its type; inside a longer string it becomes text. "{{N}}" is the whole result, or its text when it is not JSON.
- after: [N, ...] waits for those calls without using their results (e.g. a write, then a read).
- forEach: "{{N.path}}" runs the call once per item of that list (at most ${MAX_FOREACH_RUNS}); "{{item}}" or "{{item.id}}" is the current item.
A call only refers to calls before it. When a call it depends on fails, it is skipped. Identical calls run once.`,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  // Keep it out of Claude Code's tool search: a deferred batch loses to the native Read and Grep that are already loaded.
  _meta: { 'anthropic/alwaysLoad': true },
  inputSchema: {
    type: 'object',
    properties: {
      calls: {
        type: 'array', minItems: 1, maxItems: MAX_BATCH_CALLS,
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string' },
            args: { type: 'object' },
            after: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Earlier call numbers (1-based) to wait for.' },
            forEach: { type: 'string', description: 'A "{{N.path}}" list; the call runs once per item.' },
          },
          required: ['tool'],
        },
      },
    },
    required: ['calls'],
  },
} as const;

/** `after` and the numbers in placeholders are 1-based call numbers, as in the result headers. */
export interface BatchCall { tool: string; args: Record<string, unknown>; after?: number[]; forEach?: string }
/** `data` is a toolpack's chaining JSON; placeholders read it instead of the text when it is there. */
export interface BatchOutcome { text: string; content?: ToolpackContent[]; isError?: boolean; data?: unknown }

/** "{{2.nodes[0].id}}" is a field of call 2's result; "{{item.id}}" one of the current forEach item. */
const PLACEHOLDER = /\{\{\s*(\d+|item)((?:\.[A-Za-z_$][\w$-]*|\.\d+|\[(?:\d+|\*)\])*)\s*\}\}/g;
const WHOLE_PLACEHOLDER = new RegExp(`^\\s*${PLACEHOLDER.source}\\s*$`);

type Source = number | 'item';

/** Calls `visit` for every string inside a value and rebuilds the value from what it returns. */
function mapStrings(value: unknown, visit: (text: string) => unknown): unknown {
  if (typeof value === 'string') return visit(value);
  if (Array.isArray(value)) return value.map(item => mapStrings(item, visit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, visit)]));
  return value;
}

function placeholderSources(value: unknown): Source[] {
  const sources: Source[] = [];
  mapStrings(value, text => {
    for (const match of text.matchAll(PLACEHOLDER)) sources.push(match[1] === 'item' ? 'item' : Number(match[1]));
    return text;
  });
  return sources;
}

/** Earlier calls a call waits for: those its placeholders read, then those named in `after`. */
export function callDependencies(call: BatchCall): number[] {
  const sources = [...placeholderSources(call.args), ...placeholderSources(call.forEach ?? ''), ...(call.after ?? [])];
  return [...new Set(sources.filter((source): source is number => source !== 'item'))].sort((a, b) => a - b);
}

/** MCP clients name a bridge tool bare or qualified with any server name. */
export function isBatchTool(tool: string): boolean {
  return /^(?:(?:mcp[._/]{1,2}[\w-]+?[._/]{1,2})|(?:[\w-]+?[./]))?batch$/i.test(tool.trim());
}

export function isBatchFileTool(tool: string): tool is BatchFileTool {
  return (BATCH_FILE_TOOLS as readonly string[]).includes(tool);
}

export function parseBatchCalls(args: Record<string, unknown>): BatchCall[] {
  const calls = args.calls;
  if (!Array.isArray(calls) || !calls.length) throw new Error('calls must be a non-empty array of { tool, args }.');
  if (calls.length > MAX_BATCH_CALLS) throw new Error(`A batch takes at most ${MAX_BATCH_CALLS} calls.`);
  return calls.map((call, index) => {
    const item = call && typeof call === 'object' ? call as Record<string, unknown> : {};
    const tool = typeof item.tool === 'string' ? item.tool.trim().replace(/^(?:mcp[._/]{1,2}[\w-]+?[._/]{1,2}|[\w-]+?[./])/i, '') : '';
    if (!tool) throw new Error(`Call ${index + 1} has no tool name.`);
    if (isBatchTool(tool)) throw new Error('A batch cannot contain another batch.');
    const raw = item.args ?? item.arguments;
    const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const number = index + 1;
    const earlier = (source: number, what: string): void => {
      if (!Number.isInteger(source) || source < 1 || source >= number) throw new Error(`Call ${number} ${what}, but a call can only use calls before it (1-${number - 1}).`);
    };
    const rawAfter = item.after ?? item.waitFor;
    const after = rawAfter === undefined ? [] : (Array.isArray(rawAfter) ? rawAfter : [rawAfter]).map(Number);
    for (const source of after) earlier(source, `waits for call ${source}`);
    const rawForEach = item.forEach ?? item.for_each;
    if (rawForEach !== undefined && (typeof rawForEach !== 'string' || !WHOLE_PLACEHOLDER.test(rawForEach))) throw new Error(`Call ${number}: forEach must be one placeholder such as "{{1.nodes}}".`);
    const forEach = typeof rawForEach === 'string' ? rawForEach.trim() : undefined;
    for (const source of placeholderSources(forEach ?? '')) {
      if (source === 'item') throw new Error(`Call ${number}: forEach must name an earlier call, not {{item}}.`);
      earlier(source, `loops over {{${source}}}`);
    }
    for (const source of placeholderSources(args)) {
      if (source === 'item') { if (!forEach) throw new Error(`Call ${number} uses {{item}} without forEach.`); }
      else earlier(source, `uses {{${source}}}`);
    }
    return { tool, args, ...(after.length ? { after: [...new Set(after)].sort((a, b) => a - b) } : {}), ...(forEach ? { forEach } : {}) };
  });
}

/** Stable JSON with sorted keys, so { a, b } and { b, a } compare equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What makes two calls the same: the tool and its args, with file-tool paths written one way ("./src\\a.ts" is "src/a.ts"). */
export function callKey(call: BatchCall): string {
  const args = { ...call.args };
  if (isBatchFileTool(call.tool) && typeof args.path === 'string') {
    args.path = args.path.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '') || '.';
  }
  return `${call.tool}\n${stableJson(args)}${call.after ? `\nafter ${call.after.join(',')}` : ''}${call.forEach ? `\nforEach ${call.forEach}` : ''}`;
}

/** The same call with its references to other calls renumbered by `renumber`. */
function renumberCall(call: BatchCall, renumber: (source: number) => number): BatchCall {
  if (!callDependencies(call).length) return call;
  const rewrite = (text: string): string => text.replace(PLACEHOLDER, (all, source: string, path: string) => source === 'item' ? all : `{{${renumber(Number(source))}${path}}}`);
  return {
    tool: call.tool,
    args: mapStrings(call.args, rewrite) as Record<string, unknown>,
    ...(call.after ? { after: [...new Set(call.after.map(renumber))].sort((a, b) => a - b) } : {}),
    ...(call.forEach ? { forEach: rewrite(call.forEach) } : {}),
  };
}

/**
 * Drops repeated calls so each one runs once; `skipped` counts what was dropped.
 * Later calls that referred to a dropped call refer to the call it repeated, numbered as in the result.
 */
export function uniqueBatchCalls(calls: BatchCall[]): { calls: BatchCall[]; skipped: number } {
  const seen = new Map<string, number>();
  // newNumber[original number - 1] is that call's number among the unique calls.
  const newNumber: number[] = [];
  const unique: BatchCall[] = [];
  for (const original of calls) {
    const call = renumberCall(original, source => newNumber[source - 1]);
    const key = callKey(call);
    const repeated = seen.get(key);
    if (repeated) { newNumber.push(repeated); continue; }
    unique.push(call);
    seen.set(key, unique.length);
    newNumber.push(unique.length);
  }
  return { calls: unique, skipped: calls.length - unique.length };
}

/** A call's result as data: the tool's chaining data, its JSON, the JSON after a line of text ("Updated.\n{...}"), or only its text. */
export interface BatchValue { text: string; json?: unknown; isJson: boolean }

export function batchValue(text: string, data?: unknown): BatchValue {
  if (data !== undefined) return { text, json: data, isJson: true };
  const trimmed = text.trim();
  try { return { text, json: JSON.parse(trimmed), isJson: true }; } catch { /* look for JSON inside */ }
  const start = trimmed.search(/[[{]/);
  const end = start < 0 ? -1 : trimmed.lastIndexOf(trimmed[start] === '{' ? '}' : ']');
  if (end > start) {
    try { return { text, json: JSON.parse(trimmed.slice(start, end + 1)), isJson: true }; } catch { /* plain text */ }
  }
  return { text, isJson: false };
}

function itemValue(item: unknown): BatchValue {
  return { text: typeof item === 'string' ? item : JSON.stringify(item), json: item, isJson: true };
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Follows a path such as ".nodes[0].id" or ".nodes[*].id"; throws a message that says where it stopped and what was there. */
function followPath(value: unknown, segments: string[], name: string, trail = ''): unknown {
  if (!segments.length) return value;
  const [segment, ...rest] = segments;
  if (segment === '*') {
    if (!Array.isArray(value)) throw new Error(`${name}${trail} is not a list, so [*] can't be used. It is: ${preview(value)}`);
    return value.map((item, index) => followPath(item, rest, name, `${trail}[${index}]`));
  }
  if (Array.isArray(value)) {
    const index = /^\d+$/.test(segment) ? Number(segment) : NaN;
    if (Number.isNaN(index)) throw new Error(`${name}${trail} is a list, so it has no "${segment}"; use an index such as [0] or [*].`);
    if (index >= value.length) throw new Error(`${name}${trail} has ${value.length} item${value.length === 1 ? '' : 's'}, so [${index}] is past the end.`);
    return followPath(value[index], rest, name, `${trail}[${index}]`);
  }
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, segment)) {
    return followPath((value as Record<string, unknown>)[segment], rest, name, `${trail}.${segment}`);
  }
  const keys = value && typeof value === 'object' ? Object.keys(value) : [];
  throw new Error(`${name}${trail} has no "${segment}". ${keys.length ? `Its keys: ${keys.slice(0, 30).join(', ')}.` : `It is: ${preview(value)}`}`);
}

function readPlaceholder(source: Source, path: string, lookup: (source: Source) => BatchValue): unknown {
  const value = lookup(source);
  const name = source === 'item' ? 'item' : `call ${source}'s result`;
  if (!path) return value.isJson ? value.json : value.text;
  if (!value.isJson) throw new Error(`${name} is text, not JSON, so only {{${source}}} (the whole text) can be used. It starts: ${preview(value.text)}`);
  const segments = [...path.matchAll(/\.([^.[\]]+)|\[(\d+|\*)\]/g)].map(match => match[1] ?? match[2]);
  return followPath(value.json, segments, name);
}

/** Fills placeholders in a value. A string that is only a placeholder takes the value as is; otherwise the value is written into the text. */
export function resolvePlaceholders(value: unknown, lookup: (source: Source) => BatchValue): unknown {
  return mapStrings(value, text => {
    const whole = text.match(WHOLE_PLACEHOLDER);
    if (whole) return readPlaceholder(whole[1] === 'item' ? 'item' : Number(whole[1]), whole[2], lookup);
    return text.replace(PLACEHOLDER, (_, source: string, path: string) => {
      const found = readPlaceholder(source === 'item' ? 'item' : Number(source), path, lookup);
      return typeof found === 'string' ? found : JSON.stringify(found) ?? '';
    });
  });
}

async function runSafely(call: BatchCall, run: (call: BatchCall) => Promise<BatchOutcome>): Promise<BatchOutcome> {
  try { return await run(call); } catch (error) { return { text: error instanceof Error ? error.message : String(error), isError: true }; }
}

/** Runs `tasks` with at most `limit` at a time and returns their results in order. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) { const index = next++; results[index] = await tasks[index](); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function runForEach(call: BatchCall, items: unknown[], lookup: (source: Source) => BatchValue, run: (call: BatchCall) => Promise<BatchOutcome>): Promise<{ outcome: BatchOutcome; value: BatchValue }> {
  if (!items.length) return { outcome: { text: `${call.forEach} is an empty list; nothing ran.` }, value: itemValue([]) };
  const outcomes = await pool(items.map(item => async (): Promise<BatchOutcome> => {
    let args: Record<string, unknown>;
    try { args = resolvePlaceholders(call.args, source => source === 'item' ? itemValue(item) : lookup(source)) as Record<string, unknown>; }
    catch (error) { return { text: error instanceof Error ? error.message : String(error), isError: true }; }
    return runSafely({ tool: call.tool, args }, run);
  }), FOREACH_CONCURRENCY);
  const failed = outcomes.filter(outcome => outcome.isError).length;
  const text = outcomes.map((outcome, index) => `(${index + 1}/${items.length})${outcome.isError ? ' error:' : ''} ${outcome.text}`).join('\n');
  const content = outcomes.flatMap(outcome => (outcome.content || []).filter(block => block.type !== 'text'));
  return {
    outcome: { text: failed ? `${text}\n[${failed} of ${items.length} failed]` : text, ...(content.length ? { content } : {}), ...(failed === items.length ? { isError: true } : {}) },
    // Later calls see one entry per item: its JSON, or its text.
    value: itemValue(outcomes.map(outcome => {
      const value = batchValue(outcome.text, outcome.data);
      return value.isJson ? value.json : value.text;
    })),
  };
}

/**
 * Runs a batch: calls without dependencies start at once; the others wait for the calls they name, then run
 * with their placeholders filled in. A call whose dependency failed is skipped. `settled` reports each call as it ends.
 */
export async function executeBatch(calls: BatchCall[], run: (call: BatchCall) => Promise<BatchOutcome>, settled?: (index: number, outcome: BatchOutcome) => void): Promise<BatchOutcome[]> {
  const results: Promise<{ outcome: BatchOutcome; value: BatchValue }>[] = [];
  const start = async (call: BatchCall): Promise<{ outcome: BatchOutcome; value: BatchValue }> => {
    const dependencies = callDependencies(call);
    // Dependencies are earlier calls, so their promises already exist.
    const done = await Promise.all(dependencies.map(number => results[number - 1]));
    const failed = dependencies.filter((_, index) => done[index].outcome.isError);
    const fail = (text: string) => ({ outcome: { text, isError: true }, value: { text, isJson: false } });
    if (failed.length) return fail(`Skipped: call ${failed.join(', ')} failed.`);
    const lookup = (source: Source): BatchValue => done[dependencies.indexOf(source as number)].value;
    try {
      if (call.forEach) {
        const items = resolvePlaceholders(call.forEach, lookup);
        if (!Array.isArray(items)) return fail(`forEach ${call.forEach} is not a list. It is: ${preview(items)}`);
        if (items.length > MAX_FOREACH_RUNS) return fail(`forEach ${call.forEach} has ${items.length} items; at most ${MAX_FOREACH_RUNS} can run. Narrow the earlier call.`);
        return await runForEach(call, items, lookup, run);
      }
      const outcome = await runSafely({ tool: call.tool, args: resolvePlaceholders(call.args, lookup) as Record<string, unknown> }, run);
      return { outcome, value: batchValue(outcome.text, outcome.data) };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
  for (const [index, call] of calls.entries()) {
    results.push(start(call).then(result => { settled?.(index, result.outcome); return result; }));
  }
  return (await Promise.all(results)).map(result => result.outcome);
}

/** Short label for a call, used in the result headers, the sidebar and the transcript. */
export function callLabel(call: BatchCall): string {
  const { args } = call;
  const first = ['path', 'pattern', 'agent', 'id', 'query', 'name'].map(key => args[key]).find(value => typeof value === 'string' && value);
  const files = Array.isArray(args.files) && args.files.every(item => typeof item === 'string') ? (args.files as string[]).join(', ') : '';
  const detail = typeof first === 'string' ? first : files;
  const label = detail ? `${call.tool} ${detail.replace(/\s+/g, ' ').slice(0, 120)}` : call.tool;
  return call.forEach ? `${label} for each of ${call.forEach}` : label;
}

/** Joins the outcomes under numbered headers and keeps the whole result within MAX_BATCH_CHARS. */
export function formatBatchResult(calls: BatchCall[], outcomes: BatchOutcome[], skipped = 0): { text: string; content: ToolpackContent[] } {
  const note = skipped ? `[${skipped} identical call${skipped === 1 ? '' : 's'} skipped; each call above ran once]` : '';
  const limits = fairShares(outcomes.map(item => item.text.length), MAX_BATCH_CHARS - note.length);
  const extra: ToolpackContent[] = [];
  const parts = calls.map((call, index) => {
    const outcome = outcomes[index];
    const limit = limits[index];
    const body = outcome.text.length > limit ? `${outcome.text.slice(0, limit)}\n[cut at ${limit} characters; narrow this call or run it alone]` : outcome.text;
    for (const block of outcome.content || []) if (block.type !== 'text') extra.push(block);
    return `[${index + 1}] ${callLabel(call)}${outcome.isError ? ' (error)' : ''}\n${body}`;
  });
  if (note) parts.push(note);
  return { text: parts.join('\n\n'), content: extra };
}

/** Splits a character budget so short results stay whole and the long ones share what is left equally. */
export function fairShares(sizes: number[], budget: number): number[] {
  const limits = sizes.map(() => 0);
  let left = budget;
  let open = sizes.map((_, index) => index);
  while (open.length) {
    const share = Math.floor(left / open.length);
    const small = open.filter(index => sizes[index] <= share);
    if (!small.length) { for (const index of open) limits[index] = share; break; }
    for (const index of small) { limits[index] = sizes[index]; left -= sizes[index]; }
    open = open.filter(index => sizes[index] > share);
  }
  return limits;
}

const leavesRoot = (rel: string): boolean => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);

function absolutePath(cwd: string, path: unknown): { value: string; absolute: string } {
  const value = typeof path === 'string' && path.trim() ? path.trim() : '.';
  return { value, absolute: isAbsolute(value) ? resolve(value) : resolve(cwd, value) };
}

/** Whether a path leaves the working copy, directly or through a symlink. A path that does not exist is judged by its text. */
export async function outsideWorkingCopy(cwd: string, path: unknown): Promise<boolean> {
  const { absolute } = absolutePath(cwd, path);
  if (leavesRoot(relative(cwd, absolute))) return true;
  try {
    const [root, real] = await Promise.all([realpath(cwd), realpath(absolute)]);
    return leavesRoot(relative(root, real));
  } catch {
    return false;
  }
}

/** Resolves a path; unless `outside` allows it, refuses anything outside the working copy, including through symlinks. */
export async function insidePath(cwd: string, path: unknown, outside = false): Promise<string> {
  const { value, absolute } = absolutePath(cwd, path);
  if (!outside && await outsideWorkingCopy(cwd, value)) throw new Error(`${value} is outside the working copy.`);
  return absolute;
}

/** A path as results show it: relative inside the working copy, absolute outside it. */
const display = (cwd: string, absolute: string): string => {
  const rel = relative(cwd, absolute);
  return (leavesRoot(rel) ? absolute : rel).split(sep).join('/') || '.';
};

/**
 * Options for the batch file tools; `outside` lets them read beyond the working copy. `ripgrep` is the rg command
 * search runs (default: the managed rg, else rg on PATH); false always uses the built-in scanner.
 */
export interface BatchFileOptions { outside?: boolean; ripgrep?: string | false }

const IMAGE_TYPES: Record<string, Extract<ToolpackContent, { type: 'image' }>['mimeType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
/** Images past this size are refused; the API rejects base64 images near 5 MB. */
const MAX_IMAGE_BYTES = 3_750_000;

/** The inline flags a pattern such as "(?i)foo" starts with become RegExp flags, since JS has no inline flags. */
export function searchRegex(source: string, ignoreCase = false): RegExp {
  const inline = source.match(/^\(\?([imsu]+)\)/);
  const flags = new Set(inline ? inline[1].split('') : []);
  if (ignoreCase) flags.add('i');
  return new RegExp(inline ? source.slice(inline[0].length) : source, [...flags].join(''));
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

/** A glob such as "*.ts", "src/**\/*.tsx" or "*.{js,mjs}" as a regular expression over slash paths. */
export function globPattern(glob: string): RegExp {
  let out = '';
  let depth = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    // "**/" also matches no directory at all, so "src/**/a.ts" finds src/a.ts.
    if (char === '*' && glob[index + 1] === '*') { out += glob[index + 2] === '/' ? '(?:.*/)?' : '.*'; index += glob[index + 2] === '/' ? 2 : 1; }
    else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else if (char === '{') { out += '(?:'; depth += 1; }
    else if (char === '}' && depth) { out += ')'; depth -= 1; }
    else if (char === ',' && depth) out += '|';
    else out += char.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function parseReadRanges(value: unknown): LineRange[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.length) throw new Error('ranges must be a non-empty array of { startLine, endLine }.');
  if (value.length > MAX_READ_RANGES) throw new Error(`A read takes at most ${MAX_READ_RANGES} ranges.`);
  return value.map((item, index) => {
    if (!isLineRange(item)) throw new Error(`Range ${index + 1} needs whole-number startLine and endLine with 1 <= startLine <= endLine.`);
    return { startLine: Math.floor(item.startLine), endLine: Math.floor(item.endLine) };
  });
}

/** Each requested range with 2 lines of context; nearby windows become one part. */
function readRangeParts(lines: string[], requested: LineRange[]): { startLine: number; endLine: number; innerStart: number; innerEnd: number }[] {
  const parts: { startLine: number; endLine: number; innerStart: number; innerEnd: number }[] = [];
  for (const range of mergeLineRanges(requested)) {
    const startLine = Math.max(1, range.startLine - RANGE_CONTEXT_LINES);
    const endLine = Math.min(lines.length, range.endLine + RANGE_CONTEXT_LINES);
    const last = parts[parts.length - 1];
    if (last && startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, endLine);
      last.innerEnd = Math.max(last.innerEnd, Math.min(range.endLine, lines.length));
      continue;
    }
    parts.push({ startLine, endLine, innerStart: range.startLine, innerEnd: Math.min(range.endLine, lines.length) });
  }
  return parts;
}

function readRangesText(name: string, lines: string[], requested: LineRange[]): string {
  return readRangeParts(lines, requested).map(part => {
    const heading = `${name} lines ${part.startLine}-${part.endLine} of ${lines.length} (range ${part.innerStart}-${part.innerEnd}, hash ${rangeHash(lines, part.innerStart, part.innerEnd)})`;
    return `${heading}\n${lines.slice(part.startLine - 1, part.endLine).join('\n')}`;
  }).join('\n\n');
}

async function readFileTool(cwd: string, args: Record<string, unknown>, options: BatchFileOptions): Promise<BatchOutcome> {
  const file = await insidePath(cwd, args.path, options.outside);
  const info = await stat(file);
  if (info.isDirectory()) return { text: `${display(cwd, file)} is a directory; use list_dir.`, isError: true };
  const mimeType = IMAGE_TYPES[extname(file).toLowerCase()];
  if (mimeType) {
    if (info.size > MAX_IMAGE_BYTES) return { text: `${display(cwd, file)} is a ${Math.round(info.size / 1024)} KB image; images over ${Math.round(MAX_IMAGE_BYTES / 1024)} KB can't be shown.`, isError: true };
    const data = (await readFile(file)).toString('base64');
    return { text: `${display(cwd, file)} (image, ${Math.round(info.size / 1024)} KB)`, content: [{ type: 'image', data, mimeType }] };
  }
  if (info.size > MAX_FILE_BYTES) return { text: `${display(cwd, file)} is ${info.size} bytes; read it with offset and limit through your own tools.`, isError: true };
  const buffer = await readFile(file);
  if (looksBinary(buffer)) return { text: `${display(cwd, file)} is a binary file.`, isError: true };
  const lines = buffer.toString('utf8').split(/\r?\n/);
  const ranges = parseReadRanges(args.ranges);
  if (ranges) {
    if (!getUnifyFeature('tools.rangeEdits')) return { text: 'Range reads are turned off in Settings (tools.rangeEdits).', isError: true };
    const beyond = ranges.find(range => range.startLine > lines.length);
    if (beyond) return { text: `Range ${beyond.startLine}-${beyond.endLine} is past the end of ${display(cwd, file)} (${lines.length} lines).`, isError: true };
    return { text: readRangesText(display(cwd, file), lines, ranges) };
  }
  const start = Math.max(1, Math.floor(Number(args.offset) || 1));
  const count = Math.max(1, Math.floor(Number(args.limit) || DEFAULT_READ_LINES));
  const picked = lines.slice(start - 1, start - 1 + count);
  const end = start + picked.length - 1;
  const range = start === 1 && end >= lines.length ? '' : ` (lines ${start}-${end} of ${lines.length})`;
  return { text: `${range ? `${range.trim()}\n` : ''}${picked.join('\n')}` };
}

async function searchTool(cwd: string, args: Record<string, unknown>, options: BatchFileOptions): Promise<BatchOutcome> {
  const source = typeof args.pattern === 'string' ? args.pattern : '';
  if (!source) return { text: 'pattern is required.', isError: true };
  let regex: RegExp;
  try { regex = searchRegex(source, args.ignore_case === true); } catch (error) { return { text: `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`, isError: true }; }
  const glob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : undefined;
  const max = Math.max(1, Math.min(Math.floor(Number(args.max_results) || 100), 500));
  const start = await insidePath(cwd, args.path, options.outside);
  const request: SearchRequest = { cwd, start, source, regex, ignoreCase: args.ignore_case === true, glob, max };
  const command = options.ripgrep === false ? undefined : options.ripgrep ?? activeRustTool('rg') ?? 'rg';
  const hits = (command && await ripgrepSearch(command, request)) || await scanSearch(request);
  return { text: hits.text() };
}

interface SearchRequest {
  cwd: string;
  /** Absolute file or folder to search, already checked against the working copy. */
  start: string;
  /** The pattern as given, inline flags included; `regex` is its JS form. */
  source: string;
  regex: RegExp;
  ignoreCase: boolean;
  glob?: string;
  max: number;
}

/** Search hits grouped under their file, in the order they are added, up to the request's cap. */
class SearchHits {
  private readonly groups: string[] = [];
  private readonly globRegex: RegExp | undefined;
  private lastFile: string | undefined;
  private count = 0;
  public truncated = false;
  public note = 'narrow path or glob';

  public constructor(private readonly request: SearchRequest) {
    this.globRegex = request.glob ? globPattern(request.glob) : undefined;
  }

  public get full(): boolean {
    return this.count >= this.request.max;
  }

  /** Whether a file passes the glob: matched against its relative path when the glob has a slash, else its name. */
  public wants(rel: string): boolean {
    if (!this.globRegex) return true;
    return this.globRegex.test(this.request.glob!.includes('/') ? rel : rel.split('/').pop()!);
  }

  /** Adds a hit on a 1-based line; false once the cap is reached. */
  public add(rel: string, lineNumber: number, text: string): boolean {
    if (this.full) {
      this.truncated = true;
      return false;
    }
    const line = text.trim();
    if (this.lastFile !== rel) {
      if (this.groups.length) this.groups.push('');
      this.groups.push(rel);
      this.lastFile = rel;
    }
    this.groups.push(`  ${lineNumber}: ${line.length > MAX_HIT_CHARS ? `${line.slice(0, MAX_HIT_CHARS)}…` : line}`);
    this.count += 1;
    if (this.full) this.truncated = true;
    return !this.full;
  }

  public text(): string {
    if (!this.count) return this.truncated ? `No matches before the search was stopped; ${this.note}.` : 'No matches.';
    return `${this.groups.join('\n')}${this.truncated ? `\n[stopped at ${this.count} matches; ${this.note}]` : ''}`;
  }
}

/** rg commands that could not be started, so later searches go straight to the built-in scanner. */
const missingRipgrep = new Set<string>();

function ripgrepText(data: { text?: unknown; bytes?: unknown } | undefined): string | undefined {
  if (typeof data?.text === 'string') return data.text;
  if (typeof data?.bytes === 'string') return Buffer.from(data.bytes, 'base64').toString('utf8');
  return undefined;
}

/** Orders paths the way the scanner walks them: folder by folder, names compared within each folder. */
function compareWalkOrder(left: string, right: string): number {
  const a = left.split('/');
  const b = right.split('/');
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Searches with ripgrep, which also skips files the repository's .gitignore excludes. Resolves undefined when rg is
 * missing or rejects the pattern (JS-only syntax such as lookbehind), so the caller falls back to the built-in scanner.
 * rg runs unsorted (sorting makes it single-threaded and about 4x slower), so matches are collected, up to
 * RIPGREP_MAX_MATCHES, and sorted here.
 */
function ripgrepSearch(command: string, request: SearchRequest): Promise<SearchHits | undefined> {
  if (missingRipgrep.has(command)) return Promise.resolve(undefined);
  const hits = new SearchHits(request);
  const args = ['--json', '--no-config', '--no-messages', '--hidden', '--crlf', '--max-filesize', String(MAX_SEARCH_FILE_BYTES)];
  if (request.ignoreCase) args.push('--ignore-case');
  // A glob with a slash is relative to the working copy, which rg globs are not; SearchHits filters those instead.
  if (request.glob && !request.glob.includes('/')) args.push('--glob', request.glob);
  for (const name of SKIP_DIRS) args.push('--glob', `!${name}`);
  args.push('--regexp', request.source, '--', request.start);
  return new Promise(resolvePromise => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: request.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      missingRipgrep.add(command);
      resolvePromise(undefined);
      return;
    }
    const files = new Map<string, { lineNumber: number; text: string }[]>();
    let collected = 0;
    let pending = '';
    let finished = false;
    let stopped = false;
    const stop = (): void => {
      stopped = true;
      hits.truncated = true;
      child.kill();
    };
    const timer = setTimeout(() => {
      hits.note = `ran past ${RIPGREP_TIMEOUT_MS / 1000} s; narrow path or glob`;
      stop();
    }, RIPGREP_TIMEOUT_MS);
    const handle = (line: string): void => {
      if (stopped || !line) return;
      let event: { type?: string; data?: { path?: { text?: unknown; bytes?: unknown }; lines?: { text?: unknown; bytes?: unknown }; line_number?: unknown } };
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'summary') finished = true;
      if (event.type !== 'match' || typeof event.data?.line_number !== 'number') return;
      const path = ripgrepText(event.data.path);
      const text = ripgrepText(event.data.lines);
      if (path === undefined || text === undefined) return;
      const rel = display(request.cwd, resolve(request.cwd, path));
      if (!hits.wants(rel)) return;
      const lines = files.get(rel) ?? [];
      lines.push({ lineNumber: event.data.line_number, text });
      files.set(rel, lines);
      collected += 1;
      if (collected >= RIPGREP_MAX_MATCHES) stop();
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) handle(line);
    });
    child.on('error', () => {
      clearTimeout(timer);
      missingRipgrep.add(command);
      resolvePromise(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      handle(pending);
      // Without a summary rg never searched: the pattern was rejected before any file was read.
      if (!finished && !stopped) {
        resolvePromise(undefined);
        return;
      }
      outer: for (const rel of [...files.keys()].sort(compareWalkOrder)) {
        for (const match of files.get(rel)!) {
          if (!hits.add(rel, match.lineNumber, match.text)) break outer;
        }
      }
      resolvePromise(hits);
    });
  });
}

/** The built-in scanner: walks the folder in name order and tests each line with the JS regex. */
async function scanSearch(request: SearchRequest): Promise<SearchHits> {
  const hits = new SearchHits(request);
  let scanned = 0;
  const visit = async (path: string): Promise<void> => {
    if (hits.full || scanned >= MAX_SEARCH_FILES) {
      hits.truncated = true;
      return;
    }
    const info = await lstat(path).catch(() => undefined);
    if (!info || info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      const entries = await readdir(path).catch(() => [] as string[]);
      for (const name of entries.sort()) {
        if (SKIP_DIRS.has(name)) continue;
        await visit(join(path, name));
        if (hits.full) return;
      }
      return;
    }
    if (!info.isFile() || info.size > MAX_SEARCH_FILE_BYTES) return;
    const rel = display(request.cwd, path);
    if (!hits.wants(rel)) return;
    scanned += 1;
    const buffer = await readFile(path).catch(() => undefined);
    if (!buffer || looksBinary(buffer)) return;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (request.regex.test(lines[index]) && !hits.add(rel, index + 1, lines[index])) return;
    }
  };
  await visit(request.start);
  return hits;
}

async function listDirTool(cwd: string, args: Record<string, unknown>, options: BatchFileOptions): Promise<BatchOutcome> {
  const dir = await insidePath(cwd, args.path, options.outside);
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries.map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name).sort();
  const shown = names.slice(0, MAX_LIST_ENTRIES);
  return { text: `${shown.join('\n') || '(empty)'}${names.length > shown.length ? `\n[${names.length - shown.length} more entries]` : ''}` };
}

export async function runBatchFileTool(cwd: string, tool: BatchFileTool, args: Record<string, unknown>, options: BatchFileOptions = {}): Promise<BatchOutcome> {
  try {
    if (tool === 'read_file') return await readFileTool(cwd, args, options);
    if (tool === 'search') return await searchTool(cwd, args, options);
    return await listDirTool(cwd, args, options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { text: code === 'ENOENT' ? `${String(args.path ?? '.')} does not exist.` : error instanceof Error ? error.message : String(error), isError: true };
  }
}
