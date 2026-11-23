/**
 * The wood-block Unify logo that backs the whole app (Figma "Backdrop/Logo" 306:17959).
 *
 * It lives inside the Home layer, the bottom layer of the window: every screen, panel and pane is drawn on
 * top of it, and wherever nothing covers it, it shows through unchanged. Never draw a per-screen backdrop.
 * Placement matches the Figma frame: a 520px box, 80px right of the rail, vertically centred.
 */
import type { JSX } from 'solid-js';
import './backdrop.css';

export function Backdrop(): JSX.Element {
  return (
    <div class="backdrop" aria-hidden="true">
      <svg class="backdrop-logo" viewBox="0 0 520 520" fill="none">
        <path d="M65 32.5H201.5V312H251.875V448.5H65V32.5Z" fill="var(--wood-light)" />
        <path d="M268.125 351H318.5V71.5H455V487.5H268.125V351Z" fill="var(--wood-dark)" />
      </svg>
    </div>
  );
}

/** The small app logo (Figma 306:683), used at the top of the rail. */
export function LogoMark(props: { size?: number }): JSX.Element {
  return (
    <svg width={props.size ?? 32} height={props.size ?? 32} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M4 2H12.4V19.2H15.5V27.6H4V2Z" fill="var(--wood-light)" />
      <path d="M16.5 21.6H19.6V4.4H28V30H16.5V21.6Z" fill="var(--wood-dark)" />
    </svg>
  );
}
