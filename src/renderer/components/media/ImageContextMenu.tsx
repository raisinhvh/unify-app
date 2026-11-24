/**
 * Right-click any image in the app (chat media, attachments, file previews) for a small menu with "Fullscreen",
 * which opens it in the full viewer (MediaViewer: the UI dims and the image grows out of where it was).
 *
 *   <ImageContextMenuHost />   mount once per window (App, Popout), beside TooltipHost
 *
 * The image is found from the right-click target: an <img>, or an element whose direct child is one (prints set
 * `pointer-events: none` on their image, so the click lands on the button around it). Stored media thumbnails
 * (`unify-media://…?thumb=1`) open at full size. Images inside the viewer itself are left alone.
 */
import { createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { Menu } from '../Menu';
import { openMediaViewer } from './MediaViewer';
import type { MediaItem } from './media';
import './media.css';

function imageAt(target: EventTarget | null): HTMLImageElement | undefined {
  if (!(target instanceof Element) || target.closest('.media-viewer-host')) {
    return undefined;
  }
  const direct = target.closest('img');
  if (direct) {
    return direct;
  }
  return target.querySelector<HTMLImageElement>(':scope > img') ?? undefined;
}

/** The full-size source: stored media drops its `thumb=1`; anything else is used as shown. */
function fullSource(image: HTMLImageElement): string {
  const source = image.currentSrc || image.src;
  if (!source.startsWith('unify-media:')) {
    return source;
  }
  return source.replace(/([?&])thumb=1(&|$)/, (_, before: string, after: string) => (after ? before : '')).replace(/[?&]$/, '');
}

function mediaFor(image: HTMLImageElement): MediaItem {
  const file = fullSource(image);
  const fromPath = decodeURIComponent(file.split(/[?#]/)[0].split(/[\\/]/).pop() || '');
  const dataMime = /^data:([^;,]+)/.exec(file)?.[1];
  return {
    name: image.alt || (file.startsWith('data:') ? 'Image' : fromPath) || 'Image',
    mimeType: dataMime || 'image/png',
    file,
  };
}

export function ImageContextMenuHost(): JSX.Element {
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [open, setOpen] = createSignal(false);
  let target: HTMLImageElement | undefined;

  /** An invisible 1px box at the pointer for the menu to hang from; a fresh one each time so it glides. */
  function placeAnchor(x: number, y: number): void {
    const element = document.createElement('div');
    element.className = 'image-context-anchor';
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    document.body.appendChild(element);
    const previous = anchor();
    setAnchor(element);
    if (previous) {
      queueMicrotask(() => previous.remove());
    }
  }

  onMount(() => {
    const onContextMenu = (event: MouseEvent) => {
      const image = imageAt(event.target);
      if (!image || !(image.currentSrc || image.src)) {
        return;
      }
      event.preventDefault();
      target = image;
      placeAnchor(event.clientX, event.clientY);
      setOpen(true);
    };
    document.addEventListener('contextmenu', onContextMenu);
    onCleanup(() => {
      document.removeEventListener('contextmenu', onContextMenu);
      anchor()?.remove();
    });
  });

  return (
    <Menu
      anchor={anchor()}
      open={open()}
      onClose={() => setOpen(false)}
      placement="bottom-start"
      items={[{ id: 'fullscreen', label: 'Fullscreen', icon: 'maximize' }]}
      highlightFirst
      onSelect={() => {
        setOpen(false);
        const image = target;
        target = undefined;
        if (!image || !image.isConnected) {
          return;
        }
        const origin = image.parentElement?.closest<HTMLElement>('.media-print') ?? image;
        openMediaViewer({ items: [mediaFor(image)], index: 0, origin: () => origin });
      }}
    />
  );
}
