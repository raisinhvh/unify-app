import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['src/engine/accounts/claudeUsage.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { readClaudeUsage, claudeEventMetric } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

test('Claude subscription usage asks to sign in when credentials are missing', async () => {
  const usage = await readClaudeUsage({
    id: 'claude:test', provider: 'claude-cli', label: 'Claude', directory: 'nonexistent-claude-dir',
  });

  assert.equal(usage.status, 'unavailable');
  assert.deepEqual(usage.metrics, []);
  assert.equal(usage.fix, 'signin');
  assert.match(usage.detail, /Sign in again/);
  assert.equal(typeof usage.fetchedAt, 'number');
});

test('Claude usage adapter rejects non-Claude accounts with an explicit explanation', async () => {
  const usage = await readClaudeUsage({
    id: 'codex:test', provider: 'codex-cli', label: 'Codex', directory: 'unused',
  });

  assert.equal(usage.status, 'unavailable');
  assert.deepEqual(usage.metrics, []);
  assert.equal(usage.detail, 'Usage is available only for Claude accounts.');
});

test('claudeEventMetric maps rate limit updates into usage metrics', () => {
  const metric = claudeEventMetric({ rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1_700_000_000 });
  assert.deepEqual(metric, {
    label: '5-hour',
    value: '42% used',
    usedPercent: 42,
    resetsAt: 1_700_000_000_000,
  });
});
