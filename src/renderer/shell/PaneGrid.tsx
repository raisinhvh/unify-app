/**
 * The tiling workspace: one PaneFrame per leaf of the split tree (shell/layout.ts), the split gutters, and the drag
 * interactions.
 *
 *   pane header drag → the pane lifts to 50% and follows the pointer; the layout picker drops in at the top centre.
 *     Drop targets, in order: a picker cell (applyPreset), a workspace edge strip (movePaneToEdge), the five zones of
 *     another leaf (movePane: the outer 28% bands = that edge, the middle = centre swap). Escape cancels.
 *   gutter drag → resizeSplit. Snaps to quarters, thirds and halves and to other splits' gutters (Alt = free).
 *   image drag from a chat (HTML5 DnD, see imageDrag.ts) → placePane with the same zones.
 *   chat drag from the chats list (chatDrag.ts) → the same zones; onChatDropped places it (layout.placeChat).
 *
 * Panes are keyed by pane id and empty leaves by leaf key, so moving a pane between leaves never remounts it
 * (terminals keep running, chats keep their state). The area is transparent where there are no panes.
 */
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show, untrack, type JSX } from 'solid-js';
import { Presence, prefersReducedMotion, Spring } from '../motion';
import { feature } from '../store/features';
import {
  applyPreset,
  closePane,
  closeSlot,
  equalize,
  focusLeaf,
  gutters,
  layout,
  leafOfPane,
  leafRects,
  movePane,
  movePaneToEdge,
  placePane,
  resizeSplit,
  type DropEdge,
  type FractionRect,
  type GutterInfo,
  type PaneInstance,
  type PlaceTarget,
  type PresetId,
} from './layout';
import { isImageDrag, readImageDrag } from './imageDrag';
import { isChatDrag, readChatDrag } from './chatDrag';
import { LayoutPicker, presetCells, type PickerTarget } from './LayoutPicker';
import { PaneFrame, type PixelRect } from './Pane';
import './shell.css';

export interface PaneContext {
  paneId: string;
  pane: () => PaneInstance | undefined;
  /** Chat id for chat panes, '' otherwise. A pane's chat never changes (a new chat = a new pane). */
  chatId: string;
  leafKey: () => string;
  focused: () => boolean;
  dragging: () => boolean;
  /** Call from a header's pointerdown: becomes a drag once the pointer moves 4px. */
  startDrag: (event: PointerEvent) => void;
  close: () => void;
  /** The pane fills a pop-out window on its own: no drag grip, no pop-out button. */
  standalone?: boolean;
}

export interface EmptySlotContext {
  leafKey: string;
  focused: () => boolean;
  close: () => void;
}

export interface PaneGridProps {
  renderPane: (context: PaneContext) => JSX.Element;
  renderEmpty: (context: EmptySlotContext) => JSX.Element;
  /** A chat dragged from the chats list was dropped on `target`. */
  onChatDropped?: (chatId: string, target: PlaceTarget) => void;
}

const padding = 8;
const defaultGap = 8;
const maxGap = 24;
const minGutterHit = 6;
const dragThreshold = 4;
/** Distance (px) from the workspace edge that counts as an edge drop zone. */
const edgeZoneWidth = 28;
/** Outer share of a leaf on each side that counts as that edge (the middle is the centre zone). */
const bandShare = 0.28;
/** Snap distance (px) for split handles. */
const snapRange = 10;
const snapRatios = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4];

type SideEdge = Exclude<DropEdge, 'center'>;

const strips: Record<SideEdge, FractionRect> = {
  left: { left: 0, top: 0, width: 0.3, height: 1 },
  right: { left: 0.7, top: 0, width: 0.3, height: 1 },
  top: { left: 0, top: 0, width: 1, height: 0.3 },
  bottom: { left: 0, top: 0.7, width: 1, height: 0.3 },
};

const fullArea: FractionRect = { left: 0, top: 0, width: 1, height: 1 };

