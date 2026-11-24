/**
 * Tests for the Unify screens' request dispatcher.
 *
 * The engine modules are bundled with esbuild into `test/.tmp` (never outside the repo) and imported as an ES
 * module. Every store is pointed at a temporary home and workspace, so nothing reads or writes the real
 * `~/.unify`. `AGENTS_HOME` is redirected for the same reason (skills live under `~/.agents`).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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

const knowledgeBundleFile = join(tempRoot, 'knowledge.mjs');
await build({
  entryPoints: [join(here, '../src/engine/unify/requests/knowledge.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: knowledgeBundleFile,
  external: ['esbuild'],
});
const { openKnowledge } = await import(pathToFileURL(knowledgeBundleFile).href);

const home = join(tempRoot, 'home');
const unifyHome = join(home, '.unify');
const unifyRoot = join(unifyHome, 'unify');
const workspace = join(home, 'project');
const agentsHome = join(home, '.agents');
const previousAgentsHome = process.env.AGENTS_HOME;
process.env.AGENTS_HOME = agentsHome;

const context = { workspaceRoot: workspace, unifyHome, unifyRoot, version: '9.9.9' };

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
  await writeFile(join(unifyHome, 'AGENTS.md'), '# Rules\n\n## Existing Rule\n\nKeep this.\n\n## Second Rule\n\nAlso keep this.\n', 'utf8');
  await mkdir(join(unifyHome, 'skills/foo'), { recursive: true });
  await writeFile(join(unifyHome, 'skills/foo/SKILL.md'), '---\nname: foo\ndescription: A demo skill\n---\n# Foo\n', 'utf8');
  await mkdir(join(agentsHome, 'skills/bar'), { recursive: true });
  await writeFile(join(agentsHome, 'skills/bar/SKILL.md'), '---\nname: bar\ndescription: Another skill\n---\n# Bar\n', 'utf8');
  await mkdir(join(unifyHome, 'memory/workflow'), { recursive: true });
  await writeFile(join(unifyHome, 'memory/workflow/release.md'), '# Release flow\n\nTag, then push.\n', 'utf8');
  await writeFile(join(unifyHome, 'memory/top.md'), '# Top note\n\nBody.\n', 'utf8');
  const accountDir = join(tempRoot, 'accounts/claude');
  await mkdir(accountDir, { recursive: true });
  await writeFile(join(accountDir, 'auth.json'), '{"token":"x"}\n', 'utf8');
  await writeFile(join(accountDir, '.claude.json'), '{"signedIn":true}\n', 'utf8');
  await writeFile(join(unifyHome, 'unify/state.json'), JSON.stringify({
    'unify.oauthCliAccounts.v1': [{ id: 'acc1', provider: 'claude-cli', label: 'Claude', email: 'a@example.com', directory: accountDir }],
    'unify.accounts.v1': [{ id: 'api1', provider: 'self-hosted', label: 'Server', metadata: { baseURL: 'http://localhost:1234' } }],
    'unify.oauthCliDefaults.v1': { 'claude-cli': 'acc1' },
  }, null, 2), 'utf8');
  await writeFile(join(unifyHome, 'unify/settings.json'), JSON.stringify({
    'unify.models': [{ name: 'Claude Default', provider: 'claude-cli', enabled: true }],
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
  assert.ok(items.some(item => item.id === 'skill:unify:skills/foo/SKILL.md' && item.kind === 'skill'));
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
  assert.match(await readFile(join(unifyHome, 'AGENTS.md'), 'utf8'), /## Batch commands/);

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
  assert.doesNotMatch(await readFile(join(unifyHome, 'AGENTS.md'), 'utf8'), /Batch commands/);

  const bad = await send({ type: 'readKnowledge', requestId: 'k6', id: 'skill:agents:../../escape/SKILL.md' });
  assert.match(ofType(bad.replies, 'knowledgeError')[0].message, /no longer exists/);

  const badFile = await send({
    type: 'readKnowledge',
    requestId: 'k7',
    id: 'skill:unify:../../escape/SKILL.md',
    file: 'secret.txt',
  });
  assert.match(ofType(badFile.replies, 'knowledgeError')[0].message, /no longer exists/);

  const escapedSkillFile = await send({
    type: 'readKnowledge',
    requestId: 'k8',
    id: 'skill:unify:skills/foo/SKILL.md',
    file: '../../AGENTS.md',
  });
  assert.match(ofType(escapedSkillFile.replies, 'knowledgeError')[0].message, /Invalid file path/);

  const validSkillFile = await send({
    type: 'readKnowledge',
    requestId: 'k9',
    id: 'skill:agents:skills/demo-skill/SKILL.md',
    file: 'references/notes.md',
  });
  assert.equal(ofType(validSkillFile.replies, 'knowledgeContent')[0].content, 'Notes.\n');

  const renameRule = await send({
    type: 'saveKnowledge',
    requestId: 'k10',
    item: {
      id: 'rule:global:existing-rule',
      kind: 'rule',
      scope: 'global',
      name: 'Renamed Rule',
    },
    content: 'Renamed body.',
  });
  const renamed = ofType(renameRule.replies, 'knowledgeSaved')[0].item;
  assert.equal(renamed.id, 'rule:global:renamed-rule');
  assert.equal(renamed.name, 'Renamed Rule');
  assert.deepEqual(renamed.audiences, ['subagents']);
  assert.equal(renamed.updatedBy, 'you');
  const rulesText = await readFile(join(unifyHome, 'AGENTS.md'), 'utf8');
  assert.match(rulesText, /## Renamed Rule/);
  assert.doesNotMatch(rulesText, /## Existing Rule/);

  // importSkillFolder rejects traversal paths and missing SKILL.md before writing any file.
  const badImportTraversal = await send({
    type: 'importSkillFolder',
    requestId: 'k11',
    scope: 'global',
    name: 'bad-traversal-skill',
    files: [
      { path: 'SKILL.md', content: '---\nname: bad-traversal-skill\n---\n# Bad\n' },
      { path: '../escaped.txt', content: 'nope' },
    ],
  });
  assert.match(ofType(badImportTraversal.replies, 'knowledgeError')[0].message, /Invalid file path/);
  assert.equal(existsSync(join(agentsHome, 'skills/bad-traversal-skill/SKILL.md')), false);

  const missingSkillDoc = await send({
    type: 'importSkillFolder',
    requestId: 'k12',
    scope: 'global',
    name: 'missing-doc-skill',
    files: [
      { path: 'references/notes.md', content: 'Only notes.\n' },
    ],
  });
  assert.match(ofType(missingSkillDoc.replies, 'knowledgeError')[0].message, /SKILL\.md/);
  assert.equal(existsSync(join(agentsHome, 'skills/missing-doc-skill/references/notes.md')), false);

  // Removing top-level memory notes must never remove the memory/ root itself.
  await send({ type: 'removeKnowledge', requestId: 'k13', id: 'memory:global:workflow/release.md' });
  await send({ type: 'removeKnowledge', requestId: 'k14', id: 'memory:global:workflow/release-flow.md' });
  await send({ type: 'removeKnowledge', requestId: 'k15', id: 'memory:global:top.md' });
  assert.equal(existsSync(join(unifyHome, 'memory')), true);
});

test('knowledge: skill ids are validated for open/remove and undo only restores stored versions', async () => {
  const openPaths = { workspaceRoot: workspace, unifyHome: unifyHome, agentsHome };
  const opened = [];
  const launch = target => opened.push(target);

  await openKnowledge(openPaths, 'skill:unify:skills/foo/SKILL.md', undefined, launch);
  assert.deepEqual(opened, [join(unifyHome, 'skills/foo')], 'a known skill opens its folder');
  await assert.rejects(
    openKnowledge(openPaths, 'skill:unify:../../..', undefined, launch),
    /no longer exists/,
  );
  await assert.rejects(
    openKnowledge(openPaths, 'skill:unify:skills/foo/SKILL.md', '../../outside', launch),
    /Invalid file path/,
  );
  assert.deepEqual(opened, [join(unifyHome, 'skills/foo')], 'crafted ids never launch a path');

  // The skills root itself is not a skill folder, even if a SKILL.md sits directly in it.
  const rootSkill = join(agentsHome, 'skills/SKILL.md');
  await writeFile(rootSkill, '---\nname: skills\n---\n# Root\n', 'utf8');
  try {
    const removed = await send({ type: 'removeKnowledge', id: 'skill:agents:skills/SKILL.md' });
    assert.match(ofType(removed.replies, 'knowledgeError')[0].message, /outside the skills folders/);
    assert.ok(existsSync(rootSkill), 'the skills root was not removed');
    assert.ok(existsSync(join(agentsHome, 'skills/bar/SKILL.md')));
  } finally {
    await rm(rootSkill, { force: true });
  }

  const skillFile = join(agentsHome, 'skills/bar/SKILL.md');
  const outsideFile = join(tempRoot, 'outside-undo.txt');
  await writeFile(outsideFile, 'untouched\n', 'utf8');
  const storeFile = join(unifyHome, 'unify/knowledge.json');
  const store = JSON.parse(await readFile(storeFile, 'utf8'));
  store.versions = {
    [resolve(outsideFile)]: [{ at: Date.now(), by: 'agent', content: 'hijacked\n' }],
    [resolve(skillFile)]: [{ at: Date.now(), by: 'agent', content: '---\nname: bar\n---\n# Bar restored\n' }],
  };
  await writeFile(storeFile, JSON.stringify(store, null, 2), 'utf8');

  const escaped = await send({ type: 'undoKnowledgeChange', id: 'skill:unify:../../outside-undo.txt' });
  assert.match(ofType(escaped.replies, 'knowledgeError')[0].message, /no longer exists/);
  assert.equal(await readFile(outsideFile, 'utf8'), 'untouched\n');

  const outsideMemory = await send({ type: 'undoKnowledgeChange', id: 'memory:global:../../outside-undo.txt' });
  assert.match(ofType(outsideMemory.replies, 'knowledgeError')[0].message, /Invalid file path/);
  assert.equal(await readFile(outsideFile, 'utf8'), 'untouched\n');

  const missing = await send({ type: 'undoKnowledgeChange', id: 'skill:unify:skills/foo/SKILL.md' });
  assert.match(ofType(missing.replies, 'knowledgeError')[0].message, /Nothing to undo/);

  const restored = await send({ type: 'undoKnowledgeChange', id: 'skill:agents:skills/bar/SKILL.md' });
  assert.equal(ofType(restored.replies, 'knowledgeState').length, 1);
  assert.match(await readFile(skillFile, 'utf8'), /Bar restored/);
});

test('files: a request can name another project folder', async () => {
  const other = join(home, 'files-other');
  await mkdir(other, { recursive: true });
  await writeFile(join(other, 'only-here.txt'), 'hi\n', 'utf8');

  const listed = await send({ type: 'listDir', requestId: 'fp1', path: '', project: other });
  const workspaceState = ofType(listed.replies, 'workspaceState')[0];
  assert.equal(workspaceState.root, resolve(other));
  assert.deepEqual(ofType(listed.replies, 'dirListing')[0].entries.map(entry => entry.name), ['only-here.txt']);

  const read = await send({ type: 'readFile', requestId: 'fp2', path: 'only-here.txt', project: other });
  assert.equal(ofType(read.replies, 'fileContent')[0].file.content, 'hi\n');

  // A top-level listing re-announces the root, so a reloaded screen learns which folder it shows.
  const back = await send({ type: 'listDir', requestId: 'fp3', path: '' });
  assert.equal(ofType(back.replies, 'workspaceState')[0].root, resolve(workspace));
});

test('files: create, rename and delete entries inside the project only', async () => {
  const created = await send({ type: 'createEntry', requestId: 'e1', path: 'made/deep/new.txt', kind: 'file' });
  assert.equal(ofType(created.replies, 'entryDone')[0].path, 'made/deep/new.txt');
  assert.equal(await readFile(join(workspace, 'made/deep/new.txt'), 'utf8'), '');

  const again = await send({ type: 'createEntry', requestId: 'e2', path: 'made/deep/new.txt', kind: 'file' });
  assert.match(ofType(again.replies, 'filesError')[0].message, /already exists/);

  const folder = await send({ type: 'createEntry', requestId: 'e3', path: 'made/empty', kind: 'dir' });
  assert.equal(ofType(folder.replies, 'entryDone')[0].path, 'made/empty');

  const renamed = await send({ type: 'renameEntry', requestId: 'e4', from: 'made/deep', to: 'made/moved' });
  assert.equal(ofType(renamed.replies, 'entryDone')[0].path, 'made/moved');
  assert.equal(await readFile(join(workspace, 'made/moved/new.txt'), 'utf8'), '');

  const into = await send({ type: 'renameEntry', requestId: 'e5', from: 'made', to: 'made/moved/inside' });
  assert.match(ofType(into.replies, 'filesError')[0].message, /inside itself/);

  for (const [id, body] of [
    ['e6', { type: 'deleteEntry', path: '' }],
    ['e7', { type: 'deleteEntry', path: '../outside' }],
    ['e8', { type: 'createEntry', path: '../escape.txt', kind: 'file' }],
    ['e9', { type: 'renameEntry', from: 'README.md', to: '../README.md' }],
  ]) {
    const refused = await send({ ...body, requestId: id });
    assert.equal(ofType(refused.replies, 'filesError').length, 1, `${id} should be refused`);
  }

  const deleted = await send({ type: 'deleteEntry', requestId: 'e10', path: 'made' });
  assert.equal(ofType(deleted.replies, 'entryDone')[0].path, 'made');
  const listing = ofType((await send({ type: 'listDir', requestId: 'e11', path: '' })).replies, 'dirListing')[0];
  assert.ok(!listing.entries.some(entry => entry.name === 'made'));
});

test('files: copy entries (taken names get " copy") and import files from disk', async () => {
  await mkdir(join(workspace, 'cp/sub'), { recursive: true });
  await writeFile(join(workspace, 'cp/a.txt'), 'A', 'utf8');
  await writeFile(join(workspace, 'cp/sub/b.txt'), 'B', 'utf8');

  const first = await send({ type: 'copyEntry', requestId: 'c1', from: 'cp/a.txt', toFolder: 'cp' });
  assert.equal(ofType(first.replies, 'entryDone')[0].path, 'cp/a copy.txt');
  const second = await send({ type: 'copyEntry', requestId: 'c2', from: 'cp/a.txt', toFolder: 'cp' });
  assert.equal(ofType(second.replies, 'entryDone')[0].path, 'cp/a copy 2.txt');

  const folder = await send({ type: 'copyEntry', requestId: 'c3', from: 'cp/sub', toFolder: '' });
  assert.equal(ofType(folder.replies, 'entryDone')[0].path, 'sub');
  assert.equal(await readFile(join(workspace, 'sub/b.txt'), 'utf8'), 'B');

  const into = await send({ type: 'copyEntry', requestId: 'c4', from: 'cp', toFolder: 'cp/sub' });
  assert.match(ofType(into.replies, 'filesError')[0].message, /into itself/);
  const outside = await send({ type: 'copyEntry', requestId: 'c5', from: 'cp/a.txt', toFolder: '../' });
  assert.equal(ofType(outside.replies, 'filesError').length, 1);

  const external = join(home, 'dropped.txt');
  await writeFile(external, 'from disk', 'utf8');
  const imported = await send({ type: 'importEntries', requestId: 'c6', sources: [external], toFolder: 'cp/sub' });
  assert.deepEqual(ofType(imported.replies, 'entryDone')[0].paths, ['cp/sub/dropped.txt']);
  assert.equal(await readFile(join(workspace, 'cp/sub/dropped.txt'), 'utf8'), 'from disk');
  const relative = await send({ type: 'importEntries', requestId: 'c7', sources: ['dropped.txt'], toFolder: '' });
  assert.equal(ofType(relative.replies, 'filesError').length, 1);
});

test('knowledge: a request can name another project folder for project scope', async () => {
  const other = join(home, 'other-project');
  await mkdir(join(other, '.unify/memory'), { recursive: true });
  await writeFile(join(other, '.unify/memory/elsewhere.md'), '# Elsewhere note\n', 'utf8');

  const picked = ofType((await send({ type: 'knowledgeList', project: other })).replies, 'knowledgeState')[0];
  assert.equal(picked.project, resolve(other));
  assert.ok(picked.items.some(item => item.scope === 'project' && item.name === 'Elsewhere note'));

  const saved = await send({ type: 'saveKnowledge', requestId: 'p1', project: other, item: { kind: 'rule', scope: 'project', name: 'Other rule', audiences: ['everyone'] }, content: 'Only here.' });
  assert.equal(ofType(saved.replies, 'knowledgeSaved').length, 1);
  assert.match(await readFile(join(other, 'AGENTS.md'), 'utf8'), /## Other rule/);
  assert.ok(!existsSync(join(workspace, 'AGENTS.md')) || !/Other rule/.test(await readFile(join(workspace, 'AGENTS.md'), 'utf8')));

  // Without a project (or with a folder that does not exist) it is the open workspace.
  const fallback = ofType((await send({ type: 'knowledgeList', project: join(home, 'missing') })).replies, 'knowledgeState')[0];
  assert.equal(fallback.project, resolve(workspace));
  assert.ok(!fallback.items.some(item => item.name === 'Elsewhere note'));
});

test('providers: labels, default model, model toggle and OAuth sign-out', async () => {
  const rename = await send({ type: 'renameAccount', accountId: 'acc1', label: 'Work' });
  const renamed = ofType(rename.replies, 'accountsState')[0].accounts.find(account => account.id === 'acc1');
  assert.equal(renamed.label, 'Work');

  const state = JSON.parse(await readFile(join(unifyHome, 'unify/state.json'), 'utf8'));
  assert.equal(state['unify.oauthCliAccounts.v1'][0].label, 'Work');

  const defaultModel = await send({ type: 'setAccountDefaultModel', accountId: 'acc1', modelId: 'Claude Default' });
  assert.equal(ofType(defaultModel.replies, 'accountsState')[0].accounts.find(account => account.id === 'acc1').defaultModel, 'Claude Default');

  const toggle = await send({ type: 'setModelEnabled', modelId: 'Claude Default', enabled: false });
  assert.deepEqual(toggle.replies, []);
  const settings = JSON.parse(await readFile(join(unifyHome, 'unify/settings.json'), 'utf8'));
  assert.equal(settings['unify.models'][0].enabled, false);
  const providerStore = JSON.parse(await readFile(join(unifyHome, 'unify/providers.json'), 'utf8'));
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
  const store = JSON.parse(await readFile(join(unifyHome, 'unify/toolpacks.json'), 'utf8'));
  assert.equal(store.packs.spreadsheets.tools.read_sheet, false);
  assert.equal(store.packs.spreadsheets.permissions.write, 'off');

  const invalid = await send({ type: 'toolpackPermission', id: 'spreadsheets', group: 'invalid', policy: 'off' });
  assert.equal(invalid.handled, true);
  assert.equal(ofType(invalid.replies, 'filesError').length, 0);
});

test('setup: tool check, complete flag and default project', async () => {
  const tools = await send({ type: 'checkTools' });
  const list = ofType(tools.replies, 'toolsState')[0].tools;
  assert.deepEqual(list.map(tool => tool.id), ['git', 'node', 'claude']);
  assert.equal(list.find(tool => tool.id === 'node').state, 'found');

  const initial = await send({ type: 'getSetupState' });
  assert.equal(ofType(initial.replies, 'setupState')[0].complete, false);

  const project = { name: 'Demo', path: workspace };
  const complete = await send({ type: 'setupComplete', summary: { accounts: ['Claude'], project, tools: ['git', 'node'], theme: 'graphite' } });
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
  assert.equal(app.dataFolder, unifyHome);
  assert.deepEqual(app.update, { state: 'idle' });

  const check = await send({ type: 'checkForUpdates' });
  assert.equal(check.handled, false, 'update checks belong to the app updater, never a canned engine answer');

  const install = await send({ type: 'installUpdate' });
  assert.equal(ofType(install.replies, 'appInfo')[0].info.update.state, 'error');
  assert.match(ofType(install.replies, 'appInfo')[0].info.update.message, /installed by the app/);

  const unknown = await send({ type: 'definitelyNotOurs' });
  assert.equal(unknown.handled, false);
  assert.deepEqual(unknown.replies, []);
});
