/**
 * App update state for the Updates screen, the rail's Updates button and Settings > About.
 *
 * The main process owns the updater (src/main/updater.ts) and pushes every change through
 * `window.unify.updates.onState`. This module keeps the latest snapshot in one signal; never copy it.
 * Clicking the "update ready" notification calls `onOpen`, which navigates to the Updates route.
 *
 * Outside Electron (the browser preview) there is no bridge: the snapshot reads `unavailable` unless a
 * preview sets one with `previewUpdateSnapshot`.
 */
import { createSignal } from 'solid-js';
import type { AppUpdateSnapshot, UnifyUpdatesApi } from '../../bridge';
import { navigate } from '../../router';

function bridgeUpdates(): UnifyUpdatesApi | undefined {
  return typeof window !== 'undefined' ? window.unify?.updates : undefined;
}

function initialSnapshot(): AppUpdateSnapshot {
  const version = typeof window !== 'undefined' ? window.unify?.appInfo?.version ?? '0.0.0' : '0.0.0';
  if (!bridgeUpdates()) {
    return { currentVersion: version, status: { state: 'unavailable', message: 'Updates are checked in installed builds of Unify.' } };
  }
  return { currentVersion: version, status: { state: 'idle' } };
}

const [updateSnapshot, setUpdateSnapshot] = createSignal<AppUpdateSnapshot>(initialSnapshot());
export { updateSnapshot };

let connected = false;

/** Subscribes once to the main process. Called at module load; safe to call again. */
export function connectUpdates(): void {
  if (connected) return;
  const updates = bridgeUpdates();
  if (!updates) return;
  connected = true;
  updates.onState(snapshot => setUpdateSnapshot(snapshot));
  updates.onOpen(() => navigate('updates'));
  void updates.state().then(snapshot => {
    if (snapshot) setUpdateSnapshot(snapshot);
  }).catch(() => undefined);
}

connectUpdates();

export function canCheckForUpdates(): boolean {
  return !!bridgeUpdates();
}

/** Starts a check; the result arrives as state changes. */
export function checkForUpdates(): void {
  const updates = bridgeUpdates();
  if (!updates) return;
  const current = updateSnapshot();
  if (current.status.state === 'idle' || current.status.state === 'current' || current.status.state === 'error') {
    setUpdateSnapshot({ ...current, status: { state: 'checking' } });
  }
  void updates.check().catch(() => undefined);
}

/** "Restart and install". Only meaningful in `ready`. */
export function installUpdate(): void {
  const updates = bridgeUpdates();
  if (!updates) return;
  void updates.install().catch(() => undefined);
}

/** True while there is something the user should see: downloading, ready or installing. */
export function updatePending(): boolean {
  const state = updateSnapshot().status.state;
  return state === 'downloading' || state === 'ready' || state === 'installing';
}

/** Browser previews only: show the screen in a given state. */
export function previewUpdateSnapshot(snapshot: AppUpdateSnapshot): void {
  setUpdateSnapshot(snapshot);
}
