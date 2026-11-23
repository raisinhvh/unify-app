/**
 * Unify's media store (docs/contracts/media.md).
 *
 * Files live under `<home>/media/<sha256[0..2]>/<sha256>.<ext>`, thumbnails under
 * `<home>/media/thumbs/<sha256>.webp`, and the index at `<home>/media/index.json`:
 * `{ [sha256]: { mimeType, bytes, width?, height?, refs: string[] } }`.
 *
 * A ref is a chat id (subagent media is referenced by its parent chat id). Bytes are deduplicated by
 * sha256, so the same screenshot sent twice is stored and displayed once. The index is written
 * atomically (temporary file + rename) and mutations are serialised, so parallel tool calls cannot
 * lose a ref.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { unifyHome } from '../settings';

export interface MediaRecord {
  hash: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
}

export interface MediaStore {
  /** Stores bytes once (dedupe by sha256) and adds `ref`. */
  put(bytes: Buffer, mimeType: string, ref: string): Promise<MediaRecord>;
  /** Same, reading a file from disk (copy, never move). */
  putFile(path: string, ref: string): Promise<MediaRecord>;
  /** Absolute path of the stored file, for runtimes that need a path (e.g. a CLI image argument). Read-only for agents. */
  pathOf(hash: string): string | undefined;
  /** Drops every ref held by a chat (chat deleted). */
  release(ref: string): Promise<void>;
  /** Deletes files with no refs. Runs on startup and after release(). */
  sweep(): Promise<number>;
}

interface IndexEntry extends MediaRecord {
  refs: string[];
}

type MediaIndex = Record<string, IndexEntry>;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Whether a string is a valid media hash, safe to turn into a file path. */
export function isMediaHash(value: string): boolean {
  return HASH_PATTERN.test(value);
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
};

const EXTENSION_MIME_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac',
  pdf: 'application/pdf',
};

/** MIME type for a file extension, with a generic binary fallback. */
export function mimeTypeForPath(path: string): string {
  return EXTENSION_MIME_TYPES[extname(path).slice(1).toLowerCase()] || 'application/octet-stream';
}

function extensionFor(mimeType: string, path?: string): string {
  const known = MIME_EXTENSIONS[mimeType.toLowerCase()];
  if (known) return known;
  const fromPath = path ? extname(path).slice(1).toLowerCase() : '';
  if (/^[a-z0-9]{1,12}$/.test(fromPath)) return fromPath;
  return 'bin';
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Width and height read from PNG, JPEG, GIF or WebP headers; undefined for other formats. */
export function imageSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString('latin1') === 'GIF') {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = bytes.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8X') {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width, height };
    }
    if (chunk === 'VP8 ' && bytes.length >= 30) {
      const width = bytes.readUInt16LE(26) & 0x3fff;
      const height = bytes.readUInt16LE(28) & 0x3fff;
      if (width && height) return { width, height };
    }
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2) return undefined;
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame && offset + 9 <= bytes.length) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return undefined;
}

/**
 * Reads `<home>/media/index.json` without touching the store class; used by the protocol handler.
 * A missing index is a silent `{}`; a corrupt one is preserved as `index.json.bad` before the next
 * write replaces it, so the broken contents can still be inspected.
 */
