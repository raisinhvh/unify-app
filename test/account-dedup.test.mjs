import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// OAuth accounts: one record per provider + email, sign-out removes the record and its credentials, and only a
// confirmed invalid sign-in is treated as gone. The Claude Code CLI is replaced by a scripted child process.
const storage = await mkdtemp(join(tmpdir(), 'unify-account-dedup-'));

globalThis.__dshOauthCalls = [];
globalThis.__dshOauthReply = () => ({ code: 0 });
globalThis.__dshOauthSpawn = (command, args, options) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  globalThis.__dshOauthCalls.push({ args, env: options.env });
  const reply = globalThis.__dshOauthReply(args, options.env);
  if (reply.writeFile) writeFileSync(reply.writeFile, reply.text);
  setImmediate(() => {
    if (reply.error) { child.emit('error', new Error('spawn failed')); return; }
    if (reply.output) child.stdout.emit('data', Buffer.from(reply.output));
    child.emit('close', reply.code ?? 0);
  });
  return child;
};

const bundled = await build({
  stdin: { contents: "export * from './accounts/oauthCli.ts';", resolveDir: 'src/engine', loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'fake-cli', setup(builder) {
    builder.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'process', namespace: 'fake' }));
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }) => ({ contents: path === 'process'
      ? 'export const spawn = (...args) => globalThis.__dshOauthSpawn(...args);'
      : `export const workspace = { getConfiguration: () => ({ get: () => undefined }) };
         export const env = { openExternal: async () => true };
         export const Uri = { parse: value => ({ value }) };` }));
  } }],
});
const { checkOAuthAccount, OAuthCliAccounts } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

after(async () => {
  await rm(storage, { recursive: true, force: true });
});

function memento() {
  const store = new Map();
  return {
    get: (key, fallback) => store.has(key) ? structuredClone(store.get(key)) : fallback,
    update: async (key, value) => { store.set(key, structuredClone(value)); },
  };
}

function accountsWith() {
  const context = { globalState: memento(), globalStorageUri: { fsPath: storage } };
  return { context, oauth: new OAuthCliAccounts(context) };
}

/** Script the CLI: a sign-in writes `token` into the account's config directory and `auth status` reports `email`. */
function scriptSignIn(token, email) {
  globalThis.__dshOauthReply = (args, env) => {
    if (args.includes('login')) {
      return { code: 0, writeFile: join(env.CLAUDE_CONFIG_DIR, 'token.txt'), text: token };
    }
    if (args.includes('status')) return { code: 0, output: JSON.stringify({ loggedIn: true, email, authMethod: 'claude.ai' }) };
    return { code: 0 };
  };
}

/** Writes a fake claude account directory on disk and seeds the registry with it. */
async function seedClaude(context, id, email, token) {
  const directory = join(storage, 'oauth', 'claude-cli', id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'token.txt'), token);
  const list = context.globalState.get('unify.oauthCliAccounts.v1', []);
  await context.globalState.update('unify.oauthCliAccounts.v1', [...list, { id: `claude-cli:${id}`, provider: 'claude-cli', label: id, email, directory }]);
  return { id: `claude-cli:${id}`, directory };
}

test('signing in again with the same email (any case) keeps one record and refreshes its credentials', async () => {
  const { oauth } = accountsWith();
  scriptSignIn('first-token', 'Me@Example.com');
  const first = await oauth.add('claude-cli', 'Work');
  scriptSignIn('second-token', 'me@example.COM');
  const again = await oauth.add('claude-cli', 'Personal');
  assert.equal(again.id, first.id);
  assert.equal(again.label, 'Work');
  assert.equal(oauth.list('claude-cli').length, 1);
  assert.equal(await readFile(join(first.directory, 'token.txt'), 'utf8'), 'second-token');
  assert.deepEqual(await readdir(join(storage, 'oauth', 'claude-cli')), [first.directory.split(/[\\/]/).pop()]);
});

