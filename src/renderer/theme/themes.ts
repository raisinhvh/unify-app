/**
 * The Unify themes. The first seven are copied from Figma (root pluginData `unifyThemes`); Dusk, Tide, Ember,
 * Linen, Mist and Sage were added in the app with the same structure.
 *
 * Every theme has the same token structure; status colours (add/del/warn) and the wood colours are shared.
 * Contrast on `bg`: text >= 7, text2 >= 4.5, text3 >= 3.
 *
 * Panes vs the window: panes fill with `bg`; the window behind and between them is `canvas` (darker than `bg`,
 * clearly so in light themes), and panes are outlined with `paneBorder` (stronger than `border`) so neighbouring
 * panes don't blend into one sheet.
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
  /** The window backdrop around and between panes. */
  canvas: string;
  /** A pane's outline. */
  paneBorder: string;
}

export type ThemeId =
  | 'walnutDark'
  | 'walnutLight'
  | 'graphite'
  | 'paper'
  | 'slate'
  | 'moss'
  | 'ink'
  | 'dusk'
  | 'tide'
  | 'ember'
  | 'linen'
  | 'mist'
  | 'sage';

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
    canvas: '#070605',
    paneBorder: '#3E352E',
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
    canvas: '#E6DCCD',
    paneBorder: '#CDBEA8',
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
    canvas: '#08080A',
    paneBorder: '#404044',
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
    canvas: '#E7E7E2',
    paneBorder: '#CFCFC9',
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
    canvas: '#06080B',
    paneBorder: '#38424E',
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
    canvas: '#070906',
    paneBorder: '#3A4235',
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
    canvas: '#000000',
    paneBorder: '#3A3A3A',
  },
  dusk: {
    bg: '#0E0C12',
    surface: '#14121A',
    raised: '#1C1924',
    hover: '#25212F',
    border: '#302B3B',
    text: '#ECE8F2',
    text2: '#A69FB3',
    text3: '#6F6880',
    accent: '#E8E3F0',
    accentLight: '#E8E3F0',
    canvas: '#08070B',
    paneBorder: '#3D374A',
  },
  tide: {
    bg: '#081012',
    surface: '#0D171A',
    raised: '#132024',
    hover: '#1A2A2F',
    border: '#24363B',
    text: '#E3EEF0',
    text2: '#94AAAF',
    text3: '#5E7479',
    accent: '#DDEBED',
    accentLight: '#DDEBED',
    canvas: '#040A0B',
    paneBorder: '#2F454B',
  },
  ember: {
    bg: '#110B0A',
    surface: '#18100E',
    raised: '#211715',
    hover: '#2B1E1B',
    border: '#382724',
    text: '#F1E7E4',
    text2: '#B19E99',
    text3: '#7A6661',
    accent: '#F0E2DD',
    accentLight: '#F0E2DD',
    canvas: '#0A0605',
    paneBorder: '#47322E',
  },
  linen: {
    bg: '#FAF6EE',
    surface: '#F2ECE0',
    raised: '#FFFDF8',
    hover: '#E9E1D2',
    border: '#DCD2BF',
    text: '#26221B',
    text2: '#5F574A',
    text3: '#877D6D',
    accent: '#2E2920',
    accentLight: '#2E2920',
    canvas: '#EAE2D3',
    paneBorder: '#D2C6B0',
  },
  mist: {
    bg: '#F3F6F9',
    surface: '#EAEFF4',
    raised: '#FFFFFF',
    hover: '#E0E7EE',
    border: '#D0D9E2',
    text: '#18202A',
    text2: '#4F5C6B',
    text3: '#7A8796',
    accent: '#1E2833',
    accentLight: '#1E2833',
    canvas: '#E1E8EF',
    paneBorder: '#C3CEDA',
  },
  sage: {
    bg: '#F3F6F1',
    surface: '#EAEFE6',
    raised: '#FCFDFB',
    hover: '#DFE6DA',
    border: '#CFD9C8',
    text: '#1B2418',
    text2: '#4E5C48',
    text3: '#788572',
    accent: '#222D1E',
    accentLight: '#222D1E',
    canvas: '#E2E9DD',
    paneBorder: '#C2CEBA',
  },
};

/** Picker order: the defaults, then dark themes, then light ones. */
export const themeOrder: ThemeId[] = [
  'walnutDark',
  'walnutLight',
  'graphite',
  'slate',
  'moss',
  'dusk',
  'tide',
  'ember',
  'ink',
  'paper',
  'linen',
  'mist',
  'sage',
];

export const themeNames: Record<ThemeId, string> = {
  walnutDark: 'Walnut Dark',
  walnutLight: 'Walnut Light',
  graphite: 'Graphite',
  paper: 'Paper',
  slate: 'Slate',
  moss: 'Moss',
  ink: 'Ink',
  dusk: 'Dusk',
  tide: 'Tide',
  ember: 'Ember',
  linen: 'Linen',
  mist: 'Mist',
  sage: 'Sage',
};

export const defaultTheme: ThemeId = 'walnutDark';

/** Light themes flip what "on accent" text and dim loader cells look like. */
export const lightThemes: ReadonlySet<ThemeId> = new Set<ThemeId>(['walnutLight', 'paper', 'linen', 'mist', 'sage']);

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
