/**
 * Organic scheduler: when the agent changes many things at once, only a few animate.
 *
 *   const ticket = claimOrganicSlot();
 *   if (!ticket) landInstantly();                       // over the limit: the change just lands
 *   else setTimeout(start, ticket.delay);               // staggered start; call ticket.release() when done
 *
 * At most `concurrency` organic animations run at a time; starts that arrive together are staggered by
 * `stagger` ms so they read as one person working down a list, not a burst. A ticket released twice is fine.
 */

export const organicScheduling = {
  concurrency: 3,
  stagger: 70,
} as const;

export interface OrganicTicket {
  /** Wait this long before starting (stagger). */
  delay: number;
  release(): void;
}

let running = 0;
let lastStart = -Infinity;

export function claimOrganicSlot(): OrganicTicket | undefined {
  if (running >= organicScheduling.concurrency) return undefined;
  running += 1;
  const now = performance.now();
  const start = Math.max(now, lastStart + organicScheduling.stagger);
  lastStart = start;
  let released = false;
  return {
    delay: Math.round(start - now),
    release() {
      if (released) return;
      released = true;
      running -= 1;
    },
  };
}

/** Animations running right now (for debugging and the gallery). */
export function organicSlotsInUse(): number {
  return running;
}
