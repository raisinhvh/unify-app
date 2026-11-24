import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyProgressEligible, normalizeCommand, parseProgress, ProgressHistory, ToolProgressTracker } from '../dist/unify/toolProgress.mjs';

const folder = mkdtempSync(join(tmpdir(), 'unify-progress-'));
try {
  // Eligibility: builds, installs, tests, compiles and bundles.
  for (const command of [
    'npm run build', 'pnpm -r test', 'npm ci', 'yarn install', 'bun run build:electron', 'npm run electron:build',
    'npx tsc --noEmit', 'vite build', 'esbuild src/a.ts --bundle', 'cargo build --release', 'go test ./...',
    'dotnet build', 'gradle assembleDebug', 'cmake --build build', 'pip install -r requirements.txt', 'docker build .',
    'pytest -q', 'npx vitest run', 'cd app && npm run build', '$env:X=1; npm test', 'rojo build default.project.json',
    'npx electron-builder --win', '& "C:\\Program Files\\nodejs\\npm.cmd" run build', 'python -m pytest tests', 'node --test',
  ]) assert.equal(classifyProgressEligible(command), true, command);

  // Not eligible: reads, searches and dev servers.
  for (const command of ['ls -la', 'cat package.json', 'git status', 'rg -n "build" src', 'grep vitest a.txt', 'npm run dev', 'echo npm run build', 'git log --oneline']) {
    assert.equal(classifyProgressEligible(command), false, command);
  }

  // Normalized history keys: whitespace, 2>&1 and pipes to tail/head do not change the command.
  assert.equal(normalizeCommand('npm   run  build 2>&1 | tail -20'), 'npm run build');
  assert.equal(normalizeCommand('npm run build 2>&1'), 'npm run build');
  assert.equal(normalizeCommand('  npm test | head -n 5 '), 'npm test');

  // Live output: the last plausible progress in a chunk.
  assert.deepEqual(parseProgress('downloading 42%'), { fraction: 0.42, label: '42%' });
  assert.deepEqual(parseProgress('[ 42%] done'), { fraction: 0.42, label: '42%' });
  assert.deepEqual(parseProgress('[3/10] Compiling a.ts'), { fraction: 0.3, label: '3/10' });
  assert.deepEqual(parseProgress('Step 3/7 : RUN npm ci'), { fraction: 3 / 7, label: '3/7' });
  assert.deepEqual(parseProgress('tests (3 of 10)'), { fraction: 0.3, label: '3/10' });
  assert.deepEqual(parseProgress('Compiling x (12/80)'), { fraction: 0.15, label: '12/80' });
  assert.deepEqual(parseProgress('Building [=====>    ] 120/300'), { fraction: 0.4, label: '120/300' });
  assert.deepEqual(parseProgress('10%\nthen 50%'), { fraction: 0.5, label: '50%' });
  assert.equal(parseProgress('250%'), undefined);
  assert.equal(parseProgress('[12/3]'), undefined);
  assert.equal(parseProgress('saved 2026/11/24'), undefined);
  assert.equal(parseProgress('no numbers here'), undefined);

  // History: median of the last five successful runs of 1.5 s or more, persisted atomically.
  const file = join(folder, 'tool-durations.json');
  const history = new ProgressHistory(file);
  assert.equal(history.expectedMs(folder, 'npm run build'), undefined);
  history.record(folder, 'npm run build', 1_000);
  assert.equal(history.expectedMs(folder, 'npm run build'), undefined, 'runs under 1.5 s are not recorded');
  history.record(folder, 'npm   run build 2>&1 | tail -5', 10_000);
  history.record(folder, 'npm run build', 20_000);
  history.record(folder, 'npm run build', 30_000);
  assert.equal(history.expectedMs(folder, 'npm run build'), 20_000, 'median of three runs');
  for (const ms of [40_000, 50_000, 60_000]) history.record(folder, 'npm run build', ms);
  assert.equal(history.expectedMs(folder, 'npm run build'), 40_000, 'only the last five runs count');
  assert.deepEqual(readdirSync(folder).sort(), ['tool-durations.json'], 'no temporary file is left behind');
  assert.equal(new ProgressHistory(file).expectedMs(folder, 'npm run build'), 40_000, 'history survives a restart');

  writeFileSync(file, '{ not json');
  assert.equal(new ProgressHistory(file).expectedMs(folder, 'npm run build'), undefined, 'a corrupt file reads as empty');
  assert.equal(new ProgressHistory(join(folder, 'missing', 'x.json')).expectedMs(folder, 'npm run build'), undefined);
  const repaired = new ProgressHistory(file);
  repaired.record(folder, 'npm run build', 4_000);
  assert.equal(new ProgressHistory(file).expectedMs(folder, 'npm run build'), 4_000, 'a corrupt file is replaced by the next write');
  assert.ok(readFileSync(file, 'utf8').startsWith('{'), 'the file is valid JSON again');

  // Tracker: a bar only for eligible calls, moved by live output, recorded on success.
  let clock = 1_000_000;
  const tracker = new ToolProgressTracker({ history: new ProgressHistory(join(folder, 'tracker.json')), now: () => clock });
  assert.equal(tracker.start('t1', 'ls -la', folder), undefined);
  assert.deepEqual(tracker.start('t2', 'npm run build', folder), { startedAt: 1_000_000 });
  assert.equal(tracker.output('t2', 'vite v5 building...\n'), undefined, 'no percentage, no update');
  assert.deepEqual(tracker.output('t2', '10%'), { startedAt: 1_000_000, fraction: 0.1, label: '10%' });
  assert.equal(tracker.output('t2', '10.5%'), undefined, 'under 1% is not sent');
  assert.equal(tracker.output('t2', '5%'), undefined, 'never backwards');
  assert.deepEqual(tracker.output('t2', '25%'), { startedAt: 1_000_000, fraction: 0.25, label: '25%' });
  assert.equal(tracker.output('unknown', '50%'), undefined);
  clock += 30_000;
  tracker.end('t2', true);
  assert.equal(tracker.output('t2', '90%'), undefined, 'a finished call is forgotten');

  clock = 2_000_000;
  assert.deepEqual(tracker.start('t3', 'npm   run build 2>&1 | tail -3', folder), { startedAt: 2_000_000, expectedMs: 30_000 });
  clock += 2_000;
  tracker.end('t3', false);
  clock = 2_003_000;
  assert.deepEqual(tracker.start('t4', 'npm run build', folder), { startedAt: 2_003_000, expectedMs: 30_000 }, 'failed runs are not recorded');
  tracker.end('t4', true);
  assert.deepEqual(tracker.start('t5', 'npm run build', folder), { startedAt: 2_003_000, expectedMs: 30_000 });
} finally {
  rmSync(folder, { recursive: true, force: true });
}

console.log('tool-progress tests passed');
