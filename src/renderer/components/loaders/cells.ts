/**
 * Loader cell model.
 *
 * Every loader is a pure function of time that returns the cells to draw in a 16×16 box. A cell is a small
 * rectangle with a stable `key`, a tone (0 = dim wood, 1 = bright wood) and optional opacity/outline.
 * Because loaders are data, two loaders that share cell keys can morph into each other: the shared cells
 * spring from where they were to where the new loader wants them (see LoaderMorph.tsx).
 *
 * Keys shared on purpose: the 3×3 grids (Sift, Develop) use g0..g8, Quad uses g0, g2, g8, g6 for its corners,
 * Split's four squares reuse the same g keys, and line loaders (Lay, Press, Checks) use l0..l3.
 */

export interface LoaderCell {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0 = dim (--loader-dim), 1 = bright (--wood-light). */
  tone: number;
  opacity?: number;
  /** Drawn as a 1px outline instead of filled. */
  outline?: boolean;
  radius?: number;
}

export type LoaderFrame = (seconds: number) => LoaderCell[];

export const cell = (
  key: string,
  x: number,
  y: number,
  width: number,
  height: number,
  tone: number,
  extra: Partial<LoaderCell> = {},
): LoaderCell => ({ key, x, y, width, height, tone, ...extra });

/** 0..1 position inside a repeating cycle. */
export const phase = (seconds: number, period: number, offset = 0): number => {
  const value = (seconds + offset) / period;
  return value - Math.floor(value);
};

/** Smooth 0..1 ease (in-out), used inside loaders so steps glide instead of snapping. */
export const smooth = (value: number): number => {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
};

/** 0..1 over [start, end] of a 0..1 phase, eased. */
export const span = (value: number, start: number, end: number): number => smooth((value - start) / (end - start));

export const mix = (from: number, to: number, amount: number): number => from + (to - from) * amount;

/** Brightness that rises and falls around a centre (a light passing by). */
export const pulse = (distance: number, width: number): number => Math.max(0, 1 - Math.abs(distance) / width);

/** The 3×3 grid used by Sift and Develop: 4px cells, 1.5px gaps, centred in 16px. */
export const gridCell = (index: number): { x: number; y: number } => ({
  x: 1.75 + (index % 3) * 4.5,
  y: 1.75 + Math.floor(index / 3) * 4.5,
});
