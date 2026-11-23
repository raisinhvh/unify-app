/**
 * liftMoves(container): rows that change place lift like they were picked up, travel, then settle.
 *
 *   <div ref={element => { flipList(element); liftMoves(element); }}> …children with data-flip… </div>
 *
 * Works with motion/flip.ts, which does the travel (the `translate` spring). This adds the "picked up" part:
 * the row that actually moved (not the neighbours that shift to make room) scales to `liftScale`, gets a raised
 * background and soft shadow, rides above its neighbours, and sets back down as flipList's travel nears its end.
 *
 * Which rows moved: the old and new key orders are compared and the rows outside the longest common order
 * (longest increasing subsequence) are the moved ones, so moving one row to the top lifts that row only.
 * Respects 'motion.organic.move' and reduced motion (no lift; flipList itself snaps), and the scheduler
 * (more than a few moving at once just travel without lifting).
 */
import { onCleanup } from 'solid-js';
import { Spring } from '../spring';
import { organicMode } from './enabled';
import { claimOrganicSlot, type OrganicTicket } from './scheduler';
import './organic.css';

/** Scale of a lifted row. */
export const liftScale = 1.02;

/** Set down once the remaining travel is below this share of the distance. */
const setDownAt = 0.35;

/** Longest a row stays lifted if the travel never reports done (ms). */
const maxLift = 900;

interface Lifted {
  spring: Spring;
  /** Held while lifted; cleared once the row is dropped and settling back down. */
  ticket: OrganicTicket | undefined;
  frame: number;
  started: number;
  peak: number;
}

function readTranslate(element: HTMLElement): number {
  const value = element.style.translate;
  if (!value) return 0;
  const [x, y] = value.split(' ').map(part => Number.parseFloat(part) || 0);
  return Math.hypot(x, y ?? 0);
}

/** Indices (into `sequence`) of a longest strictly increasing subsequence. */
function longestIncreasing(sequence: number[]): Set<number> {
  const tails: number[] = [];
  const previous = new Array<number>(sequence.length).fill(-1);
  sequence.forEach((value, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sequence[tails[middle]] < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  });
  const keep = new Set<number>();
  let cursor = tails.length ? tails[tails.length - 1] : -1;
  while (cursor >= 0) {
    keep.add(cursor);
    cursor = previous[cursor];
  }
  return keep;
}

/** Keys whose relative order changed between two orders. */
export function movedKeys(before: readonly string[], after: readonly string[]): string[] {
  const oldIndex = new Map(before.map((key, index) => [key, index]));
  const common = after.filter(key => oldIndex.has(key));
  const keep = longestIncreasing(common.map(key => oldIndex.get(key) as number));
  return common.filter((_, index) => !keep.has(index));
}

export function liftMoves(container: HTMLElement): void {
  const lifted = new Map<HTMLElement, Lifted>();
  const rows = () => [...container.querySelectorAll<HTMLElement>(':scope > [data-flip]')];
  let order = rows().map(row => row.dataset.flip ?? '');

  const paint = (row: HTMLElement, value: number) => {
    const clamped = Math.max(0, value);
    if (clamped < 0.002) {
      row.classList.remove('organic-lifted');
      row.style.removeProperty('--organic-lift');
      row.style.scale = '';
      return;
    }
    row.classList.add('organic-lifted');
    row.style.setProperty('--organic-lift', String(Math.min(1, clamped)));
    row.style.scale = String(1 + (liftScale - 1) * clamped);
  };

  const drop = (row: HTMLElement) => {
    const state = lifted.get(row);
    if (!state) return;
    cancelAnimationFrame(state.frame);
    state.ticket?.release();
    state.ticket = undefined;
    state.spring.set(0, 'panel');
  };

  const watchTravel = (row: HTMLElement, state: Lifted) => {
    const check = () => {
      const remaining = readTranslate(row);
      state.peak = Math.max(state.peak, remaining);
      const elapsed = performance.now() - state.started;
      const nearlyThere = state.peak > 0 && remaining <= state.peak * setDownAt;
      const neverMoved = state.peak === 0 && elapsed > 120;
      if (nearlyThere || neverMoved || elapsed > maxLift || !row.isConnected) {
        drop(row);
        return;
      }
      state.frame = requestAnimationFrame(check);
    };
    state.frame = requestAnimationFrame(check);
  };

  const lift = (row: HTMLElement) => {
    const existing = lifted.get(row);
    if (existing) {
      // Moved again mid-flight: stay up and keep watching the new travel. A row already dropped (settling
      // back down) released its ticket, so it needs a new one or it just travels without lifting.
      if (!existing.ticket) {
        existing.ticket = claimOrganicSlot();
        if (!existing.ticket) return;
      }
      cancelAnimationFrame(existing.frame);
      existing.started = performance.now();
      existing.peak = 0;
      existing.spring.set(1, 'control');
      watchTravel(row, existing);
      return;
    }
    const ticket = claimOrganicSlot();
    if (!ticket) return;
    const spring = new Spring(0, 'control', 1);
    const state: Lifted = { spring, ticket, frame: 0, started: performance.now(), peak: 0 };
    spring.onChange(value => paint(row, value));
    spring.onRest(value => {
      if (value === 0) {
        paint(row, 0);
        lifted.delete(row);
      }
    });
    lifted.set(row, state);
    spring.set(1, 'control');
    watchTravel(row, state);
  };

  const observer = new MutationObserver(() => {
    const current = rows();
    const nextOrder = current.map(row => row.dataset.flip ?? '');
    const moved = new Set(movedKeys(order, nextOrder));
    order = nextOrder;
    if (!moved.size || organicMode('move') !== 'organic') return;
    for (const row of current) {
      if (moved.has(row.dataset.flip ?? '')) lift(row);
    }
  });
  observer.observe(container, { childList: true });

  onCleanup(() => {
    observer.disconnect();
    for (const [row, state] of lifted) {
      cancelAnimationFrame(state.frame);
      state.ticket?.release();
      state.spring.stop();
      paint(row, 0);
    }
    lifted.clear();
  });
}
