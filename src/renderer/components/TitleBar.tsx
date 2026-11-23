/**
 * Frameless window chrome: a drag strip along the top of the window with minimize / maximize / close at the
 * right (window.unify.window). On macOS the system traffic lights are used, so only the drag strip renders.
 * Anything interactive placed inside the strip must set `-webkit-app-region: no-drag` (class `no-drag`).
 *
 * While "shut down when done" is armed (viewState.shutdown.armed, feature power.shutdownWhenIdle), a small power
 * glyph sits left of the window controls; clicking it disarms (cancelShutdown). It pops in and out.
 */
import { createSignal, onMount, Show, type JSX } from 'solid-js';
import { bridge, post } from '../bridge';
import { Presence, pressable } from '../motion';
import { viewState } from '../store';
import { Icon } from './Icon';
import { tooltip } from './Tooltip';
import './titlebar.css';

/** Power glyph in the Figma icon style (16×16, stroke 1.333, currentColor). Not in icons.ts yet. */
export function PowerGlyph(props: { size?: number }): JSX.Element {
  return (
    <svg
      class="icon"
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M8 1.83V7.5" stroke-width="1.33333" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor" />
      <path
        d="M11.77 4.23C12.52 4.98 13.02 5.93 13.23 6.96C13.43 7.99 13.33 9.06 12.92 10.04C12.52 11.01 11.84 11.84 10.96 12.43C10.08 13.01 9.05 13.33 8 13.33C6.95 13.33 5.92 13.01 5.04 12.43C4.16 11.84 3.48 11.01 3.08 10.04C2.67 9.06 2.57 7.99 2.77 6.96C2.98 5.93 3.48 4.98 4.23 4.23"
        stroke-width="1.33333"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke="currentColor"
      />
    </svg>
  );
}

function ShutdownArmedIndicator(): JSX.Element {
  const countingDown = () => viewState.shutdown?.phase === 'countdown';
  return (
    <button
      type="button"
      class="titlebar-armed no-drag"
      classList={{ counting: countingDown() }}
      aria-label="Shut down when done is on. Click to cancel"
      data-shutdown-armed
      ref={element => {
        pressable(element);
        tooltip(element, 'Shut down when done', { placement: 'bottom-end' });
      }}
      onClick={() => post({ type: 'cancelShutdown' })}
    >
      <PowerGlyph size={14} />
    </button>
  );
}

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
  const armed = () => viewState.shutdown?.armed === true;

  return (
    <div class="titlebar" classList={{ mac: isMac() }}>
      <div class="titlebar-trailing">
        <Presence when={armed()} from={0.6} origin="center">
          <div class="titlebar-armed-slot">
            <ShutdownArmedIndicator />
          </div>
        </Presence>
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
    </div>
  );
}
