import assert from 'node:assert/strict';
import { BackgroundProcessList } from '../dist/unify/backgroundProcesses.mjs';

// Injected clock and timers: lingering entries are dropped when the fake timer runs.
let clock = 5_000;
const timers = [];
const changes = [];
const list = new BackgroundProcessList({
  onChange: (sessionId, processes) => changes.push({ sessionId, processes }),
  now: () => clock,
  setTimeout: (callback, ms) => {
    const timer = { callback, ms, cleared: false };
    timers.push(timer);
    return timer;
  },
  clearTimeout: handle => { handle.cleared = true; },
});
const lastChange = () => changes.at(-1);
const fire = () => {
  for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback();
};

// Add and update: a running entry, stoppable when it has a stop function.
list.add('chat-a', { id: 'bg1', kind: 'shell', title: 'npm run dev', detail: 'Dev server' });
assert.deepEqual(lastChange().processes, [{ id: 'bg1', kind: 'shell', title: 'npm run dev', detail: 'Dev server', startedAt: 5_000, state: 'running' }]);
assert.equal(lastChange().sessionId, 'chat-a');
let stopped = 0;
list.add('chat-a', { id: 'sub1', kind: 'subagent', title: 'Sol: write tests', stop: () => { stopped += 1; } });
assert.equal(lastChange().processes[1].stoppable, true);
assert.equal(list.list('chat-b').length, 0, 'chats are separate');

clock = 6_000;
list.update('chat-a', 'bg1', { title: 'npm run dev (3 files)' });
assert.equal(list.list('chat-a')[0].title, 'npm run dev (3 files)');

// Stop: calls the stop function, marks the entry stopped and lingers it for 5 s.
assert.equal(list.stop('chat-a', 'bg1'), false, 'an entry without a stop function cannot be stopped');
assert.equal(list.stop('chat-a', 'sub1'), true);
assert.equal(stopped, 1);
const sub = list.list('chat-a').find(item => item.id === 'sub1');
assert.equal(sub.state, 'stopped');
assert.equal(sub.stoppable, undefined);
assert.equal(sub.endedAt, 6_000);
assert.equal(list.stop('chat-a', 'sub1'), false, 'a stopped entry cannot be stopped again');
assert.equal(timers.at(-1).ms, 5_000);

// Linger: ended entries drop out when their timer fires.
fire();
assert.deepEqual(list.list('chat-a').map(item => item.id), ['bg1']);

// End: a finished process keeps its state for 5 s, then is gone.
clock = 9_000;
list.end('chat-a', 'bg1', 'error');
assert.equal(list.list('chat-a')[0].state, 'error');
assert.equal(list.list('chat-a')[0].endedAt, 9_000);
list.end('chat-a', 'bg1', 'done');
assert.equal(list.list('chat-a')[0].state, 'error', 'ending twice keeps the first state');
fire();
assert.equal(list.list('chat-a').length, 0);
assert.deepEqual(lastChange().processes, []);

// Sync: one source's list is mirrored, other sources are left alone.
list.add('chat-c', { id: 'manual', kind: 'task', title: 'Manual task' });
list.sync('chat-c', 'claude', [
  { id: 'c1', kind: 'shell', title: 'npm run watch', detail: 'Watch the build' },
  { id: 'c2', kind: 'task', title: 'Explore the repo' },
]);
assert.deepEqual(list.list('chat-c').map(item => [item.id, item.state]), [['manual', 'running'], ['c1', 'running'], ['c2', 'running']]);
list.sync('chat-c', 'claude', [{ id: 'c1', kind: 'shell', title: 'npm run watch' }]);
const afterSync = Object.fromEntries(list.list('chat-c').map(item => [item.id, item.state]));
assert.deepEqual(afterSync, { manual: 'running', c1: 'running', c2: 'done' }, 'a task no longer reported ends as done');
assert.equal(list.list('chat-c').find(item => item.id === 'c1').detail, undefined);
list.sync('chat-c', 'claude', []);
assert.equal(list.list('chat-c').find(item => item.id === 'c1').state, 'done');
assert.equal(list.list('chat-c').find(item => item.id === 'manual').state, 'running');

// Clear: a closed chat drops everything at once.
list.clear('chat-c');
assert.deepEqual(lastChange(), { sessionId: 'chat-c', processes: [] });
assert.equal(list.list('chat-c').length, 0);

// A listener error does not break the source.
const broken = new BackgroundProcessList({ onChange: () => { throw new Error('listener'); }, now: () => 1 });
broken.add('chat-d', { id: 'x', kind: 'shell', title: 'npm test' });
assert.equal(broken.list('chat-d').length, 1);

console.log('background-processes tests passed');
