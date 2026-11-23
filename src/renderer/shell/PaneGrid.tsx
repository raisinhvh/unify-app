/**
 * The tiling chat area: lays out one PaneFrame per cell of the current layout (shell/layout.ts), the split
 * gutters between them, and the drag-to-arrange interaction:
 *
 *   hold a pane header and move → the pane lifts to 50% and follows the pointer, other panes dim, and the layout
 *   picker drops in at the top centre. Over a picker cell, the zone it would take is outlined in the real layout;
 *   over another pane, the two would swap. Release springs the pane into its zone (or back home).
 *   With feature `chats.layoutPicker` off the picker stays away; dropping on another pane still swaps.
 *
 * The area is transparent where there are no panes, so Home shows through.
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Presence, prefersReducedMotion, Spring } from '../motion';
import { feature } from '../store/features';
import {
  cellRects,
  closeChat,
  dropChat,
  focusPane,
  layout,
  presetGutters,
  setSplit,
  swapChats,
  type FractionRect,
  type PresetId,
} from './layout';
import { LayoutPicker, type PickerTarget } from './LayoutPicker';
import { PaneFrame, type PixelRect } from './Pane';
import './shell.css';

export interface PaneContext {
  chatId: string;
  cellIndex: () => number;
  focused: () => boolean;
  dragging: () => boolean;
  /** Call from a header's pointerdown: becomes a drag once the pointer moves. */
  startDrag: (event: PointerEvent) => void;
  close: () => void;
}

export interface PaneGridProps {
  renderPane: (context: PaneContext) => JSX.Element;
  /** An empty cell (after a drop into a bigger layout). */
  renderEmpty: (cellIndex: number) => JSX.Element;
}

const padding = 8;
const gap = 8;
const dragThreshold = 4;

type DropTarget = { kind: 'preset'; preset: PresetId; cell: number } | { kind: 'swap'; cell: number };

interface DragState {
  chatId: string;
  grabX: number;
  grabY: number;
  pointerX: number;
  pointerY: number;
  target?: DropTarget;
}

function toPixels(rect: FractionRect, width: number, height: number): PixelRect {
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

interface RenderedPane {
  key: string;
  chatId: string | null;
  leaving: boolean;
  lastRect: PixelRect;
}

export function PaneGrid(props: PaneGridProps): JSX.Element {
  let area!: HTMLDivElement;
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [drag, setDrag] = createSignal<DragState>();
  const [resizing, setResizing] = createSignal(false);
  // Feature chats.layoutPicker: off keeps drag-to-swap, but the picker never drops in. Read live.
  const pickerEnabled = () => feature('chats.layoutPicker');

  onMount(() => {
    const observer = new ResizeObserver(() => setSize({ width: area.clientWidth, height: area.clientHeight }));
    observer.observe(area);
    setSize({ width: area.clientWidth, height: area.clientHeight });
    onCleanup(() => observer.disconnect());
  });

  const rects = createMemo(() => {
    const { width, height } = size();
    const state = layout();
    return cellRects(state.preset, state.splits).map(rect => toPixels(rect, width, height));
  });

  // Keep panes of chats that just closed on screen until their exit finishes.
  const [rendered, setRendered] = createSignal<RenderedPane[]>([]);
  createEffect(() => {
    const cells = layout().cells;
    const pixelRects = rects();
    setRendered(previous => {
      // Reuse the item of a pane that stays: <For> keys by identity, so a fresh object would remount the pane
      // (and its chat) on every resize, e.g. each frame while the notice row opens above the grid.
      const staying = new Map(previous.filter(item => !item.leaving).map(item => [item.key, item]));
      const next: RenderedPane[] = cells.map((chatId, index) => {
        const key = chatId ?? `empty:${index}`;
        const existing = staying.get(key);
        if (existing) {
          existing.lastRect = pixelRects[index];
          return existing;
        }
        return { key, chatId, leaving: false, lastRect: pixelRects[index] };
      });
      const keys = new Set(next.map(item => item.key));
      for (const item of previous) {
        if (!keys.has(item.key) && item.chatId) next.push(item.leaving ? item : { ...item, leaving: true });
      }
      return next;
    });
  });

  const removeLeft = (key: string) => setRendered(list => list.filter(item => !(item.key === key && item.leaving)));

  const cellOf = (key: string) => layout().cells.findIndex((chatId, index) => (chatId ?? `empty:${index}`) === key);

  const hitTestTarget = (clientX: number, clientY: number, chatId: string): DropTarget | undefined => {
    // With the picker turned off (or fading out after being turned off mid-drag), only swaps are targets.
    const pickerCells = pickerEnabled() ? document.querySelectorAll<HTMLElement>('.layout-picker [data-preset][data-cell]') : [];
    for (const element of pickerCells) {
      const box = element.getBoundingClientRect();
      const slop = 2;
      if (clientX >= box.left - slop && clientX <= box.right + slop && clientY >= box.top - slop && clientY <= box.bottom + slop) {
        return { kind: 'preset', preset: element.dataset.preset as PresetId, cell: Number(element.dataset.cell) };
      }
    }
    const areaBox = area.getBoundingClientRect();
    const x = clientX - areaBox.left;
    const y = clientY - areaBox.top;
    const own = layout().cells.indexOf(chatId);
    const index = rects().findIndex(rect => x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height);
    if (index >= 0 && index !== own) return { kind: 'swap', cell: index };
    return undefined;
  };

  const startDrag = (chatId: string, event: PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select, a')) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const index = layout().cells.indexOf(chatId);
    const rect = rects()[index];
    if (!rect) return;
    const areaBox = area.getBoundingClientRect();
    const grabX = startX - areaBox.left - rect.left;
    const grabY = startY - areaBox.top - rect.top;
    let active = false;

    const move = (moveEvent: PointerEvent) => {
      if (!active) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < dragThreshold) return;
        active = true;
        document.body.classList.add('dragging-pane');
      }
      setDrag({
        chatId,
        grabX,
        grabY,
        pointerX: moveEvent.clientX - areaBox.left,
        pointerY: moveEvent.clientY - areaBox.top,
        target: hitTestTarget(moveEvent.clientX, moveEvent.clientY, chatId),
      });
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      document.body.classList.remove('dragging-pane');
      const state = drag();
      setDrag(undefined);
      if (!active || !state?.target) return;
      if (state.target.kind === 'preset') dropChat(chatId, state.target.preset, state.target.cell);
      else swapChats(chatId, state.target.cell);
    };
    const cancel = () => {
      active = false;
      finish();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  };

  // The zone the dragged pane would take, in real layout pixels.
  const zoneRect = createMemo<PixelRect | undefined>(() => {
    const target = drag()?.target;
    if (!target) return undefined;
    if (target.kind === 'swap') return rects()[target.cell];
    const { width, height } = size();
    return toPixels(cellRects(target.preset, layout().splits)[target.cell], width, height);
  });

  const pickerHover = (): PickerTarget | undefined => {
    const target = drag()?.target;
    return target?.kind === 'preset' ? { preset: target.preset, cell: target.cell } : undefined;
  };

  return (
    <div ref={area} class="pane-grid" classList={{ dragging: !!drag() }}>
      <For each={rendered()}>
        {item => {
          const cellIndex = () => cellOf(item.key);
          const rect = () => (item.leaving ? item.lastRect : rects()[cellIndex()] ?? item.lastRect);
          const isDragged = () => !!item.chatId && drag()?.chatId === item.chatId;
          const lifted = () => {
            const state = drag();
            if (!isDragged() || !state) return undefined;
            return { left: state.pointerX - state.grabX * 0.5, top: state.pointerY - state.grabY * 0.5 };
          };
          return (
            <PaneFrame
              rect={rect()}
              lifted={lifted()}
              dimmed={!!drag() && !isDragged()}
              resizing={resizing()}
              leaving={item.leaving}
              focused={!item.leaving && layout().focused === cellIndex() && layout().cells.length > 1}
              onLeft={() => removeLeft(item.key)}
              onPointerDown={() => {
                if (!item.leaving && cellIndex() >= 0) focusPane(cellIndex());
              }}
            >
              <Show when={item.chatId} fallback={props.renderEmpty(cellIndex())}>
                {chatId =>
                  props.renderPane({
                    chatId: chatId(),
                    cellIndex,
                    focused: () => layout().focused === cellIndex(),
                    dragging: isDragged,
                    startDrag: event => startDrag(chatId(), event),
                    close: () => closeChat(chatId()),
                  })
                }
              </Show>
            </PaneFrame>
          );
        }}
      </For>
      <Gutters rects={rects} size={size} onResizing={setResizing} hidden={!!drag()} />
      <DropZone rect={zoneRect()} />
      <LayoutPicker open={!!drag() && pickerEnabled()} hovered={pickerHover()} />
    </div>
  );
}

