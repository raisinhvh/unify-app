/**
 * GitHub Hub registry for the public `raisinhvh/unify-hub` repository.
 *
 * This is the production source the app can opt into, but nothing here runs by default. It only reads:
 *   - `index.json` and `publishers.json` on the `main` branch,
 *   - release and pack files through the public GitHub APIs for detail and download.
 *
 * `publish` does not upload anything yet; it only checks the signed-in login against `publishers.json`.
 *
 * Every request has a timeout and responses are validated before reaching the screen. A bad registry shows an
 * error state instead of breaking the Hub.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { GithubAuth } from '../unify/github';
import { publishResultFor } from './publishing';
import { HubCategory, HubDevice, HubPack, HubPackDetail, HubPublishResult, HubRegistry, HubState } from './types';

export const HUB_REPOSITORY = 'raisinhvh/unify-hub';
export const HUB_BRANCH = 'main';
export const HUB_INDEX_URL = `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${HUB_BRANCH}/index.json`;
export const HUB_PUBLISHERS_URL = `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${HUB_BRANCH}/publishers.json`;
const HUB_API = `https://api.github.com/repos/${HUB_REPOSITORY}`;
const REQUEST_TIMEOUT = 15_000;

interface RemoteIndex {
  packs?: unknown;
  categories?: unknown;
  featured?: unknown;
  authors?: unknown;
  devices?: unknown;
}

interface RemotePublishers {
  publishers?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function count(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function validPack(value: unknown): value is HubPack {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id)) return false;
  if (typeof value.name !== 'string' || !value.name.trim()) return false;
  if (typeof value.description !== 'string') return false;
  return Array.isArray(value.tools) && value.tools.every(tool => typeof tool === 'string');
}

function validCategory(value: unknown): value is HubCategory {
  return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string';
}

function validDevice(value: unknown): value is HubDevice {
  return isRecord(value) && typeof value.id === 'string' && typeof value.label === 'string' && typeof value.current === 'boolean';
}

function normalisePack(value: HubPack): HubPack {
  return {
    ...value,
    author: text(value.author, 'unknown'),
    category: text(value.category, 'dev'),
    installs: count(value.installs),
    version: text(value.version, '1.0.0'),
    updatedAt: count(value.updatedAt),
    publishedAt: count(value.publishedAt),
    license: text(value.license, 'MIT'),
    ...(typeof value.icon === 'string' ? { icon: value.icon } : {}),
  };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    headers: { accept: 'application/json, text/plain, */*', 'user-agent': 'unify-engine' },
  });
  if (!response.ok) throw new Error(`The Hub registry answered ${response.status}.`);
  return response.text();
}

export class GithubHubRegistry implements HubRegistry {
  public readonly id = 'github';

  public async state(): Promise<HubState> {
    try {
      const index = JSON.parse(await fetchText(HUB_INDEX_URL)) as RemoteIndex;
      const packs = Array.isArray(index.packs) ? index.packs.filter(validPack).map(normalisePack) : [];
      const categories = Array.isArray(index.categories) ? index.categories.filter(validCategory) : [];
      const devices = Array.isArray(index.devices) ? index.devices.filter(validDevice) : [];
      return {
        packs,
        categories,
        featured: Array.isArray(index.featured) ? index.featured.filter((id): id is string => typeof id === 'string' && packs.some(pack => pack.id === id)) : [],
        authors: count(index.authors, new Set(packs.map(pack => pack.author)).size),
        devices: devices.length ? devices : [{ id: 'desktop', label: 'Desktop', current: true }],
        fetchedAt: Date.now(),
      };
    } catch (error) {
      return {
        packs: [],
        categories: [],
        featured: [],
        authors: 0,
        devices: [{ id: 'desktop', label: 'Desktop', current: true }],
        fetchedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async detail(id: string): Promise<HubPackDetail | undefined> {
    const pack = (await this.state()).packs.find(candidate => candidate.id === id);
    if (!pack) return undefined;
    let readme: string | undefined;
    try {
      readme = await fetchText(`https://raw.githubusercontent.com/${HUB_REPOSITORY}/${HUB_BRANCH}/packs/${encodeURIComponent(id)}/README.md`);
    } catch {
      // A pack may ship without a README.
    }
    return { pack, ...(readme ? { readme } : {}) };
  }

  public async download(id: string, destination: string): Promise<void> {
    await fsp.mkdir(destination, { recursive: true });
    const base = `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${HUB_BRANCH}/packs/${encodeURIComponent(id)}`;
    const source = await fetchText(`${base}/pack.ts`);
    await fsp.writeFile(path.join(destination, 'pack.ts'), source, 'utf8');
    for (const script of ['install.js', 'install.ps1', 'install.sh']) {
      try {
        const content = await fetchText(`${base}/${script}`);
        await fsp.writeFile(path.join(destination, script), content, 'utf8');
      } catch {
        // Install scripts are optional.
      }
    }
  }

  /** Reads the approved logins and applies the shared publishing rule. */
  public async publish(auth: GithubAuth | undefined): Promise<HubPublishResult> {
    if (!auth) return publishResultFor(auth, []);
    let publishers: string[];
    try {
      const file = JSON.parse(await fetchText(HUB_PUBLISHERS_URL)) as RemotePublishers;
      publishers = Array.isArray(file.publishers)
        ? file.publishers.filter((login): login is string => typeof login === 'string')
        : [];
    } catch (error) {
      return {
        ok: false,
        message: `Could not read the approved accounts: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return publishResultFor(auth, publishers);
  }

  /** Release metadata for one pack, for a future "what's new" view. Never used for publishing. */
  public async releases(id: string): Promise<unknown[]> {
    const response = await fetch(`${HUB_API}/releases?per_page=20`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'unify-engine' },
    });
    if (!response.ok) throw new Error(`The Hub releases API answered ${response.status}.`);
    const releases = await response.json() as unknown;
    if (!Array.isArray(releases)) return [];
    return releases.filter(release => isRecord(release) && text(release.tag_name).startsWith(`${id}@`));
  }
}
