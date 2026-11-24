/**
 * Title-bar control for the workspace layout: a grid of preset tiles, then equalize, add a files /
 * terminal pane, a source control pane, and close everything. Built on the shared Popover (anchored, closes on outside click / Escape).
 */
import { createSignal, For, type JSX } from 'solid-js';
import { IconButton, Popover } from '../components';
import { applyPreset, equalize, openPane, presetNames, presetOrder, resetLayout } from './layout';
import { PresetThumb } from './LayoutPicker';

export function LayoutMenu(): JSX.Element {
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [open, setOpen] = createSignal(false);
  const close = () => setOpen(false);
  /** Closes the card first so the action's own motion is not competing with it. */
  const run = (action: () => void) => {
    close();
    action();
  };

  return (
    <div class="layout-menu-root">
      <IconButton
        icon="layout"
        label="Layouts"
        active={open()}
        ref={element => setAnchor(element)}
        onClick={() => setOpen(value => !value)}
      />
      <Popover anchor={anchor()} open={open()} onClose={close} placement="bottom-end" class="layout-menu">
        <div class="layout-menu-presets" role="group" aria-label="Layouts">
          <For each={presetOrder}>
            {preset => (
              <button type="button" class="layout-menu-tile" title={presetNames[preset]} onClick={() => run(() => applyPreset(preset))}>
                <PresetThumb preset={preset} width={44} height={28} seam={1.5} />
                <span class="layout-menu-name">{presetNames[preset]}</span>
              </button>
            )}
          </For>
        </div>
        <div class="layout-menu-list">
          <button type="button" class="layout-menu-row" onClick={() => run(() => equalize())}>
            Equalize sizes
          </button>
          <button type="button" class="layout-menu-row" onClick={() => run(() => openPane('files'))}>
            Add Files
          </button>
          <button type="button" class="layout-menu-row" onClick={() => run(() => openPane('terminal'))}>
            Add Terminal
          </button>
          <button type="button" class="layout-menu-row" onClick={() => run(() => openPane('git'))}>
            Add Source Control
          </button>
          <div class="layout-menu-separator" role="separator" />
          <button type="button" class="layout-menu-row" onClick={() => run(() => resetLayout())}>
            Close all panes
          </button>
        </div>
      </Popover>
    </div>
  );
}
