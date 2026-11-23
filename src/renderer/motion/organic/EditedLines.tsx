/**
 * <EditedLines each key>{line => …}</EditedLines> code (or any line list) that the agent edits live.
 *
 *   <EditedLines each={lines()} key={line => line.id} class="code" lineClass="code-line">
 *     {line => <code>{line().text}</code>}
 *   </EditedLines>
 *
 *   removed lines   a red highlight sweeps across them (top to bottom, like a selection drag), then they collapse
 *   added lines     the row springs open and its text wipes in left → right, one line after another; the caret
 *                   rides the wipe edge of the last added line, blinks once and fades; a soft add tint fades out
 *
 * Fast: a block of added lines takes ≈ wipe + (lines − 1) × gap (gap shrinks for big blocks, ≤ addedBudget).
 * Lines changed in the same tick form one group and use one scheduler slot; groups over the limit, reduced
 * motion and 'motion.organic.codeEdits' off all land instantly (reduced: the reveal/collapse still fades).
 * Lines need stable keys (a line id, not its index) so an edit in the middle keeps the lines around it.
 */
import { createEffect, createSignal, on, onCleanup, onMount, Show, untrack, type Accessor, type JSX } from 'solid-js';
import { AnimatedList } from '../AnimatedList';
import { useSpring } from '../createSpring';
import { Caret, type CaretPhase } from './Caret';
import { isOnScreen, organicMode } from './enabled';
import { claimOrganicSlot } from './scheduler';
import { createSweptList } from './sweptList';
import './organic.css';

export interface EditedLinesProps<T> {
  each: readonly T[];
  key: (line: T) => string;
  children: (line: Accessor<T>) => JSX.Element;
  class?: string;
  lineClass?: string;
  /** Caret colour (default currentColor). */
  caretColor?: string;
}

/** Timing of code edits (ms). */
export const codeEditTiming = {
  /** Gap between consecutive added lines starting their wipe (shrinks for big blocks). */
  addedGap: 45,
  /** All added lines of a group have started within this. */
  addedBudget: 260,
  /** Gap between removed lines starting their sweep. */
  removedGap: 18,
  removedBudget: 120,
  /** Full highlight shown this long before the lines collapse. */
  sweepHold: 80,
  /** The add tint fades this long after the line's wipe. */
  tintHold: 420,
} as const;

/** Wipe of one line: quick, no overshoot. */
const wipeSpring = { period: 0.16, damping: 1 };
/** Add tint fading out: slow and calm. */
const tintFade = { period: 0.5, damping: 1 };

interface LineHandle {
  element: HTMLElement;
  /** Start at once (delay 0) or after a stagger; `last` carries the caret. */
  start(delay: number, last: boolean): void;
  land(): void;
}

