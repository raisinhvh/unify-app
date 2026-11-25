/**
 * App updater: electron-updater against the GitHub Releases of
 * `raisinhvh/unify-app`. Packaged builds only.
 *
 * Checks run 10 s after startup and then every 6 h, and download in the background. Every step is
 * published as an `AppUpdateSnapshot` (renderer: the Updates screen) so the process is always visible.
 * Nothing installs behind the user's back: the update installs only from the Updates screen's
 * "Restart and install", which shows the installer's progress window and reopens Unify when it is done.
 * (Installing silently on quit left users with a closed app that could not be reopened for minutes.)
 *
 * The renderer mirrors these types in `src/renderer/bridge.ts` (UnifyUpdatesApi).
 */
import { app } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import { spawnSync } from 'node:child_process';
import { appendLog } from '../shim/vscode/host';

const FIRST_CHECK_DELAY_MS = 10 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Lets the Updates screen show "Closing Unify…" before the window goes away. */
const INSTALL_DELAY_MS = 900;
const UNSIGNED_MAC_MESSAGE = 'Updates are not available on unsigned macOS builds.';
const DEV_BUILD_MESSAGE = 'Updates are checked in installed builds of Unify.';
const RELEASES_URL = 'https://github.com/raisinhvh/unify-app/releases';

