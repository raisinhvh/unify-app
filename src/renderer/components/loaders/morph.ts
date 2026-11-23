/**
 * Seamless loader morphs. Any loader (or status glyph, or nothing) blends into any other, cell to cell.
 *
 * Every rectangle on screen is a Track. A track follows one cell of the current loader (by key) and adds a
 * spring offset on top of it for every drawn property (position, size, tone, ink, outline, radius, angle,
 * opacity). At rest the offsets are 0, so the loader animates exactly as defined. On a change:
 *
 *   1. what is on screen now is the start (mid-morph included), with each offset's current velocity;
 *   2. on-screen cells pair with the incoming cells: same key first, then nearest position;
 *   3. spare on-screen cells merge into their nearest incoming cell (travel onto it while fading);
 *      spare incoming cells split out of their nearest on-screen cell (start on top of it, then travel);
 *   4. to nothing (idle): every cell gathers into the centre point; from nothing: cells unfold from it.
 *
 * Offsets spring to 0 on the morph token (response 0.35 s, damping 1: no overshoot), so position, colour and
 * opacity share one curve. A change mid-morph repeats the steps from the current on-screen cells, keeping their
 * velocity: it continues, never restarts. Reduced motion: a plain crossfade on the Control spring.
 */
import { Spring, type SpringToken } from '../../motion';
import type { LoaderCell } from './cells';

export const morphToken: SpringToken = { period: 0.35, damping: 1 };

const crossfadeToken: SpringToken = { period: 0.14, damping: 1 };

const shapeKeys = ['x', 'y', 'width', 'height', 'tone', 'ink', 'hollow', 'radius', 'angle', 'opacity'] as const;

type ShapeKey = (typeof shapeKeys)[number];

/** A cell as numbers only, so every property can be offset and sprung. `hollow` is 0 (filled) to 1 (outline). */
export type Shape = Record<ShapeKey, number>;

type Velocities = Partial<Record<ShapeKey, number>>;

/** The loader drawing is 16 units; idle gathers into its centre. */
const centre = 8;

/** Presence below this counts as gone (a merged cell that finished fading). */
const goneThreshold = 0.002;

/** Extra matching cost for pairing with a cell that is mostly faded out, so visible cells pair first. */
const fadedPenalty = 8;

export function shapeOf(item: LoaderCell): Shape {
  return {
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    tone: item.tone,
    ink: item.ink ?? 0,
    hollow: item.outline ? 1 : 0,
    radius: item.radius ?? 0.5,
    angle: item.angle ?? 0,
    opacity: item.opacity ?? 1,
  };
}

/** A shape collapsed to a point at (x, y), keeping its colour. */
function pointShape(like: Shape, x: number, y: number): Shape {
  return {
    ...like,
    x,
    y,
    width: 0,
    height: 0,
    radius: 0,
  };
}

function centreX(shape: Shape): number {
  return shape.x + shape.width / 2;
}

function centreY(shape: Shape): number {
  return shape.y + shape.height / 2;
}

function matchCost(from: Shape, to: Shape): number {
  const distance = Math.hypot(centreX(from) - centreX(to), centreY(from) - centreY(to));
  const sizeChange = Math.abs(from.width - to.width) + Math.abs(from.height - to.height);
  return distance + sizeChange * 0.5;
}

/** Angle difference in -180..180, so a stroke turns the short way. */
function angleDifference(from: number, to: number): number {
  const difference = (((from - to) % 360) + 540) % 360 - 180;
  return difference;
}

interface Track {
  /** DOM key of the rect drawing this track. */
  id: string;
  /** Key of the incoming cell this track follows. */
  key: string | undefined;
  /** Fixed target instead of a cell (the idle point, or a reduced-motion crossfade holding still). */
  anchor: Shape | undefined;
  /** Last target seen, used if the followed cell leaves its own loader's frame mid-morph. */
  last: Shape | undefined;
  /** Spring offsets added to the target; only created for properties that differ. */
  offsets: Partial<Record<ShapeKey, Spring>>;
  /** 1 = fully drawn. Merging cells spring to 0 and are dropped once there. */
  presence: Spring;
  leaving: boolean;
  /** Raw shape drawn last frame (opacity before presence). */
  shown: Shape | undefined;
}

export interface DrawnCell {
  id: string;
  shape: Shape;
  /** Final opacity: the shape's opacity times presence. */
  alpha: number;
}

interface Source {
  track: Track;
  shape: Shape;
  presence: number;
  presenceVelocity: number;
  velocities: Velocities;
}

let trackCounter = 0;

export class LoaderMorph {
  private tracks: Track[] = [];

