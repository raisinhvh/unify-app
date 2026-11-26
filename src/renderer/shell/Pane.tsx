/**
 * One tiled pane frame. Its rectangle lives in springs, so every layout change (preset switch, a pane closing,
 * a drop) glides the pane to its new place on the Sheet spring instead of jumping. While being dragged it
 * follows the pointer at 50% scale; on release it springs from wherever it is into its zone.
 *
 * New panes Pop in; leaving panes play the quick exit before PaneGrid unmounts them.
 */
import { createEffect, onCleanup, onMount, type JSX } from 'solid-js';
import { prefersReducedMotion, Spring } from '../motion';

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PaneFrameProps {
  rect: PixelRect;
  /** Pointer-anchored position while dragged (top-left of the 50% pane). */
  lifted?: { left: number; top: number };
  /** Other panes dim while one is dragged. */
  dimmed: boolean;
  /** A split is being dragged: follow it exactly. */
  resizing: boolean;
  leaving: boolean;
  focused: boolean;
  onLeft?: () => void;
  onPointerDown?: () => void;
  children: JSX.Element;
}

export function PaneFrame(props: PaneFrameProps): JSX.Element {
  let element!: HTMLDivElement;
  const left = new Spring(props.rect.left, 'sheet', 100);
  const top = new Spring(props.rect.top, 'sheet', 100);
  const width = new Spring(props.rect.width, 'sheet', 100);
  const height = new Spring(props.rect.height, 'sheet', 100);
  const scale = new Spring(0.96, 'pop', 1);
  const opacity = new Spring(0, 'pop', 1);
  const dim = new Spring(1, 'indicator', 1);
  const springs = [left, top, width, height, scale, opacity, dim];

  // Last written values: a style is only touched when it changes, so a pane gliding sideways does not rewrite its
  // width (which would re-lay out everything inside it, a long chat included).
  const written = { left: '', top: '', width: '', height: '', transform: '', opacity: '' };
  const write = (property: keyof typeof written, value: string) => {
    if (written[property] === value) return;
    written[property] = value;
    element.style[property] = value;
  };
  const paintNow = () => {
    paintQueued = false;
    write('left', `${left.value}px`);
    write('top', `${top.value}px`);
    write('width', `${Math.max(0, width.value)}px`);
    write('height', `${Math.max(0, height.value)}px`);
    write('transform', scale.value === 1 ? '' : `scale(${scale.value})`);
    write('opacity', String(Math.max(0, Math.min(1, opacity.value)) * dim.value));
  };
  // Every spring reports each frame; paint once after all of them have stepped.
  let paintQueued = false;
  const paint = () => {
    if (paintQueued) return;
    paintQueued = true;
    queueMicrotask(paintNow);
  };

  onMount(() => {
    for (const spring of springs) spring.onChange(paint);
    paintNow();
    const reduced = prefersReducedMotion();
    if (reduced) scale.jump(1);
    else scale.set(1, 'pop');
    opacity.set(1, reduced ? 'control' : 'pop');
  });

  onCleanup(() => {
    for (const spring of springs) spring.stop();
  });

  createEffect(() => {
    const reduced = prefersReducedMotion();
    const lifted = props.lifted;
    const rect = props.rect;
    if (props.leaving) {
      scale.set(reduced ? 1 : 0.96, 'exit');
      opacity.set(0, reduced ? 'control' : 'exit');
      const stop = opacity.onRest(value => {
        if (value === 0) props.onLeft?.();
      });
      onCleanup(stop);
      return;
    }
    if (lifted) {
      // Follow the pointer closely; the shrink to 50% rides the Sheet spring.
      left.set(lifted.left, 'control');
      top.set(lifted.top, 'control');
      if (reduced) scale.jump(0.5);
      else scale.set(0.5, 'sheet');
      return;
    }
    const move = (spring: Spring, value: number) => {
      if (reduced || props.resizing) spring.jump(value);
      else spring.set(value, 'sheet');
    };
    move(left, rect.left);
    move(top, rect.top);
    move(width, rect.width);
    move(height, rect.height);
    if (scale.target !== 1 || scale.value !== 1) {
      if (reduced) scale.jump(1);
      else scale.set(1, 'sheet');
    }
  });

  createEffect(() => {
    dim.set(props.dimmed ? 0.45 : 1, prefersReducedMotion() ? 'control' : 'indicator');
  });

  return (
    <div
      ref={element}
      class="pane"
      classList={{ focused: props.focused, lifted: !!props.lifted }}
      onPointerDown={() => props.onPointerDown?.()}
    >
      {props.children}
    </div>
  );
}
