/**
 * <RollingNumber value="+12" /> counters that roll like an odometer.
 *
 *   <RollingNumber value={`+${added}`} />   <RollingNumber value="0:42" />   <RollingNumber value={`${percent}%`} />
 *
 * The value splits into a prefix (leading non-digits: '+', '−', '$'), a body (first to last digit, separators
 * such as ':' ',' '.' included) and a suffix ('%', ' files'). Body characters are matched from the right, so units
 * stay with units. Each digit column is a strip of 0–9 on a spring: when the number goes up every changed digit
 * rolls upward (9 → 0 wraps forward), when it goes down they roll downward. Columns that appear or leave spring
 * their width, so the whole counter's width follows smoothly. Prefix, suffix and separators crossfade.
 *
 * Interruptible: a new value retargets each column's spring from where it is. Reduced motion → crossfade of the
 * whole value; 'motion.organic.counters' off → plain text. The accessible text is always the final value.
 */
import { createEffect, createMemo, createSignal, For, Match, on, onMount, Show, Switch, untrack, type Accessor, type JSX } from 'solid-js';
import { useSpring } from '../createSpring';
import type { SpringToken, SpringTokenName } from '../tokens';
import { organicMode } from './enabled';
import './organic.css';

export interface RollingNumberProps {
  value: string | number;
  class?: string;
  /** Spring of the digit roll (default 'accent': counts may wobble a little). */
  token?: SpringToken | SpringTokenName;
  'data-motion'?: string;
}

interface ParsedValue {
  prefix: string;
  /** Body characters keyed by slot ('b0' = rightmost). */
  body: string[];
  suffix: string;
  /** Signed number the body reads as (digits only), for the roll direction. */
  numeric: number;
}

const digitPattern = /\d/;

export function parseCounter(value: string): ParsedValue {
  const first = value.search(digitPattern);
  if (first < 0) return { prefix: value, body: [], suffix: '', numeric: 0 };
  let last = value.length - 1;
  while (last > first && !digitPattern.test(value[last])) last -= 1;
  const prefix = value.slice(0, first);
  const body = Array.from(value.slice(first, last + 1));
  const suffix = value.slice(last + 1);
  const digits = body.filter(character => digitPattern.test(character)).join('');
  const negative = /[-−–]\s*$/.test(prefix);
  const numeric = Number(digits || '0') * (negative ? -1 : 1);
  return { prefix, body, suffix, numeric };
}

/** Slot keys in display order: prefix, body from the most significant slot down, suffix. */
function slotOrder(parsed: ParsedValue): string[] {
  const keys: string[] = [];
  if (parsed.prefix) keys.push('p');
  for (let index = parsed.body.length - 1; index >= 0; index -= 1) keys.push(`b${index}`);
  if (parsed.suffix) keys.push('s');
  return keys;
}

function slotCharacters(parsed: ParsedValue): Map<string, string> {
  const map = new Map<string, string>();
  if (parsed.prefix) map.set('p', parsed.prefix);
  parsed.body.forEach((character, index) => map.set(`b${parsed.body.length - 1 - index}`, character));
  if (parsed.suffix) map.set('s', parsed.suffix);
  return map;
}

function slotRank(key: string): number {
  if (key === 'p') return Number.POSITIVE_INFINITY;
  if (key === 's') return Number.NEGATIVE_INFINITY;
  return Number(key.slice(1));
}

export function RollingNumber(props: RollingNumberProps): JSX.Element {
  const text = () => String(props.value);
  // Organic columns only when the effect is on and motion is full; otherwise plain text (with a crossfade).
  const mode = createMemo(() => organicMode('counters'));
  return (
    <span class={props.class ? `organic-number ${props.class}` : 'organic-number'} data-motion={props['data-motion']}>
      <span class="organic-sr">{text()}</span>
      <Switch>
        <Match when={mode() === 'organic'}>
          <Odometer text={text()} token={props.token ?? 'accent'} />
        </Match>
        <Match when={mode() === 'crossfade'}>
          <FadeText text={text()} />
        </Match>
        <Match when={mode() === 'instant'}>
          <span aria-hidden="true">{text()}</span>
        </Match>
      </Switch>
    </span>
  );
}