/** Collects lines that change in the same tick into one group. */
function createBatcher(gap: number, budget: number) {
  let pending: LineHandle[] = [];
  const flush = () => {
    const group = pending;
    pending = [];
    group.sort((first, second) => (first.element.compareDocumentPosition(second.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const visible = group.some(handle => isOnScreen(handle.element));
    const ticket = visible ? claimOrganicSlot() : undefined;
    if (!ticket) {
      for (const handle of group) handle.land();
      return;
    }
    const step = group.length > 1 ? Math.min(gap, budget / (group.length - 1)) : 0;
    group.forEach((handle, index) => handle.start(ticket.delay + index * step, index === group.length - 1));
    window.setTimeout(() => ticket.release(), ticket.delay + group.length * step + 200);
  };
  return (handle: LineHandle) => {
    if (!pending.length) queueMicrotask(flush);
    pending.push(handle);
  };
}

export function EditedLines<T>(props: EditedLinesProps<T>): JSX.Element {
  const list = createSweptList(() => props.each, line => props.key(line), { effect: 'codeEdits', maxSweep: 900 });
  const queueAdded = createBatcher(codeEditTiming.addedGap, codeEditTiming.addedBudget);
  const queueRemoved = createBatcher(codeEditTiming.removedGap, codeEditTiming.removedBudget);
  let ready = false;
  onMount(() => {
    ready = true;
  });

  return (
    <AnimatedList each={list.items()} key={props.key} class={props.class}>
      {line => {
        const lineKey = props.key(untrack(line));
        return (
          <EditedLine
            added={ready && organicMode('codeEdits') === 'organic'}
            leaving={() => list.leaving(lineKey)}
            swept={() => list.finish(lineKey)}
            queueAdded={queueAdded}
            queueRemoved={queueRemoved}
            class={props.lineClass}
            caretColor={props.caretColor}
          >
            {props.children(line)}
          </EditedLine>
        );
      }}
    </AnimatedList>
  );
}

interface EditedLineProps {
  added: boolean;
  leaving: Accessor<boolean>;
  swept: () => void;
  queueAdded: (handle: LineHandle) => void;
  queueRemoved: (handle: LineHandle) => void;
  class?: string;
  caretColor?: string;
  children: JSX.Element;
}

function EditedLine(props: EditedLineProps): JSX.Element {
  let row!: HTMLDivElement;
  let text!: HTMLSpanElement;
  let sweepElement: HTMLSpanElement | undefined;
  let tintElement: HTMLSpanElement | undefined;
  const added = untrack(() => props.added);
  const wipe = useSpring(added ? 0 : 1, wipeSpring, 1);
  const sweep = useSpring(0, 'indicator', 1);
  const tint = useSpring(added ? 1 : 0, tintFade, 1);
  const [sweeping, setSweeping] = createSignal(false);
  const [tinted, setTinted] = createSignal(added);
  const [caretPhase, setCaretPhase] = createSignal<CaretPhase | undefined>();
  const [caretLeft, setCaretLeft] = createSignal(0);
  const timers: number[] = [];
  let carriesCaret = false;
  let swept = false;

  const later = (delay: number, action: () => void) => {
    timers.push(window.setTimeout(action, delay));
  };

  const paintWipe = (value: number) => {
    const progress = Math.max(0, Math.min(1, value));
    text.style.clipPath = progress >= 1 ? '' : `inset(-2px ${(1 - progress) * 100}% -2px 0)`;
    if (carriesCaret) setCaretLeft(text.offsetLeft + text.offsetWidth * progress);
  };

  wipe.onChange(paintWipe);
  wipe.onRest(value => {
    if (value < 1) return;
    if (carriesCaret) setCaretPhase('settling');
    later(codeEditTiming.tintHold, () => tint.set(0, tintFade));
  });
  tint.onChange(value => {
    if (tintElement) tintElement.style.opacity = String(Math.max(0, Math.min(1, value)));
  });
  tint.onRest(value => {
    if (value === 0) setTinted(false);
  });
  sweep.onChange(value => {
    if (sweepElement) sweepElement.style.transform = `scaleX(${Math.max(0, Math.min(1.02, value))})`;
  });
  sweep.onRest(value => {
    if (value >= 1 && props.leaving()) later(codeEditTiming.sweepHold, finishSweep);
  });

  const finishSweep = () => {
    if (swept) return;
    swept = true;
    props.swept();
  };

  const addedHandle = (): LineHandle => ({
    element: row,
    start(delay, last) {
      carriesCaret = last;
      later(delay, () => {
        if (carriesCaret) setCaretPhase('typing');
        wipe.set(1, wipeSpring);
      });
    },
    land() {
      wipe.jump(1);
      tint.set(0, tintFade);
    },
  });

  const removedHandle = (): LineHandle => ({
    element: row,
    start(delay) {
      later(delay, () => {
        setSweeping(true);
        sweep.jump(0).set(1, 'indicator');
      });
    },
    land: finishSweep,
  });

  createEffect(on(props.leaving, leaving => {
    if (!leaving) return;
    swept = false;
    // A line removed mid-wipe just finishes its wipe at once and sweeps.
    wipe.jump(1);
    setCaretPhase(undefined);
    if (organicMode('codeEdits') !== 'organic') finishSweep();
    else props.queueRemoved(removedHandle());
  }, { defer: true }));

  onMount(() => {
    paintWipe(wipe.value);
    if (tintElement) tintElement.style.opacity = String(tint.value);
    if (added) props.queueAdded(addedHandle());
  });

  onCleanup(() => {
    for (const timer of timers.splice(0)) window.clearTimeout(timer);
  });

  return (
    <div ref={row} class={props.class ? `organic-line ${props.class}` : 'organic-line'}>
      <Show when={tinted()}>
        <span ref={tintElement} class="organic-line-tint" aria-hidden="true" />
      </Show>
      <Show when={sweeping()}>
        <span ref={sweepElement} class="organic-line-sweep" aria-hidden="true" />
      </Show>
      <span ref={text} class="organic-line-text">{props.children}</span>
      <Show when={caretPhase()}>
        {phase => (
          <span class="organic-line-caret-track" aria-hidden="true">
            <Caret phase={phase()} left={caretLeft()} color={props.caretColor} onDone={() => setCaretPhase(undefined)} />
          </span>
        )}
      </Show>
    </div>
  );
}
