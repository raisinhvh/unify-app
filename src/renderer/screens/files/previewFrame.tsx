/**
 * DEV ONLY. A stand-in app frame for the Files and Knowledge previews (preview.html in each folder):
 * rail | side panel slot | content card, with the theme, tooltips and the (mock) store connected.
 *
 *   mountPreview(root, { panel: () => <FilesPanel />, content: () => <FilesEditor />, composite: () => <FilesScreen /> })
 *
 * `?theme=<id>` switches the theme (persisted, like picking it in Settings).
 * `?composite=1` renders `composite` inside a `.content-screen` card, the way the Shell draws screens today.
 */
import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { TooltipHost } from '../../components';
import { railRoutes } from '../../router';
import { NavRail } from '../../shell/NavRail';
import { connectStore } from '../../store';
import { installTheme, setTheme, type ThemeId } from '../../theme';
import '../../shell/shell.css';
import './preview.css';

export interface PreviewScreens {
  route: string;
  panel: () => JSX.Element;
  content: () => JSX.Element;
  composite: () => JSX.Element;
}

export function mountPreview(root: HTMLElement, screens: PreviewScreens): void {
  installTheme();
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme');
  if (theme) setTheme(theme as ThemeId);
  const composite = params.has('composite');
  render(
    () => (
      <>
        <div class="preview-frame">
          <NavRail
            items={railRoutes.map(info => ({ ...info, visible: () => true }))}
            active={screens.route}
            onSelect={() => undefined}
            onSettings={() => undefined}
            showMeter
          />
          {composite ? (
            <main class="preview-content">
              <section class="content-screen preview-composite">{screens.composite()}</section>
            </main>
          ) : (
            <>
              <div class="side-panel-slot preview-slot">{screens.panel()}</div>
              <main class="preview-content">
                <section class="preview-card">{screens.content()}</section>
              </main>
            </>
          )}
        </div>
        <TooltipHost />
      </>
    ),
    root,
  );
  connectStore();
}
