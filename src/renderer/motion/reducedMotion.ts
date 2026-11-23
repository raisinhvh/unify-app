/**
 * Reduced motion: the OS setting or the app's own "Reduce motion" feature.
 * When on, springs that move or scale things snap, and only opacity still fades.
 */
import { createRoot, createSignal } from 'solid-js';

const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined;

const [systemReduced, setSystemReduced] = createRoot(() => createSignal(query?.matches ?? false));
const [appReduced, setAppReduced] = createRoot(() => createSignal(false));

query?.addEventListener('change', event => setSystemReduced(event.matches));

/** Reactive: true when motion should be reduced. */
export function prefersReducedMotion(): boolean {
  return systemReduced() || appReduced();
}

/** Mirrors the engine's `features.reduceMotion` setting. */
export function setAppReducedMotion(reduced: boolean): void {
  setAppReduced(reduced);
}