  /** Cells to draw for this frame of the current loader. Creates tracks for cells that have none yet. */
  frame(cells: LoaderCell[]): DrawnCell[] {
    const byKey = new Map(cells.map(item => [item.key, item]));
    const followed = new Set<string>();
    for (const track of this.tracks) {
      if (!track.leaving && track.key) followed.add(track.key);
    }
    for (const item of cells) {
      if (followed.has(item.key)) continue;
      // A loader's own cell appearing (its animation, or first mount): no morph, it is part of the loader.
      this.tracks.push(this.createTrack(item.key, 1));
    }

    const drawn: DrawnCell[] = [];
    const kept: Track[] = [];
    for (const track of this.tracks) {
      const followedCell = track.key ? byKey.get(track.key) : undefined;
      if (followedCell) track.last = shapeOf(followedCell);
      const target = track.anchor ?? track.last;
      if (!target) {
        this.disposeTrack(track);
        continue;
      }
      if (this.finished(track, !!followedCell)) {
        this.disposeTrack(track);
        continue;
      }
      const shape = this.offsetShape(track, target);
      track.shown = shape;
      kept.push(track);
      const presence = Math.max(0, Math.min(1, track.presence.value));
      const alpha = Math.max(0, Math.min(1, shape.opacity)) * presence;
      drawn.push({ id: track.id, shape, alpha });
    }
    this.tracks = kept;
    return drawn;
  }

  /** The loader changed: blend what is on screen into `cells` (the incoming loader's current frame). */
  retarget(cells: LoaderCell[], reduced: boolean): void {
    const sources = this.snapshot();
    const targets = cells.map(item => ({ key: item.key, shape: shapeOf(item) }));
    if (reduced) {
      this.crossfade(sources, targets);
      return;
    }
    if (!targets.length) {
      for (const source of sources) {
        const anchor = pointShape(source.shape, centre, centre);
        this.follow(source.track, undefined, anchor, source, true);
      }
      return;
    }
    if (!sources.length) {
      for (const target of targets) {
        const track = this.createTrack(target.key, 0, target.shape);
        const from = pointShape(target.shape, centre, centre);
        this.setOffsets(track, from, target.shape, {});
        track.shown = from;
        track.presence.set(1, morphToken);
        this.tracks.push(track);
      }
      return;
    }

    const pairs = this.pair(sources, targets);
    const pairedSources = new Set<Source>();
    const pairedTargets = new Set<number>();
    for (const [source, targetIndex] of pairs) {
      pairedSources.add(source);
      pairedTargets.add(targetIndex);
      this.follow(source.track, targets[targetIndex].key, targets[targetIndex].shape, source, false);
    }
    // Spare on-screen cells merge into the nearest incoming cell.
    for (const source of sources) {
      if (pairedSources.has(source)) continue;
      const nearest = this.nearestTarget(source.shape, targets);
      this.follow(source.track, targets[nearest].key, targets[nearest].shape, source, true);
    }
    // Spare incoming cells split out of the nearest on-screen cell.
    targets.forEach((target, targetIndex) => {
      if (pairedTargets.has(targetIndex)) return;
      const nearest = this.nearestSource(target.shape, sources);
      const track = this.createTrack(target.key, nearest.presence, target.shape);
      this.setOffsets(track, nearest.shape, target.shape, nearest.velocities);
      track.presence.impulse(nearest.presenceVelocity);
      track.presence.set(1, morphToken);
      track.shown = nearest.shape;
      this.tracks.push(track);
    });
  }

  dispose(): void {
    for (const track of this.tracks) this.disposeTrack(track);
    this.tracks = [];
  }

  private snapshot(): Source[] {
    const sources: Source[] = [];
    for (const track of this.tracks) {
      if (!track.shown) {
        this.disposeTrack(track);
        continue;
      }
      const presence = track.presence.value;
      if (presence <= goneThreshold && track.presence.target <= 0) {
        this.disposeTrack(track);
        continue;
      }
      const velocities: Velocities = {};
      for (const key of shapeKeys) {
        const spring = track.offsets[key];
        if (spring) velocities[key] = spring.velocity;
      }
      sources.push({
        track,
        shape: { ...track.shown },
        presence,
        presenceVelocity: track.presence.velocity,
        velocities,
      });
    }
    this.tracks = sources.map(source => source.track);
    return sources;
  }

