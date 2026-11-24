import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeHunks, applySelectedHunks } from '../dist/review/hunks.mjs';
import { alignLineEndings } from '../dist/review/guards.mjs';
import { compareVersions, isVersion } from '../dist/update/version.mjs';

const source = await readFile('src/engine/extension.ts', 'utf8');
const bundle = await build({
  stdin: { contents: source + '\nexport { ExtensionHost, UnifySidebarProvider };', resolveDir: resolve('src/engine'), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
  logOverride: { 'import-is-undefined': 'silent' },
  plugins: [{ name: 'vscode-stub', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const workspace = { isTrusted: true }; export const window = {}; export const Uri = { file: path => ({ fsPath: path }) };' }));
  } }],
});
const { ExtensionHost, UnifySidebarProvider } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('a one-line edit in a large file is one small hunk, not a whole-file rewrite', () => {
  const base = Array.from({ length: 2400 }, (_, i) => `line ${i}\n`).join('');
  const current = base.replace('line 1200\n', 'changed\n');
  const hunks = computeHunks(base, current);
  assert.equal(hunks.length, 1);
  assert.deepEqual([hunks[0].baseStart, hunks[0].baseEnd, hunks[0].currentStart, hunks[0].currentEnd], [1200, 1201, 1200, 1201]);
  assert.equal(applySelectedHunks(base, current, [hunks[0].id]), current);
});

test('myers hunks round trip random edits and stay minimal', () => {
  let seed = 7;
  const random = max => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % max; };
  for (let round = 0; round < 60; round += 1) {
    const base = Array.from({ length: random(60) }, () => `l${random(8)}\n`);
    const current = [...base];
    for (let edits = random(6); edits > 0; edits -= 1) {
      const at = random(current.length + 1);
      if (random(2)) current.splice(at, random(3), ...Array.from({ length: random(3) }, () => `n${random(5)}\n`));
      else current.splice(at, 1);
    }
    const before = base.join('');
    const after = current.join('');
    const hunks = computeHunks(before, after);
    assert.equal(applySelectedHunks(before, after, hunks.map(h => h.id)), after);
    assert.equal(applySelectedHunks(before, after, []), before);
    for (const hunk of hunks) assert.ok(hunk.baseEnd > hunk.baseStart || hunk.currentEnd > hunk.currentStart);
  }
});

test('line-ending-only rewrites are aligned back to the reviewed style', () => {
  const base = 'a\r\nb\r\nc\r\n';
  assert.equal(alignLineEndings(base, 'a\nb\nc\n'), base);
  assert.equal(alignLineEndings(base, 'a\nB\nc\n'), 'a\r\nB\r\nc\r\n');
  assert.equal(alignLineEndings('a\nb\n', 'a\r\nb\r\n'), 'a\nb\n');
  assert.equal(alignLineEndings('single', 'single\n'), 'single\n');
  const mixed = 'a\r\nb\n';
  assert.equal(alignLineEndings(mixed, 'x\ny\n'), 'x\ny\n');
  assert.deepEqual(computeHunks(base, alignLineEndings(base, 'a\nb\nc\n')), []);
});

