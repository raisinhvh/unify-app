/**
 * Buttons. No pills (spec): text buttons, icon buttons, the flat primary (#EFE6DA, 6px radius) and flat rows.
 * Every button presses elastically (motion/press).
 *
 *   <Button variant="primary" onClick={…}>Allow</Button>
 *   <IconButton icon="close" label="Close" onClick={…} />
 */
import { splitProps, type JSX } from 'solid-js';
import { pressable } from '../motion';
import { Icon } from './Icon';
import type { IconName } from './icons';
import type { PopoverPlacement } from './Popover';
import { tooltip } from './Tooltip';
import './button.css';

export type ButtonVariant = 'text' | 'primary' | 'secondary' | 'row' | 'ghost';

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: IconName;
  /** Icon after the label (chevrons on pickers). */
  trailingIcon?: IconName;
  /** How far it presses in; large surfaces press less. */
  pressDepth?: number;
}

export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ['variant', 'icon', 'trailingIcon', 'pressDepth', 'class', 'children', 'ref']);
  return (
    <button
      type="button"
      {...rest}
      ref={element => {
        pressable(element, local.pressDepth ?? 0.94);
        if (typeof local.ref === 'function') (local.ref as (element: HTMLButtonElement) => void)(element);
      }}
      class={`button button-${local.variant ?? 'text'}${local.class ? ' ' + local.class : ''}`}
    >
      {local.icon && <Icon name={local.icon} />}
      {local.children}
      {local.trailingIcon && <Icon name={local.trailingIcon} class="button-trailing" size={14} />}
    </button>
  );
}

export interface IconButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  size?: 'small' | 'medium' | 'large';
  active?: boolean;
  /** Where the label tooltip opens. Default below. */
  tooltipPlacement?: PopoverPlacement;
}

export function IconButton(props: IconButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ['icon', 'label', 'size', 'active', 'class', 'ref', 'tooltipPlacement']);
  return (
    <button
      type="button"
      aria-label={local.label}
      {...rest}
      ref={element => {
        pressable(element);
        tooltip(element, local.label, { placement: local.tooltipPlacement ?? 'bottom-start' });
        if (typeof local.ref === 'function') (local.ref as (element: HTMLButtonElement) => void)(element);
      }}
      class={`icon-button icon-button-${local.size ?? 'medium'}${local.active ? ' active' : ''}${local.class ? ' ' + local.class : ''}`}
      aria-pressed={local.active === undefined ? undefined : local.active}
    >
      <Icon name={local.icon} />
    </button>
  );
}
