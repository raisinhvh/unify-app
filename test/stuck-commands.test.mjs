import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { build } from 'esbuild';

// Bundle the module the same way the extension build does; no vscode or extension host is involved.
const bundle = await build({
  entryPoints: ['src/engine/runtime/stuckCommands.ts'],
  bundle: true, loader: { '.sh': 'text' },
  write: false,
  format: 'esm',
  platform: 'node',
});
const {
  commandLabel,
  commandRunners,
  sampleProcesses,
  startStuckCommandWatchdog,
  StuckCommandTracker,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const ROOT = { pid: 1, ppid: 0, command: 'Unify', cpuMs: 0, ioBytes: 0 };
const RUNNER = {
  pid: 10,
  ppid: 1,
  command: 'node C:\\app\\node_modules\\@deepseek-ai\\dsh-subprocess-local\\lib\\runner.js -- powershell.exe -Command "npm test"',
  cpuMs: 0,
  ioBytes: 0,
};
const CHILD = { pid: 11, ppid: 10, command: 'powershell.exe -Command "npm test"', cpuMs: 5, ioBytes: 10 };

test('commandRunners finds only runner processes below the runtime', { timeout: 30000 }, () => {
  const samples = [
    ROOT,
    RUNNER,
    CHILD,
    { pid: 20, ppid: 1, command: 'node /app/node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner.js -- /bin/bash -c "npm test"', cpuMs: 0, ioBytes: 0 },
    { pid: 21, ppid: 20, command: 'node test.js', cpuMs: 0, ioBytes: 0 },
    { pid: 30, ppid: 1, command: 'node /app/node_modules/@deepseek-ai/dsh-delegate/lib/server.js', cpuMs: 0, ioBytes: 0 },
    { pid: 40, ppid: 999, command: 'node /other/dsh-subprocess-local/lib/runner.js -- /bin/bash -c "ls"', cpuMs: 0, ioBytes: 0 },
  ];
  assert.deepEqual(commandRunners(samples, 1).map(sample => sample.pid), [10, 20]);
  assert.deepEqual(commandRunners(samples, 30), []);
});

test('commandLabel strips the PowerShell prelude and handles bash and long commands', { timeout: 30000 }, () => {
  const powershell = commandLabel(
    'node C:\\app\\node_modules\\@deepseek-ai\\dsh-subprocess-local\\lib\\runner.js -- ' +
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo -NoProfile -NonInteractive ' +
    '-Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    "$OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; " +
    'npm test -- --runInBand"',
  );
  assert.equal(powershell, 'npm test -- --runInBand');

  const bash = commandLabel(
    '/usr/bin/node /app/node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner.js -- ' +
    '/bin/bash -c "npm test"',
  );
  assert.equal(bash, 'npm test');

  const quotedBash = commandLabel(
    '/usr/bin/node /app/node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner.js -- ' +
    "/bin/bash -c 'npm run build -- --watch'",
  );
  assert.equal(quotedBash, 'npm run build -- --watch');

  const long = commandLabel(
    `node /app/dsh-subprocess-local/lib/runner.js -- /bin/bash -c "echo ${'x'.repeat(300)}"`,
  );
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));

  assert.equal(commandLabel('node /app/other.js --version'), '');
});

test('tracker reports a runner only after its descendants stay idle, then only once', { timeout: 30000 }, () => {
  const tracker = new StuckCommandTracker();
  const samples = [ROOT, RUNNER, CHILD];
  assert.deepEqual(tracker.update(samples, 1, 1000, 0), []);
  assert.deepEqual(tracker.update(samples, 1, 1000, 999), []);

  const stuck = tracker.update(samples, 1, 1000, 1000);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].runnerPid, 10);
  assert.equal(stuck[0].idleMs, 1000);
  assert.equal(stuck[0].command, 'npm test');

  assert.deepEqual(tracker.update(samples, 1, 1000, 60_000), [], 'a runner is reported once');
});

test('tracker resets the idle clock when descendant CPU or IO changes', { timeout: 30000 }, () => {
  const cpuTracker = new StuckCommandTracker();
  const starting = [ROOT, RUNNER, CHILD];
  cpuTracker.update(starting, 1, 1000, 0);
  const busy = [ROOT, RUNNER, { ...CHILD, cpuMs: CHILD.cpuMs + 250 }];
  assert.deepEqual(cpuTracker.update(busy, 1, 1000, 1000), []);
  assert.deepEqual(cpuTracker.update(busy, 1, 1000, 1999), []);
  assert.equal(cpuTracker.update(busy, 1, 1000, 2000).length, 1);

  const ioTracker = new StuckCommandTracker();
  ioTracker.update(starting, 1, 1000, 0);
  const writing = [ROOT, RUNNER, { ...CHILD, ioBytes: CHILD.ioBytes + 4096 }];
  assert.deepEqual(ioTracker.update(writing, 1, 1000, 1000), []);
  assert.deepEqual(ioTracker.update(writing, 1, 1000, 1999), []);
  assert.equal(ioTracker.update(writing, 1, 1000, 2000).length, 1);
});

