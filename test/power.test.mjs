import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { build } from 'esbuild';

// Every test injects settings, timers and exec: nothing touches ~/.dsh/unify/settings.json and no
// real shutdown command ever runs.
const bundled = await build({
  entryPoints: ['src/engine/unify/power.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{
    name: 'no-real-settings',
    setup(builder) {
      builder.onResolve({ filter: /\/settings$/ }, () => ({ path: 'settings', namespace: 'test-settings' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-settings' }, () => ({
        contents: [
          'export function getUnifyFeature() { throw new Error("tests must inject settings"); }',
          'export function setUnifyFeature() { throw new Error("tests must inject settings"); }',
          'export function onUnifyFeatureChange() { throw new Error("tests must inject settings"); }',
        ].join('\n'),
      }));
    },
  }],
});
const { createShutdownController, shutdownCommandsFor } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function createFakeTimers() {
  let currentTime = 0;
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimeout(callback, milliseconds) {
      const id = nextId++;
      scheduled.set(id, { callback, dueAt: currentTime + milliseconds });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    },
    pendingCount() {
      return scheduled.size;
    },
    async advance(milliseconds) {
      const target = currentTime + milliseconds;
      for (;;) {
        let earliest;
        for (const [id, entry] of scheduled) {
          if (entry.dueAt <= target && (!earliest || entry.dueAt < earliest.entry.dueAt)) earliest = { id, entry };
        }
        if (!earliest) break;
        scheduled.delete(earliest.id);
        currentTime = earliest.entry.dueAt;
        earliest.entry.callback();
        await flushPromises();
      }
      currentTime = target;
      await flushPromises();
    },
  };
}

async function flushPromises() {
  for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
}

