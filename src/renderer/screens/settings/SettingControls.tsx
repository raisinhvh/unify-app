/**
 * One flat settings row (Figma 25 rows): label and description on the left, the control on the right, a
 * hairline underneath. The control follows the row's kind (catalog.ts): toggle, select or a number stepper.
 *
 * <SettingRows rows={…} /> wraps each row in <Collapse>, so a row under a toggle that turns off folds away
 * and everything below slides up: turning a feature off never leaves a gap. Child rows are indented and hang
 * off a guide line, like folders in the Chats tree.
 */
import { For, type JSX } from 'solid-js';
import { IconButton, Select, Toggle } from '../../components';
import { Collapse } from '../../motion';
import { rowDepth, rowVisible, type SettingRow } from './catalog';

function clampToStep(row: SettingRow, value: number): number {
  const step = row.step ?? 1;
  const min = row.min ?? 0;
  const max = row.max ?? 999;
  const stepped = Math.round((value - min) / step) * step + min;
  // Float steps (0.05) drift; keep four decimals.
  return Math.min(max, Math.max(min, Number(stepped.toFixed(4))));
}

export function Stepper(props: { row: SettingRow }): JSX.Element {
  const value = () => Number(props.row.read());
  const shown = () => (props.row.format ? props.row.format(value()) : String(value()));
  const change = (direction: 1 | -1) => props.row.write(clampToStep(props.row, value() + direction * (props.row.step ?? 1)));
  return (
    <div class="stepper" role="group" aria-label={props.row.label}>
      <IconButton
        icon="minimize"
        label={`Less ${props.row.label.toLowerCase()}`}
        size="small"
        disabled={value() <= (props.row.min ?? 0)}
        onClick={() => change(-1)}
      />
      <span class="stepper-value type-mono" aria-live="polite">{shown()}</span>
      <IconButton
        icon="plus"
        label={`More ${props.row.label.toLowerCase()}`}
        size="small"
        disabled={value() >= (props.row.max ?? 999)}
        onClick={() => change(1)}
      />
    </div>
  );
}

function RowControl(props: { row: SettingRow }): JSX.Element {
  if (props.row.kind === 'toggle') {
    return <Toggle checked={!!props.row.read()} onChange={checked => props.row.write(checked)} label={props.row.label} />;
  }
  if (props.row.kind === 'select') {
    return (
      <Select
        value={String(props.row.read())}
        options={props.row.options ?? []}
        onChange={value => props.row.write(value)}
        placement="bottom-end"
        title={props.row.label}
      />
    );
  }
  return <Stepper row={props.row} />;
}

export function SettingRowView(props: { row: SettingRow; showSection?: string }): JSX.Element {
  const depth = rowDepth(props.row);
  // A click anywhere on a toggle row flips it (the switch is a small target).
  const onRowClick = (event: MouseEvent) => {
    if (props.row.kind !== 'toggle') return;
    if ((event.target as Element).closest('button, a, input')) return;
    props.row.write(!props.row.read());
  };
  return (
    <div
      class="setting-row"
      classList={{ child: depth > 0, clickable: props.row.kind === 'toggle' }}
      style={{ '--depth': depth }}
      data-key={props.row.key}
      onClick={onRowClick}
    >
      <div class="setting-row-text">
        <div class="setting-row-label">
          {props.row.label}
          {props.showSection && <span class="setting-row-section type-caption">{props.showSection}</span>}
        </div>
        <div class="setting-row-description type-caption">{props.row.description}</div>
      </div>
      <div class="setting-row-control">
        <RowControl row={props.row} />
      </div>
    </div>
  );
}

export function SettingRows(props: { rows: SettingRow[]; sectionLabel?: (row: SettingRow) => string | undefined }): JSX.Element {
  return (
    <div class="setting-rows">
      <For each={props.rows}>
        {row => (
          <Collapse open={rowVisible(row)}>
            <SettingRowView row={row} showSection={props.sectionLabel?.(row)} />
          </Collapse>
        )}
      </For>
    </div>
  );
}
