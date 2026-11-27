import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../runtime/dependencies';
import type { LocalEngineInstall, LocalEngineKind } from './types';

const STALL_TIMEOUT = 60_000;
const SEARCH_DEPTH = 4;

/** One downloadable file of a GitHub release. */
export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
  /** 'sha256:<hex>' when GitHub provides it. */
  digest?: string;
}

export interface PlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  hasNvidia: boolean;
}

/** What to download: the main file plus extra archives unpacked into the same folder. */
export interface AssetPick {
  main: ReleaseAsset;
  extras: ReleaseAsset[];
}

const REPOS: Partial<Record<LocalEngineKind, string>> = {
  'llama-cpp': 'ggml-org/llama.cpp',
  koboldcpp: 'LostRuins/koboldcpp',
  ollama: 'ollama/ollama',
};

const LABELS: Partial<Record<LocalEngineKind, string>> = {
  'llama-cpp': 'llama.cpp',
  koboldcpp: 'KoboldCpp',
  ollama: 'Ollama',
};

export function defaultEngineRoot(kind: LocalEngineKind, home = join(homedir(), '.unify')): string {
  return join(home, 'local-inference', 'engines', kind);
}

function describeAssets(assets: ReleaseAsset[]): string {
  return assets.map(asset => asset.name).join(', ') || '(none)';
}

function findFirst(assets: ReleaseAsset[], patterns: RegExp[]): ReleaseAsset | undefined {
  for (const pattern of patterns) {
    const found = assets.find(asset => pattern.test(asset.name));
    if (found) return found;
  }
  return undefined;
}