test('version comparison follows semver precedence including release candidates', () => {
  assert.ok(isVersion('0.2.0-rc.2'));
  assert.ok(!isVersion('latest'));
  assert.ok(compareVersions('0.2.0', '0.2.0-rc.2') > 0);
  assert.ok(compareVersions('0.2.0-rc.10', '0.2.0-rc.2') > 0);
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0-rc.2') === 0);
  assert.ok(compareVersions('0.1.9', '0.2.0-rc.2') < 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-beta') < 0);
});

test('concurrent delegate_task calls run independently and reject invalid requests', async () => {
  const host = Object.create(ExtensionHost.prototype);
  let active = 0;
  let peak = 0;
  let started = 0;
  let notifyStarted;
  const bothStarted = new Promise(resolveStarted => { notifyStarted = resolveStarted; });
  let release;
  const gate = new Promise(resolveGate => { release = resolveGate; });
  Object.assign(host, {
    childRuns: new Set(), placesByChat: new Map(), sidebar: { postMessage() {} },
    delegationProfiles: () => [{ name: 'a', model: 'm', mode: 'read-only' }, { name: 'b', model: 'm', mode: 'read-only' }],
    subagentInfos: () => [{ name: 'a' }, { name: 'b' }],
    availableModel: () => ({ name: 'm', enabled: true, backend: 'x', provider: 'deepseek-official' }),
    resolveRoute: async () => ({ model: {} }), releaseRuntime: async () => {}, mcpServers: () => [],
    summariesOn: () => false, memorySettings: () => ({ enabled: false }), autoCompactAt: () => undefined,
    ensureRuntime: async () => ({ key: 'k', runtime: {
      newSession: async () => 'session', closeSession: async () => {},
      prompt: async () => {
        active += 1;
        peak = Math.max(peak, active);
        if (++started === 2) notifyStarted();
        await gate;
        active -= 1;
      },
    } }),
  });
  const chat = { record: { id: 'chat', modelName: 'm' }, turnEntryId: 't', mirror: { cwd: process.cwd() }, children: new Set(), locks: new Map() };
  const pending = Promise.all([
    host.runSubagent(chat, { agent: 'a', task: 'one' }),
    host.runSubagent(chat, { agent: 'b', task: 'two' }),
  ]);
  try {
    await bothStarted;
    assert.equal(peak, 2);
  } finally { release(); }
  const results = await pending;
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.isError, undefined);
    assert.match(result.text, /finished without a written report/);
  }
  const missing = await host.runSubagent(chat, { agent: 'missing', task: 'three' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /Unknown subagent "missing"/);
  const empty = await host.runSubagent(chat, {});
  assert.equal(empty.isError, true);
  assert.match(empty.text, /Unknown subagent ""/);
  const invalid = await host.runSubagent(chat, { agent: 'a', task: '  ' });
  assert.equal(invalid.isError, true);
  assert.match(invalid.text, /"task" is required/);
});

test('queue mode waits for the running turn while interrupt mode cancels it', async () => {
  for (const mode of ['queue', 'interrupt']) {
    const host = Object.create(ExtensionHost.prototype);
    const chat = { running: true, record: { id: 'chat' }, queue: [{ prompt: 'earlier', images: [] }] };
    const calls = [];
    Object.assign(host, {
      active: { id: 'chat' }, chats: new Map([['chat', chat]]), deletedSessions: new Set(), promptStarts: new Map(),
      saveImages: async () => [], loadChat: async () => chat, replayTranscript: () => {},
      cancel: (clear, id) => calls.push(['cancel', clear, id]),
      sidebar: { postMessage: message => calls.push(message) },
    });
    await host.sendPrompt('next', undefined, undefined, undefined, mode);
    assert.deepEqual(chat.queue.map(item => item.prompt), mode === 'queue' ? ['earlier', 'next'] : ['next', 'earlier']);
    assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'cancel'), mode === 'interrupt');
    const queued = calls.find(call => call.type === 'queueState');
    assert.deepEqual(queued.items, mode === 'queue' ? ['earlier', 'next'] : ['next', 'earlier']);
  }
});

test('the sidebar tracks queued messages and forgets deleted sessions', () => {
  const sidebar = new UnifySidebarProvider({});
  sidebar.postMessage({ type: 'userMessage', sessionId: 'chat', entryId: 'u', text: 'hi' });
  sidebar.postMessage({ type: 'queueState', sessionId: 'chat', items: ['later'] });
  assert.deepEqual(sidebar.state.queues.chat, ['later']);
  sidebar.postMessage({ type: 'queueState', sessionId: 'chat', items: [] });
  assert.deepEqual(sidebar.state.queues.chat, []);
  sidebar.postMessage({ type: 'sessionDeleted', sessionId: 'chat' });
  assert.equal(sidebar.hasTimeline('chat'), false);
});

