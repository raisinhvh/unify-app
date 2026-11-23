/**
 * Tests for the Unify screens' request dispatcher.
 *
 * The engine modules are bundled with esbuild into `test/.tmp` (never outside the repo) and imported as an ES
 * module. Every store is pointed at a temporary home and workspace, so nothing reads or writes the real
 * `~/.dsh`. `AGENTS_HOME` is redirected for the same reason (skills live under `~/.agents`).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tempRoot = join(here, '.tmp', `requests-${process.pid}-${Date.now()}`);
const bundleFile = join(tempRoot, 'requests.mjs');
await mkdir(tempRoot, { recursive: true });
await build({
  entryPoints: [join(here, '../src/engine/unify/requests/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundleFile,
  external: ['esbuild'],
});
const { handleUnifyRequest, disposeUnifyRequestWatchers } = await import(pathToFileURL(bundleFile).href);

const home = join(tempRoot, 'home');
const dshHome = join(home, '.dsh');
const unifyRoot = join(dshHome, 'unify');
const workspace = join(home, 'project');
const agentsHome = join(home, '.agents');
const previousAgentsHome = process.env.AGENTS_HOME;
process.env.AGENTS_HOME = agentsHome;

const context = { workspaceRoot: workspace, dshHome, unifyRoot, version: '9.9.9' };

async function send(message) {
  const replies = [];
  const handled = await handleUnifyRequest(message, reply => replies.push(reply), context);
  return { handled, replies };
}

const ofType = (replies, type) => replies.filter(message => message.type === type);

async function seed() {
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(unifyRoot, { recursive: true });
  await writeFile(join(workspace, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(workspace, 'README.md'), '# Project\n', 'utf8');
  await writeFile(join(dshHome, 'AGENTS.md'), '# Rules\n\n## Existing Rule\n\nKeep this.\n\n## Second Rule\n\nAlso keep this.\n', 'utf8');
  await mkdir(join(dshHome, 'toolpacks/legacy'), { recursive: true });
  await writeFile(join(dshHome, 'toolpacks/legacy/pack.ts'), 'export default { name: "legacy" };\n', 'utf8');
  await mkdir(join(dshHome, 'skills/foo'), { recursive: true });
  await writeFile(join(dshHome, 'skills/foo/SKILL.md'), '---\nname: foo\ndescription: A demo skill\n---\n# Foo\n', 'utf8');
  await mkdir(join(agentsHome, 'skills/bar'), { recursive: true });
  await writeFile(join(agentsHome, 'skills/bar/SKILL.md'), '---\nname: bar\ndescription: Another skill\n---\n# Bar\n', 'utf8');
  await mkdir(join(dshHome, 'memory/workflow'), { recursive: true });
  await writeFile(join(dshHome, 'memory/workflow/release.md'), '# Release flow\n\nTag, then push.\n', 'utf8');
  await writeFile(join(dshHome, 'memory/top.md'), '# Top note\n\nBody.\n', 'utf8');
  const accountDir = join(tempRoot, 'accounts/claude');
  await mkdir(accountDir, { recursive: true });
  await writeFile(join(accountDir, 'auth.json'), '{"token":"x"}\n', 'utf8');
  await writeFile(join(accountDir, '.claude.json'), '{"signedIn":true}\n', 'utf8');
  await writeFile(join(dshHome, 'unify/state.json'), JSON.stringify({
    'dsh.oauthCliAccounts.v1': [{ id: 'acc1', provider: 'claude-cli', label: 'Claude', email: 'a@example.com', directory: accountDir }],
    'dsh.accounts.v1': [{ id: 'api1', provider: 'self-hosted', label: 'Server', metadata: { baseURL: 'http://localhost:1234' } }],
    'dsh.oauthCliDefaults.v1': { 'claude-cli': 'acc1' },
  }, null, 2), 'utf8');
  await writeFile(join(dshHome, 'unify/settings.json'), JSON.stringify({
    'dsh.models': [{ name: 'Claude Default', provider: 'claude-cli', enabled: true }],
  }, null, 2), 'utf8');
  return { accountDir };
}

const seeded = await seed();

after(async () => {
  disposeUnifyRequestWatchers();
  if (previousAgentsHome === undefined) delete process.env.AGENTS_HOME;
  else process.env.AGENTS_HOME = previousAgentsHome;
  await rm(tempRoot, { recursive: true, force: true });
});

test('files: listing, reading, versioned writes, search and traversal rejection', async () => {
  const listing = await send({ type: 'listDir', requestId: 'f1', path: '' });
  assert.equal(listing.handled, true);
  assert.equal(ofType(listing.replies, 'workspaceState')[0].root, workspace);
  const dir = ofType(listing.replies, 'dirListing')[0];
  assert.equal(dir.requestId, 'f1');
  assert.ok(dir.entries.some(entry => entry.name === 'src' && entry.kind === 'dir'));
  assert.ok(dir.entries.some(entry => entry.name === 'README.md' && entry.kind === 'file'));

  const read = await send({ type: 'readFile', requestId: 'f2', path: 'src/a.ts' });
  const file = ofType(read.replies, 'fileContent')[0].file;
  assert.equal(file.content, 'export const a = 1;\n');
  assert.equal(file.language, 'typescript');
  assert.match(file.version, /^[0-9a-f]{40}$/);

  const stale = await send({ type: 'writeFile', requestId: 'f3', path: 'src/a.ts', content: 'changed\n', version: 'stale' });
  assert.equal(ofType(stale.replies, 'fileConflict')[0].current.content, 'export const a = 1;\n');

  const saved = await send({ type: 'writeFile', requestId: 'f4', path: 'src/a.ts', content: 'changed\n', version: file.version });
  const reread = await send({ type: 'readFile', requestId: 'f4b', path: 'src/a.ts' });
  assert.equal(ofType(saved.replies, 'fileSaved')[0].version, ofType(reread.replies, 'fileContent')[0].file.version);

  const created = await send({ type: 'writeFile', requestId: 'f5', path: 'src/new.ts', content: 'new\n', version: '' });
  assert.equal(ofType(created.replies, 'fileSaved')[0].path, 'src/new.ts');
  assert.equal(await readFile(join(workspace, 'src/new.ts'), 'utf8'), 'new\n');

  const matches = await send({ type: 'findFiles', requestId: 'f6', query: 'a', limit: 10 });
  assert.ok(ofType(matches.replies, 'fileMatches')[0].paths.includes('src/a.ts'));

  const traversal = await send({ type: 'listDir', requestId: 'f7', path: '../' });
  const error = ofType(traversal.replies, 'filesError')[0];
  assert.equal(error.requestId, 'f7');
  assert.match(error.message, /Invalid file path/);
});

test('knowledge: rules, memory, audiences, skill import and removal', async () => {
  const list = await send({ type: 'knowledgeList' });
  const items = ofType(list.replies, 'knowledgeState')[0].items;
  assert.ok(items.some(item => item.id === 'rule:global:existing-rule' && item.kind === 'rule'));
  assert.ok(items.some(item => item.id === 'skill:dsh:skills/foo/SKILL.md' && item.kind === 'skill'));
  assert.ok(items.some(item => item.kind === 'memory' && item.folder === 'workflow'));

  const saveRule = await send({
    type: 'saveKnowledge',
    requestId: 'k1',
    item: { kind: 'rule', scope: 'global', name: 'Batch commands', audiences: ['main'] },
    content: 'Run independent commands together.',
  });
  const rule = ofType(saveRule.replies, 'knowledgeSaved')[0].item;
  assert.equal(rule.id, 'rule:global:batch-commands');
  assert.deepEqual(rule.audiences, ['main']);
  assert.match(await readFile(join(dshHome, 'AGENTS.md'), 'utf8'), /## Batch commands/);

  const read = await send({ type: 'readKnowledge', requestId: 'k2', id: 'rule:global:batch-commands' });
  assert.equal(ofType(read.replies, 'knowledgeContent')[0].content, 'Run independent commands together.');

  const audience = await send({ type: 'setKnowledgeAudience', id: 'rule:global:existing-rule', audiences: ['subagents'] });
  const updated = ofType(audience.replies, 'knowledgeState')[0].items.find(item => item.id === 'rule:global:existing-rule');
  assert.deepEqual(updated.audiences, ['subagents']);

  const saveMemory = await send({
    type: 'saveKnowledge',
    requestId: 'k3',
    item: { kind: 'memory', scope: 'global', name: 'Release flow', folder: 'workflow', audiences: ['everyone'] },
    content: '# Release flow\n\nUpdated.\n',
  });
  assert.equal(ofType(saveMemory.replies, 'knowledgeSaved')[0].item.id, 'memory:global:workflow/release-flow.md');

  const imported = await send({
    type: 'importSkillFolder',
    requestId: 'k4',
    scope: 'global',
    name: 'demo-skill',
    files: [
      { path: 'SKILL.md', content: '---\nname: demo-skill\ndescription: Demo\n---\n# Demo\n' },
      { path: 'references/notes.md', content: 'Notes.\n' },
    ],
  });
  const skill = ofType(imported.replies, 'knowledgeSaved')[0].item;
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.name, 'demo-skill');
  assert.ok(skill.files.includes('references/notes.md'));
  assert.ok(existsSync(join(agentsHome, 'skills/demo-skill/references/notes.md')));

  const removed = await send({ type: 'removeKnowledge', requestId: 'k5', id: 'rule:global:batch-commands' });
  assert.equal(ofType(removed.replies, 'knowledgeRemoved')[0].id, 'rule:global:batch-commands');
  assert.doesNotMatch(await readFile(join(dshHome, 'AGENTS.md'), 'utf8'), /Batch commands/);

  const bad = await send({ type: 'readKnowledge', requestId: 'k6', id: 'skill:agents:../../escape/SKILL.md' });
  assert.match(ofType(bad.replies, 'knowledgeError')[0].message, /no longer exists/);
});

test('providers: labels, default model, model toggle and OAuth sign-out', async () => {
  const rename = await send({ type: 'renameAccount', accountId: 'acc1', label: 'Work' });
  const renamed = ofType(rename.replies, 'accountsState')[0].accounts.find(account => account.id === 'acc1');
  assert.equal(renamed.label, 'Work');

  const state = JSON.parse(await readFile(join(dshHome, 'unify/state.json'), 'utf8'));
  assert.equal(state['dsh.oauthCliAccounts.v1'][0].label, 'Work');

  const defaultModel = await send({ type: 'setAccountDefaultModel', accountId: 'acc1', modelId: 'Claude Default' });
  assert.equal(ofType(defaultModel.replies, 'accountsState')[0].accounts.find(account => account.id === 'acc1').defaultModel, 'Claude Default');

  const toggle = await send({ type: 'setModelEnabled', modelId: 'Claude Default', enabled: false });
  assert.deepEqual(toggle.replies, []);
  const settings = JSON.parse(await readFile(join(dshHome, 'unify/settings.json'), 'utf8'));
  assert.equal(settings['dsh.models'][0].enabled, false);
  const providerStore = JSON.parse(await readFile(join(dshHome, 'unify/providers.json'), 'utf8'));
  assert.equal(providerStore.modelEnabled['Claude Default'], false);

  assert.ok(existsSync(join(seeded.accountDir, 'auth.json')));
  const signOut = await send({ type: 'signOutAccount', accountId: 'acc1' });
  const signedOut = ofType(signOut.replies, 'accountsState')[0].accounts.find(account => account.id === 'acc1');
  assert.ok(signedOut, 'the account record stays');
  assert.equal(existsSync(join(seeded.accountDir, 'auth.json')), false);
  assert.equal(existsSync(join(seeded.accountDir, '.claude.json')), false);

  const apiKey = await send({ type: 'signOutAccount', accountId: 'api1' });
  assert.ok(ofType(apiKey.replies, 'accountsState')[0].accounts.some(account => account.id === 'api1'));
});

test('toolpacks: per-tool switches and group policies are persisted', async () => {
  const tool = await send({ type: 'toolpackToolEnabled', id: 'spreadsheets', tool: 'read_sheet', enabled: false });
  assert.equal(tool.handled, true);
  const permission = await send({ type: 'toolpackPermission', id: 'spreadsheets', group: 'write', policy: 'off' });
  assert.equal(permission.handled, true);
  const store = JSON.parse(await readFile(join(dshHome, 'unify/toolpacks.json'), 'utf8'));
  assert.equal(store.packs.spreadsheets.tools.read_sheet, false);
  assert.equal(store.packs.spreadsheets.permissions.write, 'off');

  const invalid = await send({ type: 'toolpackPermission', id: 'spreadsheets', group: 'invalid', policy: 'off' });
  assert.equal(invalid.handled, true);
  assert.equal(ofType(invalid.replies, 'filesError').length, 0);
});

test('setup: tool check, DSH import scan/import, complete flag and default project', async () => {
  const tools = await send({ type: 'checkTools' });
  const list = ofType(tools.replies, 'toolsState')[0].tools;
  assert.deepEqual(list.map(tool => tool.id), ['git', 'node', 'claude']);
  assert.equal(list.find(tool => tool.id === 'node').state, 'found');

  const scan = await send({ type: 'scanDshImports' });
  const result = ofType(scan.replies, 'dshImportState')[0].scan;
  assert.deepEqual(result.toolpacks, ['legacy']);
  assert.equal(result.rules, 2);
  assert.equal(result.skills, 3);
  assert.equal(result.memoryNotes, 3);

  const imported = await send({ type: 'importFromDsh', what: 'toolpacks' });
  assert.equal(ofType(imported.replies, 'dshImportResult')[0].count, 1);
  assert.ok(existsSync(join(dshHome, 'unify/storage/toolpacks/legacy/pack.ts')));

  const again = await send({ type: 'importFromDsh', what: 'toolpacks' });
  assert.equal(ofType(again.replies, 'dshImportResult')[0].count, 0);

  const knowledge = await send({ type: 'importFromDsh', what: 'knowledge' });
  assert.equal(ofType(knowledge.replies, 'dshImportResult')[0].count, 8);

  const initial = await send({ type: 'getSetupState' });
  assert.equal(ofType(initial.replies, 'setupState')[0].complete, false);

  const project = { name: 'Demo', path: workspace };
  const complete = await send({ type: 'setupComplete', summary: { accounts: ['Claude'], project, tools: ['git', 'node'], theme: 'graphite', toolpacks: 'imported', knowledge: 'imported' } });
  const done = ofType(complete.replies, 'setupState')[0];
  assert.equal(done.complete, true);
  assert.deepEqual(done.defaultProject, project);

  const fresh = await send({ type: 'getSetupState' });
  assert.equal(ofType(fresh.replies, 'setupState')[0].complete, true);

  const other = join(home, 'other');
  const changed = await send({ type: 'setDefaultProject', project: { name: 'Other', path: other } });
  assert.deepEqual(ofType(changed.replies, 'setupState')[0].defaultProject, { name: 'Other', path: other });
});

test('settings and unknown messages', async () => {
  const info = await send({ type: 'getAppInfo' });
  const app = ofType(info.replies, 'appInfo')[0].info;
  assert.equal(app.version, '9.9.9');
  assert.equal(app.channel, 'stable');
  assert.equal(app.dataFolder, dshHome);
  assert.deepEqual(app.update, { state: 'idle' });

  const check = await send({ type: 'checkForUpdates' });
  assert.equal(ofType(check.replies, 'appInfo')[0].info.update.state, 'current');
  assert.equal(typeof ofType(check.replies, 'appInfo')[0].info.update.checkedAt, 'number');

  const install = await send({ type: 'installUpdate' });
  assert.equal(ofType(install.replies, 'appInfo')[0].info.update.state, 'error');
  assert.match(ofType(install.replies, 'appInfo')[0].info.update.message, /installed by the app/);

  const unknown = await send({ type: 'definitelyNotOurs' });
  assert.equal(unknown.handled, false);
  assert.deepEqual(unknown.replies, []);
});
