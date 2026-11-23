/**
 * <Popover anchor={buttonEl} open={open()} onClose={…} placement="bottom-start">…</Popover>
 *
 * A raised surface anchored to an element, drawn in a portal above everything. It flips to the other side when
 * it would leave the window, grows from the anchored corner with a Pop (motion/Presence), and closes on an
 * outside pointer-down or Escape. Closing plays the quick exit; it stays mounted until the exit ends.
 */
import { createEffect, createSignal, on, onCleanup, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Presence } from '../motion';
import './popover.css';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'right-end';

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
}

const margin = 8;

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
  let surface: HTMLDivElement | undefined;

  const place = () => {
    if (!props.anchor || !surface) return;
    if (props.matchWidth) surface.style.minWidth = `${props.anchor.offsetWidth}px`;
    setPosition(computePosition(props.anchor, surface, props.placement ?? 'bottom-start', props.offset ?? 6));
  };

  createEffect(on(() => props.open, open => {
    if (!open) return;
    queueMicrotask(place);
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
    const onResize = () => place();
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
        <Presence when={props.open} origin={position().origin} offsetY={position().side === 'top' ? 4 : position().side === 'bottom' ? -4 : 0} from={0.9}>
          <div
            ref={element => {
              surface = element;
              props.ref?.(element);
              const observer = new ResizeObserver(place);
              observer.observe(element);
              onCleanup(() => observer.disconnect());
            }}
            class={props.class ? `popover ${props.class}` : 'popover'}
            style={{ left: `${position().left}px`, top: `${position().top}px` }}
          >
            {props.children}
          </div>
        </Presence>
      </Portal>
    </Show>
  );
}
