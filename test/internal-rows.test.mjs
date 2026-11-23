import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Import what `npm run build:test` produces; that build bundles internalRows into toolDisplay.
const previousHome = process.env.UNIFY_HOME;
const settingsHome = mkdtempSync(join(tmpdir(), 'unify-internal-rows-home-'));
process.env.UNIFY_HOME = settingsHome;
const { internalToolOf } = await import('../dist/runtime/toolDisplay.mjs');
// Prime the feature cache with the defaults before the temp home is removed.
internalToolOf({ tool: 'read_file', input: { file_path: 'README.md' } }, { dataHome: settingsHome, projectRoots: [] });
if (previousHome === undefined) delete process.env.UNIFY_HOME;
else process.env.UNIFY_HOME = previousHome;
rmSync(settingsHome, { recursive: true, force: true });

const places = { dataHome: 'C:/Users/Test/.unify', projectRoots: ['C:/Work/App'], globalVault: 'D:/Knowledge/Vault' };
const history = { kind: 'history.refresh', label: 'Refreshing earlier conversation' };
const memoryRead = (detail) => ({ kind: 'memory.read', label: 'Checking memory', ...(detail ? { detail } : {}) });
const memoryWrite = (detail) => ({ kind: 'memory.write', label: 'Saving to memory', ...(detail ? { detail } : {}) });
const classify = (tool, input) => internalToolOf({ tool, input }, places);
const classifyOn = (tool, input, overrides) => internalToolOf({ tool, input }, { ...places, ...overrides });

test('internal rows: transcript reads across data, project and relative paths', () => {
  for (const path of [
    'C:/Users/Test/.unify/transcripts/old.json',
    'C:/Work/App/.unify/transcripts/old.json',
    './.unify/transcripts/old.json',
  ]) {
    assert.deepEqual(classify('read_file', { file_path: path }), history, path);
  }
  assert.deepEqual(classify('mcp__unify__grep', { path: 'C:/Work/App/.unify/transcripts' }), history);
});

test('internal rows: reading and searching memory shows one note name', () => {
  assert.deepEqual(classify('read_file', { file_path: 'C:/Users/Test/.unify/memory/INDEX.md' }), memoryRead('INDEX'));
  assert.deepEqual(classify('grep', { path: 'C:/Work/App/.unify/global-memory/notes/conventions.md', pattern: 'style' }), memoryRead('conventions'));
  assert.deepEqual(classify('list_dir', { path: 'D:/Knowledge/Vault/notes' }), memoryRead());
});

test('internal rows: nested memory edits and writes in every vault', () => {
  for (const path of [
    'C:/Users/Test/.unify/memory/deep/notes/idea.md',
    'C:/Work/App/.unify/global-memory/deep/notes/idea.md',
    'D:/Knowledge/Vault/deep/notes/idea.md',
  ]) {
    assert.deepEqual(classify('write_file', { file_path: path }), memoryWrite('idea'), path);
    assert.deepEqual(classify('edit', { file_path: path }), memoryWrite('idea'), path);
  }
});

test('internal rows: unrelated and dedicated tools retain ordinary rows', () => {
  assert.equal(classify('read_file', { file_path: 'C:/Work/App/src/engine.ts' }), undefined);
  assert.equal(classify('unknown_tool', { path: '.unify/memory/INDEX.md' }), undefined);
  for (const tool of ['read_chat_history', 'checkpoint', 'read_file_summaries']) {
    assert.equal(classify(tool, { file_path: '.unify/memory/INDEX.md' }), undefined, tool);
  }
  assert.equal(classify('write', { path: '.unify/transcripts/old.json' }), undefined);
});

test('internal rows: each batch child is classified independently', () => {
  const children = [
    { tool: 'read_file', input: { file_path: '.unify/memory/INDEX.md' }, expected: memoryRead('INDEX') },
    { tool: 'search', input: { path: 'C:/Work/App/.unify/transcripts/old.json' }, expected: history },
    { tool: 'list_dir', input: { path: 'D:/Knowledge/Vault/notes' }, expected: memoryRead() },
    { tool: 'read_file', input: { file_path: 'C:/Work/App/src/main.ts' }, expected: undefined },
  ];
  for (const child of children) {
    assert.deepEqual(internalToolOf(child, places), child.expected, child.tool);
  }
});

