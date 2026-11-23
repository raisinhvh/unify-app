/**
 * Media helpers shared by thumbnails, in-place expansion and the full viewer (docs/contracts/media.md).
 *
 *   mediaKey(media)       the media store sha256 (from `hash`, else parsed from `unify-media://<hash>`), else the file
 *   thumbSource(media)    `unify-media://<hash>?thumb=1` for stored media; anything else (mock files) is used as is
 *   onEscape(active, fn)  Esc closes the topmost expanded image; the viewer swallows Esc while it is open
 */
import { createEffect, onCleanup } from 'solid-js';
import type { SidebarMedia } from '../../protocol';

/** The engine's SidebarMedia carries the contract's `hash`, `width` and `height`, all optional. */
export type MediaItem = SidebarMedia;

const storedMediaPattern = /^unify-media:\/\/([0-9a-f]{64})/i;

export function mediaKey(media: MediaItem): string {
  if (media.hash) {
    return media.hash.toLowerCase();
  }
  const match = storedMediaPattern.exec(media.file);
  return match ? match[1].toLowerCase() : media.file;
}

export function isImage(media: MediaItem): boolean {
  return media.mimeType.startsWith('image/');
}

export function thumbSource(media: MediaItem): string {
  if (!media.file.startsWith('unify-media:')) {
    return media.file;
  }
  const separator = media.file.includes('?') ? '&' : '?';
  return `${media.file}${separator}thumb=1`;
}

/** Keeps the first of each image (by mediaKey), in order, and drops keys in `exclude`. */
export function uniqueMedia(items: MediaItem[], exclude?: ReadonlySet<string>): MediaItem[] {
  const seen = new Set<string>();
  const result: MediaItem[] = [];
  for (const media of items) {
    const key = mediaKey(media);
    if (seen.has(key) || exclude?.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(media);
  }
  return result;
}

/** Width over height: the loaded thumbnail's real shape first, then the stored size, then 4:3. */
export function aspectOf(media: MediaItem, image?: HTMLImageElement | null): number {
  if (image && image.naturalWidth && image.naturalHeight) {
    return image.naturalWidth / image.naturalHeight;
  }
  if (media.width && media.height) {
    return media.width / media.height;
  }
  return 4 / 3;
}

/** While `active()` is true, Esc calls `close`. */
export function onEscape(active: () => boolean, close: () => void): void {
  createEffect(() => {
    if (!active()) {
      return;
    }
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };
    document.addEventListener('keydown', listener);
    onCleanup(() => document.removeEventListener('keydown', listener));
  });
}
