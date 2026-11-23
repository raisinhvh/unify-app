import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// `gh` must never run in tests: count the spawns and return the token a test set.
globalThis.__ghSpawns = 0;
globalThis.__ghToken = undefined;
const bundled = await build({
  entryPoints: ['src/engine/unify/github.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [{
    name: 'stub-gh-cli',
    setup(builder) {
      builder.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'child_process', namespace: 'test-gh' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-gh' }, () => ({
        contents: `
          export function execFile(_file, _args, _options, callback) {
            globalThis.__ghSpawns += 1;
            const token = globalThis.__ghToken;
            setImmediate(() => callback(token ? null : new Error('gh not available'), token || ''));
          }
        `,
      }));
    },
  }],
});
const { configureGithubSecretStore, getGithubAuth, refreshGithubAuth, setGithubToken, clearGithubToken } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function memorySecretStore(initial) {
  let saved = initial;
  return {
    get: async () => saved,
    store: async (_key, value) => { saved = value; },
    delete: async () => { saved = undefined; },
    current: () => saved,
  };
}

function stubFetch(...validTokens) {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    const authorization = options.headers.authorization;
    seen.push(authorization);
    const token = authorization.replace(/^Bearer /, '');
    return validTokens.includes(token)
      ? { ok: true, status: 200, json: async () => ({ login: `${token}-user` }) }
      : { ok: false, status: 401 };
  };
  return { seen, restore: () => { globalThis.fetch = originalFetch; } };
}

test('GitHub tokens validate through stub fetch, reject safely and clear', async () => {
  const store = memorySecretStore(undefined);
  const fetch = stubFetch('valid-token');
  configureGithubSecretStore(store);
  try {
    assert.deepEqual(await setGithubToken(' valid-token '), { token: 'valid-token', login: 'valid-token-user', source: 'token' });
    assert.equal(store.current(), 'valid-token');
    assert.equal((await getGithubAuth()).login, 'valid-token-user');
    await assert.rejects(setGithubToken('secret-invalid'), error => {
      assert.match(error.message, /GitHub rejected this token/);
      assert.doesNotMatch(error.message, /secret-invalid/);
      return true;
    });
    assert.equal(store.current(), 'valid-token');
    assert.deepEqual(fetch.seen, ['Bearer valid-token', 'Bearer secret-invalid']);
    await clearGithubToken();
    assert.equal(store.current(), undefined);
  } finally {
    fetch.restore();
    configureGithubSecretStore(undefined);
  }
});

test('a token saved in Settings is preferred over a signed-in gh CLI', async () => {
  const store = memorySecretStore('stored-token');
  const fetch = stubFetch('stored-token', 'gh-token');
  configureGithubSecretStore(store);
  globalThis.__ghSpawns = 0;
  globalThis.__ghToken = 'gh-token';
  try {
    assert.deepEqual(await getGithubAuth(), { token: 'stored-token', login: 'stored-token-user', source: 'token' });
    assert.equal(globalThis.__ghSpawns, 0);
    assert.deepEqual(fetch.seen, ['Bearer stored-token']);
  } finally {
    fetch.restore();
    configureGithubSecretStore(undefined);
  }
});

test('gh is spawned once within the cache TTL, including when it has no token', async () => {
  globalThis.__ghSpawns = 0;
  globalThis.__ghToken = 'gh-token';
  const store = memorySecretStore(undefined);
  const fetch = stubFetch('gh-token');
  configureGithubSecretStore(store);
  try {
    assert.deepEqual(await getGithubAuth(), { token: 'gh-token', login: 'gh-token-user', source: 'gh' });
    assert.equal(globalThis.__ghSpawns, 1);
    // Signing out of a pasted token clears the auth cache but keeps the gh lookup cached.
    await clearGithubToken();
    assert.equal((await getGithubAuth()).source, 'gh');
    assert.equal(globalThis.__ghSpawns, 1);

    globalThis.__ghToken = undefined;
    assert.equal(await refreshGithubAuth(), undefined);
    assert.equal(globalThis.__ghSpawns, 2);
    // A cached "gh has no token" answer does not spawn it again.
    configureGithubSecretStore(store);
    assert.equal(await getGithubAuth(), undefined);
    assert.equal(globalThis.__ghSpawns, 2);
  } finally {
    fetch.restore();
    configureGithubSecretStore(undefined);
  }
});
