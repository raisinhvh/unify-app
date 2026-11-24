/**
 * Monaco setup for the Files screen. Imported lazily (FilesEditor does `await import('./monaco')`), so the
 * editor and its languages only load when the Files screen opens.
 *
 *   workers   Vite `?worker` imports; no Vite plugin and no CDN, so they pass the app's CSP ('self').
 *   theme     'unify' is built from the live CSS variables, so it matches all 7 themes. It is re-defined
 *             whenever the app theme changes (theme/currentTheme).
 *   font      the code font (JetBrains Mono, var(--font-mono)) at 12/18 like the Figma editor.
 */
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { FONT_FAMILY_CODE } from '../../theme/fonts';
import { currentTheme, lightThemes } from '../../theme';

export type Monaco = typeof monaco;

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// A file opened on its own has no project around it: keep syntax errors, drop "cannot find module" noise.
const quietDiagnostics = { noSemanticValidation: true, noSyntaxValidation: false, noSuggestionDiagnostics: true };
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(quietDiagnostics);
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(quietDiagnostics);

/** Monaco needs a literal family, so this resolves var(--font-mono) at mount time. */
export function editorFont() {
  return {
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || FONT_FAMILY_CODE,
    fontSize: 12,
    lineHeight: 18,
    fontLigatures: true,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Theme from CSS variables

/** Any CSS colour the theme writes (#rgb, #rrggbb, #rrggbbaa, rgb(), rgba()) as #rrggbb[aa] for Monaco. */
function toHex(value: string, alpha = 1): string {
  const text = value.trim();
  let red = 0;
  let green = 0;
  let blue = 0;
  let opacity = 1;
  if (text.startsWith('#')) {
    let hex = text.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map(digit => digit + digit).join('');
    red = parseInt(hex.slice(0, 2), 16);
    green = parseInt(hex.slice(2, 4), 16);
    blue = parseInt(hex.slice(4, 6), 16);
    if (hex.length === 8) opacity = parseInt(hex.slice(6, 8), 16) / 255;
  } else {
    const parts = text.replace(/rgba?\(|\)/g, '').split(/[\s,/]+/).filter(Boolean).map(Number);
    [red, green, blue] = parts;
    if (parts.length > 3) opacity = parts[3];
  }
  const channel = (number: number) => Math.round(Math.max(0, Math.min(255, number))).toString(16).padStart(2, '0');
  const finalAlpha = opacity * alpha;
  return `#${channel(red)}${channel(green)}${channel(blue)}${finalAlpha < 1 ? channel(finalAlpha * 255) : ''}`;
}

function variable(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || '#000000';
}

function color(name: string, alpha = 1): string {
  return toHex(variable(name), alpha);
}

/** Same colour without '#', for token rules. */
function token(name: string, alpha = 1): string {
  return color(name, alpha).slice(1);
}

export function defineUnifyTheme(): void {
  const light = lightThemes.has(currentTheme());
  const wood = light ? 'wood-dark' : 'wood-light';
  monaco.editor.defineTheme('unify', {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    // Quiet syntax colours: text tones with one wood accent for literals, so code reads like the rest of Unify.
    rules: [
      { token: '', foreground: token('text') },
      { token: 'comment', foreground: token('text3') },
      { token: 'keyword', foreground: token('text2') },
      { token: 'keyword.json', foreground: token('text2') },
      { token: 'string', foreground: token(wood) },
      { token: 'string.key.json', foreground: token('text') },
      { token: 'string.value.json', foreground: token(wood) },
      { token: 'number', foreground: token(wood) },
      { token: 'regexp', foreground: token(wood) },
      { token: 'type', foreground: token('text') },
      { token: 'type.identifier', foreground: token('text') },
      { token: 'identifier', foreground: token('text') },
      { token: 'delimiter', foreground: token('text2') },
      { token: 'operator', foreground: token('text2') },
      { token: 'tag', foreground: token('text2') },
      { token: 'attribute.name', foreground: token('text') },
      { token: 'attribute.value', foreground: token(wood) },
      { token: 'variable', foreground: token('text') },
      { token: 'emphasis', fontStyle: 'italic' },
      { token: 'strong', fontStyle: 'bold' },
    ],
    colors: {
      'editor.background': color('surface'),
      'editor.foreground': color('text'),
      'editorGutter.background': color('surface'),
      'editorLineNumber.foreground': color('text3'),
      'editorLineNumber.activeForeground': color('text2'),
      'editorCursor.foreground': color('text'),
      'editor.lineHighlightBackground': color('hover', 0.45),
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': color('accent', light ? 0.16 : 0.2),
      'editor.inactiveSelectionBackground': color('accent', 0.1),
      'editor.selectionHighlightBackground': color('accent', 0.08),
      'editor.wordHighlightBackground': color('accent', 0.08),
      'editor.findMatchBackground': color('warn', 0.35),
      'editor.findMatchHighlightBackground': color('warn', 0.18),
      'editorIndentGuide.background1': color('border'),
      'editorIndentGuide.activeBackground1': color('text3'),
      'editorWhitespace.foreground': color('border'),
      'editorBracketMatch.background': color('hover'),
      'editorBracketMatch.border': color('text3'),
      'editorWidget.background': color('raised'),
      'editorWidget.foreground': color('text'),
      'editorWidget.border': color('border'),
      'editorSuggestWidget.background': color('raised'),
      'editorSuggestWidget.border': color('border'),
      'editorSuggestWidget.selectedBackground': color('hover'),
      'editorHoverWidget.background': color('raised'),
      'editorHoverWidget.border': color('border'),
      'input.background': color('bg'),
      'input.border': color('border'),
      'input.foreground': color('text'),
      'focusBorder': '#00000000',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': color('text3', 0.25),
      'scrollbarSlider.hoverBackground': color('text3', 0.4),
      'scrollbarSlider.activeBackground': color('text3', 0.55),
      'minimap.background': color('surface'),
      'minimapSlider.background': color('text3', 0.15),
      'minimapSlider.hoverBackground': color('text3', 0.25),
      'editorOverviewRuler.border': '#00000000',
      'editorGutter.addedBackground': color('add'),
      'editorGutter.deletedBackground': color('del'),
      'editorGutter.modifiedBackground': color('warn'),
      // Review diffs (FilesEditor's DiffCode): the same add/del tints as the agent-changed lines.
      'diffEditor.insertedLineBackground': color('add-tint'),
      'diffEditor.removedLineBackground': color('del-tint'),
      'diffEditor.insertedTextBackground': color('add', 0.22),
      'diffEditor.removedTextBackground': color('del', 0.22),
      'diffEditorGutter.insertedLineBackground': color('add-tint'),
      'diffEditorGutter.removedLineBackground': color('del-tint'),
      'diffEditor.border': color('border'),
      'diffEditor.diagonalFill': color('border', 0.6),
      'editorError.foreground': color('del'),
      'editorWarning.foreground': color('warn'),
      'menu.background': color('raised'),
      'menu.foreground': color('text'),
      'menu.selectionBackground': color('hover'),
      'menu.border': color('border'),
    },
  });
  monaco.editor.setTheme('unify');
}

let fontsMeasured = false;

/** Call once per editor mount: defines the theme and remeasures once the code font has loaded. */
export function prepareMonaco(): Monaco {
  defineUnifyTheme();
  if (!fontsMeasured) {
    fontsMeasured = true;
    void document.fonts.load(`12px ${FONT_FAMILY_CODE}`).then(() => monaco.editor.remeasureFonts());
  }
  return monaco;
}

export { monaco };
