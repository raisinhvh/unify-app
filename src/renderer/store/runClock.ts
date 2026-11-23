/**
 * When each chat's current turn started, so rows can show elapsed time ("0:42").
 * The protocol has no start time; the renderer notes the moment a chat leaves idle.
 */
import { createEffect, createRoot } from 'solid-js';
import { viewState } from './index';

const startedAt = new Map<string, number>();

createRoot(() => {
  createEffect(() => {
    for (const [sessionId, run] of Object.entries(viewState.runStates)) {
      const running = (run?.state || 'idle') !== 'idle';
      if (running && !startedAt.has(sessionId)) startedAt.set(sessionId, Date.now());
      if (!running) startedAt.delete(sessionId);
    }
  });
});

export function runStartedAt(sessionId: string): number | undefined {
  return startedAt.get(sessionId);
}
