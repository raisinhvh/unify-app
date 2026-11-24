import type { SidebarEditPreview, SidebarEditLine } from '../sidebar/view';

function linesOf(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n').map(line => line.replace(/\r$/, ''));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function nameOf(name: string): string {
  return name.replace(/^mcp__.+?__/i, '').toLowerCase().replace(/[_-]/g, '');
}

/** Recover the usable object members from a streamed JSON prefix. */
export function parsePartialJson(text: string): Record<string, unknown> | undefined {
  try {
    const complete = JSON.parse(text);
    return complete && typeof complete === 'object' && !Array.isArray(complete) ? complete : undefined;
  } catch { /* A prefix can be repaired below. */ }
  if (!text.trimStart().startsWith('{')) return undefined;
  let source = text;
  for (let attempt = 0; attempt < text.length + 2; attempt++) {
    const stack: string[] = [];
    let quoted = false;
    let escape = false;
    let stringStart = -1;
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (quoted) {
        if (escape) escape = false;
        else if (char === '\\') escape = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') {
        quoted = true;
        stringStart = index;
      } else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') stack.pop();
    }
    if (quoted) {
      const tail = source.slice(stringStart + 1);
      const unicode = tail.match(/\\u[0-9a-fA-F]{0,3}$/);
      if (unicode) source = source.slice(0, -unicode[0].length);
      else if (escape) source = source.slice(0, -1);
      source += '"';
    }
    const repaired = source + stack.reverse().map(char => char === '{' ? '}' : ']').join('');
    try {
      const result = JSON.parse(repaired);
      return result && typeof result === 'object' && !Array.isArray(result) ? result : undefined;
    } catch { /* Remove the last incomplete member or token and retry. */ }
    const end = source.trimEnd();
    if (end.length <= 1) break;
    if (quoted) source = source.slice(0, stringStart);
    else source = end.slice(0, -1);
  }
  return undefined;
}

/** Recognize edit tools regardless of MCP namespace and separator spelling. */
export function isEditTool(name: string): boolean {
  return new Set(['edit', 'multiedit', 'write', 'strreplace', 'strreplacebasededittool', 'writefile', 'editfile', 'editrange', 'applypatch', 'notebookedit']).has(nameOf(name));
}

function patchText(input: Record<string, unknown>): string {
  for (const value of [input.patch, input.input, input.command]) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const found = value.slice(1).find(part => typeof part === 'string' && part.includes('*** '));
      if (typeof found === 'string') return found;
    }
  }
  return '';
}

/** List raw file targets, preserving patch order and excluding duplicates. */
export function editTargets(name: string, input: Record<string, unknown>): string[] {
  if (nameOf(name) === 'applypatch') {
    return [...new Set([...patchText(input).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)\r?$/gm)].map(match => match[1]))];
  }
  const path = input.file_path ?? input.path ?? input.notebook_path;
  return typeof path === 'string' && path ? [path] : [];
}

function lineDiff(before: string[], after: string[]): SidebarEditLine[] {
  // Only the changed middle is diffed: an edit to a large file keeps its numbering and stays cheap at stream rate.
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
    suffix++;
  }
  const oldMiddle = before.slice(prefix, before.length - suffix);
  const newMiddle = after.slice(prefix, after.length - suffix);
  const result: SidebarEditLine[] = [];
  // Only the 3 lines next to the change matter as context; contextHunks trims the rest.
  for (let index = Math.max(0, prefix - 3); index < prefix; index++) {
    result.push({ kind: 'context', text: before[index], oldLine: index + 1, newLine: index + 1 });
  }
  result.push(...middleDiff(oldMiddle, newMiddle, prefix));
  for (let offset = 0; offset < Math.min(3, suffix); offset++) {
    const oldIndex = before.length - suffix + offset;
    const newIndex = after.length - suffix + offset;
    result.push({ kind: 'context', text: before[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 });
  }
  return result;
}

/** LCS line diff of the changed middle; `offset` lines precede it in both versions. */
function middleDiff(before: string[], after: string[], offset: number): SidebarEditLine[] {
  if (before.length > 2000 || after.length > 2000) {
    return [
      ...before.map((text, index) => ({ kind: 'removed' as const, text, oldLine: offset + index + 1 })),
      ...after.map((text, index) => ({ kind: 'added' as const, text, newLine: offset + index + 1 })),
    ];
  }
  const lengths = new Uint16Array((before.length + 1) * (after.length + 1));
  const stride = after.length + 1;
  for (let old = before.length - 1; old >= 0; old--) {
    for (let next = after.length - 1; next >= 0; next--) {
      lengths[old * stride + next] = before[old] === after[next]
        ? lengths[(old + 1) * stride + next + 1] + 1
        : Math.max(lengths[(old + 1) * stride + next], lengths[old * stride + next + 1]);
    }
  }
  const result: SidebarEditLine[] = [];
  let old = 0;
  let next = 0;
  while (old < before.length || next < after.length) {
    if (old < before.length && next < after.length && before[old] === after[next]) {
      result.push({ kind: 'context', text: before[old], oldLine: offset + ++old, newLine: offset + ++next });
    } else if (old < before.length && (next === after.length || lengths[(old + 1) * stride + next] >= lengths[old * stride + next + 1])) {
      result.push({ kind: 'removed', text: before[old], oldLine: offset + ++old });
    } else {
      result.push({ kind: 'added', text: after[next], newLine: offset + ++next });
    }
  }
  return result;
}

