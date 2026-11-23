/**
 * createSweptList: holds removed items in place until their select-all sweep has played, then lets them go
 * (an AnimatedList then collapses the row).
 *
 *   const list = createSweptList(() => files(), file => file.path);
 *   <AnimatedList each={list.items()} key={file => file.path}>
 *     {file => <RetypeText value={file().name} deleting={list.leaving(file().path)} onDeleted={() => list.finish(file().path)} />}
 *   </AnimatedList>
 *
 * When the effect is off (or reduced motion) removals pass straight through. A removed item always leaves within
 * `maxSweep` ms even if nothing calls finish (offscreen rows, rows that never rendered a RetypeText).
 * An item that comes back while sweeping is simply kept.
 */
import { createComputed, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from 'solid-js';
import { organicMode, type OrganicEffect } from './enabled';

export interface SweptList<T> {
  /** The source items plus removed ones still sweeping, at their old place. */
  items: Accessor<readonly T[]>;
  /** Reactive: true while the item is removed but still sweeping. */
  leaving: (key: string) => boolean;
  /** The sweep finished: let the item leave (its row collapses). */
  finish: (key: string) => void;
}

export interface SweptListOptions {
  /** Longest a removed item is held (ms). Default 700. */
  maxSweep?: number;
  /** Toggle that governs the sweep. Default 'createDelete' (code lines use 'codeEdits'). */
  effect?: OrganicEffect;
}

export function createSweptList<T>(
  source: Accessor<readonly T[]>,
  key: (item: T) => string,
  options: SweptListOptions = {},
): SweptList<T> {
  const maxSweep = options.maxSweep ?? 700;
  const effect = options.effect ?? 'createDelete';
  const [held, setHeld] = createSignal<ReadonlyMap<string, T>>(new Map());
  const safetyTimers = new Map<string, number>();
  let rendered: readonly T[] = untrack(source);

  const finish = (itemKey: string) => {
    window.clearTimeout(safetyTimers.get(itemKey));
    safetyTimers.delete(itemKey);
    if (!untrack(held).has(itemKey)) return;
    setHeld(current => {
      const updated = new Map(current);
      updated.delete(itemKey);
      return updated;
    });
  };

  createComputed(on(source, list => {
    const present = new Set(list.map(key));
    const current = untrack(held);
    const updated = new Map(current);
    let changed = false;
    for (const itemKey of current.keys()) {
      if (present.has(itemKey)) {
        updated.delete(itemKey);
        window.clearTimeout(safetyTimers.get(itemKey));
        safetyTimers.delete(itemKey);
        changed = true;
      }
    }
    if (organicMode(effect) === 'organic') {
      for (const item of rendered) {
        const itemKey = key(item);
        if (present.has(itemKey) || updated.has(itemKey)) continue;
        updated.set(itemKey, item);
        safetyTimers.set(itemKey, window.setTimeout(() => finish(itemKey), maxSweep));
        changed = true;
      }
    }
    if (changed) setHeld(updated);
  }, { defer: true }));

  const items = createMemo<readonly T[]>(() => {
    const list = source();
    const leavingItems = held();
    if (!leavingItems.size) {
      rendered = list;
      return list;
    }
    // Keep each held item after the item that preceded it last time.
    const merged = [...list];
    const previousKeys = rendered.map(key);
    previousKeys.forEach((itemKey, index) => {
      const item = leavingItems.get(itemKey);
      if (!item) return;
      let insertAt = 0;
      for (let back = index - 1; back >= 0; back -= 1) {
        const at = merged.findIndex(candidate => key(candidate) === previousKeys[back]);
        if (at >= 0) {
          insertAt = at + 1;
          break;
        }
      }
      merged.splice(insertAt, 0, item);
    });
    rendered = merged;
    return merged;
  });

  onCleanup(() => {
    for (const timer of safetyTimers.values()) window.clearTimeout(timer);
  });

  return {
    items,
    leaving: itemKey => held().has(itemKey),
    finish,
  };
}
