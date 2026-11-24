import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { build } from 'esbuild';

// Models belong to a provider: no account fields, one entry per provider + backend + name, and the provider's
// default account runs them. Checks the sync helpers and the model registry that reads and writes the setting.
globalThis.__dshSettings = {};
globalThis.__dshUpdates = [];
globalThis.__dshConfigFor = () => ({
  get: key => globalThis.__dshSettings[key],
  inspect: key => ({ globalValue: globalThis.__dshSettings[key] }),
  update: async (key, value) => {
    globalThis.__dshSettings[key] = value;
    globalThis.__dshUpdates.push([key, value]);
  },
});

const bundled = await build({
  stdin: {
    contents: "export * from './sync/configSync.ts'; export { ModelRegistry } from './accounts/modelRegistry.ts';",
    resolveDir: 'src/engine', loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'fake-vscode', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: `
      export const workspace = { getConfiguration: section => globalThis.__dshConfigFor(section) };
      export const ConfigurationTarget = { Global: 1, Workspace: 2 };
      export const window = { showQuickPick: async () => undefined };` }));
  } }],
});
const {
  accountForModel, localModels, ModelRegistry, normalizeModels, portableModels,
} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const work = { id: 'anthropic:work', provider: 'anthropic', label: 'Work', email: 'me@example.com' };
const accountSource = {
  get: id => [work].find(item => item.id === id),
  list: () => [work],
  getDefault: provider => provider === 'anthropic' ? work : undefined,
};

function context(stored = []) {
  return { globalState: { get: (_key, fallback) => stored.length ? stored : fallback } };
}

function reset(models) {
  globalThis.__dshSettings = models === undefined ? {} : { models };
  globalThis.__dshUpdates = [];
}

test('accountForModel returns the provider default and ignores a stale account binding', () => {
  const model = { name: 'Claude', provider: 'anthropic', backend: 'claude-x', account: 'anthropic:from-other-pc', accountLabel: 'Their PC' };
  assert.equal(accountForModel(accountSource, model), work);
  assert.equal(accountForModel(accountSource, { provider: 'openai' }), undefined);
});

test('normalizeModels strips account fields and folds duplicates, enabled if any copy was', () => {
  const result = normalizeModels([
    { name: 'A', provider: 'anthropic', backend: 'a1', account: 'x', accountLabel: 'Old', enabled: false },
    { name: 'A', provider: 'anthropic', backend: 'a1', account: 'y', enabled: true },
    { name: 'B', provider: 'anthropic', backend: 'b1', account: 'x', enabled: true },
  ]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.models.map(model => model.name), ['A', 'B']);
  assert.equal(result.models[0].enabled, true);
  for (const model of result.models) {
    assert.equal('account' in model, false);
    assert.equal('accountLabel' in model, false);
  }
});

test('normalizeModels reports no change for an already clean list', () => {
  const clean = [{ name: 'A', provider: 'anthropic', backend: 'a1', enabled: true }];
  const result = normalizeModels(clean);
  assert.equal(result.changed, false);
  assert.deepEqual(result.models, clean);
});

test('portableModels and localModels strip account fields in both directions and keep the rest', () => {
  const bundle = [{ name: 'A', provider: 'anthropic', backend: 'a1', account: 'anthropic:old', accountLabel: 'Their PC', enabled: true, speedOptions: [] }];
  for (const convert of [portableModels, localModels]) {
    const converted = convert(bundle);
    assert.deepEqual(converted, [{ name: 'A', provider: 'anthropic', backend: 'a1', enabled: true, speedOptions: [] }]);
  }
  assert.equal(portableModels('not a list'), 'not a list');
});

test('migrate strips account fields and de-duplicates, then persists the cleaned list once', async () => {
  reset([
    { name: 'A', provider: 'anthropic', backend: 'a1', account: 'anthropic:old', accountLabel: 'Work', enabled: false },
    { name: 'A', provider: 'anthropic', backend: 'a1', account: 'anthropic:new', enabled: true },
  ]);
  const registry = new ModelRegistry(context(), accountSource);
  await registry.migrate();
  assert.equal(globalThis.__dshUpdates.length, 1);
  const [[key, saved]] = globalThis.__dshUpdates;
  assert.equal(key, 'models');
  assert.deepEqual(saved, [{ name: 'A', provider: 'anthropic', backend: 'a1', enabled: true }]);

  await registry.migrate();
  assert.equal(globalThis.__dshUpdates.length, 1, 'a clean list is not written again');
});

test('a model synced from another PC resolves through this PC\'s default account', async () => {
  reset([{ name: 'Claude', provider: 'anthropic', backend: 'claude-x', account: 'anthropic:their-pc', accountLabel: 'Their PC', enabled: true }]);
  const accounts = { ...accountSource, getSecret: async id => id === work.id ? 'secret' : undefined };
  const route = await new ModelRegistry(context(), accounts).resolve('Claude');
  assert.equal(route.account, work);
  assert.equal(route.secret, 'secret');
});

test('resolve names the missing provider when it has no account here', async () => {
  reset([{ name: 'DeepSeek V4 Flash', provider: 'deepseek-official', backend: 'deepseek-v4-flash', enabled: true }]);
  const registry = new ModelRegistry(context(), accountSource);
  await assert.rejects(registry.resolve('DeepSeek V4 Flash'),
    /^Error: No account for DeepSeek V4 Flash \(deepseek-official\)\. Sign in to a provider in Providers\.$/);
});

test('set writes the model without account fields', async () => {
  reset([]);
  const registry = new ModelRegistry(context(), accountSource);
  await registry.set({ name: 'Claude', provider: 'anthropic', backend: 'claude-x', account: 'anthropic:old', accountLabel: 'Work', enabled: true });
  const saved = globalThis.__dshUpdates.at(-1)[1];
  assert.equal(saved.length, 1);
  assert.equal('account' in saved[0], false);
  assert.equal('accountLabel' in saved[0], false);
});
