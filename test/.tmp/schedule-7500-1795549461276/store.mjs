// src/engine/schedule/store.ts
import { randomUUID } from "node:crypto";
var SCHEDULE_KEY = "unify.scheduledPrompts";
var MAX_TIMER_MS = 2147483647;
var STARTUP_GRACE_MS = 3e3;
var ScheduledPrompts = class {
  constructor(context, options) {
    this.context = context;
    this.options = options;
    this.load();
    const now = Date.now();
    this.grace = this.prompts.some((item) => item.dueAt <= now);
    this.arm();
  }
  prompts = [];
  images = /* @__PURE__ */ new Map();
  timer;
  disposed = false;
  /** The first batch that was already due at start-up waits briefly so chat history is back on screen. */
  grace = false;
  /** Adds a prompt, arms the timer and returns the item as the sidebar sees it. */
  add(input) {
    const project = this.options.project();
    const item = {
      id: randomUUID(),
      prompt: input.prompt.trim(),
      dueAt: Math.round(input.dueAt),
      createdAt: Date.now(),
      ...input.chatId ? { chatId: input.chatId } : {},
      ...project ? { project } : {}
    };
    this.prompts.push(item);
    if (input.images?.length) {
      this.images.set(item.id, input.images.map((image) => ({ name: image.name, mimeType: image.mimeType, data: image.data })));
    }
    this.save();
    this.arm();
    this.options.changed?.();
    return this.message(item);
  }
  /** Drops a pending prompt; returns whether it existed. */
  cancel(id) {
    const index = this.prompts.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.prompts.splice(index, 1);
    this.images.delete(id);
    this.save();
    this.arm();
    this.options.changed?.();
    return true;
  }
  /** Removes one prompt and returns it with its images, for "send now". */
  take(id) {
    const index = this.prompts.findIndex((item) => item.id === id);
    if (index === -1) return void 0;
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
  takeDue(now) {
    const project = this.options.project();
    const due = this.prompts.filter((item) => item.dueAt <= now && (!item.project || item.project === project)).sort((a, b) => a.dueAt - b.dueAt);
    if (!due.length) return [];
    const ids = new Set(due.map((item) => item.id));
    this.prompts = this.prompts.filter((item) => !ids.has(item.id));
    const result = due.map((item) => {
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
  list() {
    const project = this.options.project();
    return this.prompts.filter((item) => !item.project || item.project === project).sort((a, b) => a.dueAt - b.dueAt).map((item) => this.message(item));
  }
  /** Re-arms the timer, e.g. from `ready` after the webview (and its project) is known. */
  refresh() {
    this.arm();
  }
  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = void 0;
  }
  message(item) {
    const count = this.images.get(item.id)?.length || 0;
    return {
      id: item.id,
      prompt: item.prompt,
      dueAt: item.dueAt,
      createdAt: item.createdAt,
      ...item.chatId ? { chatId: item.chatId } : {},
      ...count ? { imageCount: count } : {}
    };
  }
  load() {
    const stored = this.context.globalState.get(SCHEDULE_KEY, {});
    const prompts = Array.isArray(stored?.prompts) ? stored.prompts : [];
    const images = stored?.images && typeof stored.images === "object" ? stored.images : {};
    for (const value of prompts) {
      if (!value || typeof value.id !== "string" || typeof value.prompt !== "string") continue;
      if (!Number.isFinite(value.dueAt) || !Number.isFinite(value.createdAt)) continue;
      this.prompts.push({
        id: value.id,
        prompt: value.prompt,
        dueAt: value.dueAt,
        createdAt: value.createdAt,
        ...typeof value.chatId === "string" ? { chatId: value.chatId } : {},
        ...typeof value.project === "string" ? { project: value.project } : {}
      });
      const saved = Array.isArray(images[value.id]) ? images[value.id] : [];
      const valid = saved.filter((image) => image && typeof image.name === "string" && typeof image.mimeType === "string" && typeof image.data === "string");
      if (valid.length) this.images.set(value.id, valid);
    }
  }
  save() {
    const images = {};
    for (const [id, items] of this.images) {
      if (this.prompts.some((item) => item.id === id)) images[id] = items;
    }
    void this.context.globalState.update(SCHEDULE_KEY, { prompts: this.prompts, images });
  }
  /**
   * Arms one timer: immediately for a due prompt in this project, otherwise at the next future
   * prompt (any project) or the clamp, whichever is sooner.
   */
  arm() {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = void 0;
    const now = Date.now();
    const project = this.options.project();
    const dueNow = this.prompts.some((item) => item.dueAt <= now && (!item.project || item.project === project));
    let delay;
    if (dueNow) {
      delay = this.grace ? STARTUP_GRACE_MS : 0;
    } else {
      let next;
      for (const item of this.prompts) {
        if (item.dueAt <= now) continue;
        if (next === void 0 || item.dueAt < next) next = item.dueAt;
      }
      if (next === void 0) return;
      delay = Math.min(next - now, MAX_TIMER_MS);
    }
    this.grace = false;
    this.timer = setTimeout(() => {
      this.timer = void 0;
      this.fireDue();
    }, Math.max(0, delay));
    this.timer.unref?.();
  }
  fireDue() {
    if (this.disposed) return;
    const due = this.takeDue(Date.now());
    for (const item of due) this.options.fire(item.prompt, item.images);
    this.arm();
  }
};
export {
  SCHEDULE_KEY,
  ScheduledPrompts
};
