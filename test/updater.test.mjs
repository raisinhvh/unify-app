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
          electron: "export const app = { isPackaged: true, getPath: () => '/Applications/Unify.app/Contents/MacOS/Unify' };",
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

test('restarting the updater keeps one set of listeners and one notification per version', () => {
  const updater = globalThis.__autoUpdater;
  const notes = [];
  windowsUpdater.startUpdater({ notify: (...args) => notes.push(args) });
  for (const event of ['update-available', 'update-not-available', 'update-downloaded', 'error']) {
    assert.equal(updater.count(event), 1, event);
  }

  updater.emit('update-downloaded', { version: '1.2.3' });
  updater.emit('update-downloaded', { version: '1.2.3' });
  assert.equal(notes.length, 1);

  windowsUpdater.stopUpdater();
  windowsUpdater.startUpdater({ notify: (...args) => notes.push(args) });
  for (const event of ['update-available', 'update-not-available', 'update-downloaded', 'error']) {
    assert.equal(updater.count(event), 1, event);
  }
  updater.emit('update-downloaded', { version: '1.2.4' });
  assert.equal(notes.length, 2);
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
  assert.equal(updater.total(), 4, 'a signed build starts normally');
  assert.equal((await darwinUpdater.checkForUpdatesNow()).status, 'checking');
  assert.equal(updater.checks(), 1);
  darwinUpdater.stopUpdater();
});
