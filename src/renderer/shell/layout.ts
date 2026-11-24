/**
 * Pane layout model for the workspace: a split tree whose leaves hold pane instances (chat, files, knowledge,
 * terminal). Rows and columns split the space; sizes are fractions of the split's extent. Persisted per window
 * under the `layout` key (persist.ts). Older chat-grid layouts (preset + cells + splits) migrate on load.
 *
 *   leafRects / gutters          geometry for the UI (fractions of the workspace)
 *   openChat / openPane / fillSlot / closePane / closeChat / closeSlot    placement
 *   movePane / movePaneToEdge / splitLeaf / resizeSplit / equalize / applyPreset / resetLayout    arrangement
 *   setPoppedOutChats            chats shown in their own windows (bridge onPopoutsChanged); never placed in leaves
 *
 * Tree invariants are enforced by `normalize` on every change: no split with fewer than two children, no nested
 * split of the same direction, sizes sum to 1 and each is at least `minPaneFraction`, a chat sits in one leaf only.
 * Keys of surviving nodes are never regenerated, so the UI can key its DOM by leaf key and pane id.
 */
import { createRoot, createSignal } from 'solid-js';
import { bridge } from '../bridge';
import { readPersisted, writePersisted } from '../persist';

export type PaneKind = 'chat' | 'files' | 'knowledge' | 'terminal' | 'image' | 'git';

export interface PaneInstance {
  id: string;
  kind: PaneKind;
  /** Only for kind 'chat'. */
  chatId?: string;
  /** Only for kind 'image': the image URL (data:, https:, or the app's media protocol). */
  src?: string;
  /** Only for kind 'terminal': the folder its shell starts in (unset = the project folder). */
  cwd?: string;
  title?: string;
}

/** 'row' = children side by side left→right; 'col' = stacked top→bottom. sizes are fractions summing to 1. */
export type LayoutNode =
  | { type: 'leaf'; key: string; paneId: string | null }
  | { type: 'split'; key: string; dir: 'row' | 'col'; children: LayoutNode[]; sizes: number[] };

type LeafNode = Extract<LayoutNode, { type: 'leaf' }>;
type SplitNode = Extract<LayoutNode, { type: 'split' }>;

export interface LayoutState {
  root: LayoutNode | null;
  panes: Record<string, PaneInstance>;
  /** Leaf key of the focused leaf. */
  focused: string | null;
}

export interface FractionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LeafRect {
  key: string;
  paneId: string | null;
  rect: FractionRect;
}

/** Boundary between children[index] and children[index+1] of split `splitKey`. For dir 'row' it is a vertical line at x=rect.left spanning rect.top..+height (rect.width 0); for 'col' a horizontal line (rect.height 0). `extent` = the split's own FractionRect. */
export interface GutterInfo {
  splitKey: string;
  index: number;
  dir: 'row' | 'col';
  rect: FractionRect;
  extent: FractionRect;
}

export type DropEdge = 'left' | 'right' | 'top' | 'bottom' | 'center';
type SideEdge = Exclude<DropEdge, 'center'>;

export type PresetId =
  | 'single'
  | 'columns'
  | 'rows'
  | 'three'
  | 'threeLeft'
  | 'grid'
  | 'cols3'
  | 'rows3'
  | 'grid3x2'
  | 'grid2x3'
  | 'mainBottom'
  | 'cols3Stack';

/** Smallest share a pane can take of its split's extent. */
export const minPaneFraction = 0.08;

export const presetOrder: PresetId[] = [
  'single',
  'columns',
  'rows',
  'three',
  'threeLeft',
  'grid',
  'cols3',
  'rows3',
  'grid3x2',
  'grid2x3',
  'mainBottom',
  'cols3Stack',
];

export const presetNames: Record<PresetId, string> = {
  single: 'Single',
  columns: 'Columns',
  rows: 'Rows',
  three: 'Three',
  threeLeft: 'Three (left)',
  grid: 'Grid',
  cols3: 'Columns ×3',
  rows3: 'Rows ×3',
  grid3x2: 'Grid 3×2',
  grid2x3: 'Grid 2×3',
  mainBottom: 'Main + bottom',
  cols3Stack: 'Columns + stack',
};

const paneKinds: PaneKind[] = ['chat', 'files', 'knowledge', 'terminal', 'image', 'git'];
const singletonKinds: PaneKind[] = ['files', 'knowledge'];

// ---------------------------------------------------------------------------------------------
// Keys and builders
// ---------------------------------------------------------------------------------------------

let keySequence = 0;

