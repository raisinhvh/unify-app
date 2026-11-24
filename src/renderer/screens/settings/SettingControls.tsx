/**
 * One flat settings row (Figma 25 rows): label and description on the left, the control on the right, a
 * hairline underneath. The control follows the row's kind (catalog.ts): toggle, select or a number stepper.
 *
 * <SettingRows rows={…} /> wraps each row in <Collapse>, so a row under a toggle that turns off folds away
 * and everything below slides up: turning a feature off never leaves a gap. Rows with children read as folders
 * and their children as files, hung off ├ / └ elbows like a `tree` listing (same family as the Chats tree).
 */
import { createMemo, For, type JSX } from 'solid-js';
import { Icon, IconButton, Select, Toggle } from '../../components';
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
  if (props.row.kind === 'custom') {
    return props.row.control?.();
  }
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

/** Where a row sits in the tree drawn by <SettingRows>, recomputed as rows show and hide. */
export interface RowPlace {
  /** Levels under parents that are in this list (0 = top level). */
  depth: number;
  /** Has child rows in this list (drawn as a folder). */
  folder: boolean;
  /** A child is showing below, so a line drops from the folder glyph. */
  open: boolean;
  /** No later visible sibling: the elbow is └ and the line stops here. */
  last: boolean;
  /** One entry per ancestor level between the top and this row's elbow: whether that line runs past this row. */
  guides: boolean[];
  /** The next visible row hangs in the same group, so the hairline under this row is left out. */
  joined: boolean;
}

const loosePlace: Omit<RowPlace, 'depth'> = { folder: false, open: false, last: true, guides: [], joined: false };

/**
 * Whether a row shows: its own `shown`, then its parent in this list (a toggle parent must be on, any parent must
 * show), else the catalog's toggles above it. Lets custom rows (Agents screen) hang under each other.
 */
function visibleIn(row: SettingRow, byKey: Map<string, SettingRow>): boolean {
  if (row.shown && !row.shown()) return false;
  const parent = row.parent ? byKey.get(row.parent) : undefined;
  if (!parent) return rowVisible(row);
  if (parent.kind === 'toggle' && !parent.read()) return false;
  return visibleIn(parent, byKey);
}

/** Folder, last-child and guide-line flags for every visible row; hidden rows never count. */
function placeRows(rows: SettingRow[]): Map<string, RowPlace> {
  const byKey = new Map(rows.map(row => [row.key, row]));
  // Only parents inside this list draw lines (a lone child row elsewhere stays flat).
  const parentOf = (row: SettingRow) => (row.parent && byKey.has(row.parent) ? row.parent : undefined);
  const visible = rows.filter(row => visibleIn(row, byKey));
  const lastByKey = new Map(
    visible.map((row, index) => [row.key, !visible.slice(index + 1).some(other => parentOf(other) === parentOf(row))]),
  );
  const places = new Map<string, RowPlace>();
  visible.forEach((row, index) => {
    const ancestors: SettingRow[] = [];
    for (let key = parentOf(row); key; key = parentOf(byKey.get(key)!)) ancestors.unshift(byKey.get(key)!);
    const next = visible[index + 1];
    places.set(row.key, {
      depth: ancestors.length,
      // A child that can never show (a model without efforts) doesn't make its parent a folder.
      folder: rows.some(other => parentOf(other) === row.key && (other.shown?.() ?? true)),
      open: visible.some(other => parentOf(other) === row.key),
      last: lastByKey.get(row.key) ?? true,
      // Ancestor at depth i owns the line in column i - 1; the root (depth 0) owns none.
      guides: ancestors.slice(1).map(ancestor => !(lastByKey.get(ancestor.key) ?? true)),
      joined: !!next && !!parentOf(next),
    });
  });
  return places;
}

export function SettingRowView(props: { row: SettingRow; showSection?: string; place?: RowPlace }): JSX.Element {
  const place = (): RowPlace => props.place ?? { ...loosePlace, depth: rowDepth(props.row) };
  const depth = () => place().depth;
  // A row with sub-settings carries a folder glyph; the sub-settings themselves hang off the tree lines bare.
  const glyph = () => (place().folder ? 'folder' : undefined);
  // A click anywhere on a toggle row flips it (the switch is a small target).
  const onRowClick = (event: MouseEvent) => {
    if (props.row.kind !== 'toggle') return;
    if ((event.target as Element).closest('button, a, input')) return;
    props.row.write(!props.row.read());
  };
  return (
    <div
      class="setting-row"
      classList={{
        child: depth() > 0,
        folder: place().folder,
        open: place().open,
        'last-child': place().last,
        joined: place().joined,
        clickable: props.row.kind === 'toggle',
      }}
      style={{ '--depth': depth() }}
      data-key={props.row.key}
      onClick={onRowClick}
    >
      <For each={place().guides}>
        {(continues, level) =>
          continues && <span class="setting-row-guide" aria-hidden="true" style={{ '--level': level() }} />
        }
      </For>
      {depth() > 0 && <span class="setting-row-elbow" aria-hidden="true" />}
      {glyph() && (
        <span class="setting-row-leading setting-row-glyph">
          <Icon name={glyph()!} class="tree-folder-icon" />
        </span>
      )}
      <div class="setting-row-text">
        <div class="setting-row-label">
          {props.row.labelFor ? <label for={props.row.labelFor}>{props.row.label}</label> : props.row.label}
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
  // A row folding away keeps its last place, so its lines don't jump while it slides up.
  const places = createMemo<Map<string, RowPlace>>(previous => {
    const next = placeRows(props.rows);
    for (const [key, place] of previous) if (!next.has(key)) next.set(key, place);
    return next;
  }, new Map());
  const byKey = createMemo(() => new Map(props.rows.map(row => [row.key, row])));
  return (
    <div class="setting-rows">
      <For each={props.rows}>
        {row => (
          <Collapse open={visibleIn(row, byKey())}>
            <SettingRowView row={row} showSection={props.sectionLabel?.(row)} place={places().get(row.key)} />
          </Collapse>
        )}
      </For>
    </div>
  );
}
