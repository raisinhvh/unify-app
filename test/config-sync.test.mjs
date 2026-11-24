import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountForModel, applyFiles, collectFiles, findConfigGist, hashBundle, localModels, parseBundle, portableModels,
  readConfigGist, restoreMcpSecrets, serializeBundle, stripMcpSecrets, syncPath, writeConfigGist, GIST_FILE, LOCAL_SETTINGS, mergeBundles, SYNCED_SETTINGS,
} from '../dist/sync/configSync.mjs';
import { readFileSync } from 'node:fs';

const exists = path => access(path).then(() => true, () => false);

async function roots(t) {
  const base = await mkdtemp(join(tmpdir(), 'unify-sync-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { unifyHome: join(base, 'unify'), agentsHome: join(base, 'agents') };
}

async function put(file, text) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, text);
}

const bundle = (files = {}, settings = {}) => ({ format: 'unify-config', version: 1, settings, files });

test('collects global rules and skills, skipping hidden and bundled folders', async t => {
  const r = await roots(t);
  await put(join(r.unifyHome, 'AGENTS.md'), '# Rules');
  await put(join(r.unifyHome, 'skills', 'alpha', 'SKILL.md'), 'alpha');
  await put(join(r.unifyHome, 'skills', 'alpha', 'refs', 'notes.md'), 'notes');
  await put(join(r.unifyHome, 'skills', '.system', 'builtin', 'SKILL.md'), 'builtin');
  await put(join(r.unifyHome, 'skills', 'loose.md'), 'not in a skill folder');
  await put(join(r.agentsHome, 'skills', 'beta', 'SKILL.md'), 'beta');
  await put(join(r.agentsHome, 'skills', 'beta', 'icon.bin'), Buffer.from([0xff, 0x00, 0xfe]));
  await put(join(r.unifyHome, 'sessions', 'log.json'), '{}');
  const files = await collectFiles(r);
  assert.deepEqual(Object.keys(files).sort(), ['agents/skills/beta/SKILL.md', 'agents/skills/beta/icon.bin', 'unify/AGENTS.md', 'unify/skills/alpha/SKILL.md', 'unify/skills/alpha/refs/notes.md']);
  assert.deepEqual(files['unify/AGENTS.md'], { data: '# Rules' });
  assert.deepEqual(files['agents/skills/beta/icon.bin'], { data: Buffer.from([0xff, 0x00, 0xfe]).toString('base64'), encoding: 'base64' });
});

test('applying files writes, updates and deletes only synced paths', async t => {
  const source = await roots(t);
  await put(join(source.unifyHome, 'AGENTS.md'), 'remote rules');
  await put(join(source.agentsHome, 'skills', 'keep', 'SKILL.md'), 'remote keep');
  await put(join(source.agentsHome, 'skills', 'new', 'SKILL.md'), 'new skill');
  const remote = await collectFiles(source);

  const target = await roots(t);
  await put(join(target.unifyHome, 'AGENTS.md'), 'local rules');
  await put(join(target.agentsHome, 'skills', 'keep', 'SKILL.md'), 'local keep');
  await put(join(target.agentsHome, 'skills', 'gone', 'SKILL.md'), 'deleted elsewhere');
  await put(join(target.unifyHome, 'skills', '.system', 'builtin', 'SKILL.md'), 'builtin');
  await put(join(target.unifyHome, 'config.json'), '{}');
  await applyFiles(target, remote);

  assert.equal(await readFile(join(target.unifyHome, 'AGENTS.md'), 'utf8'), 'remote rules');
  assert.equal(await readFile(join(target.agentsHome, 'skills', 'keep', 'SKILL.md'), 'utf8'), 'remote keep');
  assert.equal(await readFile(join(target.agentsHome, 'skills', 'new', 'SKILL.md'), 'utf8'), 'new skill');
  assert.equal(await exists(join(target.agentsHome, 'skills', 'gone')), false, 'emptied skill folder is pruned');
  assert.equal(await exists(join(target.agentsHome, 'skills')), true, 'skills root is kept');
  assert.equal(await exists(join(target.unifyHome, 'skills', '.system', 'builtin', 'SKILL.md')), true);
  assert.equal(await exists(join(target.unifyHome, 'config.json')), true);
  assert.equal(hashBundle(bundle(await collectFiles(target))), hashBundle(bundle(remote)));
});

test('every unify setting either syncs or is listed as staying on this PC', () => {
  const declared = Object.keys(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).contributes.configuration.properties)
    .map(key => key.replace(/^unify\./, ''));
  assert.deepEqual([...SYNCED_SETTINGS, ...LOCAL_SETTINGS].sort(), declared.sort());
});

