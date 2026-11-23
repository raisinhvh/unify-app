/**
 * Provider logos: the one glyph source for the whole app (Providers, Toolpacks, the model picker, usage rows).
 * Drawn in Figma ("Provider glyphs" frame, and the Icon/provider/* components) on the 16px grid: monochrome
 * currentColor, filled like the real marks, about 2px line weight and a 14px live area so no logo looks heavier
 * than another. Marks taken from a 24px original are scaled into the 14px area with `fromBrand`.
 *
 *   <ProviderGlyph provider="claude-cli" size={16} />
 *   providerGlyph('codex-cli')  // 'openai'
 */
import { Show, type JSX } from 'solid-js';
import { Icon } from './Icon';
import type { IconName } from './icons';

/** Places a mark drawn on a 24px brand grid into the 14px live area of the 16px grid. */
const fromBrand = 'translate(1 1) scale(0.583333)';

export const providerGlyphs = {
  /** The "A\" wordmark-A with its slash. */
  anthropic:
    `<path fill-rule="evenodd" transform="${fromBrand}" d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/>`,
  /** The six-loop knot. Its lines are thin in the original, so a hairline stroke brings it up to the set's weight. */
  openai:
    `<path transform="${fromBrand}" stroke="currentColor" stroke-width="0.6" stroke-linejoin="round" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>`,
  /** Gemini's four-point spark with curved sides. */
  gemini: '<path d="M8 1C8.45 4.75 11.25 7.55 15 8C11.25 8.45 8.45 11.25 8 15C7.55 11.25 4.75 8.45 1 8C4.75 7.55 7.55 4.75 8 1Z"/>',
  /** Mistral's stepped block "M" on a 2px grid. */
  mistral: '<path d="M3 3h2v2h2v2h2V5h2V3h2v8h2v2H9v-2h2V9H9v2H7V9H5v2h2v2H1v-2h2Z"/>',
  /** Cursor's cube: a hexagon with its lit face cut out. */
  cursor:
    `<path fill-rule="evenodd" transform="${fromBrand}" d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"/>`,
  /** OpenCode's frame with the block set into its lower half. */
  opencode: '<path fill-rule="evenodd" d="M3 2h10v12H3Zm2 2v8h6V4Z"/><path d="M6 8h4v3H6Z"/>',
  /** Self-hosted: a neutral two-unit server. */
  selfhosted:
    '<path fill-rule="evenodd" d="M3.5 2h9A1.5 1.5 0 0 1 14 3.5v3A1.5 1.5 0 0 1 12.5 8h-9A1.5 1.5 0 0 1 2 6.5v-3A1.5 1.5 0 0 1 3.5 2Zm.25 1.5v3h8.5v-3ZM3.5 9h9a1.5 1.5 0 0 1 1.5 1.5v2a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-2A1.5 1.5 0 0 1 3.5 9Zm.25 1.5v2h8.5v-2Z"/>' +
    '<path d="M9.5 4.25h1.5v1.5H9.5ZM9.5 10.75h1.5v1.5H9.5Z"/>',
} as const;

export type ProviderGlyphName = keyof typeof providerGlyphs;

/** Engine provider id (and the plain glyph names) -> glyph. */
const providerGlyphNames: Record<string, ProviderGlyphName> = {
  'claude-cli': 'anthropic',
  anthropic: 'anthropic',
  'codex-cli': 'openai',
  openai: 'openai',
  'cursor-acp': 'cursor',
  cursor: 'cursor',
  'opencode-go': 'opencode',
  opencode: 'opencode',
  mistral: 'mistral',
  gemini: 'gemini',
  'google-gemini': 'gemini',
  'self-hosted': 'selfhosted',
  selfhosted: 'selfhosted',
};

export const providerGlyph = (provider: string): ProviderGlyphName | undefined => providerGlyphNames[provider];

export interface ProviderGlyphProps {
  /** An engine provider id ('claude-cli') or a glyph name ('anthropic'). */
  provider: string;
  size?: number;
  class?: string;
  /** Drawn when the provider has no logo. */
  fallback?: IconName;
}

export function ProviderGlyph(props: ProviderGlyphProps): JSX.Element {
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
          fill="currentColor"
          aria-hidden="true"
          innerHTML={providerGlyphs[glyph()]}
        />
      )}
    </Show>
  );
}