/** Plain text that crossfades when it changes (reduced motion). */
function FadeText(props: { text: string }): JSX.Element {
  let current!: HTMLSpanElement;
  let ghost: HTMLSpanElement | undefined;
  const [shown, setShown] = createSignal(untrack(() => props.text));
  const [previous, setPrevious] = createSignal<string>();
  const fade = useSpring(1, 'control', 1);
  fade.onChange(value => {
    current.style.opacity = String(value);
    if (ghost) ghost.style.opacity = String(1 - value);
  });
  fade.onRest(value => {
    if (value === 1) setPrevious(undefined);
  });
  createEffect(on(() => props.text, next => {
    setPrevious(shown());
    setShown(next);
    fade.jump(0).set(1, 'control');
  }, { defer: true }));
  return (
    <span style={{ position: 'relative' }} aria-hidden="true">
      <Show when={previous() !== undefined}>
        <span ref={ghost} class="organic-retype-ghost">{previous()}</span>
      </Show>
      <span ref={current}>{shown()}</span>
    </span>
  );
}

function Odometer(props: { text: string; token: SpringToken | SpringTokenName }): JSX.Element {
  const parsed = createMemo(() => parseCounter(props.text));
  const characters = createMemo(() => slotCharacters(parsed()));
  const lastKnown = new Map<string, string>();
  const [leaving, setLeaving] = createSignal<ReadonlySet<string>>(new Set());
  let previousNumeric = untrack(() => parsed().numeric);
  const [direction, setDirection] = createSignal<1 | -1>(1);

  createEffect(on(parsed, (next, previous) => {
    if (!previous) return;
    setDirection(next.numeric < previousNumeric ? -1 : 1);
    previousNumeric = next.numeric;
    const present = slotCharacters(next);
    const gone = [...slotCharacters(previous).keys()].filter(key => !present.has(key));
    setLeaving(current => {
      const updated = new Set([...current].filter(key => !present.has(key)));
      for (const key of gone) updated.add(key);
      return updated;
    });
  }));

  const order = createMemo(() => {
    const keys = new Set([...slotOrder(parsed()), ...leaving()]);
    for (const [key, character] of characters()) lastKnown.set(key, character);
    return [...keys].sort((first, second) => slotRank(second) - slotRank(first));
  });

  // Columns created by the first render are placed; later ones grow in.
  let ready = false;
  onMount(() => {
    ready = true;
  });

  const finishLeaving = (key: string) => {
    if (characters().has(key)) return;
    setLeaving(current => {
      const updated = new Set(current);
      updated.delete(key);
      return updated;
    });
    lastKnown.delete(key);
  };

  return (
    <span class="organic-number-columns" aria-hidden="true" style={{ display: 'inline-flex', 'align-items': 'baseline' }}>
      <For each={order()}>
        {key => (
          <Column
            character={() => characters().get(key) ?? lastKnown.get(key) ?? ''}
            present={() => characters().has(key)}
            direction={direction}
            token={props.token}
            late={ready}
            onLeft={() => finishLeaving(key)}
          />
        )}
      </For>
    </span>
  );
}

interface ColumnProps {
  character: Accessor<string>;
  present: Accessor<boolean>;
  direction: Accessor<1 | -1>;
  token: SpringToken | SpringTokenName;
  /** Joined after the counter's first render: grows in. */
  late: boolean;
  onLeft: () => void;
}

const stripDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function Column(props: ColumnProps): JSX.Element {
  let column!: HTMLSpanElement;
  let sizer!: HTMLSpanElement;
  let strip: HTMLSpanElement | undefined;
  let incoming: HTMLSpanElement | undefined;
  let outgoing: HTMLSpanElement | undefined;

  const isDigit = () => digitPattern.test(props.character());
  const initialDigit = untrack(() => (isDigit() ? Number(props.character()) : 0));

  // Digit roll: unbounded position, shown modulo 10 on an 11-cell strip (the last cell repeats 0).
  const roll = useSpring(initialDigit, props.token, 10);
  // Width / opacity presence: 0 = collapsed, 1 = in place.
  const presence = useSpring(0, 'panel', 1);
  // Symbol crossfade: 0 = previous symbol, 1 = current.
  const swap = useSpring(1, 'control', 1);
  const [symbol, setSymbol] = createSignal(untrack(props.character));
  const [previousSymbol, setPreviousSymbol] = createSignal<string>();
  let naturalWidth = 0;

  const paintRoll = (value: number) => {
    if (!strip) return;
    const cell = ((value % 10) + 10) % 10;
    strip.style.transform = `translateY(${(-cell / stripDigits.length) * 100}%)`;
  };

  const paintPresence = (value: number) => {
    const clamped = Math.max(0, Math.min(1, value));
    column.style.opacity = clamped >= 1 ? '' : String(clamped);
    if (value >= 1 && !presence.moving) column.style.width = '';
    else column.style.width = `${naturalWidth * Math.max(0, value)}px`;
  };

  const paintSwap = (value: number) => {
    if (incoming) {
      incoming.style.opacity = String(value);
      incoming.style.transform = value >= 1 ? '' : `translateY(${(1 - value) * 35}%)`;
    }
    if (outgoing) {
      outgoing.style.opacity = String(1 - value);
      outgoing.style.transform = `translateY(${-value * 35}%)`;
    }
  };

  roll.onChange(paintRoll);
  presence.onChange(paintPresence);
  presence.onRest(value => {
    if (value <= 0 && !props.present()) props.onLeft();
    else paintPresence(value);
  });
  swap.onChange(paintSwap);
  swap.onRest(value => {
    if (value >= 1) setPreviousSymbol(undefined);
  });

  const measure = () => {
    const width = sizer.getBoundingClientRect().width;
    if (width > 0) naturalWidth = width;
  };

  // Roll to the new digit in the number's direction (9 → 0 wraps forward when counting up).
  createEffect(on(props.character, (next, previous) => {
    if (previous === undefined || next === previous) return;
    if (digitPattern.test(next)) {
      const goal = Number(next);
      if (!digitPattern.test(previous)) {
        roll.jump(goal);
        return;
      }
      const from = ((Math.round(roll.target) % 10) + 10) % 10;
      const step = props.direction() > 0 ? (goal - from + 10) % 10 : -((from - goal + 10) % 10);
      roll.set(roll.target + step, props.token);
    } else {
      setPreviousSymbol(previous);
      setSymbol(next);
      swap.jump(0).set(1, 'control');
    }
  }));

  createEffect(on(props.present, present => {
    measure();
    if (present) presence.set(1, 'panel');
    else presence.set(0, 'exit');
  }, { defer: true }));

  onMount(() => {
    measure();
    paintRoll(roll.value);
    // The first render places every column; columns that join later grow in (and roll in from one below).
    if (props.late) {
      presence.jump(0);
      presence.set(1, 'panel');
      if (isDigit()) {
        roll.jump(initialDigit - untrack(props.direction));
        roll.set(initialDigit, props.token);
      }
    } else {
      presence.jump(1);
    }
  });

  return (
    <span ref={column} class="organic-number-column">
      <span ref={sizer} class="organic-number-sizer">{isDigit() ? '0' : symbol()}</span>
      <Show
        when={isDigit()}
        fallback={
          <>
            <Show when={previousSymbol() !== undefined}>
              <span ref={outgoing} class="organic-number-symbol">{previousSymbol()}</span>
            </Show>
            <span ref={incoming} class="organic-number-symbol">{symbol()}</span>
          </>
        }
      >
        <span ref={element => { strip = element; paintRoll(roll.value); }} class="organic-number-strip">
          <For each={stripDigits}>{digit => <span>{digit}</span>}</For>
        </span>
      </Show>
    </span>
  );
}
