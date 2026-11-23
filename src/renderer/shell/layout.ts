/**
 * Pane layout model for the chat area: a preset (Single, Columns, Rows, Three, Grid) plus one chat per cell and
 * two split ratios. Persisted per window under the `layout` key (persist.ts).
 *
 *   cellRects(preset, splits)    fractional rectangles for each cell
 *   openChat / closeChat / focusPane / dropChat / setSplit    the only ways to change the layout
 *   setPoppedOutChats            chats shown in their own windows (bridge onPopoutsChanged); never opened as panes
 *
 * Presets grow and shrink with the number of chats: closing a pane in Grid falls back to Three, then Columns,
 * then Single. Nothing open means no panes: Home shows through.
 */
import { createRoot, createSignal } from 'solid-js';
import { bridge } from '../bridge';
import { readPersisted, writePersisted } from '../persist';

export type PresetId = 'single' | 'columns' | 'rows' | 'three' | 'grid';

export interface Splits {
  /** Left column share, 0..1. */
  x: number;
  /** Top row share, 0..1 (Three: of the right column). */
  y: number;
}

export interface LayoutState {
  preset: PresetId;
  /** One chat id per cell; null is an empty cell waiting for a chat. */
  cells: (string | null)[];
  splits: Splits;
  /** Index of the cell new chats open into. */
  focused: number;
}

export interface FractionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const presetOrder: PresetId[] = ['single', 'columns', 'rows', 'three', 'grid'];

export const presetNames: Record<PresetId, string> = {
  single: 'Single',
  columns: 'Columns',
  rows: 'Rows',
  three: 'Three',
  grid: 'Grid',
};

export const presetCellCount: Record<PresetId, number> = {
  single: 1,
  columns: 2,
  rows: 2,
  three: 3,
  grid: 4,
};

/** Smallest preset that holds `count` chats, preferring the current family (rows stay rows). */
function presetFor(count: number, current: PresetId): PresetId {
  if (count <= 1) return 'single';
  if (count === 2) return current === 'rows' ? 'rows' : 'columns';
  if (count === 3) return 'three';
  return 'grid';
}

export function cellRects(preset: PresetId, splits: Splits): FractionRect[] {
  const { x, y } = splits;
  switch (preset) {
    case 'single':
      return [{ left: 0, top: 0, width: 1, height: 1 }];
    case 'columns':
      return [
        { left: 0, top: 0, width: x, height: 1 },
        { left: x, top: 0, width: 1 - x, height: 1 },
      ];
    case 'rows':
      return [
        { left: 0, top: 0, width: 1, height: y },
        { left: 0, top: y, width: 1, height: 1 - y },
      ];
    case 'three':
      return [
        { left: 0, top: 0, width: x, height: 1 },
        { left: x, top: 0, width: 1 - x, height: y },
        { left: x, top: y, width: 1 - x, height: 1 - y },
      ];
    case 'grid':
      return [
        { left: 0, top: 0, width: x, height: y },
        { left: x, top: 0, width: 1 - x, height: y },
        { left: 0, top: y, width: x, height: 1 - y },
        { left: x, top: y, width: 1 - x, height: 1 - y },
      ];
  }
}

/** Which split gutters a preset has: the vertical one at x and/or the horizontal one at y (with its extent). */
export function presetGutters(preset: PresetId): { vertical: boolean; horizontal: false | { from: 'all' | 'right' } } {
  switch (preset) {
    case 'single':
      return { vertical: false, horizontal: false };
    case 'columns':
      return { vertical: true, horizontal: false };
    case 'rows':
      return { vertical: false, horizontal: { from: 'all' } };
    case 'three':
      return { vertical: true, horizontal: { from: 'right' } };
    case 'grid':
      return { vertical: true, horizontal: { from: 'all' } };
  }
}

const defaultLayout: LayoutState = { preset: 'single', cells: [], splits: { x: 0.5, y: 0.5 }, focused: 0 };

function validLayout(value: unknown): LayoutState {
  if (!value || typeof value !== 'object') return defaultLayout;
  const candidate = value as Partial<LayoutState>;
  const preset = presetOrder.includes(candidate.preset as PresetId) ? (candidate.preset as PresetId) : 'single';
  const cells = Array.isArray(candidate.cells) ? candidate.cells.filter(cell => cell === null || typeof cell === 'string') : [];
  const splits = candidate.splits && typeof candidate.splits.x === 'number' && typeof candidate.splits.y === 'number'
    ? { x: clampSplit(candidate.splits.x), y: clampSplit(candidate.splits.y) }
    : defaultLayout.splits;
  return normalize({ preset, cells, splits, focused: typeof candidate.focused === 'number' ? candidate.focused : 0 });
}

export const clampSplit = (value: number): number => Math.max(0.2, Math.min(0.8, value));

/** Keeps cells and preset consistent: drops empty cells beyond need, fits the preset to the chat count. */
function normalize(state: LayoutState): LayoutState {
  const chats = state.cells.filter((cell): cell is string => !!cell);
  const unique = [...new Set(chats)];
  if (!unique.length && !state.cells.some(cell => cell === null)) {
    return { ...state, preset: 'single', cells: [], focused: 0 };
  }
  const wanted = presetCellCount[state.preset];
  let cells = state.cells.filter((cell, index, list) => cell === null || list.indexOf(cell) === index);
  let preset = state.preset;
  if (cells.length !== wanted) {
    // Too many cells: drop empties first, then refit. Too few: shrink the preset.
    if (cells.length > wanted) cells = [...cells.filter(cell => cell !== null), ...cells.filter(cell => cell === null)].slice(0, wanted);
    if (cells.length < wanted) preset = presetFor(cells.length, state.preset);
  }
  const focused = Math.max(0, Math.min(cells.length - 1, state.focused));
  return { ...state, preset, cells, focused };
}

