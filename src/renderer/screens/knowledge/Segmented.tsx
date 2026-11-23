/**
 * Segmented control (Figma: "Global | This project", "Read | Edit"). The selected fill slides between
 * segments on the Indicator spring; it measures the buttons, so labels of any width work.
 *
 *   <Segmented value={scope()} onChange={setScope} options={[{ value: 'global', label: 'Global' }, …]} />
 */
import { createEffect, createSignal, For, onCleanup, onMount, type JSX } from 'solid-js';
import { driveSpring, pressable, useSpring } from '../../motion';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  class?: string;
  label: string;
}

export function Segmented<T extends string>(props: SegmentedProps<T>): JSX.Element {
  let container!: HTMLDivElement;
  const buttons = new Map<string, HTMLButtonElement>();
  const [layoutTick, setLayoutTick] = createSignal(0);

  const box = () => {
    layoutTick();
    const button = buttons.get(props.value);
    return button ? { left: button.offsetLeft, width: button.offsetWidth } : { left: 0, width: 0 };
  };
  const leftSpring = useSpring(0, 'indicator', 100);
  const widthSpring = useSpring(0, 'indicator', 100);
  const [left, setLeft] = createSignal(0);
  const [width, setWidth] = createSignal(0);
  leftSpring.onChange(setLeft);
  widthSpring.onChange(setWidth);

  // The first measurement places the fill without sliding in from the left edge.
  let placed = false;
  createEffect(() => {
    const target = box();
    if (!target.width) return;
    if (!placed) {
      placed = true;
      leftSpring.jump(target.left);
      widthSpring.jump(target.width);
      return;
    }
    driveSpring(leftSpring, target.left);
    driveSpring(widthSpring, target.width);
  });

  onMount(() => {
    setLayoutTick(tick => tick + 1);
    const observer = new ResizeObserver(() => setLayoutTick(tick => tick + 1));
    observer.observe(container);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div ref={container} class={`segmented${props.class ? ' ' + props.class : ''}`} role="tablist" aria-label={props.label}>
      <span class="segmented-indicator" style={{ translate: `${left()}px 0`, width: `${width()}px` }} />
      <For each={props.options}>
        {option => (
          <button
            type="button"
            role="tab"
            class="segmented-option"
            classList={{ selected: option.value === props.value }}
            aria-selected={option.value === props.value}
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
