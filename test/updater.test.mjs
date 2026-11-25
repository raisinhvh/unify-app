import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function makeAutoUpdater() {
  const listeners = new Map();
  let checks = 0;
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: undefined,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      return this;
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    count(event) {
      return (listeners.get(event) ?? []).length;
    },
    total() {
      return [...listeners.values()].reduce((total, list) => total + list.length, 0);
    },
    checkForUpdates() {
      checks += 1;
      return Promise.resolve(null);
    },
    installs: [],
    quitAndInstall(isSilent, isForceRunAfter) {
      this.installs.push({ isSilent, isForceRunAfter });
    },
    checks: () => checks,
  };
}

function buildUpdater(instance) {
  return build({
    entryPoints: ['src/main/updater.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    banner: { js: `/* ${instance} updater test instance */` },
    plugins: [{
      name: 'updater-stubs',
      setup(builder) {
        const stub = (filter, path) => builder.onResolve({ filter }, () => ({ path, namespace: 'stub' }));
        stub(/^electron$/, 'electron');
        stub(/^electron-updater$/, 'updater');
        stub(/^node:child_process$/, 'child_process');
        stub(/shim[\\/]vscode[\\/]host$/, 'host');
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: {
          electron: "export const app = { isPackaged: true, getVersion: () => '1.2.0', getPath: () => '/Applications/Unify.app/Contents/MacOS/Unify' };",
          updater: 'export const autoUpdater = globalThis.__autoUpdater;',
          child_process: 'export function spawnSync() { return globalThis.__codesign; }',
          host: 'export function appendLog(message) { globalThis.__updaterLogs.push(message); }',
        }[path] }));
      },
    }],
  });
}

const load = async bundled => import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

// Linux/Windows keep updating regardless of signing, so the restart guard uses win32 here.
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
globalThis.__autoUpdater = makeAutoUpdater();
globalThis.__updaterLogs = [];
globalThis.__codesign = { status: 0, stdout: '', stderr: '' };
const windowsUpdater = await load(await buildUpdater('windows'));
const darwinBundle = await buildUpdater('darwin');

after(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  delete globalThis.__autoUpdater;
  delete globalThis.__updaterLogs;
  delete globalThis.__codesign;
});

const UPDATER_EVENTS = ['checking-for-update', 'update-available', 'download-progress', 'update-not-available', 'update-downloaded', 'error'];

test('restarting the updater keeps one set of listeners and one notification per version', () => {
  const updater = globalThis.__autoUpdater;
  const notes = [];
  windowsUpdater.startUpdater({ notify: (...args) => notes.push(args) });
  assert.equal(updater.autoInstallOnAppQuit, false, 'closing Unify never installs silently');
  for (const event of UPDATER_EVENTS) {
    assert.equal(updater.count(event), 1, event);
  }

  updater.emit('update-downloaded', { version: '1.2.3' });
  updater.emit('update-downloaded', { version: '1.2.3' });
  assert.equal(notes.length, 1);
  assert.equal(typeof notes[0][2], 'function', 'the notification opens the Updates screen');

  windowsUpdater.stopUpdater();
  windowsUpdater.startUpdater({ notify: (...args) => notes.push(args) });
  for (const event of UPDATER_EVENTS) {
    assert.equal(updater.count(event), 1, event);
  }
  updater.emit('update-downloaded', { version: '1.2.4' });
  assert.equal(notes.length, 2);
  windowsUpdater.stopUpdater();
});

/** A fresh module (its own state) bound to a fresh fake autoUpdater, on win32. */
async function freshWindowsUpdater(instance) {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const updater = makeAutoUpdater();
  globalThis.__autoUpdater = updater;
  const module = await load(await buildUpdater(instance));
  return { updater, windowsUpdater: module };
}