function versionParts(name: string, pattern: RegExp): number[] {
  const match = pattern.exec(name);
  return match ? match[1].split('.').map(Number) : [];
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The CUDA build with the highest version, plus its matching runtime archive. */
function pickWindowsCuda(assets: ReleaseAsset[]): AssetPick | undefined {
  const builds = assets
    .filter(asset => /bin-win-cuda-[\d.]+-x64\.zip$/.test(asset.name) && !/^cudart/.test(asset.name))
    .sort((a, b) => compareVersions(
      versionParts(b.name, /bin-win-cuda-([\d.]+)-x64/),
      versionParts(a.name, /bin-win-cuda-([\d.]+)-x64/),
    ));
  const main = builds[0];
  if (!main) return undefined;
  const version = /bin-win-cuda-([\d.]+)-x64/.exec(main.name)?.[1] ?? '';
  const runtime = assets.find(asset => asset.name === `cudart-llama-bin-win-cuda-${version}-x64.zip`);
  return { main, extras: runtime ? [runtime] : [] };
}

function pickLlama(assets: ReleaseAsset[], info: PlatformInfo): AssetPick | undefined {
  const { platform, arch, hasNvidia } = info;
  if (platform === 'win32') {
    if (arch === 'arm64') {
      const main = findFirst(assets, [/bin-win-cpu-arm64.*\.zip$/]);
      return main ? { main, extras: [] } : undefined;
    }
    if (hasNvidia) {
      const cuda = pickWindowsCuda(assets);
      if (cuda) return cuda;
    }
    const main = findFirst(assets, [/bin-win-vulkan-x64\.zip$/, /bin-win-cpu-x64\.zip$/]);
    return main ? { main, extras: [] } : undefined;
  }
  if (platform === 'darwin') {
    const pattern = arch === 'arm64' ? /bin-macos-arm64\.(zip|tar\.gz)$/ : /bin-macos-x64\.(zip|tar\.gz)$/;
    const main = findFirst(assets, [pattern]);
    return main ? { main, extras: [] } : undefined;
  }
  const main = findFirst(assets, [/bin-ubuntu-vulkan-x64\.(zip|tar\.gz)$/, /bin-ubuntu-x64\.(zip|tar\.gz)$/]);
  return main ? { main, extras: [] } : undefined;
}

function pickKobold(assets: ReleaseAsset[], info: PlatformInfo): AssetPick | undefined {
  const { platform, arch, hasNvidia } = info;
  let names: string[];
  if (platform === 'win32') names = hasNvidia ? ['koboldcpp.exe', 'koboldcpp_nocuda.exe'] : ['koboldcpp_nocuda.exe', 'koboldcpp.exe'];
  else if (platform === 'darwin') names = arch === 'arm64' ? ['koboldcpp-mac-arm64'] : [];
  else names = hasNvidia ? ['koboldcpp-linux-x64', 'koboldcpp-linux-x64-nocuda'] : ['koboldcpp-linux-x64-nocuda', 'koboldcpp-linux-x64'];
  for (const name of names) {
    const main = assets.find(asset => asset.name === name);
    if (main) return { main, extras: [] };
  }
  return undefined;
}

function pickOllama(assets: ReleaseAsset[], info: PlatformInfo): AssetPick | undefined {
  const { platform, arch } = info;
  let patterns: RegExp[];
  if (platform === 'win32') patterns = [arch === 'arm64' ? /^ollama-windows-arm64\.zip$/ : /^ollama-windows-amd64\.zip$/];
  else if (platform === 'darwin') patterns = [/^Ollama-darwin\.zip$/];
  else patterns = [arch === 'arm64' ? /^ollama-linux-arm64\.(tgz|tar\.gz)$/ : /^ollama-linux-amd64\.(tgz|tar\.gz)$/];
  const main = findFirst(assets, patterns);
  return main ? { main, extras: [] } : undefined;
}

/** Chooses the release files for this machine. Throws, listing what exists, when nothing fits. */
export function pickAssets(kind: LocalEngineKind, assets: ReleaseAsset[], info: PlatformInfo): AssetPick {
  const pick = kind === 'llama-cpp' ? pickLlama(assets, info)
    : kind === 'koboldcpp' ? pickKobold(assets, info)
    : kind === 'ollama' ? pickOllama(assets, info)
    : undefined;
  if (!pick) {
    throw new Error(`No ${LABELS[kind] ?? kind} download matches ${info.platform}/${info.arch}. Available files: ${describeAssets(assets)}`);
  }
  return pick;
}

/** The file name of the engine program inside an unpacked install. */
export function binaryMatcher(kind: LocalEngineKind): (name: string) => boolean {
  if (kind === 'llama-cpp') return name => /^llama-server(\.exe)?$/i.test(name);
  if (kind === 'koboldcpp') return name => /^koboldcpp/i.test(name) && !/\.(zip|part|txt|md)$/i.test(name);
  return name => /^ollama(\.exe)?$/i.test(name);
}

/** Looks through `folder` (a few levels deep) for the engine program. */
export async function findBinary(folder: string, matches: (name: string) => boolean, depth = SEARCH_DEPTH): Promise<string | undefined> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && matches(entry.name)) return join(folder, entry.name);
  }
  if (depth <= 0) return undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findBinary(join(folder, entry.name), matches, depth - 1);
    if (found) return found;
  }
  return undefined;
}

/** True when an NVIDIA driver answers. */
export async function detectNvidia(): Promise<boolean> {
  try {
    const result = await run('nvidia-smi', ['-L'], 8000);
    return result.code === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function fetchRelease(repo: string): Promise<{ tag_name: string; assets: ReleaseAsset[] }> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'Unify', Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`Could not look up the latest ${repo} release (${response.status}).`);
  const release = await response.json() as { tag_name?: string; assets?: ReleaseAsset[] };
  if (!release.tag_name || !Array.isArray(release.assets)) throw new Error(`Unexpected release data for ${repo}.`);
  return { tag_name: release.tag_name, assets: release.assets };
}

