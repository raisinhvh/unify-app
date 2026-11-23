/**
 * Pack and provider glyphs, copied from the Figma vectors (16px grid, 1.25 stroke, round caps).
 * Shared by the Toolpacks, Hub and Providers screens.
 *
 *   <Glyph name="roblox" />            a pack glyph
 *   <Glyph name={providerGlyph(id)} /> a provider glyph; unknown names fall back to `fallback`
 */
import { Show, type JSX } from 'solid-js';
import { Icon, type IconName } from '../../components';
import './glyphs.css';

const rect = (x: number, y: number, width: number, height: number, radius: number) =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"/>`;
const circle = (x: number, y: number, radius: number) => `<circle cx="${x}" cy="${y}" r="${radius}"/>`;
const ellipse = (x: number, y: number, radiusX: number, radiusY: number) =>
  `<ellipse cx="${x}" cy="${y}" rx="${radiusX}" ry="${radiusY}"/>`;
const path = (offset: string, data: string) => `<path transform="translate(${offset})" d="${data}"/>`;

/** Mistral's block "M": filled 2.4px cells on a 5×5 grid. */
const mistralCells: [number, number][] = [
  [0, 0], [4, 0], [0, 1], [1, 1], [3, 1], [4, 1], [0, 2], [2, 2], [4, 2], [0, 3], [4, 3], [0, 4], [4, 4],
];
const mistral = mistralCells
  .map(([column, row]) => `<rect x="${2 + column * 2.4}" y="${2 + row * 2.4}" width="2.4" height="2.4" fill="currentColor" stroke="none"/>`)
  .join('');

export const glyphs = {
  // Packs
  roblox: rect(1.75, 8.75, 5.75, 4.5, 1) + rect(8.5, 8.75, 5.75, 4.5, 1) + rect(5.125, 2.75, 5.75, 4.5, 1),
  figma: rect(1.75, 11.25, 2.5, 2.5, 0.5) + rect(11.75, 2.25, 2.5, 2.5, 0.5) + path('4.25 3.5', 'M0 9C3.75 9 3.75 0 7.5 0'),
  imaging: rect(2, 2.5, 12, 11, 1.5) + circle(10.5, 6, 1.25) + path('2.5 8', 'M0 3.5L3.5 0L7.5 4M6.5 3L8 1.5L11 4.5'),
  git: circle(4.5, 3.5, 1.5) + circle(4.5, 12.5, 1.5) + circle(11.5, 5.5, 1.5) + path('4.5 5', 'M0 0L0 6C0 4 7 4.5 7 2'),
  blender:
    path('2.5 1.75', 'M5.5 0L11 3.13L11 9.38L5.5 12.5L0 9.38L0 3.13Z') +
    path('2.5 4.88', 'M0 0L5.5 3.13M5.5 3.13L11 0M5.5 3.13L5.5 9.38'),
  web: circle(8, 8, 6) + ellipse(8, 8, 2.5, 6) + '<path d="M2 8H14"/>',
  engine: rect(2, 3, 12, 10, 1.5) + path('6.5 6', 'M0 0L3.5 2L0 4Z'),
  database:
    ellipse(8, 4, 5, 1.75) +
    path('3 4', 'M0 0L0 8C0 9 2.2 9.75 5 9.75C7.8 9.75 10 9 10 8L10 0M0 4C0 5 2.2 5.75 5 5.75C7.8 5.75 10 5 10 4'),
  browser: rect(2, 2.5, 12, 11, 1.5) + path('2 4.1', 'M0 1.65L12 1.65M2.25 0L2.26 0M4 0L4.01 0'),
  issues:
    rect(2.5, 2.5, 3, 3, 0.75) + rect(2.5, 6.5, 3, 3, 0.75) + rect(2.5, 10.5, 3, 3, 0.75) +
    path('8 4', 'M0 0L5.5 0M0 4L5.5 4M0 8L3.5 8'),
  audio: path('3 2', 'M0 4.5L0 7.5M2.5 2L2.5 10M5 0L5 12M7.5 3L7.5 9M10 5L10 7'),
  sheet: rect(2, 2.5, 12, 11, 1.5) + path('2 2.5', 'M0 3.75L12 3.75M0 7.38L12 7.38M4.5 0L4.5 11'),
  recorder: rect(1.75, 4, 9, 8, 1.5) + path('10.75 5', 'M0 2L3.5 0L3.5 6L0 4'),
  containers: rect(2.5, 2.25, 11, 3.25, 0.75) + rect(2.5, 6.38, 11, 3.25, 0.75) + rect(2.5, 10.5, 11, 3.25, 0.75),
  /** The Hub folder: a 2×2 grid. */
  hub: rect(2, 2, 12, 12, 1.5) + '<path d="M8 2V14M2 8H14"/>',

  // Providers
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

export type GlyphName = keyof typeof glyphs;

export const isGlyphName = (name: string | undefined): name is GlyphName => !!name && name in glyphs;

/** Engine provider id -> glyph. */
const providerGlyphs: Record<string, GlyphName> = {
  'claude-cli': 'anthropic',
  'codex-cli': 'openai',
  'cursor-acp': 'cursor',
  'opencode-go': 'opencode',
  mistral: 'mistral',
  'self-hosted': 'selfhosted',
};

export const providerGlyph = (provider: string): GlyphName | undefined => providerGlyphs[provider];

/** Best guess at a pack glyph from its id when the engine sends no `icon`. */
const packHints: [RegExp, GlyphName][] = [
  [/roblox|studio/, 'roblox'],
  [/figma/, 'figma'],
  [/imag|photo|picture/, 'imaging'],
  [/git/, 'git'],
  [/blender|3d|mesh/, 'blender'],
  [/web|search|http/, 'web'],
  [/unity|unreal|godot|engine/, 'engine'],
  [/sql|postgres|database|db/, 'database'],
  [/browser|playwright|chrome/, 'browser'],
  [/issue|linear|jira/, 'issues'],
  [/audio|sound|music/, 'audio'],
  [/sheet|excel|csv/, 'sheet'],
  [/record|video|screen/, 'recorder'],
  [/docker|container/, 'containers'],
];

export function packGlyph(id: string, icon?: string): GlyphName | undefined {
  if (isGlyphName(icon)) return icon;
  const lower = id.toLowerCase();
  return packHints.find(([pattern]) => pattern.test(lower))?.[1];
}

export interface GlyphProps {
  name: string | undefined;
  size?: number;
  /** Drawn when `name` is not a known glyph. */
  fallback?: IconName;
  class?: string;
}

export function Glyph(props: GlyphProps): JSX.Element {
  return (
    <Show
      when={isGlyphName(props.name) ? props.name : undefined}
      fallback={<Icon name={props.fallback ?? 'toolpacks'} size={props.size} class={props.class ? `glyph ${props.class}` : 'glyph'} />}
    >
      {name => (
        <svg
          class={props.class ? `icon glyph ${props.class}` : 'icon glyph'}
          width={props.size ?? 16}
          height={props.size ?? 16}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.25"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          innerHTML={glyphs[name()]}
        />
      )}
    </Show>
  );
}

/** A glyph on a raised rounded tile (pack headers, hub rows). */
export function GlyphTile(props: { name: string | undefined; size: 32 | 40; fallback?: IconName }): JSX.Element {
  return (
    <span class={`glyph-tile glyph-tile-${props.size}`}>
      <Glyph name={props.name} size={props.size === 40 ? 20 : 16} fallback={props.fallback} />
    </span>
  );
}