test('the snapshot follows a check, a download and a visible install', async () => {
  const { updater, windowsUpdater } = await freshWindowsUpdater('flow');
  const snapshots = [];
  let opened = 0;
  windowsUpdater.startUpdater({
    notify: (_title, _body, onClick) => onClick?.(),
    onChange: snapshot => snapshots.push(snapshot),
    openUpdates: () => { opened += 1; },
  });

  updater.emit('checking-for-update');
  assert.equal(windowsUpdater.getUpdateSnapshot().status.state, 'checking');
  updater.emit('update-available', { version: '1.3.0', releaseNotes: '<ul><li>Faster &amp; clearer</li></ul>' });
  updater.emit('download-progress', { percent: 42, transferred: 42, total: 100, bytesPerSecond: 10 });
  let snapshot = windowsUpdater.getUpdateSnapshot();
  assert.equal(snapshot.status.state, 'downloading');
  assert.equal(snapshot.status.percent, 42);
  assert.equal(snapshot.release.notes, '• Faster & clearer');
  assert.equal(snapshot.currentVersion, '1.2.0');

  updater.emit('update-downloaded', { version: '1.3.0' });
  assert.deepEqual(windowsUpdater.getUpdateSnapshot().status, { state: 'ready', version: '1.3.0' });
  assert.equal(opened, 1, 'clicking the notification opens Updates');

  // A later failed periodic check keeps the downloaded update on screen.
  updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  assert.equal(windowsUpdater.getUpdateSnapshot().status.state, 'ready');

  assert.deepEqual(windowsUpdater.installUpdateNow(), { ok: true });
  assert.equal(windowsUpdater.getUpdateSnapshot().status.state, 'installing');
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.deepEqual(updater.installs.at(-1), { isSilent: false, isForceRunAfter: true }, 'the installer window is shown');
  assert.ok(snapshots.length >= 5);
  windowsUpdater.stopUpdater();
});

test('an offline check reads as a plain error, and install needs a download', async () => {
  const { updater, windowsUpdater } = await freshWindowsUpdater('offline');
  windowsUpdater.startUpdater({ notify() {} });
  updater.emit('update-not-available');
  assert.equal(windowsUpdater.getUpdateSnapshot().status.state, 'current');
  assert.equal(windowsUpdater.installUpdateNow().ok, false);
  updater.emit('error', new Error('getaddrinfo ENOTFOUND api.github.com'));
  const status = windowsUpdater.getUpdateSnapshot().status;
  assert.equal(status.state, 'error');
  assert.match(status.message, /connection/);
  assert.match(status.detail, /ENOTFOUND/);
  windowsUpdater.stopUpdater();
});

test('an unsigned macOS build skips startup and reports a clear unavailable result', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const updater = makeAutoUpdater();
  globalThis.__autoUpdater = updater;
  globalThis.__updaterLogs = [];
  globalThis.__codesign = { status: 1, stdout: '', stderr: 'code object is not signed at all' };
  const darwinUpdater = await load(darwinBundle);

  darwinUpdater.startUpdater({ notify() {} });
  assert.equal(updater.total(), 0, 'no listeners are attached when nothing can update');
  assert.ok(globalThis.__updaterLogs.some(line => /skipped: unsigned macOS build/.test(line)));

  const result = await darwinUpdater.checkForUpdatesNow();
  assert.deepEqual(result, { status: 'unavailable', message: 'Updates are not available on unsigned macOS builds.' });
  assert.equal(updater.checks(), 0);

  globalThis.__codesign = { status: 0, stdout: '', stderr: 'Authority=Developer ID Application: Example (TEAMID)\nTeamIdentifier=TEAMID' };
  darwinUpdater.stopUpdater();
  darwinUpdater.startUpdater({ notify() {} });
  assert.equal(updater.total(), UPDATER_EVENTS.length, 'a signed build starts normally');
  assert.equal((await darwinUpdater.checkForUpdatesNow()).status, 'checking');
  assert.equal(updater.checks(), 1);
  darwinUpdater.stopUpdater();
});
