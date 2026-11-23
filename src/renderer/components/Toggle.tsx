/**
 * <Toggle checked={on()} onChange={setOn} label="Reduce motion" />
 * A flat 28×16 switch. The knob slides with a tiny settle while the accent fill and the knob colour cross-fade on
 * the Control spring (no colour cut). Pressing stretches the knob a little toward its free side (Button spring),
 * so it reads as being pulled before it travels. Reduced motion: the knob moves in one step, colours still fade,
 * no stretch.
 */
import { createSignal, type JSX } from 'solid-js';
import { createSpring, prefersReducedMotion } from '../motion';
import './toggle.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

/** Knob travel inside the 28px track (28 − 2 × 2px inset − 12px knob). */
const knobTravel = 12;
/** How much wider the knob gets while pressed, px. */
const pressStretch = 3;
/** The knob lands with a tiny settle (~0.5px past its stop); calmed to no overshoot while motion.bounce is off. */
const knobSpring = { period: 0.2, damping: 0.72 };

export function Toggle(props: ToggleProps): JSX.Element {
  const [pressed, setPressed] = createSignal(false);
  const position = createSpring(() => (props.checked ? 1 : 0), knobSpring);
  const tint = createSpring(() => (props.checked ? 1 : 0), 'control', { fadeOnly: true });
  const stretch = createSpring(() => (pressed() ? 1 : 0), 'button');

  const extraWidth = () => pressStretch * stretch();
  // The stretched knob stays pinned to the side it rests on: it grows right when off, left when on.
  const knobOffset = () => position() * (knobTravel - extraWidth());
  const percent = () => `${Math.round(Math.max(0, Math.min(1, tint())) * 1000) / 10}%`;

  const press = (event: PointerEvent) => {
    if (event.button !== 0 || props.disabled || prefersReducedMotion()) return;
    setPressed(true);
  };
  const release = () => setPressed(false);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      class="toggle"
      classList={{ on: props.checked }}
      onPointerDown={press}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="toggle-track" style={{ opacity: tint() }} />
      <span
        class="toggle-knob"
        style={{
          width: `${12 + extraWidth()}px`,
          translate: `${knobOffset()}px 0`,
          'background-color': `color-mix(in srgb, var(--on-accent) ${percent()}, var(--text))`,
        }}
      />
    </button>
  );
}