export function readMediaIndex(home: string): MediaIndex {
  let contents: string;
  try {
    contents = readFileSync(join(home, 'index.json'), 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const badPath = join(home, 'index.json.bad');
    try {
      renameSync(join(home, 'index.json'), badPath);
    } catch {
      // Best effort: even if the rename fails, keep serving an empty index instead of crashing.
    }
    console.warn(`[media] index.json is corrupt and was moved to ${badPath}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const index: MediaIndex = {};
  for (const [hash, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isMediaHash(hash) || !value || typeof value !== 'object') continue;
    const entry = value as Partial<IndexEntry>;
    index[hash] = {
      hash,
      mimeType: typeof entry.mimeType === 'string' ? entry.mimeType : 'application/octet-stream',
      bytes: typeof entry.bytes === 'number' ? entry.bytes : 0,
      ...(typeof entry.width === 'number' ? { width: entry.width } : {}),
      ...(typeof entry.height === 'number' ? { height: entry.height } : {}),
      refs: Array.isArray(entry.refs) ? entry.refs.filter((ref): ref is string => typeof ref === 'string') : [],
    };
  }
  return index;
}

/** Absolute path of a stored file, from an index entry. */
export function mediaFilePath(home: string, entry: { hash: string; mimeType: string }): string {
  const extension = extensionFor(entry.mimeType) || 'bin';
  return join(home, entry.hash.slice(0, 2), `${entry.hash}.${extension}`);
}

/** Thumbnail path for a hash, whether or not it exists yet. */
export function mediaThumbnailPath(home: string, hash: string): string {
  return join(home, 'thumbs', `${hash}.webp`);
}

type SharpModule = {
  (input: Buffer | string): {
    metadata(): Promise<{ width?: number; height?: number; format?: string }>;
    resize(options: { width: number; height: number; fit: 'inside'; withoutEnlargement: boolean }): {
      png(): { toBuffer(): Promise<Buffer> };
      jpeg(options: { quality: number }): { toBuffer(): Promise<Buffer> };
      webp(options: { quality: number }): { toBuffer(): Promise<Buffer> };
      toBuffer(): Promise<Buffer>;
    };
    toBuffer(): Promise<Buffer>;
  };
};

let sharpModule: SharpModule | null | undefined;

/**
 * The engine's `@deepseek-ai/dsh` runtime already ships `sharp` (through its attachment plugin), so
 * thumbnails and downscaled agent copies use it without adding a dependency. Loading is lazy and
 * guarded: if it is missing, callers fall back to the original image instead of failing a turn.
 */
function loadSharp(): SharpModule | undefined {
  if (sharpModule !== undefined) return sharpModule || undefined;
  try {
    const moduleRequire = createRequire(__filename);
    sharpModule = moduleRequire('sharp') as SharpModule;
  } catch {
    sharpModule = null;
  }
  return sharpModule || undefined;
}

export class DiskMediaStore implements MediaStore {
  public readonly home: string;
  private indexCache?: MediaIndex;
  /** Serialises index mutations so two tool calls adding refs cannot overwrite each other. */
  private mutation: Promise<unknown> = Promise.resolve();

  public constructor(home: string = join(unifyHome(), 'media')) {
    this.home = home;
  }

  private get indexPath(): string {
    return join(this.home, 'index.json');
  }

  private async load(): Promise<MediaIndex> {
    if (!this.indexCache) this.indexCache = readMediaIndex(this.home);
    return this.indexCache;
  }

  private async writeIndex(index: MediaIndex): Promise<void> {
    await mkdir(this.home, { recursive: true });
    const temporary = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(index, null, 2));
    await rename(temporary, this.indexPath);
  }

  private queueMutation<T>(action: (index: MediaIndex) => Promise<T> | T): Promise<T> {
    const run = this.mutation.then(async () => {
      const index = await this.load();
      const result = await action(index);
      await this.writeIndex(index);
      return result;
    });
    this.mutation = run.catch(() => undefined);
    return run;
  }

  public async put(bytes: Buffer, mimeType: string, ref: string): Promise<MediaRecord> {
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('Cannot store an empty file.');
    if (!ref) throw new Error('Media needs a chat reference.');
    const hash = sha256(bytes);
    const extension = extensionFor(mimeType);
    const path = join(this.home, hash.slice(0, 2), `${hash}.${extension}`);
    const size = imageSize(bytes);
    const record: MediaRecord = {
      hash,
      mimeType,
      bytes: bytes.length,
      ...(size ? { width: size.width, height: size.height } : {}),
    };
    // The file write belongs in the same queued mutation as the index update: otherwise a release()
    // queued in between could delete the file and let this put() re-add an entry with no bytes.
    await this.queueMutation(async index => {
      await mkdir(dirname(path), { recursive: true });
      if (!existsSync(path)) {
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, bytes);
        await rename(temporary, path);
      }
      const entry = index[hash];
      if (entry) {
        if (!entry.refs.includes(ref)) entry.refs.push(ref);
        if (!entry.width && record.width) entry.width = record.width;
        if (!entry.height && record.height) entry.height = record.height;
      } else {
        index[hash] = { ...record, refs: [ref] };
      }
    });
    return record;
  }

  public async putFile(path: string, ref: string): Promise<MediaRecord> {
    const bytes = await readFile(path);
    return this.put(bytes, mimeTypeForPath(path), ref);
  }

  public pathOf(hash: string): string | undefined {
    if (!isMediaHash(hash)) return undefined;
    const index = this.indexCache || readMediaIndex(this.home);
    this.indexCache = index;
    const entry = index[hash];
    return entry ? mediaFilePath(this.home, entry) : undefined;
  }

  /** The stored record for a hash, so callers can emit the MIME type and dimensions. */
  public recordOf(hash: string): MediaRecord | undefined {
    if (!isMediaHash(hash)) return undefined;
    const entry = (this.indexCache || readMediaIndex(this.home))[hash];
    if (!entry) return undefined;
    return {
      hash: entry.hash,
      mimeType: entry.mimeType,
      bytes: entry.bytes,
      ...(entry.width !== undefined ? { width: entry.width } : {}),
      ...(entry.height !== undefined ? { height: entry.height } : {}),
    };
  }

  public async release(ref: string): Promise<void> {
    // Drop entries and delete their files inside one queued mutation. put() runs under the same
    // lock, so a re-reference cannot land between the index removal and the file deletion.
    await this.queueMutation(async index => {
      const emptied: string[] = [];
      for (const [hash, entry] of Object.entries(index)) {
        entry.refs = entry.refs.filter(item => item !== ref);
        if (!entry.refs.length) {
          delete index[hash];
          emptied.push(hash);
        }
      }
      await this.removeFiles(emptied);
    });
    // Also cleans unreferenced leftovers from earlier releases that crashed before deleting.
    await this.sweep();
  }

  /** Deletes files with no refs. Runs on startup and after release(). */
  public async sweep(): Promise<number> {
    return this.queueMutation(async index => {
      const hashes = Object.keys(index).filter(hash => !index[hash].refs.length);
      for (const hash of hashes) delete index[hash];
      await this.removeFiles(hashes);
      return hashes.length;
    });
  }

  /** Deletes every stored file and thumbnail for hashes whose last reference was dropped. */
  private async removeFiles(hashes: string[]): Promise<void> {
    for (const hash of hashes) {
      for (const path of this.filesForHash(hash)) await rm(path, { force: true }).catch(() => undefined);
      await rm(mediaThumbnailPath(this.home, hash), { force: true }).catch(() => undefined);
    }
  }

  /** Every stored file for a hash, found by scanning its shard, however it was named. */
  private filesForHash(hash: string): string[] {
    const shard = join(this.home, hash.slice(0, 2));
    try {
      return readdirSync(shard).filter(name => name.startsWith(hash)).map(name => join(shard, name));
    } catch {
      return [];
    }
  }

  /**
   * Creates the 256 px webp thumbnail on first use, atomically. Returns undefined when untrusted
   * encoders are unavailable, so the protocol can serve the original instead of failing.
   */
  public async ensureThumbnail(hash: string): Promise<string | undefined> {
    if (!isMediaHash(hash)) return undefined;
    const target = mediaThumbnailPath(this.home, hash);
    if (existsSync(target)) return target;
    const source = this.pathOf(hash);
    if (!source) return undefined;
    const sharp = loadSharp();
    if (!sharp) return undefined;
    try {
      const bytes = await sharp(source)
        .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, target);
      return target;
    } catch {
      return undefined;
    }
  }

  /**
   * The image as the model should receive it: over 1568 px on the long side is downscaled, while the
   * store keeps the original. Without sharp (or for non-images) the stored bytes are returned as is.
   */
  public async agentImage(hash: string, maxSide = 1568): Promise<{ data: string; mimeType: string } | undefined> {
    const record = this.recordOf(hash);
    const path = this.pathOf(hash);
    if (!record || !path) return undefined;
    const tooLarge = !!record.width && !!record.height && Math.max(record.width, record.height) > maxSide;
    if (!tooLarge || !record.mimeType.startsWith('image/')) {
      return { data: (await readFile(path)).toString('base64'), mimeType: record.mimeType };
    }
    const sharp = loadSharp();
    if (!sharp) return { data: (await readFile(path)).toString('base64'), mimeType: record.mimeType };
    try {
      const pipeline = sharp(path).resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
      let bytes: Buffer;
      if (record.mimeType === 'image/png') bytes = await pipeline.png().toBuffer();
      else if (record.mimeType === 'image/webp') bytes = await pipeline.webp({ quality: 85 }).toBuffer();
      else if (record.mimeType === 'image/jpeg') bytes = await pipeline.jpeg({ quality: 85 }).toBuffer();
      else bytes = await pipeline.jpeg({ quality: 85 }).toBuffer();
      const mimeType = record.mimeType === 'image/png' ? 'image/png' : record.mimeType === 'image/webp' ? 'image/webp' : 'image/jpeg';
      return { data: bytes.toString('base64'), mimeType };
    } catch {
      return { data: (await readFile(path)).toString('base64'), mimeType: record.mimeType };
    }
  }
}
