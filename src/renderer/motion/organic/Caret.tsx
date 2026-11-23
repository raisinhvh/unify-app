/**
 * <Caret phase={…} /> a thin text caret that sits at the end of the text before it (zero width: it never
 * moves the text or its neighbours).
 *
 *   phase 'typing'    solid (snaps in on the Button spring); a moving caret never blinks
 *   phase 'settling'  stays solid for a moment, blinks once, fades out, then calls onDone
 *   phase 'hidden'    quick fade out
 *
 * Colour is currentColor unless `color` is given (e.g. 'var(--accent)').
 */
import { createEffect, on, onCleanup, type JSX } from 'solid-js';
import { useSpring } from '../createSpring';
import { prefersReducedMotion } from '../reducedMotion';
import { caretTiming } from './timing';
import './organic.css';

export type CaretPhase = 'hidden' | 'typing' | 'settling';

export interface CaretProps {
  phase: CaretPhase;
  color?: string;
  onDone?: () => void;
  /** Positioned by the parent (absolute left in px) instead of following the text inline. */
  left?: number;
}

/** The fade at the end of the caret tail: calm, no bounce. */
const caretFade = { period: 0.18, damping: 1 };

export function Caret(props: CaretProps): JSX.Element {
  let bar!: HTMLSpanElement;
  const opacity = useSpring(0, 'button', 1);
  const timers: number[] = [];

  const clearTimers = () => {
    for (const timer of timers.splice(0)) window.clearTimeout(timer);
  };

  opacity.onChange(value => {
    if (bar) bar.style.opacity = String(Math.max(0, Math.min(1, value)));
  });

  const later = (delay: number, action: () => void) => {
    timers.push(window.setTimeout(action, delay));
  };

  createEffect(on(() => props.phase, phase => {
    clearTimers();
    if (phase === 'typing') {
      opacity.set(1, 'button');
      return;
    }
    if (phase === 'hidden') {
      opacity.set(0, 'exit');
      return;
    }
    // settling: hold, one blink, fade.
    opacity.set(1, 'button');
    if (prefersReducedMotion()) {
      opacity.set(0, caretFade);
      later(caretTiming.fade, () => props.onDone?.());
      return;
    }
    later(caretTiming.hold, () => opacity.set(0, 'control'));
    later(caretTiming.hold + caretTiming.off, () => opacity.set(1, 'control'));
    later(caretTiming.hold + caretTiming.off + caretTiming.on, () => opacity.set(0, caretFade));
    later(caretTiming.hold + caretTiming.off + caretTiming.on + caretTiming.fade, () => props.onDone?.());
  }));

  onCleanup(clearTimers);

  return (
    <span
      class="organic-caret"
      classList={{ 'organic-caret-placed': props.left !== undefined }}
      style={{ left: props.left !== undefined ? `${props.left}px` : undefined }}
      aria-hidden="true"
    >
      <span
        ref={bar}
        class="organic-caret-bar"
        style={{ opacity: 0, background: props.color ?? 'currentColor' }}
      />
    </span>
  );
}
