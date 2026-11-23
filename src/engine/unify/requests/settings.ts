/**
 * App info and update state for Settings > About.
 *
 * The Electron shell owns installers and releases, so this module can only report the running version, the
 * shared data folder and an honest update state. `checkForUpdates` cannot reach a release server by itself:
 * it answers `current` after a short wait. `installUpdate` answers `error` and says the app installs updates.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppInfo, UpdateStatus } from './types';
import { RequestPaths } from './state';

function packageVersion(): string {
  try {
    const file = path.join(process.cwd(), 'package.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** App information for the About page; `context.version` wins over the package.json next to the app. */
export function appInfo(paths: RequestPaths, version?: string): AppInfo {
  return {
    version: version || packageVersion(),
    channel: 'stable',
    dataFolder: paths.dshHome,
    update: { state: 'idle' },
  };
}

export function appInfoReply(paths: RequestPaths, version?: string): { type: 'appInfo'; info: AppInfo } {
  return { type: 'appInfo', info: appInfo(paths, version) };
}

/** A check the shell has not wired yet: report the running version as current. */
export function updateChecked(paths: RequestPaths, version?: string): { type: 'appInfo'; info: AppInfo } {
  const info = appInfo(paths, version);
  const update: UpdateStatus = { state: 'current', checkedAt: Date.now() };
  return { type: 'appInfo', info: { ...info, update } };
}

/** Updates are installed by the app, which owns releases, signing and the updater. */
export function updateInstallUnavailable(paths: RequestPaths, version?: string): { type: 'appInfo'; info: AppInfo } {
  const info = appInfo(paths, version);
  const update: UpdateStatus = {
    state: 'error',
    message: 'Updates are installed by the app; the engine cannot install one.',
  };
  return { type: 'appInfo', info: { ...info, update } };
}
