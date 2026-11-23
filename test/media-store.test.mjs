import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: ['src/engine/unify/media/store.ts', 'src/engine/unify/media/shown.ts'], bundle: true, write: false, platform: 'node', format: 'esm', outdir: 'dist/test-media' });
const load = file => import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles.find(output => output.path.endsWith(file)).text).toString('base64')}`);
const { DiskMediaStore, isMediaHash, readMediaIndex } = await load('store.js');
const { createShownMediaTracker } = await load('shown.js');

test('disk media deduplicates bytes, tracks refs and removes last release', async () => {
  const home = await mkdtemp(join(tmpdir(), 'unify-media-test-'));
  try {
    const store = new DiskMediaStore(home);
    const bytes = Buffer.from('same bytes');
    const first = await store.put(bytes, 'text/plain', 'chat-a');
    const second = await store.put(bytes, 'text/plain', 'chat-b');
    assert.equal(first.hash, second.hash);
    assert.equal(isMediaHash(first.hash), true);
    assert.equal(isMediaHash('../' + first.hash), false);
    assert.deepEqual(readMediaIndex(home)[first.hash].refs, ['chat-a', 'chat-b']);
    assert.deepEqual(await readFile(store.pathOf(first.hash)), bytes);
    await store.release('chat-a');
    assert.deepEqual(readMediaIndex(home)[first.hash].refs, ['chat-b']);
    await stat(store.pathOf(first.hash));
    const path = store.pathOf(first.hash);
    await store.release('chat-b');
    assert.equal(store.pathOf(first.hash), undefined);
    await assert.rejects(stat(path), /ENOENT/);
    assert.equal(await store.sweep(), 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('put racing the release of the same ref leaves the file its new index entry points at', async () => {
  const home = await mkdtemp(join(tmpdir(), 'unify-media-test-'));
  try {
    const store = new DiskMediaStore(home);
    const bytes = Buffer.from('bytes a release must not orphan');
    const first = await store.put(bytes, 'text/plain', 'chat-a');
    const release = store.release('chat-a');
    const put = store.put(bytes, 'text/plain', 'chat-a');
    await Promise.all([release, put]);
    const path = store.pathOf(first.hash);
    assert.ok(path, 'the put after release must re-add an index entry');
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(readMediaIndex(home)[first.hash].refs, ['chat-a']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a corrupt media index is moved to index.json.bad before the next write replaces it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'unify-media-test-'));
  try {
    // A missing index is a silent empty index.
    assert.deepEqual(readMediaIndex(home), {});
    const indexPath = join(home, 'index.json');
    const badPath = join(home, 'index.json.bad');
    await writeFile(badPath, 'older corrupt copy');
    await writeFile(indexPath, '{"not": valid json');
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    let index;
    try {
      index = readMediaIndex(home);
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(index, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /corrupt/);
    // The corrupt contents win over the older backup, and the broken file is out of the way.
    assert.equal(await readFile(badPath, 'utf8'), '{"not": valid json');
    await assert.rejects(stat(indexPath), /ENOENT/);
    // The store can now write a fresh index instead of overwriting the corrupt one in place.
    const store = new DiskMediaStore(home);
    const record = await store.put(Buffer.from('fresh bytes'), 'text/plain', 'chat-a');
    assert.deepEqual(readMediaIndex(home)[record.hash].refs, ['chat-a']);
    assert.equal(await readFile(badPath, 'utf8'), '{"not": valid json');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('shown media suppresses repeated hash in one chat but accepts new images', () => {
  const shown = createShownMediaTracker();
  const sent = [];
  for (const [hash, by] of [['sha256-a', 'agent'], ['sha256-a', 'other'], ['sha256-b', 'agent']]) {
    if (!shown.has('chat', hash)) {
      sent.push(hash);
      shown.add('chat', hash, by);
    }
  }
  assert.deepEqual(sent, ['sha256-a', 'sha256-b']);
  assert.equal(shown.shownBy('chat', 'sha256-a'), 'agent');
  shown.forget('chat');
  assert.equal(shown.has('chat', 'sha256-a'), false);
});
