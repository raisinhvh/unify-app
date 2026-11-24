/**
 * Publishes an installed toolpack to the public `raisinhvh/unify-hub` repository as a pull request.
 *
 * Flow:
 *   1. Verify the signed-in GitHub login is listed in `publishers.json`.
 *   2. Let the user pick an installed pack from `storage/toolpacks`.
 *   3. Compile and validate `pack.ts` as a runnable toolpack, assemble its README and optional (un)install scripts,
 *      and run a safety scan for secrets, emails and absolute user paths.
 *   4. Read the current `index.json`, compute the next version, and ask the user to confirm the exact file list.
 *   5. Create one commit on `publish/<id>-<version>` via the GitHub Git Data API (blobs, tree, commit, ref)
 *      and open a pull request against `main`.
 */
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { TOOLPACK_NAME, TOOLPACK_SYNC_FILE } from '../toolpacks/types';
import type { GithubAuth } from '../unify/github';
import { publishAccessError, PUBLISH_SIGNED_OUT } from './publishing';
import { PACK_SCRIPT_NAMES } from './scripts';
import { HubPack, HubPickItem, HubPublishOptions, HubPublishResult } from './types';

export const HUB_REPOSITORY = 'raisinhvh/unify-hub';
export const HUB_BRANCH = 'main';
export const HUB_PUBLISHERS_URL = `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${HUB_BRANCH}/publishers.json`;
const REQUEST_TIMEOUT = 15_000;
const SCRIPT_NAMES = PACK_SCRIPT_NAMES;
const HUB_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export interface PublishHubPackOptions extends HubPublishOptions {
  repository?: string;
  branch?: string;
  publishersUrl?: string;
}

export interface SafetyFinding {
  file: string;
  line: number;
  type: string;
}

export interface ValidatedToolpack {
  name: string;
  description: string;
  version?: string;
  tools: { name: string; description: string }[];
}

interface PackMeta {
  name?: string;
  description?: string;
  hubId?: string;
  version?: string;
  category?: string;
  icon?: string;
  license?: string;
}

interface InstalledCandidate {
  folderName: string;
  folderPath: string;
  meta: PackMeta;
}

interface UploadFile {
  name: string;
  repoPath: string;
  content: string;
}

interface RemotePublishers {
  publishers?: unknown;
}

interface RemoteIndexDocument {
  packs?: unknown;
  categories?: unknown;
  featured?: unknown;
  authors?: unknown;
  [key: string]: unknown;
}

interface SafetyRule {
  type: string;
  pattern: RegExp;
}

