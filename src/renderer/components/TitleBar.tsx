/**
 * Frameless window chrome: a drag strip along the top of the window with minimize / maximize / close at the
 * right (window.unify.window). On macOS the system traffic lights are used, so only the drag strip renders.
 * Anything interactive placed inside the strip must set `-webkit-app-region: no-drag` (class `no-drag`).
 */
import { createSignal, onMount, Show, type JSX } from 'solid-js';
import { bridge } from '../bridge';
import { Icon } from './Icon';
import './titlebar.css';

export function TitleBar(): JSX.Element {
  const controls = () => bridge().window;
  const [maximized, setMaximized] = createSignal(false);
  const refresh = () => {
    void controls().isMaximized().then(setMaximized);
  };
  onMount(() => {
    refresh();
    window.addEventListener('resize', refresh);
  });
  const isMac = () => bridge().platform === 'darwin';

  return (
    <div class="titlebar" classList={{ mac: isMac() }}>
      <Show when={!isMac()}>
        <div class="titlebar-controls no-drag">
          <button type="button" class="titlebar-button" aria-label="Minimize" onClick={() => controls().minimize()}>
            <Icon name="minimize" size={14} />
          </button>
          <button
            type="button"
            class="titlebar-button"
            aria-label={maximized() ? 'Restore' : 'Maximize'}
            onClick={() => {
              controls().maximize();
              refresh();
            }}
          >
            <Icon name="maximize" size={14} />
          </button>
          <button type="button" class="titlebar-button close" aria-label="Close" onClick={() => controls().close()}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </Show>
    </div>
  );
}
