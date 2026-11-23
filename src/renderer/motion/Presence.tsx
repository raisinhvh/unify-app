/**
 * <Presence when={open()}> mounts its child with a Pop (scale from `from` with a little overshoot, opacity in)
 * and on exit plays a quick collapse (no bounce), staying mounted until the exit finishes. Toggling mid-way
 * retargets the same spring, so a menu closed half-open simply turns around.
 *
 * The child should be one element. Presence writes `opacity` and `transform` on it; give it a
 * `transform-origin` (or pass `origin`) so it grows from its anchor.
 */
import { children, createEffect, createSignal, on, onCleanup, Show, type JSX } from 'solid-js';
import { prefersReducedMotion } from './reducedMotion';
import { Spring } from './spring';
import type { SpringToken, SpringTokenName } from './tokens';

export interface PresenceProps {
  when: boolean;
  children: JSX.Element;
  /** Scale it grows from. Default 0.92. */
  from?: number;
  /** transform-origin, e.g. 'top left' for a menu under its button. */
  origin?: string;
  /** Extra offset in px it travels from (y), e.g. 4 for a menu dropping down. */
  offsetY?: number;
  enter?: SpringToken | SpringTokenName;
  exit?: SpringToken | SpringTokenName;
  onExited?: () => void;
}

export function Presence(props: PresenceProps): JSX.Element {
  const [mounted, setMounted] = createSignal(props.when);
  const progress = new Spring(props.when ? 1 : 0, 'pop', 1);
  let elements: HTMLElement[] = [];

  const paint = (value: number) => {
    const reduced = prefersReducedMotion();
    const from = props.from ?? 0.92;
    const scale = reduced ? 1 : from + (1 - from) * value;
    const offset = reduced ? 0 : (1 - value) * (props.offsetY ?? 0);
    for (const element of elements) {
      element.style.opacity = String(Math.max(0, Math.min(1, value)));
      element.style.transform = value === 1 ? '' : `translateY(${offset}px) scale(${scale})`;
      if (props.origin) element.style.transformOrigin = props.origin;
    }
  };

  progress.onChange(paint);
  progress.onRest(value => {
    if (value === 0 && !props.when) {
      setMounted(false);
      props.onExited?.();
    }
  });
  onCleanup(() => progress.stop());

  createEffect(on(() => props.when, (when, previous) => {
    // `when` is often a plain derived function whose sources notify without changing the result;
    // only a real flip may (re)start the motion, or a shown child would pop in again.
    if (previous !== undefined && when === previous) return;
    if (when) {
      setMounted(true);
      if (progress.value === 1 && !progress.moving) progress.jump(0);
      progress.set(1, prefersReducedMotion() ? 'control' : props.enter ?? 'pop');
    } else if (mounted()) {
      progress.set(0, props.exit ?? 'exit');
    }
  }, { defer: false }));

  return (
    <Show when={mounted()}>
      <PresenceBody register={list => { elements = list; paint(progress.value); }}>{props.children}</PresenceBody>
    </Show>
  );
}

function PresenceBody(props: { register: (elements: HTMLElement[]) => void; children: JSX.Element }): JSX.Element {
  const resolved = children(() => props.children);
  createEffect(() => {
    const list = resolved.toArray().filter((node): node is HTMLElement => node instanceof HTMLElement);
    props.register(list);
  });
  return <>{resolved()}</>;
}
