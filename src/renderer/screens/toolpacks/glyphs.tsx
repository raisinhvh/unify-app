/**
 * Pack glyphs, copied from the Figma vectors (16px grid, 1.25 stroke, round caps). Shared by the Toolpacks and Hub
 * screens. Provider names ('anthropic', 'openai', ...) draw the shared provider logos from components/ProviderGlyph.
 *
 *   <Glyph name="roblox" />     a pack glyph
 *   <Glyph name="anthropic" />  a provider logo; unknown names fall back to `fallback`
 */
import { Match, Switch, type JSX } from 'solid-js';
import { Icon, ProviderGlyph, providerGlyphs, type IconName, type ProviderGlyphName } from '../../components';
import './glyphs.css';

const rect = (x: number, y: number, width: number, height: number, radius: number) =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"/>`;
const circle = (x: number, y: number, radius: number) => `<circle cx="${x}" cy="${y}" r="${radius}"/>`;
const ellipse = (x: number, y: number, radiusX: number, radiusY: number) =>
  `<ellipse cx="${x}" cy="${y}" rx="${radiusX}" ry="${radiusY}"/>`;
const path = (offset: string, data: string) => `<path transform="translate(${offset})" d="${data}"/>`;

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
} as const;

export type PackGlyphName = keyof typeof glyphs;

/** A pack glyph, or a provider logo (drawn by components/ProviderGlyph, the one logo source). */
export type GlyphName = PackGlyphName | ProviderGlyphName;

const isPackGlyphName = (name: string | undefined): name is PackGlyphName => !!name && name in glyphs;

const isProviderGlyphName = (name: string | undefined): name is ProviderGlyphName => !!name && name in providerGlyphs;

export const isGlyphName = (name: string | undefined): name is GlyphName => isPackGlyphName(name) || isProviderGlyphName(name);

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
  const glyphClass = () => (props.class ? `glyph ${props.class}` : 'glyph');
  return (
    <Switch fallback={<Icon name={props.fallback ?? 'toolpacks'} size={props.size} class={glyphClass()} />}>
      <Match when={isPackGlyphName(props.name) ? props.name : undefined}>
        {name => (
          <svg
            class={`icon ${glyphClass()}`}
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
      </Match>
      <Match when={isProviderGlyphName(props.name) ? props.name : undefined}>
        {name => <ProviderGlyph provider={name()} size={props.size} class={glyphClass()} />}
      </Match>
    </Switch>
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
