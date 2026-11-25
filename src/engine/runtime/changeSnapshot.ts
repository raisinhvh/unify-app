/**
 * Content fingerprints of workspace files, taken before and after an agent runs, so the files it changed can be
 * named even when its edits never passed through an approval or an edit row (shell commands, auto-approved writes).
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Directories a walk does not descend into. */
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist']);
/** Upper bound on the files one snapshot fingerprints. */
const MAX_FILES = 5000;

/** Workspace-relative, forward-slash path. Entries that resolve outside the root are rejected. */
function normalize(root: string, raw: string): string | undefined {
  const rel = raw.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!rel || isAbsolute(rel)) return undefined;
  const inside = relative(root, resolve(root, rel)).replaceAll('\\', '/');
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return undefined;
  return rel.endsWith('/') ? `${inside}/` : inside;
}

async function fingerprint(root: string, rel: string): Promise<string> {
  try {
    const content = await readFile(join(root, rel));
    return createHash('sha1').update(content).digest('hex');
  } catch {
    return '';
  }
}

/** Adds every file under a directory (not following symlinks), up to the cap. */
async function walk(root: string, dir: string, out: Set<string>): Promise<void> {
  if (out.size >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.size >= MAX_FILES) return;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) await walk(root, rel, out);
    } else if (entry.isFile()) {
      out.add(rel);
    }
  }
}

/** Files fingerprinted at once; reading them one by one made a folder snapshot about 4x slower. */
const HASH_CONCURRENCY = 32;

/**
 * Fingerprints each path: a file gets the sha1 of its content, a missing file the '' marker, and a path ending in '/'
 * is walked recursively. Paths outside `root` are ignored.
 */
export async function snapshotFiles(root: string, paths: string[]): Promise<Map<string, string>> {
  // Listing stays sequential so the cap keeps the same files every time; only the reads run in parallel.
  const files = new Set<string>();
  for (const raw of paths) {
    const rel = normalize(root, raw);
    if (!rel) continue;
    if (rel.endsWith('/')) {
      await walk(root, rel.slice(0, -1), files);
    } else if (files.size < MAX_FILES) {
      files.add(rel);
    }
    if (files.size >= MAX_FILES) break;
  }
  const list = [...files];
  const hashes = new Array<string>(list.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < list.length) {
      const index = next++;
      hashes[index] = await fingerprint(root, list[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, list.length) }, worker));
  return new Map(list.map((rel, index) => [rel, hashes[index]]));
}

/** The paths whose fingerprint differs between two snapshots: added, removed or changed. Sorted. */
export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter(path => (before.get(path) ?? '') !== (after.get(path) ?? ''))
    .sort();
}