/** Where a pane or image would land. `preview` is the zone outlined in the workspace (fractions). */
type DropTarget =
  | { kind: 'preset'; preset: PresetId; cell: number; preview: FractionRect }
  | { kind: 'edge'; edge: SideEdge; preview: FractionRect }
  | { kind: 'leaf'; leafKey: string; edge: DropEdge; leafRect: FractionRect; preview: FractionRect }
  | { kind: 'auto'; preview?: FractionRect };

interface PaneDrag {
  paneId: string;
  grabX: number;
  grabY: number;
  pointerX: number;
  pointerY: number;
  target?: DropTarget;
}

interface ResizeState {
  /** Pointer position inside the area (px). */
  pointerX: number;
  pointerY: number;
  /** Share of the split's extent taken by the two neighbours of the handle. */
  percents: [number, number];
  /** Snap guide (px) across the split; absent while free. */
  guide?: { vertical: boolean; pos: number; start: number; length: number };
}

interface Slot {
  /** Pane id for filled leaves, 'leaf:<key>' for empty ones. */
  key: string;
  paneId: string | null;
  leafKey: string;
  instance?: PaneInstance;
  rect: PixelRect;
  frac: FractionRect;
}

interface RenderedItem {
  key: string;
  paneId: string | null;
  /** Empty leaves only. */
  leafKey: string;
  /** Pane leaves: the instance, kept so a leaving pane can still render. */
  instance?: PaneInstance;
  leaving: boolean;
  lastRect: PixelRect;
}

function toPixels(rect: FractionRect, width: number, height: number, gap: number): PixelRect {
  const innerWidth = Math.max(0, width - padding * 2);
  const innerHeight = Math.max(0, height - padding * 2);
  let left = padding + rect.left * innerWidth;
  let right = padding + (rect.left + rect.width) * innerWidth;
  let top = padding + rect.top * innerHeight;
  let bottom = padding + (rect.top + rect.height) * innerHeight;
  if (rect.left > 0.001) left += gap / 2;
  if (rect.left + rect.width < 0.999) right -= gap / 2;
  if (rect.top > 0.001) top += gap / 2;
  if (rect.top + rect.height < 0.999) bottom -= gap / 2;
  return { left, top, width: right - left, height: bottom - top };
}

/** The part of a leaf that an edge (or the centre) would take. */
function zoneRect(rect: FractionRect, edge: DropEdge): FractionRect {
  switch (edge) {
    case 'left':
      return { ...rect, width: rect.width / 2 };
    case 'right':
      return { ...rect, left: rect.left + rect.width / 2, width: rect.width / 2 };
    case 'top':
      return { ...rect, height: rect.height / 2 };
    case 'bottom':
      return { ...rect, top: rect.top + rect.height / 2, height: rect.height / 2 };
    case 'center':
      return rect;
  }
}

/** Five zones of a leaf: the nearest outer band wins, otherwise the centre. */
function zoneOf(u: number, v: number): DropEdge {
  const candidates: [DropEdge, number][] = [
    ['left', u],
    ['right', 1 - u],
    ['top', v],
    ['bottom', 1 - v],
  ];
  const [edge, distance] = candidates.reduce((best, item) => (item[1] < best[1] ? item : best));
  return distance < bandShare ? edge : 'center';
}

function sameRect(a: PixelRect | undefined, b: PixelRect | undefined): boolean {
  if (!a || !b) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function sameTarget(a: DropTarget | undefined, b: DropTarget | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'preset' && b.kind === 'preset') return a.preset === b.preset && a.cell === b.cell;
  if (a.kind === 'edge' && b.kind === 'edge') return a.edge === b.edge;
  if (a.kind === 'leaf' && b.kind === 'leaf') return a.leafKey === b.leafKey && a.edge === b.edge;
  return true;
}

function rectStyle(rect: PixelRect) {
  return { left: `${rect.left}px`, top: `${rect.top}px`, width: `${Math.max(0, rect.width)}px`, height: `${Math.max(0, rect.height)}px` };
}

function toPlaceTarget(target: DropTarget): PlaceTarget {
  if (target.kind === 'edge') return { workspaceEdge: target.edge };
  if (target.kind === 'leaf') return { leafKey: target.leafKey, edge: target.edge };
  return { auto: true };
}

