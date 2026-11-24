/**
 * Applies the Accessibility preferences (Settings → Appearance / Accessibility) to the whole renderer.
 *
 * Mapping mirrors the engine's `accessibilityStyle` (engine/sidebar/view.ts) so the webview and the Unify UI agree.
 *
 * How text size works: `--text-scale` multiplies the font sizes in theme.css (body and the .type-* classes), so text
 * grows across chats and panels while the layout keeps its px geometry. Line heights are unitless ratios times
 * `--line-scale`, so they grow with the text. We do not use `document.documentElement.style.zoom`: zoom scales
 * every px value, including borders, icons and panes, and it breaks hit-testing at non-1 values in some Chromium
 * builds. Screen CSS that hard-codes px font sizes will not follow Text size until it uses calc(… * var(--text-scale)).
 *
 * Density and the other toggles are data attributes on <html>; theme.css turns them into rules.
 */
import { createEffect, createRoot } from 'solid-js';
import { accessibility } from '../screens/settings/catalog';

/** Must match LINE_SCALES / SPACE_SCALES in engine/sidebar/view.ts. */
const LINE_SCALES = { normal: 1, relaxed: 1.2, loose: 1.4 } as const;
const SPACE_SCALES = { compact: 0.75, default: 1, roomy: 1.35 } as const;

/** Sets an attribute to "" when on, and removes it when off, so theme.css can match `[data-x]`. */
function setFlag(root: HTMLElement, name: string, on: boolean): void {
  if (on) root.setAttribute(name, '');
  else root.removeAttribute(name);
}

/** Keeps <html> in step with the accessibility settings. Call once at startup; it lives for the whole app. */
export function applyAccessibility(): void {
  createRoot(() => {
    createEffect(() => {
      const prefs = accessibility();
      const root = document.documentElement;
      const scale = Number.isFinite(prefs.textScale) ? prefs.textScale : 1;
      root.style.setProperty('--text-scale', String(scale));
      root.style.setProperty('--line-scale', String(LINE_SCALES[prefs.lineSpacing] ?? 1));
      root.style.setProperty('--space-scale', String(SPACE_SCALES[prefs.spacing] ?? 1));
      root.dataset.density = prefs.spacing;
      root.dataset.lineSpacing = prefs.lineSpacing;
      root.dataset.letterSpacing = prefs.letterSpacing;
      setFlag(root, 'data-high-contrast', prefs.highContrast === true);
      setFlag(root, 'data-large-targets', prefs.largeTargets === true);
      setFlag(root, 'data-underline-links', prefs.underlineLinks === true);
    });
  });
}