function createFakeSettings(initial = {}) {
  const values = { 'power.shutdownWhenIdle': false, 'power.rememberArmed': false, ...initial };
  const listeners = new Set();
  const writes = [];
  return {
    values,
    writes,
    get: (id) => values[id],
    set(id, value) {
      values[id] = value;
      writes.push([id, value]);
      for (const listener of listeners) listener(id, value);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const IDLE = { runningChats: 0, runningSubagents: 0, pendingApprovals: 0, pendingQuestions: 0, runningProcesses: 0 };

function setup({ settings = createFakeSettings(), activity = { ...IDLE }, exec, saveState, platform = 'win32' } = {}) {
  const timers = createFakeTimers();
  const posted = [];
  const notifications = [];
  const execCalls = [];
  const activityListeners = new Set();
  let saveCount = 0;
  const state = { activity };
  const controller = createShutdownController({
    getActivity: () => state.activity,
    onActivityChange(listener) {
      activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    },
    saveState: saveState ?? (async () => { saveCount++; }),
    notify: (title, body) => notifications.push({ title, body }),
    post: (message) => posted.push(message),
    platform,
    exec: async (file, args) => {
      execCalls.push([file, ...args]);
      if (exec) await exec(file, args);
    },
    timers,
    settings,
  });
  return {
    controller,
    timers,
    settings,
    posted,
    notifications,
    execCalls,
    get saveCount() { return saveCount; },
    setActivity(next) {
      state.activity = { ...IDLE, ...next };
      for (const listener of activityListeners) listener();
    },
    arm() {
      settings.set('power.shutdownWhenIdle', true);
    },
    types() {
      return posted.map((message) => message.type);
    },
  };
}

test('power: startup clears an armed switch unless rememberArmed is on', () => {
  const forgetting = setup({ settings: createFakeSettings({ 'power.shutdownWhenIdle': true }) });
  assert.equal(forgetting.settings.values['power.shutdownWhenIdle'], false);
  assert.equal(forgetting.controller.getStatus().armed, false);
  assert.deepEqual(forgetting.posted, []);

  const remembering = setup({
    settings: createFakeSettings({ 'power.shutdownWhenIdle': true, 'power.rememberArmed': true }),
    activity: { ...IDLE, runningChats: 1 },
  });
  assert.equal(remembering.settings.values['power.shutdownWhenIdle'], true);
  assert.deepEqual(remembering.controller.getStatus(), { armed: true, phase: 'waiting' });
  assert.deepEqual(remembering.posted, [{ type: 'shutdownArmed', armed: true }]);
});

test('power: arming posts shutdownArmed and waits while work runs', async () => {
  const harness = setup({ activity: { ...IDLE, runningChats: 1 } });
  harness.arm();
  assert.deepEqual(harness.posted, [{ type: 'shutdownArmed', armed: true }]);
  await harness.timers.advance(120_000);
  assert.equal(harness.controller.getStatus().phase, 'waiting');
  assert.equal(harness.execCalls.length, 0);
});

test('power: idle must hold for the debounce before the countdown starts', async () => {
  const harness = setup({ activity: { ...IDLE, runningSubagents: 1 } });
  harness.arm();
  harness.setActivity({});
  assert.equal(harness.controller.getStatus().phase, 'settling');
  await harness.timers.advance(3000);
  harness.setActivity({ runningProcesses: 1 });
  assert.equal(harness.controller.getStatus().phase, 'waiting');
  harness.setActivity({});
  await harness.timers.advance(4999);
  assert.ok(!harness.types().includes('shutdownCountdown'));
  await harness.timers.advance(1);
  assert.deepEqual(harness.controller.getStatus(), { armed: true, phase: 'countdown', secondsLeft: 60 });
  assert.deepEqual(harness.posted.at(-1), { type: 'shutdownCountdown', secondsLeft: 60 });
  assert.equal(harness.notifications.at(-1).title, 'Shutting down in 60 seconds');
});

test('power: pending approvals and questions block and notify once', async () => {
  const harness = setup({ activity: { ...IDLE, pendingApprovals: 1 } });
  harness.arm();
  harness.setActivity({ pendingApprovals: 1, runningChats: 1 });
  harness.setActivity({ pendingApprovals: 1 });
  await harness.timers.advance(120_000);
  assert.equal(harness.controller.getStatus().phase, 'waiting');
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].title, 'Shutdown is waiting on you');

  harness.setActivity({ runningChats: 1 });
  harness.setActivity({ pendingQuestions: 1 });
  assert.equal(harness.notifications.length, 2);
  assert.equal(harness.execCalls.length, 0);
});

test('power: full countdown saves state then runs the primary command and disarms', async () => {
  const harness = setup();
  harness.arm();
  await harness.timers.advance(5000);
  await harness.timers.advance(60_000);
  const seconds = harness.posted.filter((message) => message.type === 'shutdownCountdown').map((message) => message.secondsLeft);
  assert.equal(seconds.length, 61);
  assert.equal(seconds[0], 60);
  assert.equal(seconds.at(-1), 0);
  assert.equal(harness.saveCount, 1);
  assert.deepEqual(harness.execCalls, [['shutdown', '/s', '/t', '0']]);
  assert.equal(harness.settings.values['power.shutdownWhenIdle'], false);
  assert.deepEqual(harness.posted.at(-1), { type: 'shutdownArmed', armed: false });
  assert.equal(harness.controller.getStatus().armed, false);
});

test('power: cancelShutdown stops the countdown and turns the switch off', async () => {
  const harness = setup();
  harness.arm();
  await harness.timers.advance(5000 + 10_000);
  harness.controller.cancelShutdown();
  assert.deepEqual(harness.posted.slice(-2), [{ type: 'shutdownCancelled' }, { type: 'shutdownArmed', armed: false }]);
  assert.deepEqual(harness.settings.writes.at(-1), ['power.shutdownWhenIdle', false]);
  assert.equal(harness.timers.pendingCount(), 0);
  await harness.timers.advance(120_000);
  assert.equal(harness.execCalls.length, 0);
  assert.equal(harness.saveCount, 0);
});

test('power: turning the switch off from settings disarms', async () => {
  const harness = setup();
  harness.arm();
  await harness.timers.advance(5000 + 3000);
  harness.settings.set('power.shutdownWhenIdle', false);
  assert.deepEqual(harness.posted.at(-1), { type: 'shutdownArmed', armed: false });
  await harness.timers.advance(120_000);
  assert.equal(harness.execCalls.length, 0);
});

test('power: activity during the countdown returns to waiting, then restarts cleanly', async () => {
  const harness = setup();
  harness.arm();
  await harness.timers.advance(5000 + 30_000);
  harness.setActivity({ runningChats: 1 });
  assert.deepEqual(harness.posted.at(-1), { type: 'shutdownWaiting' });
  assert.deepEqual(harness.controller.getStatus(), { armed: true, phase: 'waiting' });
  await harness.timers.advance(120_000);
  assert.equal(harness.execCalls.length, 0);

  harness.setActivity({});
  await harness.timers.advance(5000);
  assert.deepEqual(harness.posted.at(-1), { type: 'shutdownCountdown', secondsLeft: 60 });
  await harness.timers.advance(60_000);
  assert.equal(harness.execCalls.length, 1);
});

test('power: re-checks idle after saving and does not fire if work started', async () => {
  const harness = setup({
    saveState: async () => {
      harness.setActivity({ runningProcesses: 1 });
    },
  });
  harness.arm();
  await harness.timers.advance(65_000);
  assert.equal(harness.execCalls.length, 0);
  assert.deepEqual(harness.controller.getStatus(), { armed: true, phase: 'waiting' });
  assert.ok(harness.types().includes('shutdownWaiting'));
});

test('power: a failed save aborts, reports and disarms', async () => {
  const harness = setup({ saveState: async () => { throw new Error('disk full'); } });
  harness.arm();
  await harness.timers.advance(65_000);
  assert.equal(harness.execCalls.length, 0);
  const failure = harness.posted.find((message) => message.type === 'shutdownFailed');
  assert.match(failure.error, /disk full/);
  assert.equal(harness.settings.values['power.shutdownWhenIdle'], false);
  assert.equal(harness.notifications.at(-1).title, 'Shutdown failed');
});

test('power: primary command failure falls back', async () => {
  const harness = setup({
    exec: async (file) => {
      if (file === 'shutdown') throw new Error('access denied');
    },
  });
  harness.arm();
  await harness.timers.advance(65_000);
  assert.deepEqual(harness.execCalls, [
    ['shutdown', '/s', '/t', '0'],
    ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'Stop-Computer -Force'],
  ]);
  assert.ok(!harness.types().includes('shutdownFailed'));
});