function newKey(): string {
  keySequence += 1;
  return `k${keySequence.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function newPaneId(existing: Record<string, unknown>): string {
  let id = '';
  do {
    id = `p_${Math.random().toString(36).slice(2, 10)}`;
  } while (id in existing);
  return id;
}

function equalSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

function leafNode(paneId: string | null): LayoutNode {
  return { type: 'leaf', key: newKey(), paneId };
}

function splitNode(dir: 'row' | 'col', children: LayoutNode[], sizes?: number[]): LayoutNode {
  return { type: 'split', key: newKey(), dir, children, sizes: sizes ?? equalSizes(children.length) };
}

// ---------------------------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------------------------

/** Fresh tree for a preset with every leaf empty. */
export function presetTree(preset: PresetId): LayoutNode {
  const empty = () => leafNode(null);
  const row = (children: LayoutNode[], sizes?: number[]) => splitNode('row', children, sizes);
  const col = (children: LayoutNode[], sizes?: number[]) => splitNode('col', children, sizes);
  const many = (count: number) => Array.from({ length: count }, empty);
  switch (preset) {
    case 'single':
      return empty();
    case 'columns':
      return row([empty(), empty()], [0.5, 0.5]);
    case 'rows':
      return col([empty(), empty()], [0.5, 0.5]);
    case 'three':
      return row([empty(), col([empty(), empty()], [0.5, 0.5])], [0.6, 0.4]);
    case 'threeLeft':
      return row([col([empty(), empty()], [0.5, 0.5]), empty()], [0.4, 0.6]);
    case 'grid':
      return col([row([empty(), empty()]), row([empty(), empty()])]);
    case 'cols3':
      return row(many(3));
    case 'rows3':
      return col(many(3));
    case 'grid3x2':
      return col([row(many(3)), row(many(3))]);
    case 'grid2x3':
      return col([row(many(2)), row(many(2)), row(many(2))]);
    case 'mainBottom':
      return col([empty(), row([empty(), empty()])], [0.65, 0.35]);
    case 'cols3Stack':
      return row([empty(), empty(), col([empty(), empty()])]);
  }
}

export function presetCellCount(preset: PresetId): number {
  return collectLeaves(presetTree(preset)).length;
}

// ---------------------------------------------------------------------------------------------
// Pure tree helpers
// ---------------------------------------------------------------------------------------------

/** Leaves in reading order (depth-first). */
function collectLeaves(root: LayoutNode | null): LeafNode[] {
  const out: LeafNode[] = [];
  const walk = (node: LayoutNode) => {
    if (node.type === 'leaf') out.push(node);
    else node.children.forEach(walk);
  };
  if (root) walk(root);
  return out;
}

/** Rectangles of a split's children, in order. */
function childRects(node: SplitNode, rect: FractionRect): FractionRect[] {
  let offset = 0;
  return node.children.map((_, index) => {
    const size = node.sizes[index];
    const child: FractionRect =
      node.dir === 'row'
        ? { left: rect.left + offset * rect.width, top: rect.top, width: size * rect.width, height: rect.height }
        : { left: rect.left, top: rect.top + offset * rect.height, width: rect.width, height: size * rect.height };
    offset += size;
    return child;
  });
}

export function leafRects(root: LayoutNode | null): LeafRect[] {
  const out: LeafRect[] = [];
  const walk = (node: LayoutNode, rect: FractionRect) => {
    if (node.type === 'leaf') {
      out.push({ key: node.key, paneId: node.paneId, rect });
      return;
    }
    const rects = childRects(node, rect);
    node.children.forEach((child, index) => walk(child, rects[index]));
  };
  if (root) walk(root, { left: 0, top: 0, width: 1, height: 1 });
  return out;
}

export function gutters(root: LayoutNode | null): GutterInfo[] {
  const out: GutterInfo[] = [];
  const walk = (node: LayoutNode, rect: FractionRect) => {
    if (node.type === 'leaf') return;
    const rects = childRects(node, rect);
    node.children.forEach((child, index) => {
      if (index < node.children.length - 1) {
        const end = rects[index];
        const boundary: FractionRect =
          node.dir === 'row'
            ? { left: end.left + end.width, top: rect.top, width: 0, height: rect.height }
            : { left: rect.left, top: end.top + end.height, width: rect.width, height: 0 };
        out.push({ splitKey: node.key, index, dir: node.dir, rect: boundary, extent: rect });
      }
      walk(child, rects[index]);
    });
  };
  if (root) walk(root, { left: 0, top: 0, width: 1, height: 1 });
  return out;
}

function replaceLeaf(node: LayoutNode, key: string, replace: (leaf: LeafNode) => LayoutNode): LayoutNode {
  if (node.type === 'leaf') return node.key === key ? replace(node) : node;
  return { ...node, children: node.children.map(child => replaceLeaf(child, key, replace)) };
}

function mapSplits(node: LayoutNode, change: (split: SplitNode) => SplitNode): LayoutNode {
  if (node.type === 'leaf') return node;
  return change({ ...node, children: node.children.map(child => mapSplits(child, change)) });
}

/** Removes a leaf; splits left with one child collapse. Returns null when nothing is left. */
function removeLeafNode(node: LayoutNode, key: string): LayoutNode | null {
  if (node.type === 'leaf') return node.key === key ? null : node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const kept = removeLeafNode(child, key);
    if (kept) {
      children.push(kept);
      sizes.push(node.sizes[index]);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  return { ...node, children, sizes };
}

/** Replaces leaf `key` with a split holding the target and `fresh` on `edge`; both halves take half the target's share. */
function insertBeside(root: LayoutNode, key: string, edge: SideEdge, fresh: LayoutNode): LayoutNode {
  const dir = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const before = edge === 'left' || edge === 'top';
  return replaceLeaf(root, key, target => splitNode(dir, before ? [fresh, target] : [target, fresh], [0.5, 0.5]));
}

/** Side to split a leaf along: wider on a 16:10 window → side by side, else stacked. */
function longerEdge(rect: FractionRect): SideEdge {
  return rect.width * 16 >= rect.height * 10 ? 'right' : 'bottom';
}

/** Sizes clamped to minPaneFraction and renormalized to sum 1. */
function fitSizes(values: number[]): number[] {
  const count = values.length;
  if (count === 0) return [];
  if (count * minPaneFraction >= 1) return equalSizes(count);
  const raw = values.map(value => (Number.isFinite(value) && value > 0 ? value : 1));
  const locked = raw.map(() => false);
  let out = raw;
  for (let pass = 0; pass <= count; pass += 1) {
    const lockedCount = locked.filter(Boolean).length;
    const freeRaw = raw.reduce((sum, value, index) => (locked[index] ? sum : sum + value), 0);
    const freeTotal = 1 - lockedCount * minPaneFraction;
    out = raw.map((value, index) => (locked[index] ? minPaneFraction : (value / freeRaw) * freeTotal));
    let changed = false;
    out.forEach((value, index) => {
      if (!locked[index] && value < minPaneFraction) {
        locked[index] = true;
        changed = true;
      }
    });
    if (!changed) break;
  }
  const total = out.reduce((sum, value) => sum + value, 0);
  return out.map(value => value / total);
}

/** Collapses single-child splits and flattens same-direction children into their parent. */
function normalizeNode(node: LayoutNode): LayoutNode | null {
  if (node.type === 'leaf') return node;
  const parts: { node: LayoutNode; size: number }[] = [];
  node.children.forEach((child, index) => {
    const kid = normalizeNode(child);
    if (!kid) return;
    const size = node.sizes[index];
    if (kid.type === 'split' && kid.dir === node.dir) {
      kid.children.forEach((grandchild, grandIndex) => parts.push({ node: grandchild, size: size * kid.sizes[grandIndex] }));
    } else {
      parts.push({ node: kid, size });
    }
  });
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0].node;
  return { ...node, children: parts.map(part => part.node), sizes: fitSizes(parts.map(part => part.size)) };
}

const emptyState = (): LayoutState => ({ root: null, panes: {}, focused: null });

/** Enforces every tree invariant; keeps keys of surviving nodes. */
function normalize(state: LayoutState): LayoutState {
  let root = state.root ? normalizeNode(state.root) : null;
  const known = state.panes;
  const seenPanes = new Set<string>();
  const seenChats = new Set<string>();
  const seenSingletons = new Set<PaneKind>();
  for (const leaf of collectLeaves(root)) {
    if (!leaf.paneId) continue;
    const pane = known[leaf.paneId];
    const duplicate =
      !pane ||
      seenPanes.has(pane.id) ||
      (pane.kind === 'chat' && (!pane.chatId || seenChats.has(pane.chatId))) ||
      (singletonKinds.includes(pane.kind) && seenSingletons.has(pane.kind));
    if (duplicate) {
      root = root ? replaceLeaf(root, leaf.key, current => ({ ...current, paneId: null })) : null;
      continue;
    }
    seenPanes.add(pane.id);
    if (pane.kind === 'chat' && pane.chatId) seenChats.add(pane.chatId);
    if (singletonKinds.includes(pane.kind)) seenSingletons.add(pane.kind);
  }
  const leaves = collectLeaves(root);
  const panes: Record<string, PaneInstance> = {};
  for (const leaf of leaves) {
    if (leaf.paneId) panes[leaf.paneId] = known[leaf.paneId];
  }
  const focused = leaves.some(leaf => leaf.key === state.focused) ? state.focused : leaves[0]?.key ?? null;
  return { root: leaves.length ? root : null, panes, focused };
}

// ---------------------------------------------------------------------------------------------
// Persistence: load, validate, migrate the old preset shape
// ---------------------------------------------------------------------------------------------

function parseNode(raw: unknown, keys: Set<string>, depth: number): LayoutNode | null {
  if (!raw || typeof raw !== 'object' || depth > 24) return null;
  const node = raw as Record<string, unknown>;
  let key = typeof node.key === 'string' && node.key && !keys.has(node.key) ? node.key : newKey();
  while (keys.has(key)) key = newKey();
  keys.add(key);
  if (node.type === 'leaf') {
    return { type: 'leaf', key, paneId: typeof node.paneId === 'string' && node.paneId ? node.paneId : null };
  }
  if (node.type === 'split' && (node.dir === 'row' || node.dir === 'col') && Array.isArray(node.children) && Array.isArray(node.sizes)) {
    const dir = node.dir;
    const rawSizes: unknown[] = node.sizes;
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, index) => {
      const size = rawSizes[index];
      if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return;
      const parsed = parseNode(child, keys, depth + 1);
      if (!parsed) return;
      children.push(parsed);
      sizes.push(size);
    });
    if (!children.length) return null;
    return { type: 'split', key, dir, children, sizes };
  }
  return null;
}

function parsePane(id: string, raw: unknown): PaneInstance | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (!paneKinds.includes(value.kind as PaneKind)) return null;
  const pane: PaneInstance = { id, kind: value.kind as PaneKind };
  if (pane.kind === 'chat') {
    if (typeof value.chatId !== 'string' || !value.chatId) return null;
    pane.chatId = value.chatId;
  }
  if (pane.kind === 'image') {
    // Large data: URLs are not worth persisting (and can blow the state size); keep linkable images only.
    if (typeof value.src !== 'string' || !value.src || value.src.length > 4096) return null;
    pane.src = value.src;
  }
  if (pane.kind === 'terminal' && typeof value.cwd === 'string' && value.cwd) pane.cwd = value.cwd;
  if (typeof value.title === 'string') pane.title = value.title;
  return pane;
}

function parseState(value: Record<string, unknown>): LayoutState {
  const root = parseNode(value.root, new Set(), 0);
  const panes: Record<string, PaneInstance> = {};
  if (value.panes && typeof value.panes === 'object') {
    for (const [id, raw] of Object.entries(value.panes as Record<string, unknown>)) {
      const pane = parsePane(id, raw);
      if (pane) panes[id] = pane;
    }
  }
  return { root, panes, focused: typeof value.focused === 'string' ? value.focused : null };
}

function splitFraction(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0.2, Math.min(0.8, value)) : 0.5;
}

/** Old shape: `{ preset, cells, splits: {x, y}, focused }` (one chat or null per cell). */
function migrateOld(value: Record<string, unknown>): LayoutState {
  const cells = (value.cells as unknown[]).map(cell => (typeof cell === 'string' && cell ? cell : null));
  if (!cells.length) return emptyState();
  const splits = (value.splits && typeof value.splits === 'object' ? value.splits : {}) as Record<string, unknown>;
  const x = splitFraction(splits.x);
  const y = splitFraction(splits.y);
  const panes: Record<string, PaneInstance> = {};
  const cellLeaf = (index: number): LeafNode => {
    const chatId = cells[index] ?? null;
    if (!chatId) return leafNode(null) as LeafNode;
    const pane: PaneInstance = { id: newPaneId(panes), kind: 'chat', chatId };
    panes[pane.id] = pane;
    return leafNode(pane.id) as LeafNode;
  };
  const counts: Record<string, number> = { single: 1, columns: 2, rows: 2, three: 3, grid: 4 };
  const count = counts[String(value.preset)] ?? 1;
  const leaves = Array.from({ length: count }, (_, index) => cellLeaf(index));
  let root: LayoutNode;
  switch (value.preset) {
    case 'columns':
      root = splitNode('row', [leaves[0], leaves[1]], [x, 1 - x]);
      break;
    case 'rows':
      root = splitNode('col', [leaves[0], leaves[1]], [y, 1 - y]);
      break;
    case 'three':
      root = splitNode('row', [leaves[0], splitNode('col', [leaves[1], leaves[2]], [y, 1 - y])], [x, 1 - x]);
      break;
    case 'grid':
      root = splitNode(
        'row',
        [splitNode('col', [leaves[0], leaves[2]], [y, 1 - y]), splitNode('col', [leaves[1], leaves[3]], [y, 1 - y])],
        [x, 1 - x],
      );
      break;
    default:
      root = leaves[0];
  }
  const focusIndex = typeof value.focused === 'number' ? value.focused : 0;
  return { root, panes, focused: leaves[focusIndex]?.key ?? leaves[0].key };
}

function loadState(): LayoutState {
  const stored = readPersisted<unknown>('layout', null);
  if (!stored || typeof stored !== 'object') return emptyState();
  const value = stored as Record<string, unknown>;
  if (Array.isArray(value.cells) && typeof value.preset === 'string') return normalize(migrateOld(value));
  return normalize(parseState(value));
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

const store = createRoot(() => {
  const [state, setState] = createSignal<LayoutState>(loadState());
  const [popped, setPopped] = createSignal<string[]>([]);
  return { state, setState, popped, setPopped };
});

function commit(next: LayoutState): void {
  const normalized = normalize(next);
  store.setState(normalized);
  writePersisted('layout', normalized);
}

export const layout = (): LayoutState => store.state();

/** Instances currently in leaves, in reading order. */
export const panes = (): PaneInstance[] => {
  const state = layout();
  const out: PaneInstance[] = [];
  for (const leaf of collectLeaves(state.root)) {
    if (leaf.paneId && state.panes[leaf.paneId]) out.push(state.panes[leaf.paneId]);
  }
  return out;
};

export function paneById(id: string): PaneInstance | undefined {
  return layout().panes[id];
}

export function leafOfPane(paneId: string): string | undefined {
  return collectLeaves(layout().root).find(leaf => leaf.paneId === paneId)?.key;
}

export const openChats = (): string[] =>
  panes()
    .filter(pane => pane.kind === 'chat' && !!pane.chatId)
    .map(pane => pane.chatId as string);

export function isChatOnScreen(chatId: string): boolean {
  return openChats().includes(chatId);
}

export function focusedPane(): PaneInstance | undefined {
  const state = layout();
  const leaf = collectLeaves(state.root).find(item => item.key === state.focused);
  return leaf?.paneId ? state.panes[leaf.paneId] : undefined;
}

export function focusedChatId(): string | undefined {
  const pane = focusedPane();
  return pane?.kind === 'chat' ? pane.chatId : undefined;
}

/** Chats currently shown in pop-out windows (main window only). */
export const poppedOutChats = (): string[] => store.popped();

/** Records which chats are popped out and closes any pane still showing one of them. */
export function setPoppedOutChats(chatIds: string[]): void {
  store.setPopped([...chatIds]);
  const popped = new Set(chatIds);
  removePanes(pane => pane.kind === 'chat' && !!pane.chatId && popped.has(pane.chatId));
}

/** True when the chat lives in a pop-out window: focus that window instead of opening a pane. */
function focusPoppedOut(chatId: string): boolean {
  if (!poppedOutChats().includes(chatId)) return false;
  const popOut = bridge().popOut;
  if (popOut) popOut(chatId);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------

/**
 * Places a new pane: fills an empty leaf (focused one first) if there is one; otherwise splits the focused leaf
 * when `beside` or when it holds a non-chat pane, and replaces its chat when not.
 */
function placeInState(state: LayoutState, pane: PaneInstance, beside: boolean): LayoutState {
  const withPane = { ...state.panes, [pane.id]: pane };
  if (!state.root) {
    const leaf = leafNode(pane.id);
    return { root: leaf, panes: withPane, focused: leaf.key };
  }
  const leaves = collectLeaves(state.root);
  const focusedLeaf = leaves.find(leaf => leaf.key === state.focused) ?? leaves[0];
  const emptyLeaf = !focusedLeaf.paneId ? focusedLeaf : leaves.find(leaf => !leaf.paneId);
  if (emptyLeaf) {
    const root = replaceLeaf(state.root, emptyLeaf.key, leaf => ({ ...leaf, paneId: pane.id }));
    return { root, panes: withPane, focused: emptyLeaf.key };
  }
  const focusedPaneInstance = focusedLeaf.paneId ? state.panes[focusedLeaf.paneId] : undefined;
  if (!beside && focusedPaneInstance?.kind === 'chat') {
    const root = replaceLeaf(state.root, focusedLeaf.key, leaf => ({ ...leaf, paneId: pane.id }));
    return { root, panes: withPane, focused: focusedLeaf.key };
  }
  const rect = leafRects(state.root).find(item => item.key === focusedLeaf.key)?.rect;
  const fresh = leafNode(pane.id);
  const root = insertBeside(state.root, focusedLeaf.key, rect ? longerEdge(rect) : 'right', fresh);
  return { root, panes: withPane, focused: fresh.key };
}

export function focusLeaf(leafKey: string): void {
  const state = layout();
  if (state.focused === leafKey || !collectLeaves(state.root).some(leaf => leaf.key === leafKey)) return;
  commit({ ...state, focused: leafKey });
}

/** Shows a chat. Popped out: focus its window instead. Already on screen: focus its leaf. */
export function openChat(chatId: string, options: { beside?: boolean } = {}): void {
  if (focusPoppedOut(chatId)) return;
  const state = layout();
  const existing = panes().find(pane => pane.kind === 'chat' && pane.chatId === chatId);
  if (existing) {
    focusLeaf(leafOfPane(existing.id) ?? '');
    return;
  }
  const pane: PaneInstance = { id: newPaneId(state.panes), kind: 'chat', chatId };
  commit(placeInState(state, pane, !!options.beside));
}

/** Opens a non-chat pane; files and knowledge are singletons and focus the existing instance. Returns its id. */
export function openPane(kind: Exclude<PaneKind, 'chat'>, options: { beside?: boolean; cwd?: string } = {}): string {
  const state = layout();
  if (singletonKinds.includes(kind)) {
    const existing = panes().find(pane => pane.kind === kind);
    if (existing) {
      focusLeaf(leafOfPane(existing.id) ?? '');
      return existing.id;
    }
  }
  const pane: PaneInstance = { id: newPaneId(state.panes), kind };
  if (kind === 'terminal' && options.cwd) pane.cwd = options.cwd;
  commit(placeInState(state, pane, options.beside ?? true));
  return pane.id;
}

/**
 * Puts a pane into an existing leaf. Chats or singletons already on screen are focused or moved from their leaf
 * (which is left empty) instead of duplicated. Popped-out chats are not placed.
 */
export function fillSlot(leafKey: string, kind: PaneKind, chatId?: string): void {
  const state = layout();
  const target = collectLeaves(state.root).find(leaf => leaf.key === leafKey);
  if (!target) return;
  let panesNext = state.panes;
  let paneId: string;
  let root = state.root as LayoutNode;
  if (kind === 'chat') {
    if (!chatId || focusPoppedOut(chatId)) return;
    const onScreen = panes().find(pane => pane.kind === 'chat' && pane.chatId === chatId);
    if (onScreen) {
      focusLeaf(leafOfPane(onScreen.id) ?? '');
      return;
    }
    const pane: PaneInstance = { id: newPaneId(panesNext), kind, chatId };
    panesNext = { ...panesNext, [pane.id]: pane };
    paneId = pane.id;
  } else if (singletonKinds.includes(kind)) {
    const existing = panes().find(pane => pane.kind === kind);
    if (existing) {
      const fromLeaf = leafOfPane(existing.id);
      if (fromLeaf === leafKey) {
        focusLeaf(leafKey);
        return;
      }
      if (fromLeaf) root = replaceLeaf(root, fromLeaf, leaf => ({ ...leaf, paneId: null }));
      paneId = existing.id;
    } else {
      const pane: PaneInstance = { id: newPaneId(panesNext), kind };
      panesNext = { ...panesNext, [pane.id]: pane };
      paneId = pane.id;
    }
  } else {
    const pane: PaneInstance = { id: newPaneId(panesNext), kind };
    panesNext = { ...panesNext, [pane.id]: pane };
    paneId = pane.id;
  }
  const finalPaneId = paneId;
  root = replaceLeaf(root, leafKey, leaf => ({ ...leaf, paneId: finalPaneId }));
  commit({ root, panes: panesNext, focused: leafKey });
}

/** Removes the given leaves; focus moves to the nearest surviving leaf when the focused one goes. */
function withoutLeaves(state: LayoutState, keys: string[]): LayoutState {
  const before = collectLeaves(state.root).map(leaf => leaf.key);
  let root = state.root;
  for (const key of keys) root = root ? removeLeafNode(root, key) : null;
  const survivors = new Set(collectLeaves(root).map(leaf => leaf.key));
  let focused = state.focused;
  if (!focused || !survivors.has(focused)) {
    const index = before.indexOf(state.focused ?? '');
    const candidates = [...before.slice(0, Math.max(0, index)).reverse(), ...before.slice(Math.max(0, index) + 1)];
    focused = candidates.find(key => survivors.has(key)) ?? null;
  }
  return { root, panes: state.panes, focused };
}

/** Removes every leaf whose pane matches. */
function removePanes(match: (pane: PaneInstance) => boolean): void {
  const state = layout();
  const keys = collectLeaves(state.root)
    .filter(leaf => leaf.paneId && state.panes[leaf.paneId] && match(state.panes[leaf.paneId]))
    .map(leaf => leaf.key);
  if (!keys.length) return;
  commit(withoutLeaves(state, keys));
}

export function closePane(paneId: string): void {
  removePanes(pane => pane.id === paneId);
}

export function closeChat(chatId: string): void {
  removePanes(pane => pane.kind === 'chat' && pane.chatId === chatId);
}

/** Removes an empty leaf. */
export function closeSlot(leafKey: string): void {
  const state = layout();
  const leaf = collectLeaves(state.root).find(item => item.key === leafKey);
  if (!leaf || leaf.paneId) return;
  commit(withoutLeaves(state, [leafKey]));
}

/** Removes chats that no longer exist (deleted sessions). */
export function pruneChats(exists: (chatId: string) => boolean): void {
  removePanes(pane => pane.kind === 'chat' && !!pane.chatId && !exists(pane.chatId));
}

export function setPaneTitle(paneId: string, title: string): void {
  const state = layout();
  const pane = state.panes[paneId];
  if (!pane || pane.title === title) return;
  commit({ ...state, panes: { ...state.panes, [paneId]: { ...pane, title } } });
}

/** Sets the folder a terminal pane's shell starts in; the pane restarts its shell there. */
export function setPaneCwd(paneId: string, cwd: string): void {
  const state = layout();
  const pane = state.panes[paneId];
  if (!pane || pane.kind !== 'terminal' || pane.cwd === cwd) return;
  commit({ ...state, panes: { ...state.panes, [paneId]: { ...pane, cwd } } });
}

// ---------------------------------------------------------------------------------------------
// Arrangement
// ---------------------------------------------------------------------------------------------

/**
 * Drop of a pane on a leaf. center swaps the two leaves' contents (into an empty leaf the source leaf is removed);
 * an edge removes the pane's leaf and splits the target on that edge with the pane.
 */
export function movePane(paneId: string, targetLeafKey: string, edge: DropEdge): void {
  const state = layout();
  const from = leafOfPane(paneId);
  const target = collectLeaves(state.root).find(leaf => leaf.key === targetLeafKey);
  if (!from || !target || !state.root || from === targetLeafKey) return;
  if (edge === 'center') {
    let root = state.root;
    if (target.paneId) {
      root = replaceLeaf(root, from, leaf => ({ ...leaf, paneId: target.paneId }));
      root = replaceLeaf(root, targetLeafKey, leaf => ({ ...leaf, paneId }));
    } else {
      root = replaceLeaf(root, targetLeafKey, leaf => ({ ...leaf, paneId }));
      root = removeLeafNode(root, from) ?? root;
    }
    commit({ root, panes: state.panes, focused: targetLeafKey });
    return;
  }
  const remaining = removeLeafNode(state.root, from);
  if (!remaining) return;
  const fresh = leafNode(paneId);
  commit({ root: insertBeside(remaining, targetLeafKey, edge, fresh), panes: state.panes, focused: fresh.key });
}

/** Drop on a workspace edge: a new side strip of 0.3 (or one more child when the root already splits that way). */
export function movePaneToEdge(paneId: string, edge: SideEdge): void {
  const state = layout();
  const from = leafOfPane(paneId);
  if (!from || !state.root) return;
  const remaining = removeLeafNode(state.root, from);
  const fresh = leafNode(paneId);
  commit({ root: wrapAtEdge(remaining, fresh, edge), panes: state.panes, focused: fresh.key });
}

/** Where a new pane dropped from outside the grid goes: onto a leaf (an edge splits it, center fills or splits beside) or a workspace edge. */
export type PlaceTarget = { leafKey: string; edge: DropEdge } | { workspaceEdge: SideEdge } | { auto: true };

/**
 * Places a brand-new pane (e.g. an image dragged out of a chat) at a snap target. Center on an empty leaf fills
 * it; center on an occupied leaf splits it along its longer side. Returns the new pane id ('' when not placed).
 */
export function placePane(spec: { kind: 'image'; src: string; title?: string } | { kind: 'terminal' }, target: PlaceTarget): string {
  const pane: PaneInstance = { id: newPaneId(layout().panes), kind: spec.kind };
  if (spec.kind === 'image') {
    if (!spec.src) return '';
    pane.src = spec.src;
    if (spec.title) pane.title = spec.title;
  }
  return placeNewPane(pane, target);
}

/**
 * A chat dragged from the chats list onto a snap target. A chat already on screen moves there (as a pane header
 * drag would); otherwise it opens there. Popped-out chats focus their window instead. Returns true when placed.
 */
export function placeChat(chatId: string, target: PlaceTarget): boolean {
  if (!chatId || focusPoppedOut(chatId)) return false;
  const existing = panes().find(pane => pane.kind === 'chat' && pane.chatId === chatId);
  if (existing) {
    const from = leafOfPane(existing.id);
    if ('auto' in target || !from) {
      if (from) focusLeaf(from);
      return !!from;
    }
    if ('workspaceEdge' in target) movePaneToEdge(existing.id, target.workspaceEdge);
    else if (target.leafKey === from) focusLeaf(from);
    else movePane(existing.id, target.leafKey, target.edge);
    return true;
  }
  return !!placeNewPane({ id: newPaneId(layout().panes), kind: 'chat', chatId }, target);
}

function placeNewPane(pane: PaneInstance, target: PlaceTarget): string {
  const state = layout();
  const panesNext = { ...state.panes, [pane.id]: pane };
  const fresh = leafNode(pane.id);
  if ('auto' in target || !state.root) {
    commit(placeInState(state, pane, true));
    return pane.id;
  }
  if ('workspaceEdge' in target) {
    commit({ root: wrapAtEdge(state.root, fresh, target.workspaceEdge), panes: panesNext, focused: fresh.key });
    return pane.id;
  }
  const leaf = collectLeaves(state.root).find(item => item.key === target.leafKey);
  if (!leaf) return '';
  if (target.edge === 'center') {
    if (!leaf.paneId) {
      const root = replaceLeaf(state.root, leaf.key, node => ({ ...node, paneId: pane.id }));
      commit({ root, panes: panesNext, focused: leaf.key });
      return pane.id;
    }
    const rect = leafRects(state.root).find(item => item.key === leaf.key)?.rect;
    commit({ root: insertBeside(state.root, leaf.key, rect ? longerEdge(rect) : 'right', fresh), panes: panesNext, focused: fresh.key });
    return pane.id;
  }
  commit({ root: insertBeside(state.root, leaf.key, target.edge, fresh), panes: panesNext, focused: fresh.key });
  return pane.id;
}

function wrapAtEdge(remaining: LayoutNode | null, fresh: LayoutNode, edge: SideEdge): LayoutNode {
  const dir = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const first = edge === 'left' || edge === 'top';
  let root: LayoutNode;
  if (!remaining) {
    root = fresh;
  } else if (remaining.type === 'split' && remaining.dir === dir) {
    const count = remaining.children.length;
    const scaled = remaining.sizes.map(size => (size * count) / (count + 1));
    root = {
      ...remaining,
      children: first ? [fresh, ...remaining.children] : [...remaining.children, fresh],
      sizes: first ? [1 / (count + 1), ...scaled] : [...scaled, 1 / (count + 1)],
    };
  } else {
    root = splitNode(dir, first ? [fresh, remaining] : [remaining, fresh], first ? [0.3, 0.7] : [0.7, 0.3]);
  }
  return root;
}

/** Inserts an empty leaf beside a leaf on `edge`. Returns the new leaf's key ('' when the leaf does not exist). */
export function splitLeaf(leafKey: string, edge: SideEdge): string {
  const state = layout();
  if (!state.root || !collectLeaves(state.root).some(leaf => leaf.key === leafKey)) return '';
  const fresh = leafNode(null);
  commit({ ...state, root: insertBeside(state.root, leafKey, edge, fresh) });
  return fresh.key;
}

/** Sets the gutter at `boundary` (0..1 within the split's extent) after children[index]; both neighbours keep their minimum. */
export function resizeSplit(splitKey: string, index: number, boundary: number): void {
  const state = layout();
  if (!state.root || !Number.isInteger(index) || !Number.isFinite(boundary)) return;
  const root = mapSplits(state.root, split => {
    if (split.key !== splitKey || index < 0 || index >= split.children.length - 1) return split;
    const start = split.sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
    const pair = split.sizes[index] + split.sizes[index + 1];
    const first = Math.max(minPaneFraction, Math.min(pair - minPaneFraction, boundary - start));
    const sizes = [...split.sizes];
    sizes[index] = first;
    sizes[index + 1] = pair - first;
    return { ...split, sizes };
  });
  commit({ ...state, root });
}

/** Equal sizes for every split, or only the given one. */
export function equalize(splitKey?: string): void {
  const state = layout();
  if (!state.root) return;
  const root = mapSplits(state.root, split =>
    splitKey === undefined || split.key === splitKey ? { ...split, sizes: equalSizes(split.children.length) } : split,
  );
  commit({ ...state, root });
}

/**
 * Rebuilds the workspace from a preset. The drop pane takes leaf `cell` (reading order); the other panes fill the
 * remaining leaves in their current order; extra panes split the largest leaf until they fit.
 */
export function applyPreset(preset: PresetId, dropPaneId?: string, cell = 0): void {
  const state = layout();
  if (dropPaneId !== undefined && !state.panes[dropPaneId]) return;
  const others = panes()
    .map(pane => pane.id)
    .filter(id => id !== dropPaneId);
  const tree = presetTree(preset);
  const cells = collectLeaves(tree);
  const target = Math.max(0, Math.min(cells.length - 1, Math.floor(cell)));
  const queue = [...others];
  let root: LayoutNode = tree;
  cells.forEach((leaf, index) => {
    const paneId = dropPaneId !== undefined && index === target ? dropPaneId : queue.shift();
    if (paneId !== undefined) root = replaceLeaf(root, leaf.key, current => ({ ...current, paneId }));
  });
  while (queue.length) {
    const paneId = queue.shift() as string;
    const rects = leafRects(root);
    let largest = rects[0];
    for (const item of rects) {
      if (item.rect.width * item.rect.height > largest.rect.width * largest.rect.height) largest = item;
    }
    root = insertBeside(root, largest.key, longerEdge(largest.rect), leafNode(paneId));
  }
  const focused = dropPaneId !== undefined ? cells[target].key : collectLeaves(root)[0]?.key ?? null;
  commit({ root, panes: state.panes, focused });
}

/** Closes everything. Pop-outs stay open in their own windows. */
export function resetLayout(): void {
  commit(emptyState());
}
