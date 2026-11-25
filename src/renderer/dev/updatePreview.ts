/**
 * DEV ONLY. Shows the Updates screen, the rail's Updates button and Settings > About in a given updater state
 * in the browser preview, where there is no updater bridge. Loaded by mockBridge.ts when the URL has
 * `?update=<state>`:
 *
 *   ?fixture=updates&update=ready         idle | checking | current | downloading | ready | installing | error |
 *                                         unavailable (each with sample release notes where it makes sense)
 *   ?fixture=updates&update=live          checking → downloading (progress climbs) → ready, to watch the motion
 *
 *   node tools/shot.mjs "updates?update=downloading"
 */
import type { AppUpdateRelease, AppUpdateSnapshot, AppUpdateStatus } from '../bridge';
import { bridge } from '../bridge';
import { previewUpdateSnapshot } from '../screens/updates/updateState';

const sampleRelease: AppUpdateRelease = {
  version: '1.4.0',
  date: '2026-11-20T10:00:00Z',
  url: 'https://github.com/unify-app/unify/releases/tag/v1.4.0',
  notes: [
    'Updates you can see',
    '• A new Updates screen shows what is downloading and when it is ready.',
    '• Updates install only when you press "Restart and install". Closing Unify no longer installs.',
    '• The installer shows its progress and reopens Unify when it is done.',
    '',
    'Chats',
    '• Pop-out windows remember their size and place.',
    '• Long tool output scrolls instead of stretching the pane.',
    '',
    'Fixes',
    '• Settings search finds rows by their description too.',
    '• The usage meter no longer flickers after waking from sleep.',
  ].join('\n'),
};

const totalBytes = 230 * 1024 * 1024;

const sampleStatuses: Record<string, AppUpdateStatus> = {
  idle: { state: 'idle' },
  checking: { state: 'checking' },
  current: { state: 'current' },
  downloading: {
    state: 'downloading',
    version: '1.4.0',
    percent: 5.4,
    transferred: 12.4 * 1024 * 1024,
    total: totalBytes,
    bytesPerSecond: 3.1 * 1024 * 1024,
  },
  ready: { state: 'ready', version: '1.4.0' },
  installing: { state: 'installing', version: '1.4.0' },
  error: {
    state: 'error',
    message: 'Unify could not reach GitHub to check for updates.',
    detail: 'Error: net::ERR_INTERNET_DISCONNECTED\n    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:2:114720)\n    at SimpleURLLoaderWrapper.emit (node:events:519:28)',
  },
  unavailable: { state: 'unavailable', message: 'Updates are checked in installed builds of Unify.' },
};

/** States that know about a release show its notes. */
const statesWithRelease = new Set(['downloading', 'ready', 'installing']);

function currentVersion(): string {
  return bridge().appInfo?.version ?? '1.3.0';
}

function snapshotFor(state: string): AppUpdateSnapshot | undefined {
  const status = sampleStatuses[state];
  if (!status) return undefined;
  return {
    currentVersion: currentVersion(),
    status,
    lastCheckedAt: Date.now() - 5 * 60000,
    release: statesWithRelease.has(state) ? sampleRelease : undefined,
  };
}

/** checking → downloading with a climbing percent → ready. */
function playLive(): void {
  const base = { currentVersion: currentVersion(), lastCheckedAt: Date.now() };
  previewUpdateSnapshot({ ...base, status: { state: 'checking' } });
  let percent = 0;
  window.setTimeout(() => {
    const timer = window.setInterval(() => {
      percent = Math.min(100, percent + 7 + Math.random() * 6);
      if (percent >= 100) {
        window.clearInterval(timer);
        previewUpdateSnapshot({ ...base, release: sampleRelease, status: { state: 'ready', version: sampleRelease.version } });
        return;
      }
      previewUpdateSnapshot({
        ...base,
        release: sampleRelease,
        status: {
          state: 'downloading',
          version: sampleRelease.version,
          percent,
          transferred: (percent / 100) * totalBytes,
          total: totalBytes,
          bytesPerSecond: 3.1 * 1024 * 1024,
        },
      });
    }, 600);
  }, 1500);
}

export function applyUpdatePreview(state: string): void {
  if (state === 'live') {
    playLive();
    return;
  }
  const snapshot = snapshotFor(state);
  if (snapshot) previewUpdateSnapshot(snapshot);
  else console.warn(`[mock] no update preview "${state}"; try ${Object.keys(sampleStatuses).join(', ')} or live`);
}
