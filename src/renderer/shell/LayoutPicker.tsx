/**
 * The layout picker that drops down at the top centre while a pane is dragged (Figma 11b, 306:7616).
 * Five tiles (Single, Columns, Rows, Three, Grid); each cell of a tile is a drop target. PaneGrid hit-tests the
 * pointer against `[data-preset][data-cell]` elements, so the picker itself never captures the pointer.
 */
import { For, type JSX } from 'solid-js';
import { Presence } from '../motion';
import { cellRects, presetNames, presetOrder, type PresetId } from './layout';

export interface PickerTarget {
  preset: PresetId;
  cell: number;
}

const tileWidth = 56;
const tileHeight = 36;
const cellGap = 2;

export function LayoutPicker(props: { open: boolean; hovered: PickerTarget | undefined }): JSX.Element {
  return (
    <Presence when={props.open} origin="top center" offsetY={-12} from={0.9}>
      <div class="layout-picker" aria-label="Drop to arrange panes">
        <For each={presetOrder}>
          {preset => (
            <div class="layout-tile" classList={{ hovered: props.hovered?.preset === preset }}>
              <div class="layout-tile-cells" style={{ width: `${tileWidth}px`, height: `${tileHeight}px` }}>
                <For each={cellRects(preset, { x: 0.5, y: 0.5 })}>
                  {(rect, index) => (
                    <div
                      class="layout-tile-cell"
                      classList={{ hovered: props.hovered?.preset === preset && props.hovered.cell === index() }}
                      data-preset={preset}
                      data-cell={index()}
                      style={{
                        left: `${rect.left * tileWidth + (rect.left > 0 ? cellGap / 2 : 0)}px`,
                        top: `${rect.top * tileHeight + (rect.top > 0 ? cellGap / 2 : 0)}px`,
                        width: `${rect.width * tileWidth - (rect.left > 0 ? cellGap / 2 : 0) - (rect.left + rect.width < 1 ? cellGap / 2 : 0)}px`,
                        height: `${rect.height * tileHeight - (rect.top > 0 ? cellGap / 2 : 0) - (rect.top + rect.height < 1 ? cellGap / 2 : 0)}px`,
                      }}
                    />
                  )}
                </For>
              </div>
              <span class="layout-tile-name type-caption">{presetNames[preset]}</span>
            </div>
          )}
        </For>
      </div>
    </Presence>
  );
}
