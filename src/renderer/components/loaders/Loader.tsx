/**
 * <Loader id="sift" size={12} /> draws one of the 15 loaders, and morphs when `id` changes:
 *   - cells both loaders share (same key) glide from where they were to where the new loader puts them;
 *   - cells only the outgoing loader has fade out while shrinking 1 → 0.6;
 *   - cells only the incoming loader has Pop in from 0.6 → 1.
 * The morph is driven by one Pop spring, so a second change mid-morph retargets from what is on screen.
 *
 * All mounted loaders share one animation clock (one rAF). Reduced motion: loaders hold a still frame and a
 * change of loader is a plain crossfade.
 */
import { createEffect, on, onCleanup, onMount, type JSX } from 'solid-js';
import { prefersReducedMotion, Spring } from '../../motion';
import type { LoaderCell } from './cells';
import { loaders, type LoaderId } from './definitions';
import './loader.css';

export interface LoaderProps {
  id: LoaderId | undefined;
  /** Rendered size in px (the drawing is 16 units). Default 12. */
  size?: number;
  class?: string;
  /** Freeze on a still frame (e.g. a finished chat's last state). */
  still?: boolean;
  title?: string;
}

const svgNamespace = 'http://www.w3.org/2000/svg';
const stillTime = 0.35;

interface Instance {
  render(seconds: number): void;
}

const instances = new Set<Instance>();
let clockHandle = 0;
const clockStart = performance.now();

function clockTick(now: number): void {
  const seconds = (now - clockStart) / 1000;
  for (const instance of instances) instance.render(seconds);
  clockHandle = instances.size ? requestAnimationFrame(clockTick) : 0;
}

function register(instance: Instance): () => void {
  instances.add(instance);
  if (!clockHandle) clockHandle = requestAnimationFrame(clockTick);
  return () => instances.delete(instance);
}

function toneColor(tone: number): string {
  const percent = Math.round(Math.max(0, Math.min(1, tone)) * 100);
  return `color-mix(in srgb, var(--wood-light) ${percent}%, var(--loader-dim))`;
}

function lerpCell(from: LoaderCell, to: LoaderCell, amount: number): LoaderCell {
  const lerp = (first: number, second: number) => first + (second - first) * amount;
  return {
    ...to,
    x: lerp(from.x, to.x),
    y: lerp(from.y, to.y),
    width: Math.max(0, lerp(from.width, to.width)),
    height: Math.max(0, lerp(from.height, to.height)),
    tone: lerp(from.tone, to.tone),
    opacity: lerp(from.opacity ?? 1, to.opacity ?? 1),
  };
}

/** Scales a cell about the loader centre (outgoing shrink, incoming pop). */
function scaleCell(source: LoaderCell, scale: number, opacity: number): LoaderCell {
  const centre = 8;
  return {
    ...source,
    x: centre + (source.x - centre) * scale,
    y: centre + (source.y - centre) * scale,
    width: source.width * scale,
    height: source.height * scale,
    opacity: (source.opacity ?? 1) * opacity,
  };
}

export function Loader(props: LoaderProps): JSX.Element {
  let svg!: SVGSVGElement;
  const rects = new Map<string, SVGRectElement>();
  let current: LoaderId | undefined = props.id;
  let previous: LoaderId | undefined;
  /** Cells on screen when the last morph started; the outgoing loader keeps animating from them. */
  let previousCells: LoaderCell[] = [];
  let lastCells: LoaderCell[] = [];
  const morph = new Spring(1, 'pop', 1);

  const draw = (cells: LoaderCell[]) => {
    const seen = new Set<string>();
    for (const item of cells) {
      const id = item.key;
      seen.add(id);
      let rect = rects.get(id);
      if (!rect) {
        rect = document.createElementNS(svgNamespace, 'rect');
        rects.set(id, rect);
        svg.appendChild(rect);
      }
      const inset = item.outline ? 0.5 : 0;
      rect.setAttribute('x', String(item.x + inset));
      rect.setAttribute('y', String(item.y + inset));
      rect.setAttribute('width', String(Math.max(0, item.width - inset * 2)));
      rect.setAttribute('height', String(Math.max(0, item.height - inset * 2)));
      rect.setAttribute('rx', String(item.radius ?? 0.5));
      const color = toneColor(item.tone);
      rect.style.fill = item.outline ? 'none' : color;
      rect.style.stroke = item.outline ? color : 'none';
      rect.style.strokeWidth = item.outline ? '1' : '0';
      rect.style.opacity = String(Math.max(0, Math.min(1, item.opacity ?? 1)));
    }
    for (const [id, rect] of rects) {
      if (!seen.has(id)) {
        rect.remove();
        rects.delete(id);
      }
    }
  };

  const compose = (seconds: number): LoaderCell[] => {
    const time = props.still || prefersReducedMotion() ? stillTime : seconds;
    const incoming = current ? loaders[current](time) : [];
    const amount = morph.value;
    if (amount >= 1 && !morph.moving) return incoming;
    const reduced = prefersReducedMotion();
    const outgoing = previous ? loaders[previous](time) : [];
    const outgoingByKey = new Map(previousCells.map(item => [item.key, item]));
    const cells: LoaderCell[] = [];
    const fadeIn = Math.max(0, Math.min(1, amount));
    for (const item of incoming) {
      const from = outgoingByKey.get(item.key);
      if (from && !reduced) {
        cells.push(lerpCell(from, item, amount));
      } else {
        const scale = reduced ? 1 : 0.6 + 0.4 * amount;
        cells.push(scaleCell(item, scale, fadeIn));
      }
    }
    const incomingKeys = new Set(incoming.map(item => item.key));
    for (const item of outgoing) {
      if (incomingKeys.has(item.key) && !reduced) continue;
      const leaving = Math.max(0, Math.min(1, amount));
      const scale = reduced ? 1 : 1 - 0.4 * leaving;
      // Outgoing cells live in their own namespace so a shared key is never drawn twice.
      cells.push(scaleCell({ ...item, key: `out:${item.key}` }, scale, 1 - leaving));
    }
    return cells;
  };

  const instance: Instance = {
    render(seconds) {
      lastCells = compose(seconds);
      draw(lastCells);
    },
  };

  onMount(() => {
    instance.render((performance.now() - clockStart) / 1000);
    const unregister = register(instance);
    onCleanup(() => {
      unregister();
      morph.stop();
    });
  });

  createEffect(on(() => props.id, (next, last) => {
    if (next === last) return;
    previous = last;
    // Shared cells start from what is on screen now (mid-morph included), keyed by their real key.
    previousCells = lastCells
      .filter(item => !item.key.startsWith('out:'))
      .map(item => ({ ...item }));
    current = next;
    morph.jump(0);
    morph.set(1, prefersReducedMotion() ? 'control' : 'pop');
  }, { defer: true }));

  return (
    <svg
      ref={svg}
      class={props.class ? `loader ${props.class}` : 'loader'}
      width={props.size ?? 12}
      height={props.size ?? 12}
      viewBox="0 0 16 16"
      role={props.title ? 'img' : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : 'true'}
    />
  );
}
