import type { SidebarBackgroundProcess } from '../sidebar/view';

/** How long an ended entry stays in the list before it is dropped. */
const LINGER_MS = 5_000;

/** What a source reports about one background process. */
export interface BackgroundProcessInput {
  id: string;
  kind: SidebarBackgroundProcess['kind'];
  title: string;
  detail?: string;
  /** Stops the process. Given: the entry is stoppable. The list marks it stopped; the source must stop the work. */
  stop?: () => void | Promise<void>;
}

export interface BackgroundProcessListOptions {
  /** Called with the chat's full list after every change. */
  onChange(sessionId: string, processes: SidebarBackgroundProcess[]): void;
  /** Injected timers, so tests need no real waiting. */
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Injected clock (epoch milliseconds). */
  now?: () => number;
}

interface Entry {
  process: SidebarBackgroundProcess;
  /** The source that owns the entry, when it was added through `sync`. */
  source?: string;
  stop?: () => void | Promise<void>;
  timer?: unknown;
}

/** Background processes per chat: a shell command, a subagent or a provider task that runs after the agent's turn. */
export class BackgroundProcessList {
  private readonly chats = new Map<string, Map<string, Entry>>();
  private readonly onChange: BackgroundProcessListOptions['onChange'];
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;

  constructor(options: BackgroundProcessListOptions) {
    this.onChange = options.onChange;
    this.setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimeout ?? (handle => clearTimeout(handle as NodeJS.Timeout));
    this.now = options.now ?? Date.now;
  }

  /** Adds a running process. An existing entry with the same id is replaced. */
  add(sessionId: string, input: BackgroundProcessInput, source?: string): void {
    const entries = this.entriesOf(sessionId);
    const previous = entries.get(input.id);
    if (previous?.timer !== undefined) this.clearTimer(previous.timer);
    entries.set(input.id, {
      process: {
        id: input.id,
        kind: input.kind,
        title: input.title,
        ...(input.detail ? { detail: input.detail } : {}),
        startedAt: this.now(),
        state: 'running',
        ...(input.stop ? { stoppable: true } : {}),
      },
      source,
      stop: input.stop,
    });
    this.changed(sessionId);
  }

  /** Changes the title or detail of a running process. */
  update(sessionId: string, id: string, patch: { title?: string; detail?: string }): void {
    const entry = this.chats.get(sessionId)?.get(id);
    if (!entry || entry.process.state !== 'running') return;
    if (patch.title !== undefined) entry.process.title = patch.title;
    if (patch.detail !== undefined) entry.process.detail = patch.detail || undefined;
    this.changed(sessionId);
  }

  /** Marks a process ended. It lingers for a few seconds, then drops out of the list. */
  end(sessionId: string, id: string, state: 'done' | 'error' | 'stopped' = 'done'): void {
    const entry = this.chats.get(sessionId)?.get(id);
    if (!entry || entry.process.state !== 'running') return;
    entry.process.state = state;
    entry.process.endedAt = this.now();
    delete entry.process.stoppable;
    entry.timer = this.setTimer(() => {
      const entries = this.chats.get(sessionId);
      if (entries?.get(id) === entry) entries.delete(id);
      this.changed(sessionId);
    }, LINGER_MS);
    this.changed(sessionId);
  }

  /**
   * Makes the entries of one source match `items`: new ones are added, changed titles are updated, and running ones
   * that are no longer reported end as done. Entries of other sources are left alone.
   */
  sync(sessionId: string, source: string, items: BackgroundProcessInput[]): void {
    const entries = this.entriesOf(sessionId);
    const reported = new Set(items.map(item => item.id));
    for (const [id, entry] of entries) {
      if (entry.source === source && entry.process.state === 'running' && !reported.has(id)) this.end(sessionId, id, 'done');
    }
    for (const item of items) {
      const existing = entries.get(item.id);
      if (existing?.process.state === 'running' && existing.source === source) {
        const title = item.title;
        if (existing.process.title !== title || existing.process.detail !== item.detail) this.update(sessionId, item.id, { title, detail: item.detail ?? '' });
      } else this.add(sessionId, item, source);
    }
  }

  /** The chat's processes, oldest first. */
  list(sessionId: string): SidebarBackgroundProcess[] {
    return [...(this.chats.get(sessionId)?.values() ?? [])]
      .map(entry => ({ ...entry.process }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Stops a running process through the stop function it was added with. Returns false when the process is unknown,
   * already ended, or not stoppable.
   */
  stop(sessionId: string, id: string): boolean {
    const entry = this.chats.get(sessionId)?.get(id);
    if (!entry || entry.process.state !== 'running' || !entry.stop) return false;
    const stop = entry.stop;
    this.end(sessionId, id, 'stopped');
    try {
      void Promise.resolve(stop()).catch(() => undefined);
    } catch {
      // A failing stop function leaves the entry marked stopped; the source reports its own errors.
    }
    return true;
  }

  /** Drops every process of a chat (the chat was closed or cleared) without a change event for each. */
  clear(sessionId: string): void {
    const entries = this.chats.get(sessionId);
    if (!entries) return;
    for (const entry of entries.values()) if (entry.timer !== undefined) this.clearTimer(entry.timer);
    this.chats.delete(sessionId);
    this.onChange(sessionId, []);
  }

  private entriesOf(sessionId: string): Map<string, Entry> {
    let entries = this.chats.get(sessionId);
    if (!entries) {
      entries = new Map<string, Entry>();
      this.chats.set(sessionId, entries);
    }
    return entries;
  }

  private changed(sessionId: string): void {
    try { this.onChange(sessionId, this.list(sessionId)); } catch { /* A listener error must not break the source. */ }
  }
}
