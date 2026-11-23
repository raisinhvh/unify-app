/**
 * <Toggle checked={on()} onChange={setOn} label="Reduce motion" />
 * A flat 28×16 switch. The knob slides on the Control spring and stretches a little while pressed.
 */
import type { JSX } from 'solid-js';
import { createSpring, pressable } from '../motion';
import './toggle.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export function Toggle(props: ToggleProps): JSX.Element {
  const position = createSpring(() => (props.checked ? 1 : 0), 'control');
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      class="toggle"
      classList={{ on: props.checked }}
      ref={element => pressable(element, 0.94)}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="toggle-track" style={{ opacity: 0.35 + position() * 0.65 }} />
      <span class="toggle-knob" style={{ translate: `${position() * 12}px 0` }} />
    </button>
  );
}
