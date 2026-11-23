/**
 * The seven Unify themes, copied from Figma (root pluginData `unifyThemes`).
 *
 * Every theme has the same token structure; status colours (add/del/warn) and the wood colours are shared.
 * Contrast on `bg`: text >= 7, text2 >= 4.5, text3 >= 3.
 */

export interface ThemeTokens {
  bg: string;
  surface: string;
  raised: string;
  hover: string;
  border: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  accentLight: string;
}

export type ThemeId = 'walnutDark' | 'walnutLight' | 'graphite' | 'paper' | 'slate' | 'moss' | 'ink';

export const themes: Record<ThemeId, ThemeTokens> = {
  walnutDark: {
    bg: '#0D0B09',
    surface: '#13100E',
    raised: '#1B1714',
    hover: '#241F1B',
    border: '#2E2722',
    text: '#EFEAE4',
    text2: '#A89E94',
    text3: '#6C625A',
    accent: '#EFE6DA',
    accentLight: '#EFE6DA',
  },
  walnutLight: {
    bg: '#F5EFE6',
    surface: '#EEE6DA',
    raised: '#FBF8F3',
    hover: '#E5DBCC',
    border: '#D8CBB8',
    text: '#2A1E15',
    text2: '#65523F',
    text3: '#8C7762',
    accent: '#3A2A1E',
    accentLight: '#3A2A1E',
  },
  graphite: {
    bg: '#0E0E0F',
    surface: '#141415',
    raised: '#1C1C1E',
    hover: '#252527',
    border: '#303033',
    text: '#ECECED',
    text2: '#A3A3A7',
    text3: '#6E6E73',
    accent: '#E6E6E8',
    accentLight: '#E6E6E8',
  },
  paper: {
    bg: '#F7F7F5',
    surface: '#EFEFEC',
    raised: '#FFFFFF',
    hover: '#E6E6E2',
    border: '#D9D9D4',
    text: '#1B1B1B',
    text2: '#5A5A58',
    text3: '#84847F',
    accent: '#232323',
    accentLight: '#232323',
  },
  slate: {
    bg: '#0B0E12',
    surface: '#10141A',
    raised: '#171C23',
    hover: '#1F252D',
    border: '#2A313B',
    text: '#E6EBF1',
    text2: '#9AA5B2',
    text3: '#626D7A',
    accent: '#E1E7EE',
    accentLight: '#E1E7EE',
  },
  moss: {
    bg: '#0C0E0B',
    surface: '#121510',
    raised: '#191D16',
    hover: '#21261E',
    border: '#2C3228',
    text: '#E7EBE2',
    text2: '#A0A997',
    text3: '#666F5F',
    accent: '#E2E8DB',
    accentLight: '#E2E8DB',
  },
  ink: {
    bg: '#000000',
    surface: '#0A0A0A',
    raised: '#141414',
    hover: '#1E1E1E',
    border: '#2C2C2C',
    text: '#FFFFFF',
    text2: '#B5B5B5',
    text3: '#7E7E7E',
    accent: '#FFFFFF',
    accentLight: '#FFFFFF',
  },
};

export const themeOrder: ThemeId[] = ['walnutDark', 'walnutLight', 'graphite', 'paper', 'slate', 'moss', 'ink'];

export const themeNames: Record<ThemeId, string> = {
  walnutDark: 'Walnut Dark',
  walnutLight: 'Walnut Light',
  graphite: 'Graphite',
  paper: 'Paper',
  slate: 'Slate',
  moss: 'Moss',
  ink: 'Ink',
};

export const defaultTheme: ThemeId = 'walnutDark';

/** Light themes flip what "on accent" text and dim loader cells look like. */
export const lightThemes: ReadonlySet<ThemeId> = new Set<ThemeId>(['walnutLight', 'paper']);

/** Shared across themes (Figma paint styles unify/add, del, warn, tints, wood). */
export const sharedTokens = {
  add: '#4CB862',
  del: '#E5534B',
  warn: '#D9A441',
  addTint: 'rgba(76, 184, 98, 0.13)',
  delTint: 'rgba(229, 83, 75, 0.13)',
  accentTint: 'rgba(201, 164, 101, 0.10)',
  walnut: '#523828',
  woodLight: '#C9A465',
  woodDark: '#8B6A35',
};
