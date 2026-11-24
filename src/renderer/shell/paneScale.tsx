/**
 * The pane text-size rule, shared by every pane kind: a pane narrower than its full-size width keeps its
 * full-size layout and scales down to fit, so text shrinks instead of wrapping or clipping. It never scales
 * below paneMinScale (≈9.75px text); narrower than that it stays at that size and long names truncate.
 *
 *   <ScaleToWidth fullWidth={480} class="pane-chat-scale">…children laid out at ≥ 480px…</ScaleToWidth>
 *   scaleFor(width, fullWidth)   the same rule as a number (the Files tree, the terminal's font size)
 *   createElementSize()          [ref, size] from a ResizeObserver
 *
 * Users: shell/PaneContent.tsx (Files / Knowledge tree, Terminal, Source Control), screens/chats/ChatPane.tsx.
 * Styles: paneScale.css.
 */
import { createSignal, onCleanup, type Accessor, type JSX } from 'solid-js';
import './paneScale.css';

/** The smallest a pane's content shrinks to; below this it stops scaling and truncates instead. */
export const paneMinScale = 0.75;

/** Full-size widths: narrower than these, the pane's content scales down. */
export const paneFullWidth = {
  tree: 280,
  chat: 480,
  sourceControl: 360,
  terminal: 480,
} as const;

/** How much a pane `width` wide shrinks content laid out for `fullWidth` (1 when it fits, paneMinScale at most). */
export function scaleFor(width: number, fullWidth: number): number {
  if (width <= 0) return 1;
  return Math.max(paneMinScale, Math.min(1, width / fullWidth));
}

export interface ElementSize {
  width: number;
  height: number;
}

/** Tracks an element's content size. Pass the first item as `ref`. */
export function createElementSize(): [(element: HTMLElement) => void, Accessor<ElementSize>] {
  const [size, setSize] = createSignal<ElementSize>({ width: 0, height: 0 });
  let observer: ResizeObserver | undefined;
  const ref = (element: HTMLElement) => {
    observer?.disconnect();
    observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
  };
  onCleanup(() => observer?.disconnect());
  return [ref, size];
}

interface ScaleToWidthProps {
  fullWidth: number;
  class?: string;
  children: JSX.Element;
}

/**
 * Fills its parent (a flex child). Its content is a flex column laid out at the full size and zoomed down to fit
 * when the box is narrower than `fullWidth`.
 */
export function ScaleToWidth(props: ScaleToWidthProps): JSX.Element {
  const [ref, size] = createElementSize();
  const scale = () => scaleFor(size().width, props.fullWidth);
  return (
    <div class={props.class ? `pane-scale ${props.class}` : 'pane-scale'} ref={ref}>
      <div
        class="pane-scale-inner"
        style={scale() < 1 ? {
          zoom: String(scale()),
          width: `${size().width / scale()}px`,
          height: `${size().height / scale()}px`,
        } : undefined}
      >
        {props.children}
      </div>
    </div>
  );
}