  /** One-to-one pairs: same key first (visible cells before fading ones), then cheapest pairs by distance. */
  private pair(sources: Source[], targets: { key: string; shape: Shape }[]): [Source, number][] {
    const pairs: [Source, number][] = [];
    const usedSources = new Set<Source>();
    const usedTargets = new Set<number>();
    const byVisibility = [...sources].sort((first, second) => second.presence - first.presence);
    for (const source of byVisibility) {
      const targetIndex = targets.findIndex((target, index) => !usedTargets.has(index) && target.key === source.track.key);
      if (targetIndex < 0) continue;
      pairs.push([source, targetIndex]);
      usedSources.add(source);
      usedTargets.add(targetIndex);
    }
    const candidates: { source: Source; targetIndex: number; cost: number }[] = [];
    for (const source of sources) {
      if (usedSources.has(source)) continue;
      targets.forEach((target, targetIndex) => {
        if (usedTargets.has(targetIndex)) return;
        const cost = matchCost(source.shape, target.shape) + (1 - source.presence) * fadedPenalty;
        candidates.push({ source, targetIndex, cost });
      });
    }
    candidates.sort((first, second) => first.cost - second.cost);
    for (const candidate of candidates) {
      if (usedSources.has(candidate.source) || usedTargets.has(candidate.targetIndex)) continue;
      pairs.push([candidate.source, candidate.targetIndex]);
      usedSources.add(candidate.source);
      usedTargets.add(candidate.targetIndex);
    }
    return pairs;
  }

  private nearestTarget(shape: Shape, targets: { key: string; shape: Shape }[]): number {
    let best = 0;
    let bestCost = Infinity;
    targets.forEach((target, index) => {
      const cost = matchCost(shape, target.shape);
      if (cost < bestCost) {
        bestCost = cost;
        best = index;
      }
    });
    return best;
  }

  private nearestSource(shape: Shape, sources: Source[]): Source {
    let best = sources[0];
    let bestCost = Infinity;
    for (const source of sources) {
      const cost = matchCost(source.shape, shape) + (1 - source.presence) * fadedPenalty;
      if (cost < bestCost) {
        bestCost = cost;
        best = source;
      }
    }
    return best;
  }

  /** Points a track at a new target, starting from where it is on screen and keeping its velocity. */
  private follow(track: Track, key: string | undefined, target: Shape, source: Source, leaving: boolean): void {
    track.key = key;
    track.anchor = key ? undefined : target;
    track.last = target;
    track.leaving = leaving;
    this.setOffsets(track, source.shape, target, source.velocities);
    track.presence.set(leaving ? 0 : 1, morphToken);
  }

  private crossfade(sources: Source[], targets: { key: string; shape: Shape }[]): void {
    for (const source of sources) {
      for (const key of shapeKeys) source.track.offsets[key]?.stop();
      source.track.offsets = {};
      source.track.key = undefined;
      source.track.anchor = source.shape;
      source.track.leaving = true;
      source.track.presence.set(0, crossfadeToken);
    }
    for (const target of targets) {
      const track = this.createTrack(target.key, 0, target.shape);
      track.shown = target.shape;
      track.presence.set(1, crossfadeToken);
      this.tracks.push(track);
    }
  }

  private setOffsets(track: Track, from: Shape, target: Shape, velocities: Velocities): void {
    for (const key of shapeKeys) {
      const difference = key === 'angle' ? angleDifference(from.angle, target.angle) : from[key] - target[key];
      const velocity = velocities[key] ?? 0;
      let spring = track.offsets[key];
      if (!spring) {
        if (Math.abs(difference) < 1e-6 && Math.abs(velocity) < 1e-6) continue;
        spring = new Spring(0, morphToken, 1);
        track.offsets[key] = spring;
      }
      spring.jump(difference);
      if (velocity) spring.impulse(velocity);
      spring.set(0, morphToken);
    }
  }

  private offsetShape(track: Track, target: Shape): Shape {
    const shape = { ...target };
    for (const key of shapeKeys) {
      const spring = track.offsets[key];
      if (spring) shape[key] += spring.value;
    }
    shape.width = Math.max(0, shape.width);
    shape.height = Math.max(0, shape.height);
    shape.radius = Math.max(0, shape.radius);
    return shape;
  }

  private finished(track: Track, cellPresent: boolean): boolean {
    if (track.leaving) return track.presence.value <= goneThreshold && !track.presence.moving;
    if (track.anchor || cellPresent) return false;
    // The followed cell left its own loader's frame: drop the track once its morph is over.
    return !shapeKeys.some(key => track.offsets[key]?.moving);
  }

  private createTrack(key: string, presence: number, last?: Shape): Track {
    trackCounter += 1;
    return {
      id: `t${trackCounter}`,
      key,
      anchor: undefined,
      last,
      offsets: {},
      presence: new Spring(presence, morphToken, 1),
      leaving: false,
      shown: undefined,
    };
  }

  private disposeTrack(track: Track): void {
    track.presence.stop();
    for (const key of shapeKeys) track.offsets[key]?.stop();
  }
}