test('deleting a chat removes its record, transcript, mirror and selects the next chat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unify-delete-'));
  try {
    const mirrorId = '11111111-1111-4111-8111-111111111111';
    const host = Object.create(ExtensionHost.prototype);
    const store = new Map([['unify.ide.sessions.v1', [
      { id: 'one', name: 'One', mirrorId },
      { id: 'two', name: 'Two', mirrorId: '22222222-2222-4222-8222-222222222222' },
    ]], ['unify.ide.activeSession.v1', 'one']]);
    const calls = [];
    Object.assign(host, {
      deletedSessions: new Set(), chats: new Map(), chatLoads: new Map(), transcripts: new Map([['one', []]]), active: { id: 'one' },
      backgroundProcesses: { clear() {} },
      context: { workspaceState: { get: (key, fallback) => store.has(key) ? store.get(key) : fallback, update: async (key, value) => { store.set(key, value); } }, globalStorageUri: { fsPath: dir } },
      unloadChat: async id => { calls.push(['unload', id]); host.active = undefined; },
      saveTranscripts: async () => {}, refreshSessions: () => {}, syncActiveView: () => {}, updateStatus: () => {},
      continueChat: async id => { calls.push(['continue', id]); },
      root: () => ({ uri: { fsPath: dir } }), output: { appendLine: line => calls.push(line) },
      sidebar: { postMessage: message => calls.push(message) },
    });
    await host.deleteSession('one');
    assert.deepEqual(store.get('unify.ide.sessions.v1').map(item => item.id), ['two']);
    assert.equal(store.get('unify.ide.activeSession.v1'), 'two');
    assert.ok(host.deletedSessions.has('one'));
    assert.ok(calls.some(call => call.type === 'sessionDeleted' && call.sessionId === 'one'));
    assert.deepEqual(calls.filter(Array.isArray), [['unload', 'one'], ['continue', 'two']]);
    await host.saveSession({ id: 'one', name: 'One' });
    assert.deepEqual(store.get('unify.ide.sessions.v1').map(item => item.id), ['two']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('memory folders are always allowed, and edits outside the project are never approved silently', async () => {
  const host = Object.create(ExtensionHost.prototype);
  const asked = [];
  Object.assign(host, { childRuns: new Set(), askInChat: async (_id, title) => { asked.push(title); return false; } });
  const chat = { record: { id: 'chat' }, cancelRequested: false, locks: new Map(), mirror: { cwd: '/copy' } };
  const parent = { owner: 'parent', label: '', readOnly: false };
  const edit = path => ({ tool: 'Edit', input: { file_path: path } });
  for (const mode of ['ask', 'auto']) {
    host.approvalMode = mode;
    assert.equal(await host.decideApproval(chat, parent, 'Edit', edit('/copy/.unify/global-memory/tools/rig.md')), true, mode);
    assert.equal(await host.decideApproval(chat, parent, 'Edit', edit('.unify/memory/notes.md')), true, mode);
  }
  // With memory turned off, its folders are ordinary files again and ask like any other edit.
  host.approvalMode = 'ask';
  host.memorySettings = () => ({ enabled: false });
  assert.equal(await host.decideApproval(chat, parent, 'Edit', edit('.unify/memory/notes.md')), false);
  assert.deepEqual(asked.splice(0), ['Permission requested']);
  delete host.memorySettings;
  // Read-only subagents and read-only job phases still may not write memory.
  assert.match(await host.decideApproval(chat, { owner: 'sub', label: 'explorer', readOnly: true }, 'Edit', edit('.unify/memory/notes.md')), /read-only/);
  chat.record.job = { phase: 'verify' };
  assert.match(await host.decideApproval(chat, parent, 'Edit', edit('.unify/memory/notes.md')), /read-only phase/);
  chat.record.job = undefined;
  // Outside the working copy nothing reviews the edit: auto mode and Claude's auto-allow hint ask anyway; full access does not.
  host.approvalMode = 'auto';
  assert.equal(await host.decideApproval(chat, parent, 'Edit', { ...edit('/elsewhere/a.md'), autoAllowEdits: true }), false);
  assert.deepEqual(asked, ['Edit outside the project']);
  host.approvalMode = 'full';
  assert.equal(await host.decideApproval(chat, parent, 'Edit', edit('/elsewhere/a.md')), true);
  // Ordinary project edits keep their existing behavior.
  host.approvalMode = 'auto';
  assert.equal(await host.decideApproval(chat, parent, 'Edit', { ...edit('src/a.ts'), autoAllowEdits: true }), true);
});
