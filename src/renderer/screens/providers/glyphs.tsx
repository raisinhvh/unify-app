/**
 * Provider brand glyphs (Figma vectors, 16px grid, 1.25 stroke, round caps). Copied from the Toolpacks
 * screen's glyph set so Providers does not depend on another screen's folder while they are built in parallel.
 *
 *   <ProviderGlyph provider="claude-cli" size={16} />
 */
import { Show, type JSX } from 'solid-js';
import { Icon, type IconName } from '../../components';

const rect = (x: number, y: number, width: number, height: number, radius: number) =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"/>`;
const path = (offset: string, data: string) => `<path transform="translate(${offset})" d="${data}"/>`;

/** Mistral's block "M": filled 2.4px cells on a 5×5 grid. */
const mistralCells: [number, number][] = [
  [0, 0], [4, 0], [0, 1], [1, 1], [3, 1], [4, 1], [0, 2], [2, 2], [4, 2], [0, 3], [4, 3], [0, 4], [4, 4],
];
const mistral = mistralCells
  .map(([column, row]) => `<rect x="${2 + column * 2.4}" y="${2 + row * 2.4}" width="2.4" height="2.4" fill="currentColor" stroke="none"/>`)
  .join('');

export const providerGlyphs = {
  anthropic: path('3 2.5', 'M0 11L5 0L10 11') + path('5.4 9.5', 'M0 0L5.2 0'),
  openai:
    path('2.59 1.75', 'M5.41 0L10.82 3.13L10.82 9.38L5.41 12.5L0 9.38L0 3.13Z') +
    path('5 5.4', 'M6 2.6L4.5 5.2L1.5 5.2L0 2.6L1.5 0L4.5 0Z') +
    path('5.29 3.31', 'M5.71 4.69L8.12 4.69M1.21 7.29L.01 9.38M1.21 2.09L0 0'),
  mistral,
  gemini: path(
    '1.75 1.75',
    'M6.25 0C6.65 3.45 9.05 5.85 12.5 6.25C9.05 6.65 6.65 9.05 6.25 12.5C5.85 9.05 3.45 6.65 0 6.25C3.45 5.85 5.85 3.45 6.25 0Z',
  ),
  selfhosted: rect(2.25, 2.75, 11.5, 4.5, 1.25) + rect(2.25, 8.75, 11.5, 4.5, 1.25) + '<path d="M9.35 5h1M9.35 11h1"/>',
  cursor: path('2.5 1.75', 'M5.5 0L11 3.15L11 9.35L5.5 12.5L0 9.35L0 3.15Z') + path('2.5 4.9', 'M0 0L11 6.2'),
  opencode: rect(2.75, 1.75, 10.5, 12.5, 1.25) + rect(5.5, 7, 5, 4.5, 0.5),
} as const;

export type ProviderGlyphName = keyof typeof providerGlyphs;

const providerGlyphNames: Record<string, ProviderGlyphName> = {
  'claude-cli': 'anthropic',
  'codex-cli': 'openai',
  'cursor-acp': 'cursor',
  'opencode-go': 'opencode',
  mistral: 'mistral',
  gemini: 'gemini',
  'google-gemini': 'gemini',
  'self-hosted': 'selfhosted',
};

export const providerGlyph = (provider: string): ProviderGlyphName | undefined => providerGlyphNames[provider];

export function ProviderGlyph(props: { provider: string; size?: number; class?: string; fallback?: IconName }): JSX.Element {
  const name = () => providerGlyph(props.provider);
  return (
    <Show
      when={name()}
      fallback={<Icon name={props.fallback ?? 'providers'} size={props.size} class={props.class} />}
    >
      {glyph => (
        <svg
          class={props.class ? `icon provider-glyph ${props.class}` : 'icon provider-glyph'}
          width={props.size ?? 16}
          height={props.size ?? 16}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.25"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          innerHTML={providerGlyphs[glyph()]}
        />
      )}
    </Show>
  );
}

/** A provider glyph on a raised rounded tile (account page header). */
export function ProviderTile(props: { provider: string; size: 32 | 40 }): JSX.Element {
  return (
    <span class={`pv-glyph-tile pv-glyph-tile-${props.size}`}>
      <ProviderGlyph provider={props.provider} size={props.size === 40 ? 20 : 16} />
    </span>
  );
}
