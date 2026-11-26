/**
 * <Loader id="sift" size={12} /> draws one of the 15 loaders (or a status glyph like "done", or nothing when
 * `id` is undefined), and blends seamlessly whenever `id` changes: every cell on screen travels to a cell of
 * the new shape, merging or splitting where the counts differ (morph.ts). Position, colour and opacity share
 * one no-overshoot spring, and a change mid-morph continues from what is on screen.
 *
 * All mounted loaders share one animation clock (one rAF). Reduced motion: loaders hold a still frame and a
 * change is a plain crossfade. The "Animated loaders" feature (motion.loaders) off: still frames, morphs stay.
 */
import { createEffect, on, onCleanup, onMount, type JSX } from 'solid-js';
import { prefersReducedMotion } from '../../motion';
import { feature } from '../../store/features';
import { frameFor, type LoaderShape } from './definitions';
import { LoaderMorph, type DrawnCell } from './morph';
import './loader.css';

export interface LoaderProps {
  /** A loader id, a status glyph ("done"), or undefined for nothing (idle). */
  id: LoaderShape | undefined;
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
  // One loader that throws is reported and skipped; it must not stop the clock for every other loader.
  for (const instance of instances) {
    try {
      instance.render(seconds);
    } catch (error) {
      reportError(error);
    }
  }
  clockHandle = instances.size ? requestAnimationFrame(clockTick) : 0;
}

function register(instance: Instance): () => void {
  instances.add(instance);
  if (!clockHandle) clockHandle = requestAnimationFrame(clockTick);
  return () => instances.delete(instance);
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Wood between --loader-dim and --wood-light by tone, then toward --loader-ink by ink. */
function cellColor(tone: number, ink: number): string {
  const tonePercent = Math.round(clampUnit(tone) * 100);
  const wood = `color-mix(in srgb, var(--wood-light) ${tonePercent}%, var(--loader-dim))`;
  const inkPercent = Math.round(clampUnit(ink) * 100);
  if (inkPercent === 0) return wood;
  return `color-mix(in srgb, var(--loader-ink) ${inkPercent}%, ${wood})`;
}

export function Loader(props: LoaderProps): JSX.Element {
  let svg!: SVGSVGElement;
  const rects = new Map<string, SVGRectElement>();
  const morph = new LoaderMorph();
  let current: LoaderShape | undefined = props.id;
  let lastSeconds = (performance.now() - clockStart) / 1000;

  const frameTime = (seconds: number) => {
    const holdStill = props.still || prefersReducedMotion() || !feature('motion.loaders');
    return holdStill ? stillTime : seconds;
  };

  const currentCells = (seconds: number) => (current ? frameFor(current)(frameTime(seconds)) : []);

  const draw = (cells: DrawnCell[]) => {
    const seen = new Set<string>();
    for (const item of cells) {
      seen.add(item.id);
      let rect = rects.get(item.id);
      if (!rect) {
        rect = document.createElementNS(svgNamespace, 'rect');
        rects.set(item.id, rect);
        svg.appendChild(rect);
      }
      const { shape } = item;
      const hollow = clampUnit(shape.hollow);
      const inset = 0.5 * hollow;
      const width = Math.max(0, shape.width - inset * 2);
      const height = Math.max(0, shape.height - inset * 2);
      rect.setAttribute('x', String(shape.x + inset));
      rect.setAttribute('y', String(shape.y + inset));
      rect.setAttribute('width', String(width));
      rect.setAttribute('height', String(height));
      rect.setAttribute('rx', String(Math.min(shape.radius, width / 2, height / 2)));
      if (Math.abs(shape.angle) > 0.01) {
        const centreX = shape.x + shape.width / 2;
        const centreY = shape.y + shape.height / 2;
        rect.setAttribute('transform', `rotate(${shape.angle} ${centreX} ${centreY})`);
      } else {
        rect.removeAttribute('transform');
      }
      const color = cellColor(shape.tone, shape.ink);
      rect.style.fill = color;
      rect.style.fillOpacity = String(1 - hollow);
      rect.style.stroke = color;
      rect.style.strokeOpacity = String(hollow);
      rect.style.strokeWidth = hollow > 0 ? '1' : '0';
      rect.style.opacity = String(item.alpha);
    }
    for (const [id, rect] of rects) {
      if (!seen.has(id)) {
        rect.remove();
        rects.delete(id);
      }
    }
  };

  const instance: Instance = {
    render(seconds) {
      lastSeconds = seconds;
      draw(morph.frame(currentCells(seconds)));
    },
  };

  onMount(() => {
    instance.render((performance.now() - clockStart) / 1000);
    const unregister = register(instance);
    onCleanup(() => {
      unregister();
      morph.dispose();
    });
  });

  createEffect(on(() => props.id, (next, last) => {
    if (next === last) return;
    current = next;
    // Blend from what is on screen now (mid-morph included) into the new shape's current frame.
    morph.retarget(currentCells(lastSeconds), prefersReducedMotion());
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
