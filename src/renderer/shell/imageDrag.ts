/**
 * Dragging an image out of a chat into the workspace (HTML5 drag and drop).
 *
 *   <img {...imageDragProps(() => url, () => name)} />   on any chat image (or its wrapping button)
 *   isImageDrag(event)                                    true during dragenter/dragover of such a drag
 *   readImageDrag(event)                                  the { src, title } on drop
 *
 * PaneGrid shows the same snap zones as a pane drag and calls layout.placePane({ kind: 'image', ... }, target).
 */
import type { JSX } from 'solid-js';

export const imageDragType = 'application/x-unify-image';

export interface DraggedImage {
  src: string;
  title?: string;
}

export function imageDragProps(src: () => string | undefined, title?: () => string | undefined): {
  draggable: boolean;
  onDragStart: JSX.EventHandler<HTMLElement, DragEvent>;
} {
  return {
    draggable: true,
    onDragStart: event => {
      const url = src();
      if (!url || !event.dataTransfer) return;
      const payload: DraggedImage = { src: url, title: title?.() || undefined };
      event.dataTransfer.setData(imageDragType, JSON.stringify(payload));
      event.dataTransfer.setData('text/uri-list', url);
      event.dataTransfer.effectAllowed = 'copy';
    },
  };
}

export function isImageDrag(event: DragEvent): boolean {
  return !!event.dataTransfer && [...event.dataTransfer.types].includes(imageDragType);
}

export function readImageDrag(event: DragEvent): DraggedImage | undefined {
  const raw = event.dataTransfer?.getData(imageDragType);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<DraggedImage>;
    if (typeof value.src !== 'string' || !value.src) return undefined;
    return { src: value.src, title: typeof value.title === 'string' ? value.title : undefined };
  } catch {
    return undefined;
  }
}
