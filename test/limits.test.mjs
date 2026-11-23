import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { build } from 'esbuild';
import { isLimitNotice, isUsageLimit, isUsageLimitText, UsageLimitError } from '../dist/runtime/limits.mjs';

test('recognizes Claude and ChatGPT (Codex) usage limit errors', () => {
  assert.ok(isUsageLimitText('Claude AI usage limit reached|1760000000'));
  assert.ok(isUsageLimitText("You've hit your usage limit. Upgrade to Pro or try again later."));
  assert.ok(isUsageLimitText('stream error: usageLimitExceeded'));
  assert.ok(isUsageLimitText('API Error: 429 Too Many Requests'));
  assert.ok(isUsageLimit(new UsageLimitError('spent')));
  assert.ok(isUsageLimit(new Error('Codex turn failed. rate_limit_exceeded')));
  assert.ok(isUsageLimit(new Error('You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.')));
  assert.ok(!isUsageLimit(new Error('Claude Code exited with code 1. Sign in again from Accounts.')));
});

test('treats a reply as a limit notice only when it is nothing but the notice', () => {
  assert.ok(isLimitNotice('5-hour limit reached ∙ resets 3pm'));
  assert.ok(isLimitNotice("You've hit your limit · resets 3pm (Europe/London)"));
  assert.ok(isLimitNotice('Claude AI usage limit reached|1760000000'));
  assert.ok(!isLimitNotice('I fixed the rate limit bug in the uploader.'));
  assert.ok(!isLimitNotice(`5-hour limit reached ∙ resets 3pm ${'x'.repeat(300)}`));
});

const queueBundle = await build({
  entryPoints: ['src/engine/delegate/limits.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { DelegateTaskQueue } = await import(
  `data:text/javascript;base64,${Buffer.from(queueBundle.outputFiles[0].text).toString('base64')}`
);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('raising the concurrency limit starts every waiting task', async () => {
  let limit = 1;
  const queue = new DelegateTaskQueue(() => limit);
  const started = [];
  const gates = [];
  const tasks = [];
  for (let index = 0; index < 3; index += 1) {
    const gate = deferred();
    gates.push(gate);
    tasks.push(queue.run(async () => {
      started.push(index);
      await gate.promise;
    }));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0]);
  assert.equal(queue.queued, 2);

  limit = 3;
  gates[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(queue.queued, 0);

  gates[1].resolve();
  gates[2].resolve();
  await Promise.all(tasks);
});