function applyPaneDrop(paneId: string, target: DropTarget): void {
  if (target.kind === 'preset') applyPreset(target.preset, paneId, target.cell);
  else if (target.kind === 'edge') movePaneToEdge(paneId, target.edge);
  else if (target.kind === 'leaf') movePane(paneId, target.leafKey, target.edge);
}

export function PaneGrid(props: PaneGridProps): JSX.Element {
  let area!: HTMLDivElement;
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [drag, setDrag] = createSignal<PaneDrag>();
  const [imageTarget, setImageTarget] = createSignal<DropTarget>();
  const [resize, setResize] = createSignal<ResizeState>();
  const [rendered, setRendered] = createSignal<RenderedItem[]>([]);

  // Feature chats.layoutPicker: off keeps the edge and leaf drops, but the picker never drops in. Read live.
  const pickerEnabled = () => feature('chats.layoutPicker');
  const gap = () => {
    const value = Number(feature<number>('layout.gap'));
    return Number.isFinite(value) ? Math.max(0, Math.min(maxGap, value)) : defaultGap;
  };

  const slots = createMemo<Slot[]>(() => {
    const { width, height } = size();
    const pixelGap = gap();
    const state = layout();
    return leafRects(state.root).map(leaf => ({
      key: leaf.paneId ? leaf.paneId : `leaf:${leaf.key}`,
      paneId: leaf.paneId,
      leafKey: leaf.key,
      instance: leaf.paneId ? state.panes[leaf.paneId] : undefined,
      rect: toPixels(leaf.rect, width, height, pixelGap),
      frac: leaf.rect,
    }));
  });
  const slotByKey = createMemo(() => new Map(slots().map(slot => [slot.key, slot])));
  const leafCount = () => slots().length;
  const gutterList = createMemo(() => gutters(layout().root));

  // Keep panes that just closed on screen until their exit finishes; reuse staying items so <For> keeps their DOM.
  createEffect(() => {
    const next = slots();
    setRendered(previous => {
      const staying = new Map(previous.filter(item => !item.leaving).map(item => [item.key, item]));
      const list: RenderedItem[] = next.map(slot => {
        const existing = staying.get(slot.key);
        if (existing) {
          existing.lastRect = slot.rect;
          if (slot.instance) existing.instance = slot.instance;
          return existing;
        }
        return {
          key: slot.key,
          paneId: slot.paneId,
          leafKey: slot.leafKey,
          instance: slot.instance,
          leaving: false,
          lastRect: slot.rect,
        };
      });
      const keys = new Set(list.map(item => item.key));
      for (const item of previous) {
        if (!keys.has(item.key) && item.paneId !== null) list.push(item.leaving ? item : { ...item, leaving: true });
      }
      return list;
    });
  });

  const removeLeft = (key: string) => setRendered(list => list.filter(item => !(item.key === key && item.leaving)));
  const rectFor = (item: RenderedItem): PixelRect => (item.leaving ? item.lastRect : slotByKey().get(item.key)?.rect ?? item.lastRect);

  onMount(() => {
    const observer = new ResizeObserver(() => setSize({ width: area.clientWidth, height: area.clientHeight }));
    observer.observe(area);
    setSize({ width: area.clientWidth, height: area.clientHeight });

    const inside = (event: { clientX: number; clientY: number }) => {
      const box = area.getBoundingClientRect();
      return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    };
    const droppable = (event: DragEvent) => isImageDrag(event) || isChatDrag(event);
    const over = (event: DragEvent) => {
      if (!droppable(event)) return;
      if (!inside(event)) {
        setImageTarget(undefined);
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = isChatDrag(event) ? 'move' : 'copy';
      const next = imageTargetAt(event.clientX, event.clientY);
      setImageTarget(previous => (sameTarget(previous, next) ? previous : next));
    };
    const leave = (event: DragEvent) => {
      if (droppable(event) && !inside(event)) setImageTarget(undefined);
    };
    const drop = (event: DragEvent) => {
      if (!droppable(event)) return;
      setImageTarget(undefined);
      if (!inside(event)) return;
      event.preventDefault();
      const target = toPlaceTarget(imageTargetAt(event.clientX, event.clientY));
      if (isChatDrag(event)) {
        const chatId = readChatDrag(event);
        if (chatId) props.onChatDropped?.(chatId, target);
        return;
      }
      const image = readImageDrag(event);
      if (!image) return;
      placePane({ kind: 'image', src: image.src, title: image.title }, target);
    };
    const clear = () => setImageTarget(undefined);

    window.addEventListener('dragenter', over);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('dragend', clear);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener('dragenter', over);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('dragend', clear);
    });
  });

  /**
   * The drop target under a pointer. Picker cells first (pane drags only), then the workspace edge strips, then the
   * five zones of a leaf. `ownLeaf` (the dragged pane's own leaf) is never a target.
   */
  const targetAt = (clientX: number, clientY: number, options: { pickers: boolean; ownLeaf?: string }): DropTarget | undefined => {
    if (options.pickers && pickerEnabled()) {
      for (const element of document.querySelectorAll<HTMLElement>('.layout-picker [data-preset][data-cell]')) {
        const box = element.getBoundingClientRect();
        const slop = 2;
        if (clientX >= box.left - slop && clientX <= box.right + slop && clientY >= box.top - slop && clientY <= box.bottom + slop) {
          const preset = element.dataset.preset as PresetId;
          const cell = Number(element.dataset.cell);
          const leaf = presetCells[preset]?.[cell];
          if (leaf) return { kind: 'preset', preset, cell, preview: leaf.rect };
        }
      }
    }
    const box = area.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    if (x < 0 || y < 0 || x > box.width || y > box.height) return undefined;
    if (feature('layout.edgeZones')) {
      const distances: [SideEdge, number][] = [
        ['left', x],
        ['right', box.width - x],
        ['top', y],
        ['bottom', box.height - y],
      ];
      const [edge, distance] = distances.reduce((best, item) => (item[1] < best[1] ? item : best));
      if (distance <= edgeZoneWidth) return { kind: 'edge', edge, preview: strips[edge] };
    }
    const slot = slots().find(
      item =>
        item.rect.width > 0 &&
        item.rect.height > 0 &&
        x >= item.rect.left &&
        x <= item.rect.left + item.rect.width &&
        y >= item.rect.top &&
        y <= item.rect.top + item.rect.height,
    );
    if (!slot || slot.leafKey === options.ownLeaf) return undefined;
    const u = (x - slot.rect.left) / slot.rect.width;
    const v = (y - slot.rect.top) / slot.rect.height;
    const edge = zoneOf(u, v);
    return { kind: 'leaf', leafKey: slot.leafKey, edge, leafRect: slot.frac, preview: zoneRect(slot.frac, edge) };
  };

  /** Image drops: an empty workspace takes the whole area; anything else falls back to automatic placement. */
  const imageTargetAt = (clientX: number, clientY: number): DropTarget => {
    if (!layout().root) return { kind: 'auto', preview: fullArea };
    return targetAt(clientX, clientY, { pickers: false }) ?? { kind: 'auto' };
  };

  const startPaneDrag = (paneId: string, event: PointerEvent) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, input, textarea, select, a')) return;
    const slot = slotByKey().get(paneId);
    if (!slot) return;
    const box = area.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const grabX = startX - box.left - slot.rect.left;
    const grabY = startY - box.top - slot.rect.top;
    const ownLeaf = leafOfPane(paneId);
    let active = false;

    const move = (moveEvent: PointerEvent) => {
      if (!active) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < dragThreshold) return;
        active = true;
        document.body.classList.add('dragging-pane');
      }
      const current = area.getBoundingClientRect();
      setDrag({
        paneId,
        grabX,
        grabY,
        pointerX: moveEvent.clientX - current.left,
        pointerY: moveEvent.clientY - current.top,
        target: targetAt(moveEvent.clientX, moveEvent.clientY, { pickers: true, ownLeaf }),
      });
    };
    const finish = (apply: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('dragging-pane');
      const state = drag();
      setDrag(undefined);
      if (apply && active && state?.target) applyPaneDrop(paneId, state.target);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  };

  // What the drop outline and the zone hint show: the dragged pane's target, or the image's.
  const activeTarget = (): DropTarget | undefined => drag()?.target ?? imageTarget();

  const previewRect = createMemo<PixelRect | undefined>(
    () => {
      const preview = activeTarget()?.preview;
      if (!preview) return undefined;
      return toPixels(preview, size().width, size().height, gap());
    },
    undefined,
    { equals: sameRect },
  );

  const hintRect = createMemo<PixelRect | undefined>(
    () => {
      const target = activeTarget();
      if (target?.kind !== 'leaf') return undefined;
      return toPixels(target.leafRect, size().width, size().height, gap());
    },
    undefined,
    { equals: sameRect },
  );
  const hintEdge = (): DropEdge | undefined => {
    const target = activeTarget();
    return target?.kind === 'leaf' ? target.edge : undefined;
  };

  const pickerHover = (): PickerTarget | undefined => {
    const target = drag()?.target;
    return target?.kind === 'preset' ? { preset: target.preset, cell: target.cell } : undefined;
  };

  const renderPaneItem = (item: RenderedItem, paneId: string): JSX.Element => {
    const isDragged = () => drag()?.paneId === paneId;
    const leafKey = () => leafOfPane(paneId);
    const lifted = () => {
      const state = drag();
      if (!state || state.paneId !== paneId) return undefined;
      return { left: state.pointerX - state.grabX * 0.5, top: state.pointerY - state.grabY * 0.5 };
    };
    const context: PaneContext = {
      paneId,
      pane: () => layout().panes[paneId] ?? item.instance,
      chatId: item.instance?.chatId ?? '',
      leafKey: () => leafKey() ?? '',
      focused: () => {
        const key = leafKey();
        return !!key && layout().focused === key;
      },
      dragging: isDragged,
      startDrag: event => startPaneDrag(paneId, event),
      close: () => closePane(paneId),
    };
    // Rendered once: the content tracks its own state, and a re-run would remount it.
    const content = untrack(() => props.renderPane(context));
    return (
      <PaneFrame
        rect={rectFor(item)}
        lifted={lifted()}
        dimmed={!!drag() && !isDragged()}
        resizing={!!resize()}
        leaving={item.leaving}
        focused={!item.leaving && leafCount() > 1 && !!leafKey() && layout().focused === leafKey()}
        onLeft={() => removeLeft(item.key)}
        onPointerDown={() => {
          const key = leafKey();
          if (!item.leaving && key) focusLeaf(key);
        }}
      >
        {content}
      </PaneFrame>
    );
  };

  const renderEmptyItem = (item: RenderedItem): JSX.Element => {
    const leafKey = item.leafKey;
    const content = untrack(() =>
      props.renderEmpty({
        leafKey,
        focused: () => layout().focused === leafKey,
        close: () => closeSlot(leafKey),
      }),
    );
    return (
      <PaneFrame
        rect={rectFor(item)}
        dimmed={!!drag()}
        resizing={!!resize()}
        leaving={false}
        focused={leafCount() > 1 && layout().focused === leafKey}
        onPointerDown={() => focusLeaf(leafKey)}
      >
        {content}
      </PaneFrame>
    );
  };

  return (
    <div ref={area} class="pane-grid" classList={{ dragging: !!drag(), resizing: !!resize() }}>
      <For each={rendered()}>
        {item => (item.paneId !== null ? renderPaneItem(item, item.paneId) : renderEmptyItem(item))}
      </For>
      <Gutters
        list={gutterList}
        size={size}
        gap={gap}
        area={() => area}
        setResize={value => setResize(value)}
        hidden={!!drag()}
      />
      <ResizeOverlay state={resize()} />
      <ZoneHint rect={hintRect()} active={hintEdge()} />
      <DropZone rect={previewRect()} />
      <LayoutPicker open={!!drag() && pickerEnabled()} hovered={pickerHover()} />
    </div>
  );
}

