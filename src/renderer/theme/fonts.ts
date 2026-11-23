/**
 * Bundled fonts (no network).
 * UI font: generated in ./ui-font.ts. Change it with  node scripts/set-font.mjs "<Google font family>".
 * Code font: JetBrains Mono, fixed here.
 */
import '@fontsource/jetbrains-mono/400.css';
import { UI_FONT_FAMILY } from './ui-font';

export const FONT_FAMILY_UI = UI_FONT_FAMILY;
export const FONT_FAMILY_CODE = "'JetBrains Mono', ui-monospace, monospace";

document.documentElement.style.setProperty('--font-ui', FONT_FAMILY_UI);
document.documentElement.style.setProperty('--font-code', FONT_FAMILY_CODE);
