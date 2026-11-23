/**
 * The model ids picked most recently (newest first), for the model picker's Recents group.
 * Persisted in renderer settings through persist.ts, like the pane layout and theme.
 *
 *   recentModelIds()        reactive list, at most `recentModelLimit`
 *   rememberModel(id)       moves `id` to the front
 */
import { createSignal } from 'solid-js';
import { readPersisted, writePersisted } from '../persist';

export const recentModelLimit = 5;

const persistKey = 'recentModels';

function validIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, recentModelLimit);
}

const [recentIds, setRecentIds] = createSignal<string[]>(validIds(readPersisted<unknown>(persistKey, [])));

export const recentModelIds = recentIds;

export function rememberModel(modelId: string): void {
  if (!modelId) return;
  const next = [modelId, ...recentIds().filter(id => id !== modelId)].slice(0, recentModelLimit);
  setRecentIds(next);
  writePersisted(persistKey, next);
}