/** Outline of where the dragged pane or image will land; glides between zones. */
function DropZone(props: { rect: PixelRect | undefined }): JSX.Element {
  let element: HTMLDivElement | undefined;
  const springs = {
    left: new Spring(0, 'indicator', 100),
    top: new Spring(0, 'indicator', 100),
    width: new Spring(0, 'indicator', 100),
    height: new Spring(0, 'indicator', 100),
  };
  const paint = () => {
    if (!element) return;
    element.style.left = `${springs.left.value}px`;
    element.style.top = `${springs.top.value}px`;
    element.style.width = `${springs.width.value}px`;
    element.style.height = `${springs.height.value}px`;
  };
  for (const spring of Object.values(springs)) spring.onChange(paint);
  onCleanup(() => {
    for (const spring of Object.values(springs)) spring.stop();
  });
  let shown = false;
  createEffect(() => {
    const rect = props.rect;
    if (!rect) {
      shown = false;
      return;
    }
    const jump = !shown || prefersReducedMotion();
    shown = true;
    for (const key of ['left', 'top', 'width', 'height'] as const) {
      if (jump) springs[key].jump(rect[key]);
      else springs[key].set(rect[key]);
    }
  });
  return (
    <Presence when={!!props.rect} from={0.98}>
      <div
        ref={node => {
          element = node;
          paint();
        }}
        class="drop-zone"
      />
    </Presence>
  );
}

