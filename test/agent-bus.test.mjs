import { test, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { build } from 'esbuild';

// The bus reads its scope from Unify's feature settings. Substitute an in-memory settings module so
// the test never touches the user's real ~/.dsh/unify/settings.json.
globalThis.__unifyFeatures = { 'agents.messaging': true, 'agents.messaging.scope': 'everyone' };

const bundled = await build({
  entryPoints: ['src/engine/unify/agentBusImpl.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{
    name: 'in-memory-settings',
    setup(builder) {
      builder.onResolve({ filter: /\/settings$/ }, () => ({ path: 'settings', namespace: 'test-settings' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-settings' }, () => ({
        contents: 'export function getUnifyFeature(id) { return globalThis.__unifyFeatures[id]; }',
      }));
    },
  }],
});
const { agentBus } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const DEFAULT_FEATURES = { 'agents.messaging': true, 'agents.messaging.scope': 'everyone' };
let registeredIds = [];
let unsubscribeFns = [];

function setFeatures(values) {
  globalThis.__unifyFeatures = { ...DEFAULT_FEATURES, ...values };
}

/** Registers an agent and remembers it for cleanup. */
function addAgent(id, extras = {}) {
  const agent = { id, name: id, task: 'test task', chatId: 'chat-a', state: 'running', ...extras };
  agentBus.register(agent);
  registeredIds.push(agent.id);
  return agent;
}

function subscribe() {
  const events = [];
  unsubscribeFns.push(agentBus.onEvent(event => events.push(event)));
  return events;
}

afterEach(() => {
  for (const unsubscribe of unsubscribeFns) unsubscribe();
  unsubscribeFns = [];
  for (const id of registeredIds) agentBus.unregister(id);
  registeredIds = [];
  setFeatures({});
});

test('registering agents announces the roster and listVisible hides the caller', () => {
  const events = subscribe();
  addAgent('main-a', { name: 'Main' });
  addAgent('sub-b', { name: 'Sol', chatId: 'chat-b', parentId: 'main-a' });
  assert.equal(events.filter(event => event.kind === 'roster').length, 2);
  const roster = events.at(-1);
  assert.deepEqual(roster.agents.map(agent => agent.id), ['main-a', 'sub-b']);
  assert.deepEqual(agentBus.listVisible('main-a').map(agent => agent.id), ['sub-b']);
  assert.deepEqual(agentBus.listVisible('sub-b').map(agent => agent.id), ['main-a']);
});

test('everyone scope delivers a message once and emits a message event', () => {
  const events = subscribe();
  addAgent('main-a', { name: 'Main' });
  addAgent('main-b', { name: 'Other main', chatId: 'chat-b' });
  const sent = agentBus.send('main-a', 'main-b', '  Can you check the build?  ');
  assert.equal(sent.fromId, 'main-a');
  assert.equal(sent.fromName, 'Main');
  assert.equal(sent.toId, 'main-b');
  assert.equal(sent.toName, 'Other main');
  assert.equal(sent.text, 'Can you check the build?');
  assert.equal(typeof sent.sentAt, 'number');
  assert.equal(sent.replyToId, undefined);
  const messages = events.filter(event => event.kind === 'message');
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].message, sent);
  assert.deepEqual(agentBus.takeInbox('main-b'), [sent]);
  assert.deepEqual(agentBus.takeInbox('main-b'), []);
  assert.equal(agentBus.takeInbox('main-a').length, 0);
});

test('a reply keeps the id of the message it answers', () => {
  addAgent('main-a');
  addAgent('sub-b', { parentId: 'main-a' });
  const question = agentBus.send('main-a', 'sub-b', 'Which file failed?');
  const reply = agentBus.send('sub-b', 'main-a', 'src/a.ts.', question.id);
  assert.equal(reply.replyToId, question.id);
  assert.equal(agentBus.takeInbox('main-a')[0].replyToId, question.id);
});

test('same-chat scope limits visibility and sending to the same chat', () => {
  setFeatures({ 'agents.messaging.scope': 'same-chat' });
  addAgent('main-a', { name: 'Main' });
  addAgent('sub-a', { name: 'Child', parentId: 'main-a' });
  addAgent('main-b', { name: 'Elsewhere', chatId: 'chat-b' });
  assert.deepEqual(agentBus.listVisible('main-a').map(agent => agent.id), ['sub-a']);
  assert.throws(() => agentBus.send('main-a', 'main-b', 'hello'), /same-chat/);
  assert.equal(agentBus.send('main-a', 'sub-a', 'hello').toId, 'sub-a');
});

test('parent-child scope allows only direct parent and children', () => {
  setFeatures({ 'agents.messaging.scope': 'parent-child' });
  addAgent('parent', { name: 'Main' });
  addAgent('child-1', { name: 'Sol', parentId: 'parent' });
  addAgent('child-2', { name: 'Luna', parentId: 'parent' });
  addAgent('grandchild', { name: 'Deep', parentId: 'child-1' });
  assert.deepEqual(agentBus.listVisible('child-1').map(agent => agent.id).sort(), ['grandchild', 'parent']);
  assert.equal(agentBus.send('child-1', 'parent', 'question').toId, 'parent');
  assert.equal(agentBus.send('parent', 'child-2', 'answer').toId, 'child-2');
  assert.throws(() => agentBus.send('child-1', 'child-2', 'sibling'), /parent-child/);
  assert.throws(() => agentBus.send('parent', 'grandchild', 'skip a level'), /parent-child/);
  assert.throws(() => agentBus.send('grandchild', 'parent', 'skip a level'), /parent-child/);
});

test('messaging turned off refuses list and send with a clear message', () => {
  addAgent('main-a');
  addAgent('main-b', { chatId: 'chat-b' });
  setFeatures({ 'agents.messaging': false });
  assert.throws(() => agentBus.listVisible('main-a'), /turned off/);
  assert.throws(() => agentBus.send('main-a', 'main-b', 'hello'), /turned off/);
});

test('unknown, self and empty messages fail with readable errors', () => {
  addAgent('main-a', { name: 'Main' });
  assert.throws(() => agentBus.send('main-a', 'missing', 'hello'), /No running agent has id "missing"/);
  assert.throws(() => agentBus.send('missing', 'main-a', 'hello'), /No running agent has id "missing"/);
  assert.throws(() => agentBus.send('main-a', 'main-a', 'hello'), /cannot message itself/);
  addAgent('main-b', { chatId: 'chat-b' });
  assert.throws(() => agentBus.send('main-a', 'main-b', '   '), /needs some text/);
});

test('update changes agent state, unregister removes it and drops its inbox', () => {
  const events = subscribe();
  addAgent('main-a', { name: 'Main' });
  addAgent('main-b', { chatId: 'chat-b' });
  agentBus.update('main-a', { state: 'waiting' });
  assert.equal(events.at(-1).agents.find(agent => agent.id === 'main-a').state, 'waiting');
  agentBus.send('main-b', 'main-a', 'hello');
  agentBus.unregister('main-a');
  assert.equal(events.at(-1).kind, 'roster');
  assert.deepEqual(events.at(-1).agents.map(agent => agent.id), ['main-b']);
  assert.deepEqual(agentBus.takeInbox('main-a'), []);
  assert.deepEqual(agentBus.listVisible('main-b'), []);
});

test('unsubscribing stops roster and message events', () => {
  const events = [];
  const unsubscribe = agentBus.onEvent(event => events.push(event));
  unsubscribe();
  addAgent('main-a');
  addAgent('main-b', { chatId: 'chat-b' });
  agentBus.send('main-a', 'main-b', 'hello');
  assert.equal(events.length, 0);
});
