import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const bundled = await build({
  stdin: {
    contents: "export * from './src/engine/accounts/usageService.ts'; export * from './src/engine/accounts/opencodeUsage.ts';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node20',
});
const { AccountUsageService, readOpenCodeUsage } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve().then(run).finally(() => { globalThis.fetch = original; });
}

/** Point OpenCode's XDG data lookup at a temporary folder for every platform. */
async function withOpenCodeAuth(auth, run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-opencode-usage-'));
  const saved = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = root;
  try {
    if (auth) {
      await mkdir(join(root, 'opencode'), { recursive: true });
      await writeFile(join(root, 'opencode', 'auth.json'), typeof auth === 'string' ? auth : JSON.stringify(auth));
    }
    return await run();
  } finally {
    if (saved === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = saved;
    await rm(root, { recursive: true, force: true });
  }
}

const goUsage = {
  usage: {
    rolling: { status: 'ok', percent: 30, resetsAt: '2026-11-21T15:00:00.000Z' },
    weekly: { status: 'rate-limited', percent: 100, resetsAt: '2026-11-23T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 50, resetsAt: '2026-12-01T00:00:00.000Z' },
  },
};

test('OpenCode Go usage maps the rolling, weekly and monthly meters', async () => {
  let request;
  const usage = await withFetch(async (url, init) => {
    request = { url: String(url), init };
    return Response.json(goUsage);
  }, () => readOpenCodeUsage('sk-test-key'));
  assert.equal(request.url, 'https://opencode.ai/inference/go/v1/usage');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers.Authorization, 'Bearer sk-test-key');
  assert.equal(usage.status, 'ready');
  assert.deepEqual(usage.metrics.map(metric => [metric.label, metric.usedPercent, metric.resetsAt]), [
    ['5-hour', 30, Date.parse('2026-11-21T15:00:00.000Z')],
    ['Weekly', 100, Date.parse('2026-11-23T00:00:00.000Z')],
    ['Monthly', 50, Date.parse('2026-12-01T00:00:00.000Z')],
  ]);
  assert.deepEqual(usage.metrics.map(metric => metric.value), ['30% used', '100% used', '50% used']);
});

test('OpenCode Go treats a rate-limited meter without a percent as fully used', async () => {
  const usage = await withFetch(async () => Response.json({ usage: {
    rolling: { status: 'rate-limited', resetsAt: '2026-11-21T15:00:00.000Z' },
    weekly: { status: 'ok', percent: 'lots' },
  } }), () => readOpenCodeUsage('key'));
  assert.equal(usage.status, 'ready');
  assert.deepEqual(usage.metrics.map(metric => [metric.label, metric.usedPercent]), [['5-hour', 100]]);
});

test('OpenCode Go explains rejected keys and missing subscriptions', async () => {
  const rejected = await withFetch(async () => new Response('', { status: 401 }), () => readOpenCodeUsage('bad-key'));
  assert.equal(rejected.status, 'error');
  assert.equal(rejected.fix, 'key');
  assert.doesNotMatch(JSON.stringify(rejected), /bad-key/);

  const entitled = await withFetch(async () => Response.json({ type: 'error', error: { type: 'EntitlementError' } }, { status: 403 }), () => readOpenCodeUsage('free-key'));
  assert.equal(entitled.status, 'unavailable');
  assert.equal(entitled.fix, 'browser');
  assert.deepEqual(entitled.metrics, []);
  assert.match(entitled.detail, /OpenCode Go subscription/);
});

test('OpenCode Go falls back to the key saved during browser sign-in', () => withOpenCodeAuth({ 'opencode-go': { type: 'api', key: 'sk-local-key' } }, async () => {
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push(init.headers.Authorization); return Response.json(goUsage); };
  const usage = await readOpenCodeUsage();
  assert.equal(usage.status, 'ready');
  assert.deepEqual(sent, ['Bearer sk-local-key']);
  await readOpenCodeUsage('  sk-explicit  ');
  assert.deepEqual(sent, ['Bearer sk-local-key', 'Bearer sk-explicit']);
}));

test('OpenCode Go without a saved sign-in points at the browser and makes no request', () => withOpenCodeAuth(undefined, async () => {
  globalThis.fetch = async () => assert.fail('no key means no request');
  const usage = await readOpenCodeUsage();
  assert.equal(usage.status, 'unavailable');
  assert.equal(usage.fix, 'browser');
  assert.match(usage.detail, /sign-in/);
}));

test('usage service dispatches OpenCode Go accounts to their reader', async () => {
  const service = new AccountUsageService(() => {});
  const seen = [];
  await withFetch(async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.Authorization });
    return Response.json(goUsage);
  }, () => service.refreshOne({ id: 'go', provider: 'opencode-go', secret: async () => 'sk-go' }));
  assert.deepEqual(seen, [{ url: 'https://opencode.ai/inference/go/v1/usage', auth: 'Bearer sk-go' }]);
  assert.equal(service.snapshot().go.status, 'ready');
});


test('usage service reports self-hosted servers as not tracked without a request', async () => {
  globalThis.fetch = async () => assert.fail('self-hosted usage must not fetch');
  const service = new AccountUsageService(() => {});
  await service.refreshOne({ id: 'host', provider: 'self-hosted', secret: async () => 'key' });
  const usage = service.snapshot().host;
  assert.equal(usage.status, 'unavailable');
  assert.deepEqual(usage.metrics, []);
  assert.equal(usage.fix, undefined);
  assert.match(usage.detail, /does not track usage/);
});

test('usage service gives console-only providers a clear unavailable state', async () => {
  globalThis.fetch = async () => assert.fail('console-only providers must not fetch');
  const service = new AccountUsageService(() => {});
  for (const provider of ['google-gemini', 'gemini', 'xai', 'groq', 'mistral']) {
    await service.refreshOne({ id: provider, provider, secret: async () => 'key' });
    const usage = service.snapshot()[provider];
    assert.equal(usage.status, 'unavailable');
    assert.deepEqual(usage.metrics, []);
    assert.equal(usage.fix, 'browser');
  }
  assert.match(service.snapshot()['google-gemini'].detail, /Google AI Studio/);
  assert.match(service.snapshot().xai.detail, /team management console/);
  assert.match(service.snapshot().groq.detail, /Groq console/);
  assert.match(service.snapshot().mistral.detail, /Mistral console/);
});