/** Faint five-zone guide on the leaf under the pointer, so the edges are discoverable. */
function ZoneHint(props: { rect: PixelRect | undefined; active: DropEdge | undefined }): JSX.Element {
  return (
    <Show when={props.rect}>
      {rect => (
        <div class="zone-hint" style={rectStyle(rect())}>
          <div class="zone-hint-zone top" classList={{ active: props.active === 'top' }} />
          <div class="zone-hint-zone bottom" classList={{ active: props.active === 'bottom' }} />
          <div class="zone-hint-zone left" classList={{ active: props.active === 'left' }} />
          <div class="zone-hint-zone right" classList={{ active: props.active === 'right' }} />
          <div class="zone-hint-zone center" classList={{ active: props.active === 'center' }} />
        </div>
      )}
    </Show>
  );
}

/** Snap guide line and the neighbour-percent label while a split handle is dragged. */
function ResizeOverlay(props: { state: ResizeState | undefined }): JSX.Element {
  return (
    <Show when={props.state}>
      {state => (
        <>
          <Show when={state().guide}>
            {guide => (
              <div
                class="snap-guide"
                classList={{ vertical: guide().vertical, horizontal: !guide().vertical }}
                style={
                  guide().vertical
                    ? { left: `${guide().pos}px`, top: `${guide().start}px`, height: `${guide().length}px` }
                    : { top: `${guide().pos}px`, left: `${guide().start}px`, width: `${guide().length}px` }
                }
              />
            )}
          </Show>
          <div
            class="ratio-label"
            style={{ left: `${state().pointerX + 14}px`, top: `${state().pointerY + 14}px` }}
          >
            {`${state().percents[0]}% | ${state().percents[1]}%`}
          </div>
        </>
      )}
    </Show>
  );
}

