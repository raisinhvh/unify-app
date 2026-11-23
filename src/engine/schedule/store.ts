/**
 * Pending `/schedule` prompts, persisted globally so they survive project switches and app restarts.
 *
 * Prompts are only sent for the project they were scheduled in; the store arms one timer for the
 * next due item rather than one per prompt. Images live in a separate map and are never part of the
 * `scheduledPromptsState` message (it only carries `imageCount`).
 */
import { randomUUID } from 'node:crypto';
import type { SidebarImage, SidebarScheduledPrompt } from '../sidebar/view';

/** Global-state key for the stored prompts and their images. */
export const SCHEDULE_KEY = 'unify.scheduledPrompts';

/** setTimeout clamps larger delays to this and fires immediately, so long waits re-arm in chunks. */
const MAX_TIMER_MS = 2_147_483_647;
/** Prompts that came due while the app was closed wait for chats to be restored. */
const STARTUP_GRACE_MS = 3_000;

/** A stored prompt: the message shape plus the project path it belongs to. */
export interface ScheduledPrompt extends SidebarScheduledPrompt {
  /** Project the prompt was scheduled from; missing means any project (scheduled from Home). */
  project?: string;
}

export interface ScheduledPromptInput {
  prompt: string;
  dueAt: number;
  chatId?: string;
  images?: SidebarImage[];
}

/** The slice of `vscode.Memento` this store needs, so tests can use a fake. */
export interface ScheduleMemento {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): Promise<unknown> | void;
}

export interface ScheduledPromptsOptions {
  /** The current project path, or undefined when no folder is open. */
  project(): string | undefined;
  /** Called with prompts that just came due for the current project. */
  fire(prompt: ScheduledPrompt, images: SidebarImage[]): void;
  /** Called after any change, including firing, so the sidebar can refresh its list. */
  changed?(): void;
}

interface StoredState {
  prompts: ScheduledPrompt[];
  images: Record<string, SidebarImage[]>;
}

export class ScheduledPrompts {
  private prompts: ScheduledPrompt[] = [];
  private readonly images = new Map<string, SidebarImage[]>();
  private timer?: NodeJS.Timeout;
  private disposed = false;
  /** The first batch that was already due at start-up waits briefly so chat history is back on screen. */
  private grace = false;

  public constructor(
    private readonly context: { globalState: ScheduleMemento },
    private readonly options: ScheduledPromptsOptions,
  ) {
    this.load();
    const now = Date.now();
    this.grace = this.prompts.some(item => item.dueAt <= now);
    this.arm();
  }

  /** Adds a prompt, arms the timer and returns the item as the sidebar sees it. */
  public add(input: ScheduledPromptInput): SidebarScheduledPrompt {
    const project = this.options.project();
    const item: ScheduledPrompt = {
      id: randomUUID(),
      prompt: input.prompt.trim(),
      dueAt: Math.round(input.dueAt),
      createdAt: Date.now(),
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(project ? { project } : {}),
    };
    this.prompts.push(item);
    if (input.images?.length) {
      this.images.set(item.id, input.images.map(image => ({ name: image.name, mimeType: image.mimeType, data: image.data })));
    }
    this.save();
    this.arm();
    this.options.changed?.();
    return this.message(item);
  }

  /** Drops a pending prompt; returns whether it existed. */
  public cancel(id: string): boolean {
    const index = this.prompts.findIndex(item => item.id === id);
    if (index === -1) return false;
    this.prompts.splice(index, 1);
    this.images.delete(id);
    this.save();
    this.arm();
    this.options.changed?.();
    return true;
  }

  /** Removes one prompt and returns it with its images, for "send now". */
  public take(id: string): { prompt: ScheduledPrompt; images: SidebarImage[] } | undefined {
    const index = this.prompts.findIndex(item => item.id === id);
    if (index === -1) return undefined;
    const prompt = this.prompts[index];
    this.prompts.splice(index, 1);
    const images = this.images.get(id) || [];
    this.images.delete(id);
    this.save();
    this.arm();
    this.options.changed?.();
    return { prompt, images };
  }

