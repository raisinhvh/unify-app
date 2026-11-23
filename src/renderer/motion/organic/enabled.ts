/**
 * Which way an organic effect plays right now.
 *
 *   organicMode('rename')   'organic'    the human-like animation
 *                           'crossfade'  reduced motion: a short opacity crossfade, nothing moves
 *                           'instant'    the effect (or motion.organic as a whole) is switched off
 *
 * Reactive (reads feature toggles and reduced motion), so read it at the moment a change happens.
 */
import { feature } from '../../store/features';
import { prefersReducedMotion } from '../reducedMotion';

export type OrganicEffect = 'rename' | 'createDelete' | 'move' | 'counters' | 'codeEdits';

export type OrganicMode = 'organic' | 'crossfade' | 'instant';

export function organicEnabled(effect: OrganicEffect): boolean {
  return feature('motion.organic') && feature(`motion.organic.${effect}`);
}

export function organicMode(effect: OrganicEffect): OrganicMode {
  if (!organicEnabled(effect)) return 'instant';
  return prefersReducedMotion() ? 'crossfade' : 'organic';
}

/** True when the element is rendered, inside the viewport and the window is visible (worth animating). */
export function isOnScreen(element: Element | undefined): boolean {
  if (!element || !element.isConnected) return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  // An empty inline span has no box; judge by the nearest ancestor that has one.
  let box: Element | null = element;
  while (box && box.getClientRects().length === 0) box = box.parentElement;
  if (!box) return false;
  const rect = box.getBoundingClientRect();
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}
