/**
 * <RetypeText value={name} /> text the agent changes, shown as if a person retyped it.
 *
 *   <RetypeText value={chat.title} />                                  rename: backspace to shared prefix, retype
 *   <RetypeText value={row.name} typeOnMount={row.created} />          created: types in from empty
 *   <RetypeText value={row.name} deleting={row.leaving()} onDeleted={row.swept} />   deleted: select-all sweep
 *   <RetypeText value={status} speed="fast" />                         status / loader labels
 *
 * Display only, never in the user's way:
 *   - the accessible text is the final value at once (screen readers and tooling never see half a word);
 *   - a new value mid-animation retypes from what is displayed (interruptible, never restarts);
 *   - pointerdown / focus on the row, or `instant`, finishes at once;
 *   - first mount shows the value (unless typeOnMount); offscreen or hidden windows land instantly;
 *   - reduced motion → short crossfade; effect toggle off → instant;
 *   - at most a few run at once (scheduler); the rest land instantly.
 * While animating, the box springs its width so neighbours glide rather than jump per keystroke.
 */
import { createEffect, createSignal, on, onCleanup, onMount, Show, untrack, type JSX } from 'solid-js';
import { useSpring } from '../createSpring';
import { Caret, type CaretPhase } from './Caret';
import { isOnScreen, organicMode, type OrganicEffect } from './enabled';
import { claimOrganicSlot, type OrganicTicket } from './scheduler';
import { planRetype, type RetypePlan } from './timing';
import './organic.css';

export interface RetypeTextProps {
  value: string;
  /** Land the next change (and finish the current one) without animating. */
  instant?: boolean;
  /** Type the value in from empty on first mount (a created row). Read once. */
  typeOnMount?: boolean;
  /** Play the select-all sweep, then call onDeleted (hand off to the row's collapse). */
  deleting?: boolean;
  onDeleted?: () => void;
  /** Called when a retype / type-in has fully finished (caret gone) or landed instantly. */
  onSettled?: () => void;
  /** 'fast' for status and loader labels. */
  speed?: 'normal' | 'fast';
  /** Fixed seed for the jitter (default: hash of the two texts). */
  seed?: number;
  /** Caret colour (default currentColor). */
  caretColor?: string;
  /** Which feature toggle governs value changes (default 'rename'; type-in and sweep use 'createDelete'). */
  effect?: OrganicEffect;
  class?: string;
  /** Name for .dsh/tools/motion-audit.mjs. */
  'data-motion'?: string;
}

/** Width follows each keystroke quickly and without overshoot. */
export const followWidth = { period: 0.1, damping: 1 };

/** Hold on the full highlight before the row collapses (ms). */
export const sweepHold = 70;

/** Selectors for the row that owns the text: pressing or focusing it finishes the animation. */
const ownerSelector = 'button, a, [role], [tabindex], li, [data-flip]';

