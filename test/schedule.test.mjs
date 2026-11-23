/**
 * `/schedule`: the argument grammar (fixed clock) and the persistent prompt store.
 *
 * Both engine modules are bundled with esbuild, like the other tests, so `npm test` does not depend
 * on the main build's outputs.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tempRoot = join(here, '.tmp', `schedule-${process.pid}-${Date.now()}`);
await mkdir(tempRoot, { recursive: true });

async function bundle(entry, name) {
  const outfile = join(tempRoot, name);
  await build({
    entryPoints: [join(here, '../src/engine/schedule', entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
  });
  return import(pathToFileURL(outfile).href);
}

const { parseScheduleArgs } = await bundle('parse.ts', 'parse.mjs');
const { ScheduledPrompts, SCHEDULE_KEY } = await bundle('store.ts', 'store.mjs');

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// Local time so the expectations do not depend on the machine's time zone.
const now = new Date(2026, 4, 10, 10, 0, 0);
const stamp = (year, month, day, hour, minute, second = 0) => new Date(year, month - 1, day, hour, minute, second, 0).getTime();
const minutes = count => count * 60_000;
const hours = count => count * 3_600_000;
const days = count => count * 86_400_000;

function parsed(args) {
  const result = parseScheduleArgs(args, now);
  assert.ok(!('error' in result), `expected a parsed schedule for ${JSON.stringify(args)}, got ${result.error}`);
  return result;
}

function failed(args) {
  const result = parseScheduleArgs(args, now);
  assert.ok('error' in result, `expected an error for ${JSON.stringify(args)}`);
  return result.error;
}

test('delay forms, units and bare delays', () => {
  assert.deepEqual(parsed('in 10m run the tests'), { dueAt: now.getTime() + minutes(10), prompt: 'run the tests' });
  assert.deepEqual(parsed('in 2h check the build'), { dueAt: now.getTime() + hours(2), prompt: 'check the build' });
  assert.deepEqual(parsed('in 1h30m deploy'), { dueAt: now.getTime() + hours(1.5), prompt: 'deploy' });
  assert.deepEqual(parsed('IN 90 MINUTES Deploy'), { dueAt: now.getTime() + minutes(90), prompt: 'Deploy' });
  assert.deepEqual(parsed('in 1 hour 30 minutes deploy'), { dueAt: now.getTime() + minutes(90), prompt: 'deploy' });
  assert.deepEqual(parsed('in 2 hours review'), { dueAt: now.getTime() + hours(2), prompt: 'review' });
  assert.deepEqual(parsed('in 1 day archive'), { dueAt: now.getTime() + days(1), prompt: 'archive' });
  assert.deepEqual(parsed('in 45s ping'), { dueAt: now.getTime() + 45_000, prompt: 'ping' });
  assert.deepEqual(parsed('in 2 sec ping'), { dueAt: now.getTime() + 2_000, prompt: 'ping' });
  assert.deepEqual(parsed('10m bare'), { dueAt: now.getTime() + minutes(10), prompt: 'bare' });
  assert.deepEqual(parsed('1h30m: bare colon'), { dueAt: now.getTime() + hours(1.5), prompt: 'bare colon' });
  assert.deepEqual(parsed('2h - bare dash'), { dueAt: now.getTime() + hours(2), prompt: 'bare dash' });
  assert.deepEqual(parsed('2h, bare comma'), { dueAt: now.getTime() + hours(2), prompt: 'bare comma' });
  assert.deepEqual(parsed('1 day. not a separator'), { dueAt: now.getTime() + days(1), prompt: '. not a separator' });
});

test('clock times, rollover and day words', () => {
  assert.deepEqual(parsed('at 15:30 stand up'), { dueAt: stamp(2026, 5, 10, 15, 30), prompt: 'stand up' });
  assert.deepEqual(parsed('15:30 stand up'), { dueAt: stamp(2026, 5, 10, 15, 30), prompt: 'stand up' });
  assert.deepEqual(parsed('3pm stand up'), { dueAt: stamp(2026, 5, 10, 15, 0), prompt: 'stand up' });
  assert.deepEqual(parsed('3:15pm stand up'), { dueAt: stamp(2026, 5, 10, 15, 15), prompt: 'stand up' });
  assert.deepEqual(parsed('at 9 am stand up'), { dueAt: stamp(2026, 5, 11, 9, 0), prompt: 'stand up' });
  assert.deepEqual(parsed('noon lunch'), { dueAt: stamp(2026, 5, 10, 12, 0), prompt: 'lunch' });
  assert.deepEqual(parsed('midnight rollover'), { dueAt: stamp(2026, 5, 11, 0, 0), prompt: 'rollover' });
  assert.deepEqual(parsed('tomorrow 9am stand up'), { dueAt: stamp(2026, 5, 11, 9, 0), prompt: 'stand up' });
  assert.deepEqual(parsed('9am tomorrow stand up'), { dueAt: stamp(2026, 5, 11, 9, 0), prompt: 'stand up' });
  assert.deepEqual(parsed('today 15:30 stand up'), { dueAt: stamp(2026, 5, 10, 15, 30), prompt: 'stand up' });
  assert.deepEqual(parsed('at 15:30: with separator'), { dueAt: stamp(2026, 5, 10, 15, 30), prompt: 'with separator' });
  assert.deepEqual(parsed('AT 3PM Uppercase'), { dueAt: stamp(2026, 5, 10, 15, 0), prompt: 'Uppercase' });
});

test('ISO dates and invalid or past times', () => {
  assert.deepEqual(parsed('2026-11-24 09:00 plan'), { dueAt: stamp(2026, 11, 24, 9, 0), prompt: 'plan' });
  assert.deepEqual(parsed('2026-11-24T09:30 plan'), { dueAt: stamp(2026, 11, 24, 9, 30), prompt: 'plan' });
  assert.match(failed('2025-01-01 09:00 past'), /already passed/i);
  assert.match(failed('2026-02-30 09:00 impossible'), /does not exist|already passed/i);
  assert.match(failed('25:00 later'), /does not exist/i);
  assert.match(failed('13pm later'), /does not exist/i);
  assert.match(failed('today 9am already gone'), /already passed/i);
  assert.match(failed('tomorrow today 9am confused'), /do not exist|read a time/i);
});

test('errors include usage and examples', () => {
  assert.match(failed(''), /\/schedule/);
  assert.match(failed('soon do it'), /\/schedule/);
  assert.match(failed('soon do it'), /Examples:/i);
  assert.match(failed('in 2x go'), /\/schedule/);
  assert.match(failed('in 31 days go'), /30 days/i);
  assert.match(failed('31d go'), /30 days/i);
  assert.match(failed('in 2h'), /prompt/i);
  assert.match(failed('at 15:30'), /prompt/i);
});

function fakeMemento(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    get(key, fallback) {
      return key in values ? structuredClone(values[key]) : fallback;
    },
    update(key, value) {
      values[key] = structuredClone(value);
      return Promise.resolve();
    },
  };
}

test('store persists prompts with images, filters by project and fires due items', async t => {
  const memento = fakeMemento();
  let project = 'C:/one';
  const fired = [];
  const changes = [];
  const store = new ScheduledPrompts({ globalState: memento }, {
    project: () => project,
    fire: (prompt, images) => fired.push({ prompt, images }),
    changed: () => changes.push(1),
  });
  t.after(() => store.dispose());

  const later = now.getTime() + hours(1);
  const stored = store.add({
    prompt: 'run the tests',
    dueAt: later,
    chatId: 'chat-1',
    images: [{ name: 'screen.png', mimeType: 'image/png', data: 'abc' }],
  });
  assert.equal(stored.prompt, 'run the tests');
  assert.equal(stored.chatId, 'chat-1');
  assert.equal(stored.imageCount, 1);
  assert.equal('project' in stored, false);

  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal('project' in list[0], false);
  assert.equal(memento.values[SCHEDULE_KEY].prompts.length, 1);
  assert.equal(memento.values[SCHEDULE_KEY].prompts[0].project, 'C:/one');
  assert.equal(memento.values[SCHEDULE_KEY].images[stored.id].length, 1);

  assert.deepEqual(store.takeDue(later - 1), []);
  project = 'C:/two';
  assert.deepEqual(store.takeDue(later + 1), []);
  assert.equal(store.list().length, 0);
  project = 'C:/one';
  assert.equal(store.list().length, 1);

  const due = store.takeDue(later + 1);
  assert.equal(due.length, 1);
  assert.equal(due[0].prompt.prompt, 'run the tests');
  assert.equal(due[0].images[0].name, 'screen.png');
  assert.equal(store.list().length, 0);
  assert.equal(memento.values[SCHEDULE_KEY].prompts.length, 0);
  assert.ok(changes.length >= 2);
  assert.deepEqual(fired, []);
});

test('store reloads, takes one item and cancels another', t => {
  const memento = fakeMemento();
  const first = new ScheduledPrompts({ globalState: memento }, { project: () => 'C:/one', fire: () => undefined });
  first.add({ prompt: 'first', dueAt: Date.now() + hours(2) });
  first.add({ prompt: 'second', dueAt: Date.now() + hours(3) });
  first.dispose();

  const second = new ScheduledPrompts({ globalState: memento }, { project: () => 'C:/one', fire: () => undefined });
  t.after(() => second.dispose());
  const loaded = second.list();
  assert.deepEqual(loaded.map(item => item.prompt), ['first', 'second']);
  const taken = second.take(loaded[0].id);
  assert.equal(taken.prompt.prompt, 'first');
  assert.equal(second.cancel(loaded[1].id), true);
  assert.equal(second.cancel('missing'), false);
  assert.equal(second.list().length, 0);
});