test('edits made on both PCs merge item by item', () => {
  const base = bundle({ 'unify/AGENTS.md': { data: 'rules' }, 'agents/skills/a/SKILL.md': { data: 'a' } }, { models: [1] });
  const local = bundle({ 'unify/AGENTS.md': { data: 'rules' }, 'agents/skills/a/SKILL.md': { data: 'a' }, 'agents/skills/b/SKILL.md': { data: 'b' } }, { models: [1], subagents: [2] });
  const remote = bundle({ 'unify/AGENTS.md': { data: 'new rules' } }, { models: [1, 3] });
  const { bundle: merged, conflicts } = mergeBundles(base, local, remote);
  assert.deepEqual(conflicts, []);
  // Remote deleted skill a and edited the rules; this PC added skill b and a subagent.
  assert.deepEqual(merged.files, { 'unify/AGENTS.md': { data: 'new rules' }, 'agents/skills/b/SKILL.md': { data: 'b' } });
  assert.deepEqual(merged.settings, { models: [1, 3], subagents: [2] });
  assert.equal('toolpacks' in merged, false);
});

test('an item changed differently on both PCs is a conflict settled by the chosen side', () => {
  const base = bundle({ 'unify/AGENTS.md': { data: 'old' } }, { models: [1] });
  const local = bundle({ 'unify/AGENTS.md': { data: 'mine' } }, { models: [1], nameModel: 'x' });
  const remote = bundle({ 'unify/AGENTS.md': { data: 'theirs' } }, { models: [2] });
  const remoteWins = mergeBundles(base, local, remote);
  assert.deepEqual(remoteWins.conflicts, ['~/.unify/AGENTS.md']);
  assert.deepEqual(remoteWins.bundle.files, remote.files);
  assert.deepEqual(remoteWins.bundle.settings, { models: [2], nameModel: 'x' });
  assert.deepEqual(mergeBundles(base, local, remote, 'local').bundle.files, local.files);
  // The same edit on both sides is not a conflict.
  assert.deepEqual(mergeBundles(base, remote, remote).conflicts, []);
});

test('rejects paths outside the synced folders', () => {
  const r = { unifyHome: join(tmpdir(), 'd'), agentsHome: join(tmpdir(), 'a') };
  for (const path of ['unify/config.json', 'unify/skills/../x/SKILL.md', 'agents/AGENTS.md', 'other/skills/a/SKILL.md', 'unify/skills/.system/a/SKILL.md', 'unify/skills/a/C:x', 'unify/skills/x.md', 'unify/skills//SKILL.md']) {
    assert.throws(() => syncPath(r, path), /unexpected path/, path);
  }
  assert.equal(syncPath(r, 'agents/skills/a/SKILL.md'), join(r.agentsHome, 'skills', 'a', 'SKILL.md'));
  assert.throws(() => parseBundle(JSON.stringify(bundle({ 'unify/../../evil': { data: '' } }))), /unexpected path/);
});

test('bundles parse back and hash independently of key order', () => {
  const a = bundle({ 'unify/AGENTS.md': { data: 'x' } }, { 'features.autoName': false, models: [{ name: 'M', provider: 'p', backend: 'b' }] });
  const b = { files: a.files, settings: { models: [{ backend: 'b', provider: 'p', name: 'M' }], 'features.autoName': false }, version: 1, format: 'unify-config' };
  assert.equal(hashBundle(a), hashBundle(b));
  assert.deepEqual(parseBundle(serializeBundle(a)), JSON.parse(serializeBundle(b)));
  assert.throws(() => parseBundle('{"format":"unify-config","version":2,"settings":{},"files":{}}'), /version 2/);
  assert.throws(() => parseBundle('nope'), /not valid JSON/);
});

test('toolpacks in a config from an older build are dropped, never synced', () => {
  const old = { ...bundle({ 'unify/AGENTS.md': { data: 'x' } }), toolpacks: { echo: { enabled: true, source: 'export default {}' } } };
  const parsed = parseBundle(JSON.stringify(old));
  assert.equal('toolpacks' in parsed, false);
  assert.equal(hashBundle(parsed), hashBundle(bundle({ 'unify/AGENTS.md': { data: 'x' } })));
});