export const layoutStore = createRoot(() => {
  const [layout, setLayoutSignal] = createSignal<LayoutState>(validLayout(readPersisted('layout', defaultLayout)));

  const setLayout = (next: LayoutState) => {
    const normalized = normalize(next);
    setLayoutSignal(normalized);
    writePersisted('layout', normalized);
  };

  return { layout, setLayout };
});

export const layout = layoutStore.layout;

export const openChats = (): string[] => layout().cells.filter((cell): cell is string => !!cell);

export const isChatOnScreen = (chatId: string): boolean => openChats().includes(chatId);

/** Chats currently shown in pop-out windows (main window only). */
const [poppedOutChats, setPoppedOutSignal] = createSignal<string[]>([]);
export { poppedOutChats };

/** Records which chats are popped out and closes any pane still showing one of them. */
export function setPoppedOutChats(chatIds: string[]): void {
  setPoppedOutSignal(chatIds);
  const popped = new Set(chatIds);
  for (const chatId of openChats()) {
    if (popped.has(chatId)) closeChat(chatId);
  }
}

/** True when the chat lives in a pop-out window: focus that window instead of opening a pane. */
function focusPoppedOut(chatId: string): boolean {
  if (!poppedOutChats().includes(chatId)) return false;
  const popOut = bridge().popOut;
  if (popOut) popOut(chatId);
  return true;
}

/**
 * Shows a chat. Popped out: focus its window instead. Already on screen: focus it. `beside` adds a pane (growing the preset); otherwise it replaces
 * the focused pane, or fills the first pane when none is open.
 */
export function openChat(chatId: string, options: { beside?: boolean } = {}): void {
  if (focusPoppedOut(chatId)) return;
  const state = layout();
  const existing = state.cells.indexOf(chatId);
  if (existing >= 0) {
    focusPane(existing);
    return;
  }
  const emptyCell = state.cells.indexOf(null);
  if (emptyCell >= 0) {
    const cells = [...state.cells];
    cells[emptyCell] = chatId;
    layoutStore.setLayout({ ...state, cells, focused: emptyCell });
    return;
  }
  if (!state.cells.length) {
    layoutStore.setLayout({ ...state, preset: 'single', cells: [chatId], focused: 0 });
    return;
  }
  if (options.beside && state.cells.length < 4) {
    const cells = [...state.cells, chatId];
    layoutStore.setLayout({ ...state, preset: presetFor(cells.length, state.preset), cells, focused: cells.length - 1 });
    return;
  }
  const cells = [...state.cells];
  cells[state.focused] = chatId;
  layoutStore.setLayout({ ...state, cells });
}

export function closeChat(chatId: string): void {
  const state = layout();
  const index = state.cells.indexOf(chatId);
  if (index < 0) return;
  const cells = state.cells.filter((_, cellIndex) => cellIndex !== index);
  const preset = presetFor(cells.length, state.preset);
  layoutStore.setLayout({ ...state, preset, cells, focused: Math.min(state.focused, Math.max(0, cells.length - 1)) });
}

/** Removes chats that no longer exist (deleted sessions). */
export function pruneChats(exists: (chatId: string) => boolean): void {
  const state = layout();
  const cells = state.cells.filter(cell => cell === null || exists(cell));
  if (cells.length === state.cells.length) return;
  layoutStore.setLayout({ ...state, preset: presetFor(cells.length, state.preset), cells });
}

export function focusPane(index: number): void {
  const state = layout();
  if (state.focused === index) return;
  layoutStore.setLayout({ ...state, focused: index });
}

export function setSplit(axis: 'x' | 'y', value: number): void {
  const state = layout();
  layoutStore.setLayout({ ...state, splits: { ...state.splits, [axis]: clampSplit(value) } });
}

/**
 * Drop of a dragged pane onto cell `cellIndex` of `preset` (the layout picker). The dragged chat takes that
 * cell; the other open chats fill the remaining cells in their current order; chats that don't fit close;
 * cells left over stay empty and wait for a chat.
 */
export function dropChat(chatId: string, preset: PresetId, cellIndex: number): void {
  if (focusPoppedOut(chatId)) return;
  const state = layout();
  const others = openChats().filter(id => id !== chatId);
  const count = presetCellCount[preset];
  const cells: (string | null)[] = new Array(count).fill(null);
  cells[cellIndex] = chatId;
  let next = 0;
  for (let index = 0; index < count; index += 1) {
    if (index === cellIndex) continue;
    cells[index] = others[next] ?? null;
    next += 1;
  }
  layoutStore.setLayout({ ...state, preset, cells, focused: cellIndex });
}

/** Drop of a dragged pane onto another pane in the current layout: the two swap places. */
export function swapChats(chatId: string, cellIndex: number): void {
  const state = layout();
  const from = state.cells.indexOf(chatId);
  if (from < 0 || from === cellIndex) return;
  const cells = [...state.cells];
  [cells[from], cells[cellIndex]] = [cells[cellIndex], cells[from]];
  layoutStore.setLayout({ ...state, cells, focused: cellIndex });
}