test('tracker ignores keepalive noise below the CPU/IO floor while counting real work and child exits', { timeout: 30000 }, () => {
  const tracker = new StuckCommandTracker();
  const esbuild = { pid: 12, ppid: 11, command: 'esbuild.exe --service=0.25.12 --ping', cpuMs: 170, ioBytes: 2_000_000 };
  let nodeCpu = 280;
  let nodeIo = 1_700_000;
  let esbuildCpu = esbuild.cpuMs;
  let esbuildIo = esbuild.ioBytes;
  const snapshot = () => [
    ROOT,
    RUNNER,
    { ...CHILD, cpuMs: nodeCpu, ioBytes: nodeIo },
    { ...esbuild, cpuMs: esbuildCpu, ioBytes: esbuildIo },
  ];

  // Simulate hung node + esbuild --ping (~110 ms CPU and ~2.76 KiB IO every 30 s) over 2 minutes.
  assert.deepEqual(tracker.update(snapshot(), 1, 120_000, 0), []);
  for (const t of [30_000, 60_000, 90_000]) {
    nodeCpu += 100;
    esbuildCpu += 10;
    nodeIo += 1380;
    esbuildIo += 1380;
    assert.deepEqual(tracker.update(snapshot(), 1, 120_000, t), [], `not stuck yet at ${t}ms`);
  }
  nodeCpu += 100;
  esbuildCpu += 10;
  nodeIo += 1380;
  esbuildIo += 1380;
  const stuck = tracker.update(snapshot(), 1, 120_000, 120_000);
  assert.equal(stuck.length, 1, 'keepalive noise does not hide a hung tree');
  assert.equal(stuck[0].runnerPid, 10);

  // Real work above the CPU floor (600 ms / 30 s = 1200 ms/min) or IO floor (20 KiB / 30 s) keeps it alive.
  const activeCpu = new StuckCommandTracker();
  let cpu = 100;
  activeCpu.update([ROOT, RUNNER, { ...CHILD, cpuMs: cpu }], 1, 60_000, 0);
  for (const t of [30_000, 60_000, 90_000, 120_000]) {
    cpu += 600;
    assert.deepEqual(activeCpu.update([ROOT, RUNNER, { ...CHILD, cpuMs: cpu }], 1, 60_000, t), []);
  }

  const activeIo = new StuckCommandTracker();
  let io = 100;
  activeIo.update([ROOT, RUNNER, { ...CHILD, ioBytes: io }], 1, 60_000, 0);
  for (const t of [30_000, 60_000, 90_000, 120_000]) {
    io += 20_480;
    assert.deepEqual(activeIo.update([ROOT, RUNNER, { ...CHILD, ioBytes: io }], 1, 60_000, t), []);
  }

  // Brief Windows CPU tick jitter on short 10 s polls is smoothed over the rolling window.
  const jittery = new StuckCommandTracker();
  let jitterCpu = 265;
  let jitterIo = 3_844_000;
  jittery.update([ROOT, RUNNER, { ...CHILD, cpuMs: jitterCpu, ioBytes: jitterIo }], 1, 60_000, 0);
  const deltas = [62.5, 109.375, 15.625, 46.875, 62.5, 31.25];
  for (let i = 0; i < deltas.length; i++) {
    jitterCpu += deltas[i];
    jitterIo += 920;
    const result = jittery.update([ROOT, RUNNER, { ...CHILD, cpuMs: jitterCpu, ioBytes: jitterIo }], 1, 60_000, (i + 1) * 10_000);
    assert.equal(result.length, i === deltas.length - 1 ? 1 : 0);
  }

  // A child exiting lowers cumulative CPU/IO, which resets the baseline rather than masking future idle time.
  const shrinking = new StuckCommandTracker();
  const helper = { pid: 13, ppid: 11, command: 'worker.exe', cpuMs: 5000, ioBytes: 100_000 };
  shrinking.update([ROOT, RUNNER, CHILD, helper], 1, 60_000, 0);
  assert.deepEqual(shrinking.update([ROOT, RUNNER, CHILD], 1, 60_000, 30_000), []);
  assert.deepEqual(shrinking.update([ROOT, RUNNER, CHILD], 1, 60_000, 60_000), [], 'idle clock reset when child exited');
  assert.equal(shrinking.update([ROOT, RUNNER, CHILD], 1, 60_000, 90_000).length, 1);
});

