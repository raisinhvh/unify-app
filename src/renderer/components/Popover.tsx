/**
 * <Popover anchor={buttonEl} open={open()} onClose={…} placement="bottom-start">…</Popover>
 *
 * A raised surface anchored to an element, drawn in a portal above everything. It flips to the other side when
 * it would leave the window, and closes on an outside pointer-down or Escape.
 *
 * Motion (Apple chrome: no overshoot, entering slower than leaving):
 *   'pop'   (default) grows from 0.96 at the anchored corner and drifts 4px away from the anchor while it fades in
 *           on the Panel spring (~230ms, critically damped); closing plays the quick Exit (~120ms).
 *   'fade'  opacity only (tooltips).
 * If the anchor changes while it is open (tooltip moving to the next target), the surface glides to the new place
 * instead of jumping. Reduced motion: fades only and moves in one step.
 */
import { createEffect, createSignal, on, onCleanup, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { prefersReducedMotion, Presence, useSpring } from '../motion';
import './popover.css';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'right-end';

export type PopoverMotion = 'pop' | 'fade';

export interface PopoverProps {
  anchor: HTMLElement | undefined;
  open: boolean;
  onClose: () => void;
  placement?: PopoverPlacement;
  /** Gap between anchor and popover in px. Default 6. */
  offset?: number;
  class?: string;
  /** Match the anchor's width (pickers). */
  matchWidth?: boolean;
  children: JSX.Element;
  /** Receives the surface element (menus focus it). */
  ref?: (element: HTMLDivElement) => void;
  /** How it appears. Default 'pop'. */
  motion?: PopoverMotion;
}

const margin = 8;
/** Scale a popping surface grows from. */
const popFrom = 0.96;
/** How far (px) a popping surface travels away from its anchor while it fades in. */
const popTravel = 4;

interface Position {
  left: number;
  top: number;
  origin: string;
  side: 'top' | 'bottom' | 'right';
}

function computePosition(anchor: HTMLElement, surface: HTMLElement, placement: PopoverPlacement, offset: number): Position {
  const anchorBox = anchor.getBoundingClientRect();
  const width = surface.offsetWidth;
  const height = surface.offsetHeight;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const [side, align] = placement.split('-') as ['bottom' | 'top' | 'right', 'start' | 'end'];
  let resolvedSide = side;
  let left: number;
  let top: number;
  if (side === 'right') {
    left = anchorBox.right + offset;
    top = align === 'start' ? anchorBox.top : anchorBox.bottom - height;
    if (left + width > viewportWidth - margin) left = anchorBox.left - offset - width;
  } else {
    left = align === 'start' ? anchorBox.left : anchorBox.right - width;
    const below = anchorBox.bottom + offset;
    const above = anchorBox.top - offset - height;
    if (side === 'bottom') {
      top = below + height > viewportHeight - margin && above >= margin ? above : below;
    } else {
      top = above < margin && below + height <= viewportHeight - margin ? below : above;
    }
    resolvedSide = top === below ? 'bottom' : 'top';
  }
  left = Math.max(margin, Math.min(left, viewportWidth - margin - width));
  top = Math.max(margin, Math.min(top, viewportHeight - margin - height));
  const horizontal = side === 'right' ? 'left' : align === 'start' ? 'left' : 'right';
  const vertical = resolvedSide === 'right' ? (align === 'start' ? 'top' : 'bottom') : resolvedSide === 'bottom' ? 'top' : 'bottom';
  return { left, top, origin: `${vertical} ${horizontal}`, side: resolvedSide };
}

export function Popover(props: PopoverProps): JSX.Element {
  const [position, setPosition] = createSignal<Position>({ left: -9999, top: -9999, origin: 'top left', side: 'bottom' });
  const [coords, setCoords] = createSignal({ left: -9999, top: -9999 });
  const leftSpring = useSpring(-9999, 'panel', 100);
  const topSpring = useSpring(-9999, 'panel', 100);
  const writeCoords = () => setCoords({ left: leftSpring.value, top: topSpring.value });
  leftSpring.onChange(writeCoords);
  topSpring.onChange(writeCoords);
  let surface: HTMLDivElement | undefined;
  /** The anchor it was last placed against, while it is on screen (cleared once the exit finishes). */
  let placedAnchor: HTMLElement | undefined;

  const place = (fromResize = false) => {
    if (!props.anchor || !surface) return;
    if (props.matchWidth) surface.style.minWidth = `${props.anchor.offsetWidth}px`;
    const next = computePosition(props.anchor, surface, props.placement ?? 'bottom-start', props.offset ?? 6);
    setPosition(next);
    // Glide when it moves to another anchor while shown (or is already gliding); otherwise it sits in place.
    const moved = placedAnchor !== undefined && placedAnchor !== props.anchor;
    const gliding = leftSpring.moving || topSpring.moving;
    if (!fromResize && (moved || gliding) && !prefersReducedMotion()) {
      leftSpring.set(next.left, 'panel');
      topSpring.set(next.top, 'panel');
    } else {
      leftSpring.jump(next.left);
      topSpring.jump(next.top);
    }
    placedAnchor = props.anchor;
  };

  const fades = () => props.motion === 'fade';
  /** Starts nearer the anchor and drifts away from it: down for a surface below, up for one above. */
  const travel = () => {
    const side = position().side;
    if (side === 'bottom') return -popTravel;
    if (side === 'top') return popTravel;
    return 0;
  };

  createEffect(on(() => [props.anchor, props.placement] as const, () => {
    if (props.open) queueMicrotask(() => place());
  }, { defer: true }));

  createEffect(on(() => props.open, open => {
    if (!open) return;
    queueMicrotask(() => place());
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (surface?.contains(target) || props.anchor?.contains(target)) return;
      props.onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        props.onClose();
        props.anchor?.focus();
      }
    };
    const onResize = () => place(true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onResize);
    onCleanup(() => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onResize);
    });
  }));

  return (
    <Show when={props.anchor}>
      <Portal>
        <Presence
          when={props.open}
          origin={position().origin}
          offsetY={fades() ? 0 : travel()}
          from={fades() ? 1 : popFrom}
          enter={fades() ? 'control' : 'panel'}
          exit="exit"
          onExited={() => {
            placedAnchor = undefined;
          }}
        >
          <div
            ref={element => {
              surface = element;
              props.ref?.(element);
              const observer = new ResizeObserver(() => place());
              observer.observe(element);
              onCleanup(() => observer.disconnect());
            }}
            class={props.class ? `popover ${props.class}` : 'popover'}
            style={{ left: `${coords().left}px`, top: `${coords().top}px` }}
          >
            {props.children}
          </div>
        </Presence>
      </Portal>
    </Show>
  );
}
