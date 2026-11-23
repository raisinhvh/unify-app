/**
 * <Select value={v()} options={[{ value: 'high', label: 'high', hint: 'slowest' }]} onChange={setV} />
 * A text button with a chevron that opens a Menu with a check on the current value (composer pickers).
 */
import { createSignal, type JSX } from 'solid-js';
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
        {label()}
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