test('internal rows: multiple memory notes have no misleading detail', () => {
  assert.deepEqual(classify('read_file', { paths: [
    { file_path: '.unify/memory/alpha.md' },
    { file_path: '.unify/memory/beta.md' },
  ] }), memoryRead());
});

test('internal rows: one project path makes the whole call ordinary', () => {
  assert.equal(classify('read_file', { paths: [
    { file_path: '.unify/memory/alpha.md' },
    { file_path: 'src/main.ts' },
  ] }), undefined);
  assert.equal(classify('read_file', { file_path: 'src/main.ts', pattern: '.unify/memory/alpha.md' }), undefined);
  assert.deepEqual(classify('read_file', { paths: [
    { file_path: '.unify/memory/alpha.md' },
    { file_path: '.unify/transcripts/old.json' },
  ] }), memoryRead('alpha'));
});

test('internal rows: a vault at home or above a project is ignored', () => {
  const home = homedir().replace(/\\/g, '/');
  assert.equal(classifyOn('read_file', { file_path: `${home}/Documents/notes.md` }, { globalVault: home }), undefined);
  assert.equal(classifyOn('read_file', { file_path: 'C:/Work/App/src/main.ts' }, { globalVault: 'C:/Work' }), undefined);
  assert.deepEqual(classifyOn('read_file', { file_path: 'C:/Work/App/.unify/memory/INDEX.md' }, { globalVault: 'C:/Work' }), memoryRead('INDEX'));
});

test('internal rows: memory and transcripts only match directly under a data root', () => {
  assert.equal(classify('read_file', {
    file_path: 'C:/Users/Test/.unify/agent-runtime/node_modules/package/memory/notes.md',
  }), undefined);
  assert.equal(classify('read_file', {
    file_path: 'C:/Work/App/.unify/vendor/dependency/transcripts/old.json',
  }), undefined);
  assert.equal(classify('read_file', { file_path: '.unify/nested/memory/notes.md' }), undefined);
  assert.deepEqual(classify('read_file', { file_path: 'C:/Work/App/.unify/transcripts/chat/part.json' }), history);
});

test('internal rows: path forms normalize like the tools that wrote them', () => {
  const windows = { platform: 'win32' };
  assert.deepEqual(classifyOn('read_file', {
    file_path: '/c/Users/Test/.unify/memory/INDEX.md',
  }, windows), memoryRead('INDEX'));
  assert.deepEqual(classifyOn('read_file', {
    file_path: '\\\\?\\C:\\Users\\Test\\.unify\\memory\\INDEX.md',
  }, windows), memoryRead('INDEX'));
  assert.deepEqual(classifyOn('read_file', {
    file_path: 'file:///C:/Users/Test/.unify/memory/INDEX.md',
  }, windows), memoryRead('INDEX'));
  assert.equal(classify('read_file', { file_path: 'C:/Work/App/.unify/../src/x.ts' }), undefined);
  assert.equal(classify('read_file', { file_path: '.unify/../src/x.ts' }), undefined);
});

test('internal rows: path comparison is case-sensitive off Windows', () => {
  const path = 'c:/users/test/.unify/memory/INDEX.md';
  assert.equal(classifyOn('read_file', { file_path: path }, { platform: 'linux' }), undefined);
  assert.deepEqual(classifyOn('read_file', { file_path: path }, { platform: 'win32' }), memoryRead('INDEX'));
});

test('internal rows: settings toggle suppresses internalToolOf', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'unify-internal-rows-'));
  const previous = process.env.UNIFY_HOME;
  process.env.UNIFY_HOME = temp;
  writeFileSync(join(temp, 'settings.json'), JSON.stringify({ features: { 'chat.friendlyInternalRows': false } }));
  try {
    // A fresh query string loads an isolated copy of the bundle, so its settings cache is empty.
    const disabled = await import(`../dist/runtime/toolDisplay.mjs?disabled=${Date.now()}`);
    assert.equal(disabled.internalToolOf({ tool: 'read_file', input: { file_path: '.unify/memory/INDEX.md' } }, places), undefined);
    assert.deepEqual(classify('read_file', { file_path: '.unify/memory/INDEX.md' }), memoryRead('INDEX'));
  } finally {
    if (previous === undefined) delete process.env.UNIFY_HOME;
    else process.env.UNIFY_HOME = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});