const SAFETY_RULES: SafetyRule[] = [
  { type: 'PEM block', pattern: /-----BEGIN [A-Z0-9 ]+-----/ },
  { type: 'API key or token (sk-)', pattern: /\bsk-[A-Za-z0-9_-]{10,}/ },
  { type: 'GitHub token (ghp_)', pattern: /\bghp_[A-Za-z0-9]{10,}\b/ },
  { type: 'GitHub token (gho_)', pattern: /\bgho_[A-Za-z0-9]{10,}\b/ },
  { type: 'GitHub token (github_pat_)', pattern: /\bgithub_pat_[A-Za-z0-9_]{10,}\b/ },
  { type: 'Slack token (xox)', pattern: /\bxox[a-zA-Z]-[A-Za-z0-9-]{8,}\b/ },
  { type: 'AWS access key (AKIA)', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { type: 'Google API key (AIza)', pattern: /\bAIza[0-9A-Za-z_-]{16,}\b/ },
  { type: 'email address', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { type: 'absolute user path', pattern: /[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)/i },
  { type: 'absolute user path', pattern: /(?:^|[\s"'`(=:,])\/Users\// },
  { type: 'absolute user path', pattern: /(?:^|[\s"'`(=:,])\/home\// },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function titleFromId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

function compareSemver(a: string, b: string): number {
  const left = SEMVER_PATTERN.exec(a);
  const right = SEMVER_PATTERN.exec(b);
  if (!left || !right) return 0;
  for (let index = 1; index <= 3; index++) {
    const diff = Number(left[index]) - Number(right[index]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function bumpPatch(version: string): string {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) return '1.0.1';
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** Chooses the version to publish from `pack.ts`, `meta.json`, and any existing entry in `index.json`. */
export function nextPackVersion(options: {
  metaVersion?: string;
  packVersion?: string;
  existingVersion?: string;
}): string {
  const packVer = options.packVersion && SEMVER_PATTERN.test(options.packVersion) ? options.packVersion : undefined;
  const metaVer = options.metaVersion && SEMVER_PATTERN.test(options.metaVersion) ? options.metaVersion : undefined;
  const existingVer = options.existingVersion && SEMVER_PATTERN.test(options.existingVersion)
    ? options.existingVersion
    : undefined;
  const localVer = packVer ?? metaVer;
  if (!existingVer) return localVer ?? '1.0.0';
  if (localVer && compareSemver(localVer, existingVer) > 0) return localVer;
  return bumpPatch(existingVer);
}

/** Scans candidate upload files line by line for secrets, emails and personal file paths. */
export function scanPublishFiles(files: { name: string; content: string }[]): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      for (const rule of SAFETY_RULES) {
        if (rule.pattern.test(line)) {
          findings.push({ file: file.name, line: index + 1, type: rule.type });
          break;
        }
      }
    }
  }
  return findings;
}

/** Compiles `pack.ts` with esbuild and validates its default export the same way the toolpack worker does. */
export async function validateToolpackSource(
  source: string,
  sourcePath: string,
): Promise<ValidatedToolpack> {
  if (!source.trim()) throw new Error('The pack.ts file is empty.');
  const esbuild = await import('esbuild');
  const transformed = await esbuild.transform(source, { loader: 'ts', format: 'cjs', target: 'node20' });
  const absolutePath = path.resolve(sourcePath);
  const mod: { exports: unknown } = { exports: {} };
  const localRequire = createRequire(absolutePath);
  const wrapper = `(function (exports, require, module, __filename, __dirname) {\n${transformed.code}\n})`;
  const runner = vm.runInThisContext(wrapper, { filename: absolutePath, timeout: 10_000 }) as (
    exports: unknown,
    require: NodeRequire,
    module: { exports: unknown },
    filename: string,
    dirname: string,
  ) => void;
  runner(mod.exports, localRequire, mod, absolutePath, path.dirname(absolutePath));

  const exported = mod.exports as { default?: unknown } | undefined;
  const candidate = (exported && typeof exported === 'object' && 'default' in exported
    ? exported.default
    : undefined) as Record<string, unknown> | undefined;
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('The script must `export default` a toolpack object.');
  }
  if (typeof candidate.name !== 'string' || !TOOLPACK_NAME.test(candidate.name)) {
    throw new Error('Toolpack "name" must be lowercase letters, digits or _ and start with a letter.');
  }
  if (typeof candidate.description !== 'string' || !candidate.description.trim()) {
    throw new Error('Toolpack "description" is required.');
  }
  if (!Array.isArray(candidate.tools) || !candidate.tools.length) {
    throw new Error('Toolpack "tools" must be a non-empty array.');
  }
  const seen = new Set<string>();
  const tools: { name: string; description: string }[] = [];
  for (const tool of candidate.tools) {
    if (!isRecord(tool) || typeof tool.name !== 'string' || !TOOLPACK_NAME.test(tool.name)) {
      throw new Error('Every tool needs a lowercase "name".');
    }
    if (seen.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}".`);
    seen.add(tool.name);
    if (typeof tool.description !== 'string' || !tool.description.trim()) {
      throw new Error(`Tool "${tool.name}" needs a description.`);
    }
    if (typeof tool.run !== 'function') {
      throw new Error(`Tool "${tool.name}" needs a run function.`);
    }
    tools.push({ name: tool.name, description: tool.description });
  }
  if (candidate.sync !== undefined) {
    const sync = candidate.sync;
    const validList = (value: unknown, max: number, check: (item: string) => boolean): boolean =>
      Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && check(item));
    if (!isRecord(sync) || !validList(sync.files, 8, item => TOOLPACK_SYNC_FILE.test(item))) {
      throw new Error('Toolpack "sync.files" must list up to 8 .json file names in dataDir.');
    }
    if (sync.secrets !== undefined && !validList(sync.secrets, 64, item => item.length > 0 && item.length <= 64)) {
      throw new Error('Toolpack "sync.secrets" must list up to 64 key names.');
    }
  }
  const version = typeof candidate.version === 'string' && candidate.version.trim()
    ? candidate.version.trim()
    : undefined;
  return {
    name: candidate.name,
    description: candidate.description.trim(),
    ...(version ? { version } : {}),
    tools,
  };
}

function generateReadme(displayName: string, pack: ValidatedToolpack): string {
  const toolLines = pack.tools.map(tool => `- \`${pack.name}_${tool.name}\` — ${tool.description}`);
  return `# ${displayName}\n\n${pack.description}\n\n## Tools\n\n${toolLines.join('\n')}\n`;
}

async function readPackMeta(folderPath: string): Promise<PackMeta> {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(folderPath, 'meta.json'), 'utf8')) as unknown;
    if (!isRecord(parsed)) return {};
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      hubId: typeof parsed.hubId === 'string' ? parsed.hubId : undefined,
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
      category: typeof parsed.category === 'string' ? parsed.category : undefined,
      icon: typeof parsed.icon === 'string' ? parsed.icon : undefined,
      license: typeof parsed.license === 'string' ? parsed.license : undefined,
    };
  } catch {
    return {};
  }
}

async function listInstalledToolpacks(toolpacksDir: string): Promise<InstalledCandidate[]> {
  if (!toolpacksDir) return [];
  let entries;
  try {
    entries = await fsp.readdir(toolpacksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: InstalledCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folderPath = path.join(toolpacksDir, entry.name);
    try {
      await fsp.access(path.join(folderPath, 'pack.ts'));
    } catch {
      continue;
    }
    const meta = await readPackMeta(folderPath);
    candidates.push({ folderName: entry.name, folderPath, meta });
  }
  candidates.sort((left, right) => left.folderName.localeCompare(right.folderName));
  return candidates;
}

function hubIdFor(validatedName: string, metaHubId?: string): string {
  if (metaHubId && HUB_ID_PATTERN.test(metaHubId)) return metaHubId;
  const converted = validatedName.toLowerCase().replace(/_/g, '-');
  if (!HUB_ID_PATTERN.test(converted)) {
    throw new Error(`Cannot derive a Hub pack id from "${validatedName}".`);
  }
  return converted;
}

async function errorMessageFromResponse(response: Response, action: string): Promise<string> {
  let detail = '';
  try {
    const raw = await response.text();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { message?: unknown };
        detail = typeof parsed.message === 'string' ? parsed.message : raw.slice(0, 200);
      } catch {
        detail = raw.slice(0, 200);
      }
    }
  } catch {
    // Keep the HTTP status message when the error body cannot be read.
  }
  return detail
    ? `Could not ${action} (HTTP ${response.status}): ${detail}`
    : `Could not ${action} (HTTP ${response.status}).`;
}

async function githubRequest(
  fetchFn: typeof fetch,
  url: string,
  token: string,
  action: string,
  options: { method?: string; body?: unknown; accept?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: options.accept ?? 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'unify-engine',
    'x-github-api-version': '2022-11-28',
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: options.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not ${action}: ${reason}`);
  }
  if (!response.ok) {
    throw new Error(await errorMessageFromResponse(response, action));
  }
  return response;
}

async function githubJson<T>(
  fetchFn: typeof fetch,
  url: string,
  token: string,
  action: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await githubRequest(fetchFn, url, token, action, options);
  return response.json() as Promise<T>;
}

async function fetchApprovedPublishers(fetchFn: typeof fetch, url: string): Promise<string[]> {
  const response = await fetchFn(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    headers: { accept: 'application/json, text/plain, */*', 'user-agent': 'unify-engine' },
  });
  if (!response.ok) throw new Error(`The Hub registry answered ${response.status}.`);
  const parsed = JSON.parse(await response.text()) as RemotePublishers;
  return Array.isArray(parsed.publishers)
    ? parsed.publishers.filter((login): login is string => typeof login === 'string')
    : [];
}

function buildUpdatedIndex(
  currentIndex: RemoteIndexDocument,
  entry: HubPack,
): RemoteIndexDocument {
  const existingPacks = Array.isArray(currentIndex.packs)
    ? currentIndex.packs.filter(isRecord) as unknown as HubPack[]
    : [];
  const nextPacks = existingPacks.slice();
  const existingPos = nextPacks.findIndex(pack => pack.id === entry.id);
  if (existingPos >= 0) nextPacks[existingPos] = entry;
  else nextPacks.push(entry);

  const authorCount = new Set(
    nextPacks.map(pack => (typeof pack.author === 'string' ? pack.author : '')).filter(Boolean),
  ).size;
  return {
    ...currentIndex,
    packs: nextPacks,
    authors: authorCount,
  };
}

/** Runs the full interactive Hub publishing flow and opens a pull request against the Hub repository. */
export async function publishHubPack(
  auth: GithubAuth | undefined,
  options: PublishHubPackOptions,
): Promise<HubPublishResult> {
  if (!auth) return { ok: false, message: PUBLISH_SIGNED_OUT };

  const fetchFn = options.fetch ?? globalThis.fetch;
  const repository = options.repository ?? HUB_REPOSITORY;
  const branch = options.branch ?? HUB_BRANCH;
  const publishersUrl = options.publishersUrl ?? HUB_PUBLISHERS_URL;
  const apiBase = `https://api.github.com/repos/${repository}`;

  let publishers: string[];
  try {
    publishers = await fetchApprovedPublishers(fetchFn, publishersUrl);
  } catch (error) {
    return {
      ok: false,
      message: `Could not read the approved accounts: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const accessError = publishAccessError(auth, publishers);
  if (accessError) return accessError;

  const candidates = await listInstalledToolpacks(options.toolpacksDir);
  if (!candidates.length) {
    return { ok: false, message: 'No installed toolpacks found to publish.' };
  }
  if (!options.pickOption) {
    return { ok: false, message: 'No picker is available to choose a toolpack.' };
  }
  const pickItems: HubPickItem[] = candidates.map(candidate => ({
    id: candidate.folderName,
    label: candidate.meta.hubId ?? candidate.folderName,
    ...(candidate.meta.version ? { description: `v${candidate.meta.version}` } : {}),
    ...(candidate.meta.description ? { detail: candidate.meta.description } : {}),
  }));
  const chosenFolder = await options.pickOption(pickItems, 'Choose an installed toolpack to publish to the Hub');
  if (!chosenFolder) return { ok: false, message: 'Publishing cancelled.' };

  const candidate = candidates.find(item => item.folderName === chosenFolder);
  if (!candidate) return { ok: false, message: `Unknown toolpack "${chosenFolder}".` };

  const packTsPath = path.join(candidate.folderPath, 'pack.ts');
  let packSource: string;
  try {
    packSource = await fsp.readFile(packTsPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      message: `Could not read pack.ts: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let validated: ValidatedToolpack;
  try {
    validated = await validateToolpackSource(packSource, packTsPath);
  } catch (error) {
    return {
      ok: false,
      message: `Pack validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let hubId: string;
  try {
    hubId = hubIdFor(validated.name, candidate.meta.hubId);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const displayName = candidate.meta.name?.trim() || titleFromId(hubId);

  let readmeContent: string | undefined;
  try {
    const existingReadme = await fsp.readFile(path.join(candidate.folderPath, 'README.md'), 'utf8');
    if (existingReadme.trim()) readmeContent = existingReadme;
  } catch {
    // Packs without a README get one generated from the validated manifest below.
  }
  if (!readmeContent) readmeContent = generateReadme(displayName, validated);

  const packFiles: UploadFile[] = [
    { name: 'pack.ts', repoPath: `packs/${hubId}/pack.ts`, content: packSource },
    { name: 'README.md', repoPath: `packs/${hubId}/README.md`, content: readmeContent },
  ];
  for (const scriptName of SCRIPT_NAMES) {
    try {
      const scriptContent = await fsp.readFile(path.join(candidate.folderPath, scriptName), 'utf8');
      packFiles.push({
        name: scriptName,
        repoPath: `packs/${hubId}/${scriptName}`,
        content: scriptContent,
      });
    } catch {
      // Install scripts are optional.
    }
  }

  const findings = scanPublishFiles(packFiles.map(file => ({ name: file.name, content: file.content })));
  if (findings.length) {
    const summary = findings
      .slice(0, 3)
      .map(finding => `${finding.file}:${finding.line} (${finding.type})`)
      .join(', ');
    const extra = findings.length > 3 ? ` (+${findings.length - 3} more)` : '';
    return { ok: false, message: `Safety scan blocked publishing: ${summary}${extra}.` };
  }

  let currentIndex: RemoteIndexDocument;
  try {
    const indexResponse = await githubRequest(
      fetchFn,
      `${apiBase}/contents/index.json?ref=${encodeURIComponent(branch)}`,
      auth.token,
      'read index.json from the Hub',
      { accept: 'application/vnd.github.raw+json' },
    );
    const parsedIndex = JSON.parse(await indexResponse.text()) as unknown;
    if (!isRecord(parsedIndex)) throw new Error('index.json is not a JSON object.');
    currentIndex = parsedIndex;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const existingEntries = Array.isArray(currentIndex.packs)
    ? currentIndex.packs.filter(isRecord) as unknown as HubPack[]
    : [];
  const existing = existingEntries.find(pack => pack.id === hubId);
  const version = nextPackVersion({
    metaVersion: candidate.meta.version,
    packVersion: validated.version,
    existingVersion: typeof existing?.version === 'string' ? existing.version : undefined,
  });

  const now = Date.now();
  const icon = candidate.meta.icon ?? (typeof existing?.icon === 'string' ? existing.icon : undefined);
  const updatedEntry: HubPack = {
    id: hubId,
    name: (typeof existing?.name === 'string' && existing.name.trim()) ? existing.name : displayName,
    author: auth.login,
    category: (typeof existing?.category === 'string' && existing.category)
      ? existing.category
      : (candidate.meta.category ?? 'dev'),
    description: validated.description,
    ...(icon ? { icon } : {}),
    installs: typeof existing?.installs === 'number' && Number.isFinite(existing.installs) ? existing.installs : 0,
    tools: validated.tools.map(tool => `${validated.name}_${tool.name}`),
    version,
    updatedAt: now,
    publishedAt: typeof existing?.publishedAt === 'number' && Number.isFinite(existing.publishedAt)
      ? existing.publishedAt
      : now,
    license: candidate.meta.license ?? (typeof existing?.license === 'string' && existing.license ? existing.license : 'MIT'),
  };

  const updatedIndex = buildUpdatedIndex(currentIndex, updatedEntry);
  const commitFiles: UploadFile[] = [
    ...packFiles,
    {
      name: 'index.json',
      repoPath: 'index.json',
      content: `${JSON.stringify(updatedIndex, null, 2)}\n`,
    },
  ];

  if (!options.confirm) {
    return { ok: false, message: 'No confirmation dialog is available to publish.' };
  }
  const publishBranch = `publish/${hubId}-${version}`;
  const confirmMessage = `Publish "${hubId}" v${version} to the Toolpack Hub?`;
  const confirmDetail = [
    `Pack: ${hubId}`,
    `Version: ${version}`,
    `Branch: ${publishBranch}`,
    'Files:',
    ...commitFiles.map(file => `  - ${file.repoPath}`),
  ].join('\n');
  const confirmed = await options.confirm(confirmMessage, confirmDetail);
  if (!confirmed) return { ok: false, message: 'Publishing cancelled.' };

  try {
    const baseRef = await githubJson<{ object?: { sha?: string } }>(
      fetchFn,
      `${apiBase}/git/ref/heads/${encodeURIComponent(branch)}`,
      auth.token,
      `read ${branch} branch ref`,
    );
    const baseCommitSha = baseRef.object?.sha;
    if (!baseCommitSha) throw new Error(`GitHub returned no commit SHA for branch "${branch}".`);

    const baseCommit = await githubJson<{ tree?: { sha?: string } }>(
      fetchFn,
      `${apiBase}/git/commits/${baseCommitSha}`,
      auth.token,
      'read base commit',
    );
    const baseTreeSha = baseCommit.tree?.sha;
    if (!baseTreeSha) throw new Error('GitHub returned no tree SHA for the base commit.');

    const treeEntries: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];
    for (const file of commitFiles) {
      const blob = await githubJson<{ sha?: string }>(
        fetchFn,
        `${apiBase}/git/blobs`,
        auth.token,
        `create blob for ${file.repoPath}`,
        { method: 'POST', body: { content: file.content, encoding: 'utf-8' } },
      );
      if (!blob.sha) throw new Error(`GitHub returned no blob SHA for ${file.repoPath}.`);
      treeEntries.push({ path: file.repoPath, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const newTree = await githubJson<{ sha?: string }>(
      fetchFn,
      `${apiBase}/git/trees`,
      auth.token,
      'create git tree',
      { method: 'POST', body: { base_tree: baseTreeSha, tree: treeEntries } },
    );
    if (!newTree.sha) throw new Error('GitHub returned no tree SHA.');

    const commitMessage = `Publish ${hubId} ${version}`;
    const newCommit = await githubJson<{ sha?: string }>(
      fetchFn,
      `${apiBase}/git/commits`,
      auth.token,
      'create commit',
      {
        method: 'POST',
        body: { message: commitMessage, tree: newTree.sha, parents: [baseCommitSha] },
      },
    );
    if (!newCommit.sha) throw new Error('GitHub returned no commit SHA.');

    await githubJson<unknown>(
      fetchFn,
      `${apiBase}/git/refs`,
      auth.token,
      `create branch ${publishBranch}`,
      { method: 'POST', body: { ref: `refs/heads/${publishBranch}`, sha: newCommit.sha } },
    );

    const prBody = [
      `Publishes toolpack \`${hubId}\` \`v${version}\` (${updatedEntry.tools.length} tools).`,
      '',
      'Files:',
      ...commitFiles.map(file => `- \`${file.repoPath}\``),
    ].join('\n');
    const pullRequest = await githubJson<{ html_url?: string }>(
      fetchFn,
      `${apiBase}/pulls`,
      auth.token,
      'open pull request',
      {
        method: 'POST',
        body: {
          title: commitMessage,
          head: publishBranch,
          base: branch,
          body: prBody,
        },
      },
    );
    if (!pullRequest.html_url) throw new Error('GitHub returned no pull request URL.');

    return {
      ok: true,
      message: 'Opened a pull request to the Hub.',
      url: pullRequest.html_url,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