test('power: both commands failing posts shutdownFailed, notifies and stays disarmed', async () => {
  const harness = setup({
    platform: 'linux',
    exec: async (file) => { throw new Error(`${file} not permitted`); },
  });
  harness.arm();
  await harness.timers.advance(65_000);
  assert.deepEqual(harness.execCalls, [['systemctl', 'poweroff'], ['shutdown', '-h', 'now']]);
  const failure = harness.posted.find((message) => message.type === 'shutdownFailed');
  assert.match(failure.error, /systemctl not permitted/);
  assert.match(failure.error, /shutdown not permitted/);
  assert.equal(harness.notifications.at(-1).title, 'Shutdown failed');
  assert.equal(harness.settings.values['power.shutdownWhenIdle'], false);
  assert.equal(harness.controller.getStatus().armed, false);
  await harness.timers.advance(120_000);
  assert.equal(harness.execCalls.length, 2);
});

test('power: platform commands', () => {
  assert.deepEqual(shutdownCommandsFor('darwin'), [
    { file: 'osascript', args: ['-e', 'tell app "System Events" to shut down'] },
    { file: 'shutdown', args: ['-h', 'now'] },
  ]);
  assert.deepEqual(shutdownCommandsFor('linux')[0], { file: 'systemctl', args: ['poweroff'] });
  assert.deepEqual(shutdownCommandsFor('win32')[0], { file: 'shutdown', args: ['/s', '/t', '0'] });
});

test('power: dispose stops timers and listeners', async () => {
  const harness = setup();
  harness.arm();
  await harness.timers.advance(5000);
  harness.controller.dispose();
  assert.equal(harness.timers.pendingCount(), 0);
  harness.settings.set('power.shutdownWhenIdle', true);
  await harness.timers.advance(120_000);
  assert.equal(harness.execCalls.length, 0);
});