test('MCP env and header values are blanked on upload and refilled on download', () => {
  const local = [
    { name: 'search', command: 'node', args: ['s.js'], env: [{ name: 'API_KEY', value: 'secret' }, { name: 'MODE', value: 'fast' }] },
    { type: 'http', name: 'web', url: 'https://x.test/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] },
  ];
  const uploaded = stripMcpSecrets(local);
  assert.equal(JSON.stringify(uploaded).includes('secret'), false);
  assert.equal(JSON.stringify(uploaded).includes('Bearer'), false);
  assert.deepEqual(uploaded[0].env, [{ name: 'API_KEY', value: '' }, { name: 'MODE', value: '' }]);
  const remote = [...uploaded, { name: 'fresh', command: 'x', env: [{ name: 'TOKEN', value: '' }] }];
  assert.deepEqual(restoreMcpSecrets(remote, local), [...local, remote[2]]);
});

test('synced models carry no account, in either direction', () => {
  const models = [
    { name: 'A', provider: 'deepseek-official', backend: 'x', account: 'acct-1' },
    { name: 'B', provider: 'deepseek-official', backend: 'y', accountLabel: 'Work' },
    { name: 'C', provider: 'deepseek-official', backend: 'z' },
  ];
  const expected = [
    { name: 'A', provider: 'deepseek-official', backend: 'x' },
    { name: 'B', provider: 'deepseek-official', backend: 'y' },
    { name: 'C', provider: 'deepseek-official', backend: 'z' },
  ];
  assert.deepEqual(portableModels(models), expected);
  assert.deepEqual(localModels(models), expected);
});

test('models resolve to their provider default account', () => {
  const work = { id: 'acct-9', provider: 'claude-cli', label: 'Work' };
  const home = { id: 'acct-2', provider: 'claude-cli', label: 'Home' };
  const source = { get: id => [work, home].find(item => item.id === id), list: () => [work, home], getDefault: provider => provider === 'claude-cli' ? home : undefined };
  assert.equal(accountForModel(source, { provider: 'claude-cli', account: 'acct-9' }), home);
  assert.equal(accountForModel(source, { provider: 'codex-cli' }), undefined);
});

function fakeGitHub() {
  const gists = new Map();
  const calls = [];
  let next = 1;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const view = gist => ({ id: gist.id, html_url: `https://gist.github.com/me/${gist.id}`, updated_at: '2026-10-05T00:00:00Z', description: gist.description, files: gist.files });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.authorization });
    const path = new URL(url).pathname;
    if (path === '/gists' && (init.method || 'GET') === 'GET') return json(200, [{ id: 'other', description: 'unrelated', files: { 'a.txt': {} } }, ...[...gists.values()].map(view)]);
    if (path === '/gists' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.equal(body.public, false);
      const gist = { id: `g${next++}`, description: body.description, files: Object.fromEntries(Object.entries(body.files).map(([name, file]) => [name, { content: file.content }])) };
      gists.set(gist.id, gist);
      return json(201, view(gist));
    }
    const id = path.split('/')[2];
    const gist = gists.get(id);
    if (!gist) return json(404, { message: 'Not Found' });
    if (init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      for (const [name, file] of Object.entries(body.files)) gist.files[name] = { content: file.content };
    }
    return json(200, view(gist));
  };
  return { gists, calls, fetchImpl };
}

test('creates, finds, reads and updates the config gist', async () => {
  const github = fakeGitHub();
  assert.equal(await findConfigGist('tok', github.fetchImpl), undefined);
  const first = bundle({ 'unify/AGENTS.md': { data: 'one' } });
  const created = await writeConfigGist('tok', undefined, first, github.fetchImpl);
  assert.equal(created.url, `https://gist.github.com/me/${created.id}`);
  assert.equal((await findConfigGist('tok', github.fetchImpl)).id, created.id);
  assert.equal(hashBundle((await readConfigGist('tok', created.id, github.fetchImpl)).bundle), hashBundle(first));
  const second = bundle({ 'unify/AGENTS.md': { data: 'two' } });
  assert.equal((await writeConfigGist('tok', created.id, second, github.fetchImpl)).id, created.id);
  assert.equal(hashBundle((await readConfigGist('tok', created.id, github.fetchImpl)).bundle), hashBundle(second));
  assert.ok(github.gists.get(created.id).files[GIST_FILE]);
  assert.equal(await readConfigGist('tok', 'missing', github.fetchImpl), undefined);
  assert.equal(await writeConfigGist('tok', 'missing', second, github.fetchImpl), undefined);
  assert.ok(github.calls.every(call => call.url.startsWith('https://api.github.com/') && call.auth === 'Bearer tok'));
});

test('reports GitHub errors with their message', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
  await assert.rejects(findConfigGist('bad', fetchImpl), /HTTP 401: Bad credentials/);
});
