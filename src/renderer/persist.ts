/**
 * Renderer-local state that survives reloads (pane layout, route, theme, unread chats...).
 *
 * The bridge persists one value per window, so every module stores its slice under its own key here.
 * Writes are batched into one setState per frame.
 */
import { bridge } from './bridge';

type PersistedSlices = Record<string, unknown>;

let cache: PersistedSlices | undefined;
let flushScheduled = false;

function load(): PersistedSlices {
  if (cache) return cache;
  const stored = bridge().getState<PersistedSlices>();
  cache = stored && typeof stored === 'object' ? { ...stored } : {};
  return cache;
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    bridge().setState(load());
  });
}

export function readPersisted<T>(key: string, fallback: T): T {
  const value = load()[key];
  return value === undefined ? fallback : (value as T);
}

export function writePersisted<T>(key: string, value: T): void {
  load()[key] = value;
  scheduleFlush();
}