test('a different email is a second account', async () => {
  const { oauth } = accountsWith();
  scriptSignIn('a', 'one@example.com');
  await oauth.add('claude-cli', 'One');
  scriptSignIn('b', 'two@example.com');
  await oauth.add('claude-cli', 'Two');
  assert.equal(oauth.list('claude-cli').length, 2);
});

test('collapseDuplicates keeps the chosen default and removes the other directories', async () => {
  const { context, oauth } = accountsWith();
  const keep = await seedClaude(context, 'keep', 'same@example.com', 'k');
  const drop = await seedClaude(context, 'drop', 'SAME@example.com', 'd');
  await oauth.setDefault('claude-cli', keep.id);
  assert.equal(await oauth.collapseDuplicates(), 1);
  assert.deepEqual(oauth.list('claude-cli').map(account => account.id), [keep.id]);
  assert.equal(existsSync(drop.directory), false);
  assert.equal(existsSync(keep.directory), true);
  assert.equal(oauth.getDefault('claude-cli').id, keep.id);
});

test('collapseDuplicates without a chosen default keeps the newest record', async () => {
  const { context, oauth } = accountsWith();
  const older = await seedClaude(context, 'older', 'x@example.com', 'o');
  const newer = await seedClaude(context, 'newer', 'x@example.com', 'n');
  assert.equal(await oauth.collapseDuplicates(), 1);
  assert.deepEqual(oauth.list('claude-cli').map(account => account.id), [newer.id]);
  assert.equal(existsSync(older.directory), false);
});

test('sign-out removes the record, its credentials, and moves the default to the next account', async () => {
  const { context, oauth } = accountsWith();
  const first = await seedClaude(context, 'first', 'a@example.com', 'a');
  const second = await seedClaude(context, 'second', 'b@example.com', 'b');
  await oauth.setDefault('claude-cli', first.id);
  globalThis.__dshOauthCalls = [];
  await oauth.remove(first.id);
  assert.equal(oauth.get(first.id), undefined);
  assert.equal(existsSync(first.directory), false);
  assert.equal(existsSync(second.directory), true);
  assert.equal(oauth.getDefault('claude-cli').id, second.id);
  assert.ok(globalThis.__dshOauthCalls.some(call => call.args.includes('logout')), 'the CLI session is logged out too');
});

test('sign-out of a ChatGPT account removes its directory', async () => {
  const { context, oauth } = accountsWith();
  const directory = join(storage, 'oauth', 'codex-cli', 'codex-one');
  await mkdir(directory, { recursive: true });
  await context.globalState.update('unify.oauthCliAccounts.v1', [{ id: 'codex-cli:one', provider: 'codex-cli', label: 'Work', directory }]);
  await oauth.remove('codex-cli:one');
  assert.equal(oauth.list('codex-cli').length, 0);
  assert.equal(existsSync(directory), false);
});

test('checkOAuthAccount treats only a confirmed sign-out as invalid', async () => {
  const claude = { id: 'claude-cli:c', provider: 'claude-cli', label: 'C', directory: join(storage, 'oauth', 'claude-cli', 'check') };
  await mkdir(claude.directory, { recursive: true });
  globalThis.__dshOauthReply = () => ({ code: 1, output: JSON.stringify({ loggedIn: false }) });
  assert.equal(await checkOAuthAccount(claude), 'invalid');
  globalThis.__dshOauthReply = () => ({ code: 0, output: JSON.stringify({ loggedIn: true }) });
  assert.equal(await checkOAuthAccount(claude), 'valid');
  globalThis.__dshOauthReply = () => ({ code: 0, output: 'not json' });
  assert.equal(await checkOAuthAccount(claude), 'unknown');
  globalThis.__dshOauthReply = () => ({ error: true });
  assert.equal(await checkOAuthAccount(claude), 'unknown', 'a CLI that cannot start is not a sign-out');

  const codex = { id: 'codex-cli:x', provider: 'codex-cli', label: 'X', directory: join(storage, 'oauth', 'codex-cli', 'missing-auth') };
  await mkdir(codex.directory, { recursive: true });
  assert.equal(await checkOAuthAccount(codex), 'invalid', 'a ChatGPT account with no auth file is gone');
});
