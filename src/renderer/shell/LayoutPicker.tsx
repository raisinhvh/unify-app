/**
 * The layout picker that drops down at the top centre while a pane is dragged (Figma 11b, 306:7616).
 * One tile per preset (presetOrder, wrapping into two rows); each cell of a tile is a drop target. PaneGrid
 * hit-tests the pointer against `[data-preset][data-cell]` elements, so the picker itself never captures the pointer.
 *
 * PresetThumb draws a preset's cells at any size; LayoutMenu reuses it.
 */
import { For, type JSX } from 'solid-js';
import { Presence } from '../motion';
import { leafRects, presetNames, presetOrder, presetTree, type FractionRect, type LeafRect, type PresetId } from './layout';

export interface PickerTarget {
  preset: PresetId;
  cell: number;
}

/** Cell rectangles of every preset, built once (presetTree makes fresh keys on every call). */
export const presetCells = {} as Record<PresetId, LeafRect[]>;
for (const preset of presetOrder) presetCells[preset] = leafRects(presetTree(preset));

const tileWidth = 56;
const tileHeight = 36;

/** Left/top/width/height of a cell inside a thumbnail, with the seams between cells kept open. */
function cellStyle(rect: FractionRect, width: number, height: number, seam: number) {
  const left = rect.left > 0 ? seam / 2 : 0;
  const top = rect.top > 0 ? seam / 2 : 0;
  const right = rect.left + rect.width < 1 ? seam / 2 : 0;
  const bottom = rect.top + rect.height < 1 ? seam / 2 : 0;
  return {
    left: `${rect.left * width + left}px`,
    top: `${rect.top * height + top}px`,
    width: `${rect.width * width - left - right}px`,
    height: `${rect.height * height - top - bottom}px`,
  };
}

/** A preset drawn as its cells. `hovered` is the index of the cell to highlight (-1 for none). */
export function PresetThumb(props: { preset: PresetId; width: number; height: number; seam?: number; hovered?: number }): JSX.Element {
  const seam = () => props.seam ?? 2;
  return (
    <div class="layout-thumb" style={{ width: `${props.width}px`, height: `${props.height}px` }}>
      <For each={presetCells[props.preset]}>
        {(leaf, index) => (
          <div
            class="layout-thumb-cell"
            classList={{ hovered: props.hovered === index() }}
            data-preset={props.preset}
            data-cell={index()}
            style={cellStyle(leaf.rect, props.width, props.height, seam())}
          />
        )}
      </For>
    </div>
  );
}

export function LayoutPicker(props: { open: boolean; hovered: PickerTarget | undefined }): JSX.Element {
  return (
    <Presence when={props.open} origin="top center" offsetY={-12} from={0.9}>
      <div class="layout-picker" aria-label="Drop to arrange panes">
        <For each={presetOrder}>
          {preset => (
            <div class="layout-tile" classList={{ hovered: props.hovered?.preset === preset }}>
              <PresetThumb
                preset={preset}
                width={tileWidth}
                height={tileHeight}
                hovered={props.hovered?.preset === preset ? props.hovered.cell : -1}
              />
              <span class="layout-tile-name type-caption">{presetNames[preset]}</span>
            </div>
          )}
        </For>
      </div>
    </Presence>
  );
}