/** Streams one asset to disk, checking its SHA-256 when the release lists one. */
async function downloadAsset(asset: ReleaseAsset, destination: string, onBytes: (count: number) => void): Promise<void> {
  const controller = new AbortController();
  let stall = setTimeout(() => controller.abort(), STALL_TIMEOUT);
  const partial = `${destination}.part`;
  try {
    const response = await fetch(asset.browser_download_url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${asset.name}`);
    const hash = createHash('sha256');
    const output = createWriteStream(partial);
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(), STALL_TIMEOUT);
        hash.update(chunk);
        if (!output.write(chunk)) await new Promise<void>(resolve => output.once('drain', () => resolve()));
        onBytes(chunk.length);
      }
    } finally {
      await new Promise<void>(resolve => output.end(() => resolve()));
    }
    const expected = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1];
    if (expected && hash.digest('hex').toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Downloaded file failed its SHA-256 check: ${asset.name}`);
    }
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    if (controller.signal.aborted) throw new Error(`Download stalled: ${asset.name}`);
    throw error;
  } finally {
    clearTimeout(stall);
  }
}

async function unpack(archive: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  let result: { code: number; stderr: string };
  if (process.platform === 'win32') {
    result = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:UNIFY_ARCHIVE -DestinationPath $env:UNIFY_DEST -Force"],
      300_000,
      { ...process.env, UNIFY_ARCHIVE: archive, UNIFY_DEST: destination },
    );
  } else if (/\.zip$/i.test(archive)) {
    result = await run('unzip', ['-o', archive, '-d', destination], 300_000);
  } else {
    result = await run('tar', ['-xzf', archive, '-C', destination], 300_000);
  }
  if (result.code !== 0) throw new Error(`Could not unpack ${archive}: ${result.stderr.slice(-500)}`);
}

function isArchive(name: string): boolean {
  return /\.(zip|tgz|tar\.gz)$/i.test(name);
}

/**
 * Downloads and unpacks the latest release of an installable engine.
 * `onProgress` gets 0..100 and a short message. Returns the program path.
 */
export async function installEngine(
  kind: LocalEngineKind,
  root: string = defaultEngineRoot(kind),
  onProgress: (percent: number, message: string) => void = () => undefined,
): Promise<LocalEngineInstall> {
  const repo = REPOS[kind];
  if (!repo) throw new Error(`${LABELS[kind] ?? kind} cannot be installed by Unify.`);
  onProgress(0, `Looking up the latest ${LABELS[kind]} release`);
  const release = await fetchRelease(repo);
  const info: PlatformInfo = { platform: process.platform, arch: process.arch, hasNvidia: await detectNvidia() };
  const pick = pickAssets(kind, release.assets, info);
  const files = [pick.main, ...pick.extras];
  const totalBytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
  const target = join(root, release.tag_name);
  const staging = `${target}.staging`;
  await mkdir(root, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  let done = 0;
  const archives: string[] = [];
  try {
    for (const file of files) {
      const destination = join(staging, file.name);
      onProgress(totalBytes ? Math.round((done / totalBytes) * 90) : 0, `Downloading ${file.name}`);
      await downloadAsset(file, destination, count => {
        done += count;
        if (totalBytes) onProgress(Math.min(90, Math.round((done / totalBytes) * 90)), `Downloading ${file.name}`);
      });
      if (isArchive(file.name)) archives.push(destination);
    }
    for (const archive of archives) {
      onProgress(92, `Unpacking ${archive.split(/[\\/]/).pop()}`);
      await unpack(archive, staging);
      await rm(archive, { force: true });
    }
    const binary = await findBinary(staging, binaryMatcher(kind));
    if (!binary) throw new Error(`The ${LABELS[kind]} download did not contain its program. Release ${release.tag_name}: ${describeAssets(files)}`);
    if (process.platform !== 'win32') await chmod(binary, 0o755);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    const relative = binary.slice(staging.length);
    const finalPath = join(target, relative);
    if (!existsSync(finalPath)) throw new Error(`Installed program is missing: ${finalPath}`);
    onProgress(100, `${LABELS[kind]} ${release.tag_name} installed`);
    return { path: finalPath, version: release.tag_name, source: 'installed' };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
