/**
 * DEV ONLY contact sheet of the provider glyphs: every glyph at 12, 16 and 24px, one column per theme.
 *
 *   /dev-o6/glyphs.html
 *
 * Each column paints its own theme tokens inline, so all seven themes sit on one sheet.
 */
import { For } from 'solid-js';
import type * as GlyphModule from '../components/ProviderGlyph';
import type * as ThemeModule from '../theme';

// App modules load after the mock bridge (the theme reads persisted state at module scope).
let ProviderGlyph: typeof GlyphModule.ProviderGlyph;
let providerGlyphs: typeof GlyphModule.providerGlyphs;
let themes: typeof ThemeModule.themes;
let themeNames: typeof ThemeModule.themeNames;
let themeOrder: typeof ThemeModule.themeOrder;

const sizes = [12, 16, 24];

function ThemeColumn(props: { theme: ThemeModule.ThemeId }) {
  const glyphNames = Object.keys(providerGlyphs) as GlyphModule.ProviderGlyphName[];
  const tokens = themes[props.theme];
  return (
    <div
      style={{
        background: tokens.bg,
        color: tokens.text,
        padding: '20px 18px',
        display: 'flex',
        'flex-direction': 'column',
        gap: '14px',
      }}
    >
      <div
        style={{
          color: tokens.text2,
          'font-size': '12px',
          'font-weight': '600',
        }}
      >
        {themeNames[props.theme]}
      </div>
      <For each={glyphNames}>
        {name => (
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '14px',
              height: '28px',
            }}
          >
            <For each={sizes}>
              {size => (
                <div
                  style={{
                    width: '28px',
                    display: 'flex',
                    'justify-content': 'center',
                  }}
                >
                  <ProviderGlyph provider={name} size={size} />
                </div>
              )}
            </For>
            <span
              style={{
                color: tokens.text3,
                'font-size': '11px',
              }}
            >
              {name}
            </span>
            <span style={{ color: tokens.text2 }}>
              <ProviderGlyph provider={name} size={16} />
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

function ContactSheet() {
  return (
    <div
      style={{
        display: 'grid',
        'grid-template-columns': `repeat(${themeOrder.length}, 1fr)`,
        'font-family': 'var(--font-sans, system-ui)',
        'min-height': '100vh',
      }}
    >
      <For each={themeOrder}>{theme => <ThemeColumn theme={theme} />}</For>
    </div>
  );
}

async function boot(): Promise<void> {
  const { installMockBridge } = await import('../dev/mockBridge');
  await installMockBridge();
  const [{ render }, theme, components] = await Promise.all([
    import('solid-js/web'),
    import('../theme'),
    import('../components/ProviderGlyph'),
  ]);
  ({ themes, themeNames, themeOrder } = theme);
  ({ ProviderGlyph, providerGlyphs } = components);
  theme.installTheme();
  document.body.style.margin = '0';
  const root = document.getElementById('root');
  if (root) render(() => <ContactSheet />, root);
}

void boot();
