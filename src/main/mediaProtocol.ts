/**
 * Electron side of the media store (docs/contracts/media.md).
 *
 * `unify-media://<sha256>` serves the stored original and `unify-media://<sha256>?thumb=1` its
 * 256 px webp thumbnail. The scheme is privileged, secure and read-only, so the renderer can use it
 * in `<img src>` exactly like the old relative file URLs.
 *
 * `registerMediaSchemes()` must run before `app.whenReady`; `installMediaProtocol()` after it.
 */
import { app, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DiskMediaStore, isMediaHash, mediaFilePath, readMediaIndex } from '../engine/unify/media/store';
import { unifyHome } from '../engine/unify/settings';

const MEDIA_SCHEME = 'unify-media';

// Raster images and audio/video. SVG is served too, but locked down (SVG_HEADERS): in `<img>` it can
// never run script, and opened on its own the CSP blocks script and every outside load. HTML and
// anything else is served as a download, so it can never run as an active document in the renderer.
const SAFE_IMAGE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon',
]);
const SVG_TYPE = 'image/svg+xml';
const SVG_HEADERS = {
  'content-security-policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:",
} as const;
const SAFE_MEDIA_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/flac', 'audio/aac',
]);

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': 'sandbox',
} as const;

let schemesRegistered = false;
let handlerInstalled = false;
let store: DiskMediaStore | undefined;

function mediaStore(home: string): DiskMediaStore {
  if (!store || store.home !== home) {
    store = new DiskMediaStore(home);
  }
  return store;
}

function isSafeImageType(mimeType: string): boolean {
  const type = (mimeType || '').split(';')[0].trim().toLowerCase();
  return SAFE_IMAGE_TYPES.has(type);
}

/** A fresh response per request: a Response body can only be consumed once. */
function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS },
  });
}

/** The content type to send, or undefined when the bytes must be an attachment. */
function safeContentType(mimeType: string): string | undefined {
  const type = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (SAFE_IMAGE_TYPES.has(type)) return type === 'image/jpg' ? 'image/jpeg' : type;
  if (type === SVG_TYPE) return SVG_TYPE;
  return SAFE_MEDIA_TYPES.has(type) ? type : undefined;
}

function responseFor(bytes: Buffer, mimeType: string): Response {
  const contentType = safeContentType(mimeType);
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    ...(contentType === SVG_TYPE ? SVG_HEADERS : {}),
    'content-type': contentType || 'application/octet-stream',
    'content-length': String(bytes.length),
    // Media is immutable once stored under its content hash.
    'cache-control': 'public, max-age=31536000, immutable',
  };
  if (!contentType) headers['content-disposition'] = 'attachment';
  return new Response(bytes, { status: 200, headers });
}

/** The hash from `unify-media://<hash>` (hostname) or, for odd URL forms, the first path segment. */
function hashFromRequest(request: Request): string {
  const url = new URL(request.url);
  const host = decodeURIComponent(url.hostname || '');
  if (isMediaHash(host)) return host;
  const segment = url.pathname.split('/').filter(Boolean)[0] || '';
  return decodeURIComponent(segment).toLowerCase();
}

async function serve(request: Request): Promise<Response> {
  const hash = hashFromRequest(request);
  if (!isMediaHash(hash)) return notFound();
  const home = join(unifyHome(), 'media');
  const entry = readMediaIndex(home)[hash];
  if (!entry) return notFound();
  const wantsThumbnail = new URL(request.url).searchParams.get('thumb') === '1';
  if (wantsThumbnail && isSafeImageType(entry.mimeType)) {
    // Generated lazily on first view; any thumbnail failure falls through to the original.
    const thumbnail = await mediaStore(home).ensureThumbnail(hash).catch(() => undefined);
    if (thumbnail) {
      try {
        return responseFor(await readFile(thumbnail), 'image/webp');
      } catch {
        // Fall through to serve the original stored file.
      }
    }
  }
  const path = mediaFilePath(home, entry);
  try {
    return responseFor(await readFile(path), entry.mimeType || 'application/octet-stream');
  } catch {
    return notFound();
  }
}

/** Registers the scheme as privileged. Must be called before `app.whenReady`. */
export function registerMediaSchemes(): void {
  if (schemesRegistered) return;
  schemesRegistered = true;
  protocol.registerSchemesAsPrivileged([{
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  }]);
}

/** Installs the request handler. Must be called after `app.whenReady`. */
export function installMediaProtocol(): void {
  if (handlerInstalled) return;
  if (!app.isReady()) throw new Error('installMediaProtocol() must run after app.whenReady.');
  handlerInstalled = true;
  protocol.handle(MEDIA_SCHEME, request => {
    // A broken disk or index must never crash the main process: answer 404 instead.
    return serve(request).catch(() => notFound());
  });
}