test('tracker ignores activity of the runner itself and runners without descendants', { timeout: 30000 }, () => {
  const tracker = new StuckCommandTracker();
  tracker.update([ROOT, RUNNER, CHILD], 1, 1000, 0);
  const busyRunner = [ROOT, { ...RUNNER, cpuMs: 5000, ioBytes: 5000 }, CHILD];
  assert.equal(tracker.update(busyRunner, 1, 1000, 1000).length, 1, 'runner pipe IO does not mask a hung child');

  const childless = new StuckCommandTracker();
  const loneRunner = [ROOT, RUNNER];
  assert.deepEqual(childless.update(loneRunner, 1, 1000, 0), []);
  assert.deepEqual(childless.update(loneRunner, 1, 1000, 60_000), [], 'no descendants yet means unknown');
  assert.deepEqual(childless.update([ROOT, RUNNER, CHILD], 1, 1000, 60_000), [], 'the child starts a new baseline');
  assert.equal(childless.update([ROOT, RUNNER, CHILD], 1, 1000, 61_000).length, 1);
});

test('tracker forgets runners that disappeared and can report them again later', { timeout: 30000 }, () => {
  const tracker = new StuckCommandTracker();
  const samples = [ROOT, RUNNER, CHILD];
  tracker.update(samples, 1, 1000, 0);
  assert.equal(tracker.update(samples, 1, 1000, 1000).length, 1);

  assert.deepEqual(tracker.update([ROOT], 1, 1000, 2000), []);
  assert.deepEqual(tracker.update(samples, 1, 1000, 3000), [], 'a returning runner is tracked from scratch');
  assert.deepEqual(tracker.update(samples, 1, 1000, 3999), []);
  assert.equal(tracker.update(samples, 1, 1000, 4000).length, 1);
});

test('watchdog stops then reports a stuck command and is disabled by idleMinutes', { timeout: 30000 }, async () => {
  const samples = [ROOT, RUNNER, CHILD];
  const events = [];
  let now = 0;
  let idleMinutes = 1;
  let samplesTaken = 0;
  const watchdog = startStuckCommandWatchdog({
    rootPid: () => 1,
    idleMinutes: () => idleMinutes,
    pollMs: 60_000,
    sample: async () => {
      samplesTaken += 1;
      return samples;
    },
    stop: async runnerPid => {
      events.push(`stop:${runnerPid}`);
    },
    onStuck: command => {
      events.push(`stuck:${command.runnerPid}`);
    },
    now: () => now,
  });

  try {
    await watchdog.tick();
    now = 60_000;
    await watchdog.tick();
    assert.deepEqual(events, ['stop:10', 'stuck:10'], 'the command is stopped before it is reported');
    assert.equal(samplesTaken, 2);

    idleMinutes = 0;
    now = 120_000;
    await watchdog.tick();
    assert.equal(samplesTaken, 2, 'a disabled watchdog does not sample');

    idleMinutes = 1;
    now = 180_000;
    await watchdog.tick();
    assert.deepEqual(events, ['stop:10', 'stuck:10'], 'a reported runner is not reported twice');
  } finally {
    watchdog.stop();
  }
});

test('sampleProcesses lists this process with positive CPU time', { timeout: 30000 }, async () => {
  const samples = await sampleProcesses();
  if (samples.length === 0) return;
  const self = samples.find(sample => sample.pid === process.pid);
  assert.ok(self, `process list includes pid ${process.pid}`);
  assert.ok(self.cpuMs > 0, `cpuMs for this process is positive (${self.cpuMs})`);
});

test('ACP runtime YAML patch caps tool-jobs wait timeouts', { timeout: 30000 }, async () => {
  const acpBundle = await build({
    entryPoints: ['src/engine/runtime/acp.ts'],
    bundle: true, loader: { '.sh': 'text' },
    write: false,
    format: 'esm',
    platform: 'node',
    external: ['@deepseek-ai/dsh'],
    plugins: [{
      name: 'vscode-stub',
      setup(builder) {
        builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export class EventEmitter { event = () => ({ dispose() {} }); fire() {} dispose() {} } export const workspace = { getConfiguration: () => ({ get: (_k, d) => d }) };',
        }));
      },
    }],
  });
  const { buildAcpPatch } = await import(`data:text/javascript;base64,${Buffer.from(acpBundle.outputFiles[0].text).toString('base64')}`);
  const yaml = buildAcpPatch({
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    instructionsHome: '/home/unify/instructions',
    dataHome: '/home/unify',
  });
  assert.match(yaml, /- id: tool-jobs\n  config:\n    waitTimeoutMs: 30000\n    maxWaitTimeoutMs: 120000/);
});
