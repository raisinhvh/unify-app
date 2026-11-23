/**
 * <Collapse open={expanded()}> reveals its content by springing its height (Reveal token) while the content
 * fades. Whatever sits below moves with it, so the layout follows the size change instead of jumping.
 * Once fully open the height is released to `auto`, so content that grows later (streaming text) just flows.
 * Closed content is unmounted after the collapse finishes (pass `keepMounted` to keep it).
 */
import { createEffect, createSignal, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { prefersReducedMotion } from './reducedMotion';
import { Spring } from './spring';

export interface CollapseProps {
  open: boolean;
  children: JSX.Element;
  keepMounted?: boolean;
  class?: string;
  /** Mount closed and reveal straight away (a row added to a list). Read once. */
  appear?: boolean;
  /** Called when a close finishes (height reached 0). */
  onClosed?: () => void;
  /** Marks the wrapper as a flipList child (AnimatedList rows). */
  'data-flip'?: string;
}

export function Collapse(props: CollapseProps): JSX.Element {
  let outer!: HTMLDivElement;
  let inner!: HTMLDivElement;
  const appearing = props.open && !!props.appear;
  const [mounted, setMounted] = createSignal(props.open);
  const height = new Spring(0, 'reveal', 100);
  const opacity = new Spring(props.open && !appearing ? 1 : 0, 'reveal', 1);

  const contentHeight = () => inner?.offsetHeight ?? 0;

  const release = () => {
    if (props.open && !height.moving) {
      outer.style.height = '';
      outer.style.overflow = '';
    }
  };

  height.onChange(value => {
    outer.style.height = `${Math.max(0, value)}px`;
    outer.style.overflow = 'hidden';
  });
  height.onRest(value => {
    if (props.open) release();
    else if (value === 0) {
      if (!props.keepMounted) setMounted(false);
      props.onClosed?.();
    }
  });
  opacity.onChange(value => {
    if (inner) inner.style.opacity = String(Math.max(0, Math.min(1, value)));
  });

  const animateOpen = () => {
    setMounted(true);
    // Measure after the content is in the DOM; start from the current visual height.
    queueMicrotask(() => {
      if (!props.open) return;
      const from = outer.getBoundingClientRect().height;
      const to = contentHeight();
      if (prefersReducedMotion()) {
        height.jump(to);
        release();
        opacity.set(1, 'control');
        return;
      }
      if (!height.moving) height.jump(from);
      height.set(to, 'reveal');
      opacity.set(1, 'reveal');
    });
  };

  const animateClose = () => {
    const reduced = prefersReducedMotion();
    const from = outer.getBoundingClientRect().height;
    if (!height.moving) height.jump(from);
    if (reduced) height.jump(0);
    else height.set(0, 'reveal');
    opacity.set(0, reduced ? 'control' : 'exit');
  };

  onMount(() => {
    if (!props.open || appearing) {
      outer.style.height = '0px';
      outer.style.overflow = 'hidden';
      if (inner) inner.style.opacity = '0';
    }
    if (appearing) animateOpen();
  });

  onCleanup(() => {
    height.stop();
    opacity.stop();
  });

  createEffect(on(() => props.open, (open, previous) => {
    if (open === previous) return;
    if (open) animateOpen();
    else animateClose();
  }, { defer: true }));

  // While opening, follow content that changes size mid-flight.
  onMount(() => {
    const observer = new ResizeObserver(() => {
      if (props.open && height.moving) height.set(contentHeight());
    });
    if (inner) observer.observe(inner);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div ref={outer} class={props.class} data-collapse={props.open ? 'open' : 'closed'} data-flip={props['data-flip']}>
      <div ref={inner}>
        <Show when={mounted() || props.keepMounted}>{props.children}</Show>
      </div>
    </div>
  );
}
