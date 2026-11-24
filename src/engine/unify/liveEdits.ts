/**
 * Live edit preview (spec "Live edit preview in chat"): follows each edit tool call of one agent turn, from its first
 * streamed input to its result, and builds the diff its chat row shows.
 *
 * The files a call touches are read once, the first time the call names them, so the diff is always against the
 * file as it was before the edit landed. The last preview is kept, so the finished row still shows the change after
 * the file on disk has moved on.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SidebarEditPreview } from '../sidebar/view';
import { buildEditPreview, editTargets, isEditTool } from '../runtime/editPreview';

/** Larger files are not read; their preview has changes but no file context. */
const MAX_FILE_BYTES = 2_000_000;

interface TrackedCall {
  name: string;
  files: Record<string, string | undefined>;
  preview?: SidebarEditPreview;
}

export class LiveEdits {
  private readonly calls = new Map<string, TrackedCall>();

  constructor(private readonly cwd: string) {}

  /** Whether a tool name is one this tracker previews. */
  static handles(name: string): boolean {
    return isEditTool(name);
  }

  /**
   * ACP runtimes title a call for people ("Edit src/a.ts", "Writing file") and give its kind separately.
   * Returns the edit tool name to preview the call as, or undefined when it is not an edit.
   */
  static acpToolName(title: string, rawKind: string, input: Record<string, unknown>): string | undefined {
    const first = title.trim().split(/\s+/)[0] || '';
    if (isEditTool(first)) {
      return first;
    }
    if (rawKind.toLowerCase() !== 'edit' && !/edit|write|patch/i.test(title)) {
      return undefined;
    }
    if (Array.isArray(input.edits)) {
      return 'MultiEdit';
    }
    if ('old_string' in input || 'old_str' in input) {
      return 'Edit';
    }
    if ('replacement' in input && 'startLine' in input) {
      return 'edit_range';
    }
    if ('content' in input) {
      return 'Write';
    }
    if ('patch' in input || typeof input.input === 'string') {
      return 'apply_patch';
    }
    return undefined;
  }

  /** The preview for a call's input so far (`streaming`) or complete. Undefined until the input names a file. */
  update(id: string, name: string, input: Record<string, unknown>, streaming: boolean): SidebarEditPreview | undefined {
    const call = this.calls.get(id) ?? { name, files: {} };
    this.calls.set(id, call);
    for (const target of editTargets(name, input)) {
      if (!(target in call.files)) {
        call.files[target] = this.readBefore(target);
      }
    }
    const preview = buildEditPreview({ name, input, streaming, files: call.files, displayPath: raw => this.displayPath(raw) });
    if (preview) {
      call.preview = preview;
    }
    return call.preview;
  }

  /** The last preview of a call, marked finished (and failed when `error` is set). Forgets the call. */
  finish(id: string, error?: string): SidebarEditPreview | undefined {
    const call = this.calls.get(id);
    this.calls.delete(id);
    if (!call?.preview) {
      return undefined;
    }
    return { ...call.preview, streaming: false, ...(error ? { error } : {}) };
  }

  /** The last preview of a call without finishing it. */
  current(id: string): SidebarEditPreview | undefined {
    return this.calls.get(id)?.preview;
  }

  clear(): void {
    this.calls.clear();
  }

  private absolutePath(raw: string): string {
    return isAbsolute(raw) ? raw : resolve(this.cwd, raw);
  }

  private displayPath(raw: string): string {
    const absolute = this.absolutePath(raw);
    const inside = relative(this.cwd, absolute);
    return (inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : absolute).replace(/\\/g, '/');
  }

  private readBefore(raw: string): string | undefined {
    try {
      const path = this.absolutePath(raw);
      if (statSync(path).size > MAX_FILE_BYTES) {
        return undefined;
      }
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  }
}
