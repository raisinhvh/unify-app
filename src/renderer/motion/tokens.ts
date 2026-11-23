/**
 * Spring tokens (apple-design): period in seconds, damping ratio (1 = no overshoot, lower = bouncier).
 * Pick by what moves, not by taste:
 *   Button     press feedback on anything clickable
 *   Control    toggles, checkboxes, small state flips, quick exits
 *   Indicator  selection highlights, chevrons, focus rings
 *   Accent     attention cues that may wobble a little (counts, badges)
 *   Panel      side panels, splits, rows moving to a new place (FLIP)
 *   Pop        menus, popovers, tooltips, loaders appearing
 *   Reveal     content expanding (tree folders, tool lists)
 *   Sheet      large surfaces sliding in, dragged panes settling
 *   Modal      full-window layers
 */
import { feature } from '../store/features';

export interface SpringToken {
  period: number;
  damping: number;
}

export const springs = {
  button: { period: 0.065, damping: 0.85 },
  control: { period: 0.14, damping: 1 },
  indicator: { period: 0.17, damping: 0.95 },
  accent: { period: 0.2, damping: 0.8 },
  panel: { period: 0.22, damping: 1 },
  pop: { period: 0.24, damping: 0.6 },
  reveal: { period: 0.24, damping: 0.9 },
  sheet: { period: 0.32, damping: 1 },
  modal: { period: 0.4, damping: 1 },
  /** Quick exit for things leaving the screen: no bounce, gone fast. */
  exit: { period: 0.12, damping: 1 },
} satisfies Record<string, SpringToken>;

export type SpringTokenName = keyof typeof springs;

/**
 * Resolves a token name, then calms the spring while `motion.bounce` is off: overshooting presets
 * (damping ratio below 1) are clamped to 1 so they settle without wobble, keeping the same period.
 * Read at spring creation/start, so toggling the feature takes effect on the next animation.
 */
export function resolveToken(token: SpringToken | SpringTokenName): SpringToken {
  const resolved = typeof token === 'string' ? springs[token] : token;
  if (resolved.damping < 1 && !feature<boolean>('motion.bounce')) {
    return { period: resolved.period, damping: 1 };
  }
  return resolved;
}