export type AppUpdateStatus =
  | { state: 'unavailable'; message: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current' }
  | { state: 'downloading'; version: string; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { state: 'ready'; version: string }
  | { state: 'installing'; version: string }
  | { state: 'error'; message: string; detail?: string };

export interface AppUpdateRelease {
  version: string;
  /** ISO date of the release, when GitHub reports it. */
  date?: string;
  /** Release notes as plain text (GitHub sends HTML). */
  notes?: string;
  url: string;
}

export interface AppUpdateSnapshot {
  currentVersion: string;
  status: AppUpdateStatus;
  /** Epoch ms of the last finished check (up to date, found an update, or failed). */
  lastCheckedAt?: number;
  /** The release being downloaded, ready or installing. */
  release?: AppUpdateRelease;
}

export interface UpdaterOptions {
  /** OS notification; `onClick` opens the Updates screen. */
  notify(title: string, body?: string, onClick?: () => void): void;
  /** Every state change, for the renderer. */
  onChange?(snapshot: AppUpdateSnapshot): void;
  /** Bring the main window forward on the Updates screen (notification click). */
  openUpdates?(): void;
}

export interface UpdateCheckResult {
  status: 'unavailable' | 'checking' | 'error';
  message?: string;
}

export interface UpdateInstallResult {
  ok: boolean;
  message?: string;
}

let started = false;
let initialTimer: ReturnType<typeof setTimeout> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let listenersAttached = false;
let options: UpdaterOptions = { notify: () => {} };
const announced = new Set<string>();

let status: AppUpdateStatus = { state: 'idle' };
let lastCheckedAt: number | undefined;
let release: AppUpdateRelease | undefined;
/** A manual check that finds nothing new should still say "Up to date" even while a download sits ready. */
let manualCheck = false;

function log(message: string): void {
  appendLog(`updater: ${message}`, 'main');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}

export function getUpdateSnapshot(): AppUpdateSnapshot {
  return { currentVersion: currentVersion(), status, lastCheckedAt, release };
}

function publish(next: AppUpdateStatus): void {
  status = next;
  try {
    options.onChange?.(getUpdateSnapshot());
  } catch (error) {
    log(`state listener failed: ${errorText(error)}`);
  }
}

/** GitHub release bodies arrive as HTML; the Updates screen shows plain text. */
export function releaseNotesText(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (!notes) return undefined;
  const html = typeof notes === 'string' ? notes : notes.map(note => note.note ?? '').join('\n');
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(p|li|h[1-6]|ul|ol|div|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || undefined;
}

function releaseFrom(info: UpdateInfo): AppUpdateRelease {
  return {
    version: info.version,
    date: info.releaseDate || undefined,
    notes: releaseNotesText(info.releaseNotes),
    url: RELEASES_URL,
  };
}

/** Offline and rate limits are normal; say so plainly and keep the raw text as detail. */
function friendlyError(error: unknown): AppUpdateStatus {
  const detail = errorText(error);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|net::ERR_/i.test(detail)) {
    return { state: 'error', message: 'Could not reach GitHub. Check your connection and try again.', detail };
  }
  if (/\b(403|429)\b|rate limit/i.test(detail)) {
    return { state: 'error', message: 'GitHub is limiting requests right now. Try again in a few minutes.', detail };
  }
  if (/\b404\b/.test(detail)) {
    return { state: 'error', message: 'No published release was found.', detail };
  }
  return { state: 'error', message: 'The update check failed.', detail };
}

/**
 * electron-updater applies macOS updates through Squirrel, which refuses them unless the running
 * app has a real code signature (not just the ad-hoc one arm64 requires). Builds configured with
 * `identity: null` therefore cannot update, so checking would only produce errors.
 */
function macBuildIsSigned(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', app.getPath('exe')], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    return result.status === 0 && /TeamIdentifier=(?!not set)/.test(details);
  } catch {
    return false;
  }
}

function unavailableReason(): string | undefined {
  if (!app.isPackaged) return 'not a packaged build';
  if (process.platform === 'darwin' && !macBuildIsSigned()) {
    return 'unsigned macOS build; electron-updater cannot apply unsigned macOS updates';
  }
  return undefined;
}

function attachListeners(): void {
  // startUpdater runs again after stopUpdater(); keep a single set of listeners so a restart does
  // not duplicate log lines and notifications.
  if (listenersAttached) return;
  listenersAttached = true;
  autoUpdater.on('checking-for-update', () => {
    // A finished download stays on screen while the periodic check runs.
    if (status.state === 'ready' || status.state === 'downloading' || status.state === 'installing') return;
    publish({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log(`version ${info.version} is available; downloading`);
    lastCheckedAt = Date.now();
    manualCheck = false;
    if (status.state === 'ready' && release?.version === info.version) {
      publish(status);
      return;
    }
    release = releaseFrom(info);
    publish({ state: 'downloading', version: info.version, percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
  });
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    const version = release?.version ?? '';
    publish({
      state: 'downloading',
      version,
      percent: Math.max(0, Math.min(100, progress.percent)),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });
  autoUpdater.on('update-not-available', () => {
    log('up to date');
    lastCheckedAt = Date.now();
    manualCheck = false;
    if (status.state === 'ready' || status.state === 'installing') {
      publish(status);
      return;
    }
    release = undefined;
    publish({ state: 'current' });
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log(`version ${info.version} downloaded`);
    release = releaseFrom(info);
    publish({ state: 'ready', version: info.version });
    if (announced.has(info.version)) return;
    announced.add(info.version);
    options.notify(`Unify ${info.version} is ready to install`, 'Click to open Updates.', () => options.openUpdates?.());
  });
  autoUpdater.on('error', (error: Error) => {
    log(`update failed: ${errorText(error)}`);
    lastCheckedAt = Date.now();
    // A failed periodic check must not hide an update that is already downloaded, and a failed
    // installer launch goes back to "ready" so the button works again.
    if (status.state === 'installing') {
      publish({ state: 'ready', version: status.version });
      return;
    }
    if (status.state === 'ready') {
      publish(status);
      return;
    }
    manualCheck = false;
    publish(friendlyError(error));
  });
}

/** Starts the background updater. Safe to call once; reports `unavailable` outside a packaged app. */
export function startUpdater(next: UpdaterOptions): void {
  if (started) return;
  started = true;
  options = next;
  const reason = unavailableReason();
  if (reason) {
    log(`skipped: ${reason}`);
    publish({ state: 'unavailable', message: app.isPackaged ? UNSIGNED_MAC_MESSAGE : DEV_BUILD_MESSAGE });
    return;
  }

  autoUpdater.autoDownload = true;
  // Installs only from "Restart and install"; see the file comment.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: (message?: unknown) => log(String(message ?? '')),
    warn: (message?: unknown) => log(`warning: ${String(message ?? '')}`),
    error: (message?: unknown) => log(`error: ${String(message ?? '')}`),
    // Differential downloads print one debug line per block (hundreds per update).
    debug: () => {},
  };
  attachListeners();

  const check = (): void => {
    autoUpdater.checkForUpdates().catch(error => log(`check failed: ${errorText(error)}`));
  };
  initialTimer = setTimeout(() => {
    initialTimer = undefined;
    check();
  }, FIRST_CHECK_DELAY_MS);
  initialTimer.unref?.();
  timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref?.();
}

/** The Updates screen's "Check for updates" button. */
export async function checkForUpdatesNow(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) {
    return { status: 'unavailable', message: DEV_BUILD_MESSAGE };
  }
  if (process.platform === 'darwin' && !macBuildIsSigned()) {
    log('manual check skipped: unsigned macOS build');
    return { status: 'unavailable', message: UNSIGNED_MAC_MESSAGE };
  }
  if (status.state === 'downloading' || status.state === 'installing') return { status: 'checking' };
  manualCheck = true;
  if (status.state !== 'ready') publish({ state: 'checking' });
  try {
    await autoUpdater.checkForUpdates();
    return { status: 'checking' };
  } catch (error) {
    const message = errorText(error);
    log(`manual check failed: ${message}`);
    if (manualCheck && status.state === 'checking') publish(friendlyError(error));
    manualCheck = false;
    return { status: 'error', message };
  }
}

/**
 * "Restart and install": runs the downloaded installer with its window visible (progress, then a
 * Finish page that reopens Unify) and quits. Only valid once the update is downloaded.
 */
export function installUpdateNow(): UpdateInstallResult {
  if (status.state !== 'ready') {
    return { ok: false, message: 'No downloaded update to install yet.' };
  }
  const version = status.version;
  log(`installing ${version} on request`);
  publish({ state: 'installing', version });
  setTimeout(() => {
    try {
      // isSilent=false shows the installer; it relaunches Unify from its Finish page.
      autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      log(`install failed: ${errorText(error)}`);
      publish({ state: 'ready', version });
    }
  }, INSTALL_DELAY_MS);
  return { ok: true };
}

/** Stops the startup and 6-hour timers (used on shutdown and in tests). */
export function stopUpdater(): void {
  if (initialTimer) clearTimeout(initialTimer);
  initialTimer = undefined;
  if (timer) clearInterval(timer);
  timer = undefined;
  started = false;
}
