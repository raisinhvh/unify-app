/**
 * Renderer-local state that survives reloads (pane layout, route, theme, unread chats...).
 *
 * The bridge persists one value per window, so every module stores its slice under its own key here.
 * Writes are coalesced: a burst (a split dragged, a pane gliding through layouts) sends one setState once it has been
 * quiet for `flushDelay`, instead of one IPC message and one disk write per pointermove. Leaving the page flushes
 * whatever is still pending.
 */
import { bridge } from './bridge';

type PersistedSlices = Record<string, unknown>;

const flushDelay = 250;

let cache: PersistedSlices | undefined;
let flushTimer: number | undefined;

function load(): PersistedSlices {
  if (cache) return cache;
  const stored = bridge().getState<PersistedSlices>();
  cache = stored && typeof stored === 'object' ? { ...stored } : {};
  return cache;
}

function flush(): void {
  if (flushTimer === undefined) return;
  window.clearTimeout(flushTimer);
  flushTimer = undefined;
  bridge().setState(load());
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(flush, flushDelay);
}

window.addEventListener('pagehide', flush);
window.addEventListener('beforeunload', flush);

export function readPersisted<T>(key: string, fallback: T): T {
  const value = load()[key];
  return value === undefined ? fallback : (value as T);
}

export function writePersisted<T>(key: string, value: T): void {
  load()[key] = value;
  scheduleFlush();
}
