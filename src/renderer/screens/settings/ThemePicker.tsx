/**
 * Theme pickers (Figma 25b Themes 306:12078 and the 26e Extras cards).
 *
 *   <ThemeList />    Settings: one flat row per theme (preview, name, kind) with a check on the current one
 *   <ThemeCards />   Setup: a wrapping grid of small previews with the name underneath
 *
 * Both call setTheme, which crossfades the whole window (theme/index.ts). Previews draw from the theme's own
 * colours, so every preview shows its theme whatever theme is active.
 */
import { For, type JSX } from 'solid-js';
import { Icon } from '../../components';
import { createSpring, pressable } from '../../motion';
import { currentTheme, setTheme, themeNames, themeOrder, themes, type ThemeId } from '../../theme';

export const themeKinds: Record<ThemeId, string> = {
  walnutDark: 'Dark, default',
  walnutLight: 'Light',
  graphite: 'Dark',
  paper: 'Light',
  slate: 'Dark',
  moss: 'Dark',
  ink: 'Dark, true black for OLED',
  dusk: 'Dark',
  tide: 'Dark',
  ember: 'Dark',
  linen: 'Light',
  mist: 'Light',
  sage: 'Light',
};

/** A tiny window in the theme's colours: a side panel, two lines of text and the accent. Drawn at 48×32. */
export function ThemePreview(props: { id: ThemeId; width?: number; height?: number }): JSX.Element {
  const tokens = () => themes[props.id];
  return (
    <svg
      class="theme-preview"
      width={props.width ?? 48}
      height={props.height ?? 32}
      viewBox="0 0 48 32"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect x="0.5" y="0.5" width="47" height="31" rx="4.5" fill={tokens().bg} stroke={tokens().border} />
      <path d="M5 0.5H12.5V31.5H5A4.5 4.5 0 0 1 0.5 27V5A4.5 4.5 0 0 1 5 0.5Z" fill={tokens().surface} stroke={tokens().border} />
      <rect x="3.5" y="6" width="5" height="1.5" rx="0.75" fill={tokens().text3} />
      <rect x="3.5" y="10" width="5" height="1.5" rx="0.75" fill={tokens().text3} />
      <rect x="19" y="8" width="22" height="2" rx="1" fill={tokens().text} />
      <rect x="19" y="13" width="15" height="2" rx="1" fill={tokens().text2} />
      <rect x="38" y="22" width="5" height="5" rx="1" fill={tokens().accent} />
    </svg>
  );
}

function ThemeRow(props: { id: ThemeId }): JSX.Element {
  const selected = () => currentTheme() === props.id;
  const mark = createSpring(() => (selected() ? 1 : 0), 'pop');
  return (
    <button
      type="button"
      class="theme-row"
      classList={{ selected: selected() }}
      role="radio"
      aria-checked={selected()}
      ref={element => pressable(element, 0.99)}
      onClick={() => setTheme(props.id)}
    >
      <ThemePreview id={props.id} />
      <span class="theme-row-text">
        <span class="theme-row-name">{themeNames[props.id]}</span>
        <span class="theme-row-kind type-caption">{themeKinds[props.id]}</span>
      </span>
      <Icon
        name="check"
        class="theme-row-check"
        style={{ opacity: Math.max(0, Math.min(1, mark())), transform: `scale(${0.6 + 0.4 * mark()})` }}
      />
    </button>
  );
}

export function ThemeList(): JSX.Element {
  return (
    <div class="theme-list" role="radiogroup" aria-label="Theme">
      <For each={themeOrder}>{id => <ThemeRow id={id} />}</For>
    </div>
  );
}

function ThemeCard(props: { id: ThemeId }): JSX.Element {
  const selected = () => currentTheme() === props.id;
  const ring = createSpring(() => (selected() ? 1 : 0), 'indicator', { fadeOnly: true });
  return (
    <button
      type="button"
      class="theme-card"
      role="radio"
      aria-checked={selected()}
      ref={element => pressable(element, 0.96)}
      onClick={() => setTheme(props.id)}
    >
      <span class="theme-card-frame">
        <ThemePreview id={props.id} width={72} height={48} />
        <span class="theme-card-ring" style={{ opacity: Math.max(0, Math.min(1, ring())) }} />
      </span>
      <span class="theme-card-name type-caption" classList={{ selected: selected() }}>{themeNames[props.id]}</span>
    </button>
  );
}

export function ThemeCards(): JSX.Element {
  return (
    <div class="theme-cards" role="radiogroup" aria-label="Theme">
      <For each={themeOrder}>{id => <ThemeCard id={id} />}</For>
    </div>
  );
}
