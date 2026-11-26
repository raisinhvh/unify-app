import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Messages from other agents must reach a chat that is blocked waiting: on background tasks after its reply, or
// inside wait_for_subagents. Settings are an in-memory stub so the test never reads the user's ~/.unify/settings.json.
const features = { 'agents.messaging': true, 'agents.messaging.scope': 'everyone' };
globalThis.__agentWakeFeatures = features;

const settingsFile = resolve('src/engine/unify/settings');
const source = await readFile('src/engine/extension.ts', 'utf8');
const bundle = await build({
  stdin: { contents: `${source}\nexport { ExtensionHost };\nexport { agentBus } from './unify/agentBusImpl';`, resolveDir: resolve('src/engine'), loader: 'ts' },
  bundle: true, loader: { '.sh': 'text' }, write: false, platform: 'node', format: 'esm',
  logOverride: { 'import-is-undefined': 'silent' },
  plugins: [{ name: 'stubs', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    builder.onResolve({ filter: /settings$/ }, args => resolve(args.resolveDir, args.path) === settingsFile ? { path: 'settings', namespace: 'settings-stub' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const workspace = { isTrusted: true }; export const window = {}; export const Uri = { file: path => ({ fsPath: path }) };' }));
    builder.onLoad({ filter: /.*/, namespace: 'settings-stub' }, () => ({ contents: [
      'const features = globalThis.__agentWakeFeatures;',
      'export const ENGINE_FEATURE_DEFAULTS = {};',
      'export function unifyHome() { return process.cwd(); }',
      'export function resetUnifySettingsCache() {}',
      'export function getUnifyFeature(id) { return features[id]; }',
      'export function allUnifyFeatures() { return { ...features }; }',
      'export function setUnifyFeature(id, value) { features[id] = value; }',
      'export function onUnifyFeatureChange() { return () => {}; }',
    ].join('\n') }));
  } }],
});
const { ExtensionHost, agentBus } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function setup(waiting) {
  agentBus.register({ id: 'chat', role: 'main', task: 'main task', chatId: 'chat', state: 'running' });
  agentBus.register({ id: 'other', role: 'main', task: 'other task', chatId: 'other', state: 'running' });
  const said = [];
  const chat = {
    running: true, jobActive: false, cancelRequested: false, record: { id: 'chat', name: 'Chat', provider: 'claude-cli' },
    turnReply: 'Started the build.', turnTools: [], background: new Map(), breakMessage() {},
    cli: { waitingOnBackground: () => waiting, say: text => { said.push(text); return true; } },
  };
  const host = Object.create(ExtensionHost.prototype);
  Object.assign(host, {
    chats: new Map([['chat', chat]]), deletedSessions: new Set(), promptStarts: new Map(), messageWakes: new Map(), transcripts: new Map(),
    output: { appendLine() {} }, postRun() {}, sidebar: { postMessage() {} },
  });
  const cleanup = () => {
    agentBus.takeInbox('chat');
    agentBus.unregister('chat');
    agentBus.unregister('other');
  };
  return { chat, host, said, cleanup };
}

test('a message reaches a Claude chat that finished its reply and waits on background tasks', () => {
  const { chat, host, said, cleanup } = setup(true);
  try {
    agentBus.send('other', 'chat', 'The API is ready, go ahead.');
    host.wakeForMessages(chat);
    assert.equal(said.length, 1);
    assert.match(said[0], /The API is ready, go ahead\./);
    assert.equal(agentBus.hasInbox('chat'), false);
    assert.equal(host.messageWakes.get('chat'), 1);
    const history = host.transcripts.get('chat');
    assert.deepEqual(history.map(item => item.role), ['assistant', 'user']);
    assert.equal(history[1].internal, true);
  } finally { cleanup(); }
});

test('a chat in the middle of its reply keeps its mail for the next tool result', () => {
  const { chat, host, said, cleanup } = setup(false);
  try {
    agentBus.send('other', 'chat', 'Hello.');
    host.wakeForMessages(chat);
    assert.equal(said.length, 0);
    assert.equal(agentBus.hasInbox('chat'), true);
  } finally { cleanup(); }
});

test('wait_for_subagents stops waiting when another agent messages the chat', async () => {
  const { chat, host, cleanup } = setup(false);
  try {
    chat.background.set('task-1', { id: 'task-1', label: 'Sonnet', done: false, finished: new Promise(() => {}) });
    const started = Date.now();
    const waiting = host.waitSubagents(chat, { timeout_seconds: 30 });
    setTimeout(() => agentBus.send('other', 'chat', 'Question for you.'), 50);
    const result = await waiting;
    assert.ok(Date.now() - started < 5_000, 'the wait ended early');
    assert.match(result.text, /another agent messaged you/);
    assert.match(result.text, /Still running: task-1/);
    // The mail itself rides on the tool result through the MCP server's inbox call.
    assert.equal(agentBus.hasInbox('chat'), true);
  } finally { cleanup(); }
});
