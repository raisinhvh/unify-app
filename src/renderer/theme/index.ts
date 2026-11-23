/**
 * Theme runtime: writes the active theme's tokens as CSS variables on <html> and switches themes with a crossfade.
 *
 * Components only ever read `var(--token)`; nothing reads theme objects directly. The choice is persisted.
 * Switching uses the View Transitions API (one crossfade of the whole window) and falls back to an instant swap.
 */
import { createSignal } from 'solid-js';
import { readPersisted, writePersisted } from '../persist';
import { prefersReducedMotion } from '../motion/reducedMotion';
import { defaultTheme, lightThemes, sharedTokens, themes, type ThemeId, type ThemeTokens } from './themes';
import './fonts';
import './theme.css';

export * from './themes';

const [currentTheme, setCurrentTheme] = createSignal<ThemeId>(validTheme(readPersisted('theme', defaultTheme)));
export { currentTheme };

function validTheme(value: unknown): ThemeId {
  return typeof value === 'string' && value in themes ? (value as ThemeId) : defaultTheme;
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
}

function writeVariables(id: ThemeId): void {
  const root = document.documentElement;
  const tokens: ThemeTokens = themes[id];
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty('--' + kebab(name), value);
  for (const [name, value] of Object.entries(sharedTokens)) root.style.setProperty('--' + kebab(name), value);
  const light = lightThemes.has(id);
  root.dataset.theme = id;
  root.style.colorScheme = light ? 'light' : 'dark';
  // Text on the flat primary button and dim loader cells depend on whether the theme is light.
  root.style.setProperty('--on-accent', tokens.bg);
  root.style.setProperty('--loader-dim', light ? '#D9C7A6' : '#4A3A28');
}

/** Applies the persisted theme. Call once before mounting. */
export function installTheme(): void {
  writeVariables(currentTheme());
}

interface ViewTransitionDocument {
  startViewTransition?: (update: () => void) => unknown;
}

/** Switches theme with one window-wide crossfade (instant when reduced motion is on). */
export function setTheme(id: ThemeId): void {
  const next = validTheme(id);
  if (next === currentTheme()) return;
  const apply = () => {
    writeVariables(next);
    setCurrentTheme(next);
    writePersisted('theme', next);
  };
  const transitions = document as unknown as ViewTransitionDocument;
  if (prefersReducedMotion() || typeof transitions.startViewTransition !== 'function') {
    apply();
    return;
  }
  transitions.startViewTransition(apply);
}
