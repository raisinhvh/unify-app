/**
 * <Select value={v()} options={[{ value: 'high', label: 'high', hint: 'slowest' }]} onChange={setV} />
 * A text button with a chevron that opens a Menu with a check on the current value (composer pickers).
 *
 * Picking a value with a longer or shorter label springs the button's width (Indicator, no overshoot) so whatever
 * sits beside it slides over instead of jumping, while the new label fades in. Reduced motion: width snaps, fade stays.
 */
import { createEffect, createSignal, on, onCleanup, onMount, type JSX } from 'solid-js';
import { prefersReducedMotion, useSpring } from '../motion';
import { Button } from './Button';
import { Menu, type MenuEntry } from './Menu';
import type { PopoverPlacement } from './Popover';

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  /** Starts a new caption group above this option. */
  group?: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string | undefined;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** Text on the button; defaults to the selected option's label. */
  display?: string;
  placement?: PopoverPlacement;
  disabled?: boolean;
  class?: string;
  title?: string;
}

/** The button's label: its width follows the text on a spring, released to auto once settled. */
function SelectLabel(props: { text: string }): JSX.Element {
  let inner!: HTMLSpanElement;
  const [width, setWidth] = createSignal<number>();
  const [opacity, setOpacity] = createSignal(1);
  const widthSpring = useSpring(0, 'indicator', 100);
  const fade = useSpring(1, 'control', 1);
  widthSpring.onChange((value, spring) => setWidth(spring.moving ? value : undefined));
  fade.onChange(value => setOpacity(Math.max(0, Math.min(1, value))));
  let measured: number | undefined;

  onMount(() => {
    const observer = new ResizeObserver(() => {
      const next = inner.offsetWidth;
      if (measured === undefined || prefersReducedMotion()) widthSpring.jump(next);
      else if (next !== measured) {
        // Hold the old width for this frame; the spring takes it from there.
        setWidth(widthSpring.value);
        widthSpring.set(next, 'indicator');
      }
      measured = next;
    });
    observer.observe(inner);
    onCleanup(() => observer.disconnect());
  });

  createEffect(on(() => props.text, () => {
    fade.jump(0);
    fade.set(1, 'control');
  }, { defer: true }));

  return (
    <span class="select-label" classList={{ resizing: width() !== undefined }} style={{ width: width() === undefined ? undefined : `${width()}px` }}>
      <span ref={inner} style={{ opacity: opacity() }}>
        {props.text}
      </span>
    </span>
  );
}

export function Select(props: SelectProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();

  const entries = (): MenuEntry[] => {
    const list: MenuEntry[] = [];
    let lastGroup: string | undefined;
    for (const option of props.options) {
      if (option.group && option.group !== lastGroup) {
        list.push({ kind: 'group', label: option.group });
        lastGroup = option.group;
      }
      list.push({ id: option.value, label: option.label, hint: option.hint, checked: option.value === props.value, disabled: option.disabled });
    }
    return list;
  };

  const label = () => props.display ?? props.options.find(option => option.value === props.value)?.label ?? props.placeholder ?? '';

  return (
    <>
      <Button
        ref={setAnchor}
        variant="text"
        trailingIcon="chevron"
        class={props.class ? `select ${props.class}` : 'select'}
        disabled={props.disabled}
        title={props.title}
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <SelectLabel text={label()} />
      </Button>
      <Menu
        anchor={anchor()}
        open={open()}
        onClose={() => setOpen(false)}
        onSelect={props.onChange}
        items={entries()}
        placement={props.placement ?? 'top-start'}
      />
    </>
  );
}
