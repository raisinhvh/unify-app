import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, writeJsonFile, isRecord } from '../unify/requests/state';
import type { LocalInferenceFile } from './types';

/** A fresh config with nothing set up. */
export function defaultFile(): LocalInferenceFile {
  return { version: 1, engines: {}, servers: [], presets: [], exclusive: true };
}

export function storePath(home: string): string {
  return join(home, 'local-inference.json');
}

/** Fills in anything missing so older or hand-edited files still load. */
function normalize(raw: unknown): LocalInferenceFile {
  const base = defaultFile();
  if (!isRecord(raw)) return base;
  return {
    version: 1,
    engines: isRecord(raw.engines) ? (raw.engines as LocalInferenceFile['engines']) : base.engines,
    servers: Array.isArray(raw.servers) ? (raw.servers as LocalInferenceFile['servers']) : base.servers,
    presets: Array.isArray(raw.presets) ? (raw.presets as LocalInferenceFile['presets']) : base.presets,
    exclusive: typeof raw.exclusive === 'boolean' ? raw.exclusive : base.exclusive,
  };
}

/** True when the file exists but is not valid JSON. */
function isCorrupt(file: string): boolean {
  try {
    JSON.parse(readFileSync(file, 'utf8'));
    return false;
  } catch {
    return true;
  }
}

/** Loads the config. A corrupt file is kept as `.bak` and replaced by defaults in memory. */
export function loadFile(home: string): LocalInferenceFile {
  const file = storePath(home);
  if (!existsSync(file)) return defaultFile();
  if (isCorrupt(file)) {
    try {
      copyFileSync(file, `${file}.bak`);
    } catch {
      // Keep going without a backup.
    }
    return defaultFile();
  }
  return normalize(readJsonFile<unknown>(file, undefined));
}

/** Serialized, atomic saves of the config file. */
export class LocalStore {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly home: string) {}

  load(): LocalInferenceFile {
    return loadFile(this.home);
  }

  /** Snapshots the value now and writes it after earlier saves finish. */
  save(file: LocalInferenceFile): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(file)) as LocalInferenceFile;
    const next = this.chain.then(() => writeJsonFile(storePath(this.home), snapshot));
    this.chain = next.catch(() => undefined);
    return next;
  }
}
