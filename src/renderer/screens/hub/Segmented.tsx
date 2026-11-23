/**
 * Small segmented control (Hub "Install to" and "Sort"). The selected fill slides between options on the
 * Control spring; measured from the option buttons, so labels of any width work.
 */
import { createEffect, createSignal, For, onCleanup, onMount, type JSX } from 'solid-js';
import { driveSpring, pressable, useSpring } from '../../motion';

export interface SegmentedProps<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  class?: string;
}

export function Segmented<T extends string>(props: SegmentedProps<T>): JSX.Element {
  const buttons = new Map<string, HTMLButtonElement>();
  const [layoutTick, setLayoutTick] = createSignal(0);
  const box = () => {
    layoutTick();
    const element = buttons.get(props.value);
    return element ? { left: element.offsetLeft, width: element.offsetWidth } : { left: 0, width: 0 };
  };
  const leftSpring = useSpring(0, 'control', 100);
  const widthSpring = useSpring(0, 'control', 100);
  const [left, setLeft] = createSignal(0);
  const [width, setWidth] = createSignal(0);
  leftSpring.onChange(setLeft);
  widthSpring.onChange(setWidth);
  let measured = false;
  createEffect(() => {
    const target = box();
    if (!target.width) return;
    // The first measurement places the fill; later changes slide it.
    if (!measured) {
      measured = true;
      leftSpring.jump(target.left);
      widthSpring.jump(target.width);
      return;
    }
    driveSpring(leftSpring, target.left);
    driveSpring(widthSpring, target.width);
  });
  let root!: HTMLDivElement;

  onMount(() => {
    // Fonts load after mount; re-measure whenever the control changes size.
    const observer = new ResizeObserver(() => setLayoutTick(tick => tick + 1));
    observer.observe(root);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div ref={root} class={props.class ? `segmented ${props.class}` : 'segmented'} role="radiogroup" aria-label={props.label}>
      <span class="segmented-fill" style={{ translate: `${left()}px 0`, width: `${width()}px` }} />
      <For each={props.options}>
        {option => (
          <button
            type="button"
            role="radio"
            aria-checked={option.value === props.value}
            class="segmented-option"
            classList={{ selected: option.value === props.value }}
            ref={element => {
              buttons.set(option.value, element);
              pressable(element, 0.96);
            }}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}