function contextHunks(diff: SidebarEditLine[]): SidebarEditLine[] {
  const keep = new Set<number>();
  for (let index = 0; index < diff.length; index++) {
    if (diff[index].kind === 'context') continue;
    for (let nearby = Math.max(0, index - 3); nearby <= Math.min(diff.length - 1, index + 3); nearby++) keep.add(nearby);
  }
  return diff.filter((_, index) => keep.has(index));
}

function text(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof input[key] === 'string') return input[key] as string;
  return undefined;
}

function patchLines(patch: string, files: Record<string, string | undefined>): SidebarEditLine[] {
  const result: SidebarEditLine[] = [];
  let path = '';
  let old = 1;
  let next = 1;
  let inside = false;
  for (const line of linesOf(patch)) {
    const header = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (header) {
      path = header[2];
      old = 1;
      next = 1;
      inside = header[1] !== 'Update';
      continue;
    }
    if (line.startsWith('@@')) {
      inside = true;
      const anchor = line.slice(2).replace(/^\s+|\s+$/g, '');
      const source = linesOf(files[path] ?? '');
      const found = anchor ? source.indexOf(anchor, old - 1) : -1;
      if (found >= 0) old = found + 1;
      next = old;
      continue;
    }
    if (!inside || !path || line.startsWith('***')) continue;
    if (line.startsWith(' ')) result.push({ kind: 'context', text: line.slice(1), oldLine: old++, newLine: next++ });
    else if (line.startsWith('-')) result.push({ kind: 'removed', text: line.slice(1), oldLine: old++ });
    else if (line.startsWith('+')) result.push({ kind: 'added', text: line.slice(1), newLine: next++ });
  }
  return result;
}

/** Build a numbered, context-limited preview without reading the filesystem. */
export function buildEditPreview(options: {
  name: string;
  input: Record<string, unknown>;
  streaming: boolean;
  files: Record<string, string | undefined>;
  displayPath: (raw: string) => string;
}): SidebarEditPreview | undefined {
  const { name, input, streaming, files, displayPath } = options;
  const targets = editTargets(name, input);
  if (!targets.length) return undefined;
  const tool = nameOf(name);
  const original = linesOf(files[targets[0]] ?? '');
  let diff: SidebarEditLine[] = [];
  if (tool === 'applypatch') diff = patchLines(patchText(input), files);
  else if (tool === 'notebookedit') diff = [];
  else if (tool === 'write' || tool === 'writefile') diff = contextHunks(lineDiff(original, linesOf(text(input, 'content') ?? '')));
  else if (tool === 'editrange') {
    const start = Math.max(1, Number(input.startLine) || 1);
    const end = Math.max(start - 1, Number(input.endLine) || start);
    const updated = [...original.slice(0, start - 1), ...linesOf(text(input, 'replacement') ?? ''), ...original.slice(end)];
    diff = contextHunks(lineDiff(original, updated));
  } else {
    const edits = tool === 'multiedit' && Array.isArray(input.edits) ? input.edits : [input];
    let current = original.join('\n');
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') continue;
      const fields = edit as Record<string, unknown>;
      const oldText = text(fields, 'old_string', 'old_str');
      if (!oldText) continue;
      const replacement = text(fields, 'new_string', 'new_str') ?? '';
      // An old_string the file doesn't contain will fail the edit; it must not read as replacing the whole file.
      const position = current.indexOf(oldText);
      if (position < 0) continue;
      current = current.slice(0, position) + replacement + current.slice(position + oldText.length);
    }
    diff = contextHunks(lineDiff(original, linesOf(current)));
  }
  const additions = diff.filter(line => line.kind === 'added').length;
  const deletions = diff.filter(line => line.kind === 'removed').length;
  return {
    path: displayPath(targets[0]), files: Math.max(1, targets.length),
    lines: diff.slice(0, 400), additions, deletions, streaming,
    ...(diff.length > 400 ? { truncated: true } : {}),
  };
}

/** Extract a short human-readable error from a tool result. */
export function errorText(content: unknown): string | undefined {
  const value = typeof content === 'string' ? content : Array.isArray(content)
    ? content.find(item => item && item.type === 'text' && typeof item.text === 'string')?.text : undefined;
  return typeof value === 'string' ? value.replace(/<\/?tool_use_error>/g, '').trim().slice(0, 300) || undefined : undefined;
}