/** Split handles: drag to resize (panes follow exactly), double-click to equalize the split. */
function Gutters(props: {
  list: () => GutterInfo[];
  size: () => { width: number; height: number };
  gap: () => number;
  area: () => HTMLDivElement;
  setResize: (state: ResizeState | undefined) => void;
  hidden: boolean;
}): JSX.Element {
  const innerWidth = () => Math.max(1, props.size().width - padding * 2);
  const innerHeight = () => Math.max(1, props.size().height - padding * 2);
  const hit = () => Math.max(props.gap(), minGutterHit);

  const style = (gutter: GutterInfo) => {
    const thickness = hit();
    if (gutter.dir === 'row') {
      return {
        left: `${padding + gutter.rect.left * innerWidth() - thickness / 2}px`,
        top: `${padding + gutter.extent.top * innerHeight()}px`,
        width: `${thickness}px`,
        height: `${gutter.extent.height * innerHeight()}px`,
      };
    }
    return {
      left: `${padding + gutter.extent.left * innerWidth()}px`,
      top: `${padding + gutter.rect.top * innerHeight() - thickness / 2}px`,
      width: `${gutter.extent.width * innerWidth()}px`,
      height: `${thickness}px`,
    };
  };

  const begin = (gutter: GutterInfo, event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const { splitKey, index, dir, extent } = gutter;
    const vertical = dir === 'row';
    const box = props.area().getBoundingClientRect();
    const extStart = vertical ? extent.left : extent.top;
    const extLength = vertical ? extent.width : extent.height;
    const perpStart = vertical ? extent.top : extent.left;
    const perpLength = vertical ? extent.height : extent.width;
    const inner = () => (vertical ? innerWidth() : innerHeight());
    const perpInner = () => (vertical ? innerHeight() : innerWidth());
    // Keep the pointer's offset from the handle so grabbing it does not jump it.
    const startLocal = vertical ? event.clientX - box.left : event.clientY - box.top;
    const grab = startLocal - (padding + (vertical ? gutter.rect.left : gutter.rect.top) * inner());
    document.body.classList.add(vertical ? 'resizing-x' : 'resizing-y');

    const move = (moveEvent: PointerEvent) => {
      const pointer = vertical ? moveEvent.clientX - box.left : moveEvent.clientY - box.top;
      let at = pointer - grab;
      let guide: ResizeState['guide'];
      if (feature('layout.snapGutters') && !moveEvent.altKey) {
        const candidates: { pos: number; from?: GutterInfo }[] = snapRatios.map(ratio => ({ pos: extStart + ratio * extLength }));
        for (const other of props.list()) {
          if (other.dir !== dir || (other.splitKey === splitKey && other.index === index)) continue;
          const pos = vertical ? other.rect.left : other.rect.top;
          if (pos > extStart && pos < extStart + extLength) candidates.push({ pos, from: other });
        }
        let best: { px: number; from?: GutterInfo } | undefined;
        let bestDistance = snapRange;
        for (const candidate of candidates) {
          const px = padding + candidate.pos * inner();
          const distance = Math.abs(px - pointer + grab);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = { px, from: candidate.from };
          }
        }
        if (best) {
          at = best.px;
          // A snap onto another split's handle draws the guide across both splits.
          const from = best.from;
          const fromStart = from ? (vertical ? from.extent.top : from.extent.left) : perpStart;
          const fromEnd = from ? fromStart + (vertical ? from.extent.height : from.extent.width) : perpStart + perpLength;
          const spanStart = Math.min(perpStart, fromStart);
          const spanEnd = Math.max(perpStart + perpLength, fromEnd);
          guide = {
            vertical,
            pos: best.px,
            start: padding + spanStart * perpInner(),
            length: (spanEnd - spanStart) * perpInner(),
          };
        }
      }
      const boundary = (at - padding) / inner();
      resizeSplit(splitKey, index, (boundary - extStart) / extLength);

      const current = props.list().find(item => item.splitKey === splitKey && item.index === index);
      const within = (pos: number) => (pos - extStart) / extLength;
      const handleAt = current ? within(vertical ? current.rect.left : current.rect.top) : (boundary - extStart) / extLength;
      const sibling = (position: number, fallback: number) => {
        const item = props.list().find(other => other.splitKey === splitKey && other.index === position);
        return item ? within(vertical ? item.rect.left : item.rect.top) : fallback;
      };
      const before = sibling(index - 1, 0);
      const after = sibling(index + 1, 1);
      props.setResize({
        pointerX: moveEvent.clientX - box.left,
        pointerY: moveEvent.clientY - box.top,
        percents: [Math.round((handleAt - before) * 100), Math.round((after - handleAt) * 100)],
        guide,
      });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing-x', 'resizing-y');
      props.setResize(undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return (
    <Show when={!props.hidden}>
      <Index each={props.list()}>
        {gutter => (
          <div
            class="gutter"
            classList={{ 'gutter-vertical': gutter().dir === 'row', 'gutter-horizontal': gutter().dir === 'col' }}
            style={style(gutter())}
            onPointerDown={event => begin(gutter(), event)}
            onDblClick={() => equalize(gutter().splitKey)}
          />
        )}
      </Index>
    </Show>
  );
}
