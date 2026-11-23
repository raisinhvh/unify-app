/** A 16px Figma icon that takes the text colour. `size` scales it (the strokes scale with it). */
import type { JSX } from 'solid-js';
import { icons, type IconName } from './icons';

export interface IconProps {
  name: IconName;
  size?: number;
  class?: string;
  style?: JSX.CSSProperties;
}

export function Icon(props: IconProps): JSX.Element {
  return (
    <svg
      class={props.class ? `icon ${props.class}` : 'icon'}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={props.style}
      innerHTML={icons[props.name]}
    />
  );
}