export function RetypeText(props: RetypeTextProps): JSX.Element {
  let root!: HTMLSpanElement;
  let textElement!: HTMLSpanElement;
  let ghostElement: HTMLSpanElement | undefined;
  let sweepElement: HTMLSpanElement | undefined;
  /** Absolute, invisible copy of the target text: measures the width the box springs to. */
  let sizer: HTMLSpanElement | undefined;

  const typeOnMount = untrack(() => !!props.typeOnMount);
  const [shown, setShown] = createSignal(typeOnMount ? '' : untrack(() => props.value));
  const [animating, setAnimating] = createSignal(false);
  const [caretPhase, setCaretPhase] = createSignal<CaretPhase>('hidden');
  const [ghostText, setGhostText] = createSignal<string>();
  const [sweeping, setSweeping] = createSignal(false);

  const width = useSpring(0, followWidth, 100);
  const textOpacity = useSpring(1, 'control', 1);
  const ghostOpacity = useSpring(0, 'control', 1);
  const sweepProgress = useSpring(0, 'indicator', 1);

  let ticket: OrganicTicket | undefined;
  let startTimer = 0;
  let stepTimer = 0;
  let holdTimer = 0;
  let plan: RetypePlan | undefined;
  let planStart = 0;
  let stepIndex = 0;
  let deleteCalled = false;

  // The spring glides the box to the final value's width; the clamp only kicks in for the first frames,
  // where the text may already be wider than the spring (never let typed characters overrun the meta).
  const paintWidth = () => {
    if (!animating() || !textElement) return;
    root.style.width = `${Math.max(0, width.value, textElement.offsetWidth)}px`;
  };
  width.onChange(paintWidth);

  /**
   * Width of `text` in the animated font. The box springs to the final value's width once per retype, so
   * neighbours glide once instead of stepping a character at a time (the clamp in paintWidth still guarantees
   * the text is never clipped while the spring catches up).
   */
  const measure = (text: string): number => {
    if (!sizer) return textElement?.offsetWidth ?? 0;
    sizer.textContent = text;
    return sizer.offsetWidth;
  };
  textOpacity.onChange(value => {
    textElement.style.opacity = value >= 1 ? '' : String(Math.max(0, value));
  });
  ghostOpacity.onChange(value => {
    if (ghostElement) ghostElement.style.opacity = String(Math.max(0, Math.min(1, value)));
  });
  ghostOpacity.onRest(value => {
    if (value === 0) setGhostText(undefined);
  });
  sweepProgress.onChange(value => {
    if (sweepElement) sweepElement.style.transform = `scaleX(${Math.max(0, Math.min(1.02, value))})`;
  });

  const releaseTicket = () => {
    ticket?.release();
    ticket = undefined;
  };

  const clearTimers = () => {
    window.clearTimeout(startTimer);
    window.clearTimeout(stepTimer);
    startTimer = 0;
    stepTimer = 0;
    plan = undefined;
  };

  const beginAnimating = () => {
    if (animating()) return;
    width.jump(root.getBoundingClientRect().width);
    setAnimating(true);
    paintWidth();
  };

  const stopAnimating = () => {
    setAnimating(false);
    width.stop();
    root.style.width = '';
    if (sizer) sizer.textContent = '';
  };

  const show = (text: string) => {
    setShown(text);
    if (!animating()) return;
    // The spring already targets the final width; only ever widen it to keep the newest character visible.
    paintWidth();
  };

  const settled = () => {
    stopAnimating();
    props.onSettled?.();
  };

  /** Lands `text` now: no motion at all. */
  const land = (text: string) => {
    clearTimers();
    releaseTicket();
    setShown(text);
    setCaretPhase('hidden');
    stopAnimating();
    props.onSettled?.();
  };

  const crossfade = (text: string) => {
    clearTimers();
    releaseTicket();
    setCaretPhase('hidden');
    stopAnimating();
    if (shown() !== text) {
      setGhostText(shown());
      ghostOpacity.jump(1).set(0, 'control');
      textOpacity.jump(0).set(1, 'control');
      setShown(text);
    }
    props.onSettled?.();
  };

  const typingDone = () => {
    plan = undefined;
    releaseTicket();
    setCaretPhase('settling');
  };

  const scheduleNextStep = () => {
    if (!plan) return;
    if (stepIndex >= plan.steps.length) {
      typingDone();
      return;
    }
    const delay = planStart + plan.steps[stepIndex].at - performance.now();
    stepTimer = window.setTimeout(() => {
      if (!plan) return;
      // A late timer catches up to the newest due step instead of replaying every keystroke.
      const now = performance.now() - planStart;
      let latest = stepIndex;
      while (latest + 1 < plan.steps.length && plan.steps[latest + 1].at <= now) latest += 1;
      show(plan.steps[latest].text);
      stepIndex = latest + 1;
      scheduleNextStep();
    }, Math.max(0, delay));
  };

  const run = (target: string, continuing: boolean) => {
    window.clearTimeout(stepTimer);
    plan = planRetype(shown(), target, props.seed, { speed: props.speed, continuing });
    if (!plan.steps.length) {
      if (animating()) {
        typingDone();
      } else {
        plan = undefined;
        releaseTicket();
        props.onSettled?.();
      }
      return;
    }
    beginAnimating();
    width.set(measure(target));
    setCaretPhase('typing');
    planStart = performance.now();
    stepIndex = 0;
    scheduleNextStep();
  };

  /** Retypes from what is displayed to `target`, choosing organic / crossfade / instant. */
  const retypeTo = (target: string, effect: OrganicEffect) => {
    const mode = organicMode(effect);
    if (props.instant || mode === 'instant' || !isOnScreen(root)) {
      land(target);
      return;
    }
    if (mode === 'crossfade') {
      crossfade(target);
      return;
    }
    // Already on screen with a caret: carry on from here (no new slot, no lead-in).
    if (animating() && !startTimer) {
      run(target, true);
      return;
    }
    if (startTimer) return; // A staggered start is pending; it reads the latest value when it fires.
    ticket = claimOrganicSlot();
    if (!ticket) {
      land(target);
      return;
    }
    startTimer = window.setTimeout(() => {
      startTimer = 0;
      run(props.value, false);
    }, ticket.delay);
  };

  const callDeleted = () => {
    if (deleteCalled) return;
    deleteCalled = true;
    props.onDeleted?.();
  };

  const startSweep = () => {
    deleteCalled = false;
    land(props.value);
    if (organicMode('createDelete') !== 'organic' || !isOnScreen(root)) {
      callDeleted();
      return;
    }
    const sweepTicket = claimOrganicSlot();
    if (!sweepTicket) {
      callDeleted();
      return;
    }
    ticket = sweepTicket;
    startTimer = window.setTimeout(() => {
      startTimer = 0;
      setSweeping(true);
      sweepProgress.jump(0).set(1, 'indicator');
    }, sweepTicket.delay);
  };

  sweepProgress.onRest(value => {
    if (value < 1 || !props.deleting) return;
    holdTimer = window.setTimeout(() => {
      releaseTicket();
      callDeleted();
    }, sweepHold);
  });

  /** Pointerdown / focus on the owner, or `instant`: everything lands now. */
  const finishNow = () => {
    if (props.deleting) {
      window.clearTimeout(holdTimer);
      window.clearTimeout(startTimer);
      startTimer = 0;
      releaseTicket();
      callDeleted();
      return;
    }
    if (animating() || startTimer) land(props.value);
  };

  /** The value last handed to the effect: a re-render with the same string must not retype or take a slot. */
  let target = untrack(() => props.value);
  createEffect(on(() => props.value, value => {
    if (value === target) return;
    target = value;
    if (props.deleting) {
      setShown(value);
      return;
    }
    retypeTo(value, props.effect ?? 'rename');
  }, { defer: true }));

  createEffect(on(() => !!props.deleting, deleting => {
    if (deleting) {
      startSweep();
    } else if (sweeping()) {
      window.clearTimeout(holdTimer);
      releaseTicket();
      sweepProgress.set(0, 'exit');
    }
  }, { defer: true }));

  sweepProgress.onRest(value => {
    if (value === 0 && !props.deleting) setSweeping(false);
  });

  createEffect(on(() => !!props.instant, instant => {
    if (instant) finishNow();
  }, { defer: true }));

  onMount(() => {
    // An absolute invisible copy of the target text, sharing this element's font, for measure().
    sizer = document.createElement('span');
    sizer.setAttribute('aria-hidden', 'true');
    sizer.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:pre;pointer-events:none;';
    root.appendChild(sizer);
    const owner = root.parentElement?.closest(ownerSelector) ?? root.parentElement ?? root;
    owner.addEventListener('pointerdown', finishNow);
    owner.addEventListener('focusin', finishNow);
    onCleanup(() => {
      owner.removeEventListener('pointerdown', finishNow);
      owner.removeEventListener('focusin', finishNow);
    });
    if (typeOnMount) retypeTo(props.value, 'createDelete');
    if (props.deleting) startSweep();
  });

  onCleanup(() => {
    sizer?.remove();
    sizer = undefined;
    clearTimers();
    window.clearTimeout(holdTimer);
    releaseTicket();
  });

  return (
    <span
      ref={root}
      class={props.class ? `organic-retype ${props.class}` : 'organic-retype'}
      data-animating={animating() ? '' : undefined}
      data-motion={props['data-motion']}
    >
      <span class="organic-sr">{props.value}</span>
      <Show when={sweeping()}>
        <span ref={sweepElement} class="organic-retype-sweep" aria-hidden="true" />
      </Show>
      <Show when={ghostText() !== undefined}>
        <span ref={ghostElement} class="organic-retype-ghost" aria-hidden="true">{ghostText()}</span>
      </Show>
      <span ref={textElement} class="organic-retype-text" aria-hidden="true">
        {shown() || (animating() ? '​' : '')}
        <Show when={animating()}>
          <Caret phase={caretPhase()} color={props.caretColor} onDone={settled} />
        </Show>
      </span>
    </span>
  );
}
