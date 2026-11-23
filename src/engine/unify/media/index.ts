/**
 * Unify's media store (docs/contracts/media.md): deduplicated files and the "already shown in
 * this chat" tracker. The Electron protocol handler in `src/main/mediaProtocol.ts` serves the
 * files under `unify-media://<sha256>` and its `?thumb=1` variant.
 */
export { DiskMediaStore, imageSize, isMediaHash, mediaFilePath, mediaThumbnailPath, mimeTypeForPath, readMediaIndex } from './store';
export type { MediaRecord, MediaStore } from './store';
export { createShownMediaTracker } from './shown';
export type { ShownMediaTracker } from './shown';
