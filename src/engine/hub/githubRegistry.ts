/**
 * GitHub Hub registry for the public `raisinhvh/unify-hub` repository.
 *
 * This is the Hub's only source. It reads:
 *   - `index.json` and `publishers.json` on the `main` branch,
 *   - release and pack files through the public GitHub APIs for detail and download.
 *
 * `publish` validates an installed pack, scans its files for secrets or personal paths, asks for confirmation,
 * and opens a pull request against `main` via the GitHub Git Data API.
 *
 * Every request has a timeout and responses are validated before reaching the screen. A bad registry shows an
 * error state instead of breaking the Hub.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { GithubAuth } from '../unify/github';
import { HUB_BRANCH, HUB_PUBLISHERS_URL, HUB_REPOSITORY, publishHubPack } from './publish';
import { PACK_SCRIPT_NAMES } from './scripts';
import {
  HubCategory,
  HubPack,
  HubPackDetail,
  HubPublishOptions,
  HubPublishResult,
  HubRegistry,
  HubState,
} from './types';

export { HUB_BRANCH, HUB_PUBLISHERS_URL, HUB_REPOSITORY };
export const HUB_INDEX_URL = `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${HUB_BRANCH}/index.json`;
const HUB_API = `https://api.github.com/repos/${HUB_REPOSITORY}`;
const REQUEST_TIMEOUT = 15_000;

interface RemoteIndex {
  packs?: unknown;
  categories?: unknown;
  featured?: unknown;
  authors?: unknown;
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

/** Plain file names listed in a pack's setup.json `files`; anything with a folder or reserved name is skipped. */
export function setupFileNames(setupText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(setupText);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.files)) return [];
  const reserved = new Set(['pack.ts', 'pack.js', 'meta.json', 'setup.json', ...PACK_SCRIPT_NAMES]);
  return parsed.files.filter((name): name is string =>
    typeof name === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)
    && !reserved.has(name.toLowerCase()));
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

export class GithubHubRegistry implements HubRegistry {
  public readonly id = 'github';
  private readonly fetchFn?: typeof fetch;

  public constructor(fetchFn?: typeof fetch) {
    this.fetchFn = fetchFn;
  }

  private async fetchText(url: string): Promise<string> {
    const fetchImpl = this.fetchFn ?? globalThis.fetch;
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: { accept: 'application/json, text/plain, */*', 'user-agent': 'unify-engine' },
    });
    if (!response.ok) throw new Error(`The Hub registry answered ${response.status}.`);
    return response.text();
  }

  public async state(): Promise<HubState> {
    try {
      const index = JSON.parse(await this.fetchText(HUB_INDEX_URL)) as RemoteIndex;
      const packs = Array.isArray(index.packs) ? index.packs.filter(validPack).map(normalisePack) : [];
      const categories = Array.isArray(index.categories) ? index.categories.filter(validCategory) : [];
      return {
        packs,
        categories,
        featured: Array.isArray(index.featured)
          ? index.featured.filter((id): id is string => typeof id === 'string' && packs.some(pack => pack.id === id))
          : [],
        authors: count(index.authors, new Set(packs.map(pack => pack.author)).size),
        fetchedAt: Date.now(),
      };
    } catch (error) {
      return {
        packs: [],
        categories: [],
        featured: [],
        authors: 0,
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
      readme = await this.fetchText(
        `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${HUB_BRANCH}/packs/${encodeURIComponent(id)}/README.md`,
      );
    } catch {
      // A pack may ship without a README.
    }
    return { pack, ...(readme ? { readme } : {}) };
  }

  /**
   * The Hub branch's current commit id, or the branch name when GitHub can't be asked. raw.githubusercontent.com
   * caches branch URLs for about 5 minutes, so a pack installed right after a push would get stale files; a commit
   * URL is never stale, and every file of one install comes from the same commit.
   */
  private async latestCommit(): Promise<string> {
    try {
      const fetchImpl = this.fetchFn ?? globalThis.fetch;
      const response = await fetchImpl(`${HUB_API}/commits/${HUB_BRANCH}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        headers: { accept: 'application/vnd.github.sha', 'user-agent': 'unify-engine' },
      });
      const sha = response.ok ? (await response.text()).trim() : '';
      return /^[0-9a-f]{40}$/.test(sha) ? sha : HUB_BRANCH;
    } catch {
      return HUB_BRANCH;
    }
  }

  public async download(id: string, destination: string): Promise<void> {
    await fsp.mkdir(destination, { recursive: true });
    const ref = await this.latestCommit();
    const base = `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${ref}/packs/${encodeURIComponent(id)}`;
    const source = await this.fetchText(`${base}/pack.ts`);
    await fsp.writeFile(path.join(destination, 'pack.ts'), source, 'utf8');
    for (const script of PACK_SCRIPT_NAMES) {
      try {
        const content = await this.fetchText(`${base}/${script}`);
        await fsp.writeFile(path.join(destination, script), content, 'utf8');
      } catch {
        // Install and uninstall scripts are optional.
      }
    }
    let setupText: string | undefined;
    try {
      setupText = await this.fetchText(`${base}/setup.json`);
    } catch {
      // setup.json is optional.
    }
    if (setupText === undefined) return;
    await fsp.writeFile(path.join(destination, 'setup.json'), setupText, 'utf8');
    for (const name of setupFileNames(setupText)) {
      const content = await this.fetchText(`${base}/${encodeURIComponent(name)}`);
      await fsp.writeFile(path.join(destination, name), content, 'utf8');
    }
  }

  /** Checks approval, picks and validates an installed pack, and opens a pull request to the Hub. */
  public async publish(
    auth: GithubAuth | undefined,
    options?: HubPublishOptions,
  ): Promise<HubPublishResult> {
    return publishHubPack(auth, {
      toolpacksDir: options?.toolpacksDir ?? '',
      pickOption: options?.pickOption,
      confirm: options?.confirm,
      fetch: options?.fetch ?? this.fetchFn,
    });
  }

  /** Release metadata for one pack, for a future "what's new" view. Never used for publishing. */
  public async releases(id: string): Promise<unknown[]> {
    const fetchImpl = this.fetchFn ?? globalThis.fetch;
    const response = await fetchImpl(`${HUB_API}/releases?per_page=20`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'unify-engine' },
    });
    if (!response.ok) throw new Error(`The Hub releases API answered ${response.status}.`);
    const releases = await response.json() as unknown;
    if (!Array.isArray(releases)) return [];
    return releases.filter(release => isRecord(release) && text(release.tag_name).startsWith(`${id}@`));
  }
}