  /** Removes and returns the prompts for the current project that are due at or before `now`. */
  public takeDue(now: number): { prompt: ScheduledPrompt; images: SidebarImage[] }[] {
    const project = this.options.project();
    const due = this.prompts
      .filter(item => item.dueAt <= now && (!item.project || item.project === project))
      .sort((a, b) => a.dueAt - b.dueAt);
    if (!due.length) return [];
    const ids = new Set(due.map(item => item.id));
    this.prompts = this.prompts.filter(item => !ids.has(item.id));
    const result = due.map(item => {
      const images = this.images.get(item.id) || [];
      this.images.delete(item.id);
      return { prompt: item, images };
    });
    this.save();
    this.arm();
    this.options.changed?.();
    return result;
  }

  /** The current project's pending prompts, soonest first, in the sidebar's message shape. */
  public list(): SidebarScheduledPrompt[] {
    const project = this.options.project();
    return this.prompts
      .filter(item => !item.project || item.project === project)
      .sort((a, b) => a.dueAt - b.dueAt)
      .map(item => this.message(item));
  }

  /** Re-arms the timer, e.g. from `ready` after the webview (and its project) is known. */
  public refresh(): void {
    this.arm();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private message(item: ScheduledPrompt): SidebarScheduledPrompt {
    const count = this.images.get(item.id)?.length || 0;
    return {
      id: item.id,
      prompt: item.prompt,
      dueAt: item.dueAt,
      createdAt: item.createdAt,
      ...(item.chatId ? { chatId: item.chatId } : {}),
      ...(count ? { imageCount: count } : {}),
    };
  }

  private load(): void {
    const stored = this.context.globalState.get<Partial<StoredState>>(SCHEDULE_KEY, {});
    const prompts = Array.isArray(stored?.prompts) ? stored.prompts : [];
    const images = stored?.images && typeof stored.images === 'object' ? stored.images : {};
    for (const value of prompts) {
      if (!value || typeof value.id !== 'string' || typeof value.prompt !== 'string') continue;
      if (!Number.isFinite(value.dueAt) || !Number.isFinite(value.createdAt)) continue;
      this.prompts.push({
        id: value.id,
        prompt: value.prompt,
        dueAt: value.dueAt,
        createdAt: value.createdAt,
        ...(typeof value.chatId === 'string' ? { chatId: value.chatId } : {}),
        ...(typeof value.project === 'string' ? { project: value.project } : {}),
      });
      const saved = Array.isArray(images[value.id]) ? images[value.id] : [];
      const valid = saved.filter(image => image && typeof image.name === 'string' && typeof image.mimeType === 'string' && typeof image.data === 'string');
      if (valid.length) this.images.set(value.id, valid);
    }
  }

  private save(): void {
    const images: Record<string, SidebarImage[]> = {};
    for (const [id, items] of this.images) {
      if (this.prompts.some(item => item.id === id)) images[id] = items;
    }
    void this.context.globalState.update(SCHEDULE_KEY, { prompts: this.prompts, images } satisfies StoredState);
  }

  /**
   * Arms one timer: immediately for a due prompt in this project, otherwise at the next future
   * prompt (any project) or the clamp, whichever is sooner.
   */
  private arm(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    const project = this.options.project();
    const dueNow = this.prompts.some(item => item.dueAt <= now && (!item.project || item.project === project));
    let delay: number;
    if (dueNow) {
      delay = this.grace ? STARTUP_GRACE_MS : 0;
    } else {
      let next: number | undefined;
      for (const item of this.prompts) {
        if (item.dueAt <= now) continue;
        if (next === undefined || item.dueAt < next) next = item.dueAt;
      }
      if (next === undefined) return;
      delay = Math.min(next - now, MAX_TIMER_MS);
    }
    this.grace = false;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.fireDue();
    }, Math.max(0, delay));
    this.timer.unref?.();
  }

  private fireDue(): void {
    if (this.disposed) return;
    const due = this.takeDue(Date.now());
    for (const item of due) this.options.fire(item.prompt, item.images);
    this.arm();
  }
}
