/**
 * User-selectable UI and code fonts (Settings > Appearance).
 *
 * Each option id maps to its CSS font-family stack and a lazy loader. Loaders are dynamic imports, so a font
 * the user has not picked stays out of the initial bundle. The defaults (space-mono for UI, jetbrains-mono for
 * code) are also bundled by ./fonts and ./ui-font, so loading them again is a no-op.
 * Cascadia Code has no Google/Fontsource variable build; it is a static @fontsource package.
 */
import { createEffect, createRoot } from 'solid-js';
import { feature, type FeatureId } from '../store/features';

interface FontChoice {
  /** CSS font-family stack. Ends in a generic family. */
  family: string;
  /** Loads this font's @font-face CSS. Resolves once the stylesheet is injected. */
  load: () => Promise<unknown>;
}

const MONO = 'ui-monospace, monospace';
const SANS = 'ui-sans-serif, system-ui, sans-serif';

const FONTS: Record<string, FontChoice> = {
  'space-mono': {
    family: `'Space Mono', ${MONO}`,
    load: () => Promise.all([
      import('@fontsource/space-mono/400.css'),
      import('@fontsource/space-mono/400-italic.css'),
      import('@fontsource/space-mono/700.css'),
      import('@fontsource/space-mono/700-italic.css'),
    ]),
  },
  // Kept at weight 400 only, exactly as the bundled default code font.
  'jetbrains-mono': {
    family: `'JetBrains Mono', ${MONO}`,
    load: () => import('@fontsource/jetbrains-mono/400.css'),
  },
  'ibm-plex-mono': {
    family: `'IBM Plex Mono', ${MONO}`,
    load: () => Promise.all([
      import('@fontsource/ibm-plex-mono/latin-400.css'),
      import('@fontsource/ibm-plex-mono/latin-500.css'),
      import('@fontsource/ibm-plex-mono/latin-600.css'),
      import('@fontsource/ibm-plex-mono/latin-700.css'),
    ]),
  },
  'geist-mono': {
    family: `'Geist Mono', ${MONO}`,
    load: () => import('@fontsource-variable/geist-mono/wght.css'),
  },
  'ibm-plex-sans': {
    family: `'IBM Plex Sans', ${SANS}`,
    load: () => Promise.all([
      import('@fontsource/ibm-plex-sans/latin-400.css'),
      import('@fontsource/ibm-plex-sans/latin-500.css'),
      import('@fontsource/ibm-plex-sans/latin-600.css'),
      import('@fontsource/ibm-plex-sans/latin-700.css'),
    ]),
  },
  'space-grotesk': {
    family: `'Space Grotesk', ${SANS}`,
    load: () => import('@fontsource-variable/space-grotesk/wght.css'),
  },
  'fira-code': {
    family: `'Fira Code', ${MONO}`,
    load: () => import('@fontsource-variable/fira-code/wght.css'),
  },
  'source-code-pro': {
    family: `'Source Code Pro', ${MONO}`,
    load: () => import('@fontsource-variable/source-code-pro/wght.css'),
  },
  'cascadia-code': {
    family: `'Cascadia Code', Consolas, ${MONO}`,
    load: () => Promise.all([
      import('@fontsource/cascadia-code/latin-400.css'),
      import('@fontsource/cascadia-code/latin-500.css'),
      import('@fontsource/cascadia-code/latin-600.css'),
      import('@fontsource/cascadia-code/latin-700.css'),
    ]),
  },
};

const DEFAULT_UI = 'space-mono';
const DEFAULT_CODE = 'jetbrains-mono';

let started = false;

/** Keeps one CSS variable in step with a feature. Unknown ids fall back to the default. */
function follow(featureId: FeatureId, fallbackId: string, cssVar: string): void {
  let latest = 0;
  createEffect(() => {
    const choice = FONTS[feature<string>(featureId)] ?? FONTS[fallbackId];
    const run = ++latest;
    choice.load().then(
      () => {
        // A newer selection may have started loading while this one was in flight.
        if (run === latest) document.documentElement.style.setProperty(cssVar, choice.family);
      },
      error => console.warn(`Could not load font for ${featureId}`, error),
    );
  });
}

/**
 * Applies the chosen UI and code fonts by setting --font-ui and --font-code on <html>, and re-applies when
 * the settings change. Idempotent: only the first call starts the effects. Call once at startup.
 */
export function applyFontChoices(): void {
  if (started) return;
  started = true;
  createRoot(() => {
    follow('appearance.uiFont', DEFAULT_UI, '--font-ui');
    follow('appearance.codeFont', DEFAULT_CODE, '--font-code');
  });
}
