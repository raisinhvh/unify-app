/**
 * App updater: electron-updater against the GitHub Releases of
 * `raisinhvh/unify-app`. Packaged builds only; errors are logged and never
 * shown, because being offline or rate-limited is normal.
 *
 * Checks run 10 s after startup and then every 6 h. Downloads happen in the
 * background and one notification per version announces a ready update.
 */
import { app } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { spawnSync } from 'node:child_process';
import { appendLog } from '../shim/vscode/host';

const FIRST_CHECK_DELAY_MS = 10 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UNSIGNED_MAC_MESSAGE = 'Updates are not available on unsigned macOS builds.';

export interface UpdaterOptions {
  notify(title: string, body?: string): void;
}

export interface UpdateCheckResult {
  status: 'unavailable' | 'checking' | 'error';
  message?: string;
}

let started = false;
let initialTimer: ReturnType<typeof setTimeout> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let listenersAttached = false;
let notify: UpdaterOptions['notify'] = () => {};
const announced = new Set<string>();

function log(message: string): void {
  appendLog(`updater: ${message}`, 'main');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** Starts the background updater. Safe to call once; no-op outside a packaged app. */
export function startUpdater(options: UpdaterOptions): void {
  if (started) return;
  started = true;
  notify = options.notify;
  const reason = unavailableReason();
  if (reason) {
    log(`skipped: ${reason}`);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (message?: unknown) => log(String(message ?? '')),
    warn: (message?: unknown) => log(`warning: ${String(message ?? '')}`),
    error: (message?: unknown) => log(`error: ${String(message ?? '')}`),
    debug: (message?: unknown) => log(`debug: ${String(message ?? '')}`),
  };

  // startUpdater runs again after stopUpdater(); keep a single set of listeners so a restart does
  // not duplicate log lines and notifications.
  if (!listenersAttached) {
    listenersAttached = true;
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      log(`version ${info.version} is available; downloading`);
    });
    autoUpdater.on('update-not-available', () => {
      log('up to date');
    });
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      log(`version ${info.version} downloaded`);
      if (announced.has(info.version)) return;
      announced.add(info.version);
      notify(`Unify ${info.version} is ready. Restart to update.`, 'The update installs when Unify closes.');
    });
    autoUpdater.on('error', (error: Error) => {
      // A private repository or an offline machine is normal; never interrupt.
      log(`update failed: ${errorText(error)}`);
    });
  }

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

/** The Settings "Check for updates" button. */
export async function checkForUpdatesNow(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) {
    return { status: 'unavailable', message: 'Updates are checked in installed builds of Unify.' };
  }
  if (process.platform === 'darwin' && !macBuildIsSigned()) {
    log('manual check skipped: unsigned macOS build');
    return { status: 'unavailable', message: UNSIGNED_MAC_MESSAGE };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { status: 'checking' };
  } catch (error) {
    const message = errorText(error);
    log(`manual check failed: ${message}`);
    return { status: 'error', message };
  }
}

/** Stops the startup and 6-hour timers (used on shutdown and in tests). */
export function stopUpdater(): void {
  if (initialTimer) clearTimeout(initialTimer);
  initialTimer = undefined;
  if (timer) clearInterval(timer);
  timer = undefined;
  started = false;
}