/** Outline of where the dragged pane will land; glides between zones. */
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

/** Split handles: drag to resize; the panes follow exactly while dragging. */
function Gutters(props: {
  rects: () => PixelRect[];
  size: () => { width: number; height: number };
  onResizing: (resizing: boolean) => void;
  hidden: boolean;
}): JSX.Element {
  const gutters = () => presetGutters(layout().preset);

  const begin = (axis: 'x' | 'y', event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const element = event.currentTarget as HTMLElement;
    element.setPointerCapture(event.pointerId);
    const box = (element.parentElement as HTMLElement).getBoundingClientRect();
    props.onResizing(true);
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    const move = (moveEvent: PointerEvent) => {
      const inner = axis === 'x' ? box.width - padding * 2 : box.height - padding * 2;
      const offset = axis === 'x' ? moveEvent.clientX - box.left - padding : moveEvent.clientY - box.top - padding;
      setSplit(axis, offset / inner);
    };
    const end = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', end);
      element.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing-x', 'resizing-y');
      props.onResizing(false);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', end);
  };

  const verticalLeft = () => {
    const { width } = props.size();
    return padding + layout().splits.x * (width - padding * 2) - gap / 2;
  };
  const horizontalTop = () => {
    const { height } = props.size();
    return padding + layout().splits.y * (height - padding * 2) - gap / 2;
  };
  const horizontalLeft = () => (gutters().horizontal && (gutters().horizontal as { from: string }).from === 'right' ? verticalLeft() + gap : padding);

  return (
    <Show when={!props.hidden}>
      <Show when={gutters().vertical}>
        <div
          class="gutter gutter-vertical"
          style={{ left: `${verticalLeft()}px`, top: `${padding}px`, bottom: `${padding}px`, width: `${gap}px` }}
          onPointerDown={event => begin('x', event)}
          onDblClick={() => setSplit('x', 0.5)}
        />
      </Show>
      <Show when={gutters().horizontal}>
        <div
          class="gutter gutter-horizontal"
          style={{ top: `${horizontalTop()}px`, left: `${horizontalLeft()}px`, right: `${padding}px`, height: `${gap}px` }}
          onPointerDown={event => begin('y', event)}
          onDblClick={() => setSplit('y', 0.5)}
        />
      </Show>
    </Show>
  );
}
