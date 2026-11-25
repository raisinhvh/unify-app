import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffSnapshots, snapshotFiles } from '../dist/runtime/changeSnapshot.mjs';

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-'));
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await mkdir(join(root, 'src', 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'one');
  await writeFile(join(root, 'src', 'nested', 'b.ts'), 'two');
  await writeFile(join(root, 'src', 'node_modules', 'pkg', 'index.js'), 'dep');
  await writeFile(join(root, 'top.md'), 'top');
  return root;
}

test('snapshots mark missing files with the empty marker and hash present ones', async () => {
  const root = await workspace();
  try {
    const snap = await snapshotFiles(root, ['src/a.ts', 'src/missing.ts']);
    assert.equal(snap.size, 2);
    assert.notEqual(snap.get('src/a.ts'), '');
    assert.equal(snap.get('src/missing.ts'), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a changed file is reported; an unchanged one is not', async () => {
  const root = await workspace();
  try {
    const before = await snapshotFiles(root, ['src/a.ts', 'top.md']);
    await writeFile(join(root, 'src', 'a.ts'), 'one, edited');
    const after = await snapshotFiles(root, ['src/a.ts', 'top.md']);
    assert.deepEqual(diffSnapshots(before, after), ['src/a.ts']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('added and removed files are reported', async () => {
  const root = await workspace();
  try {
    const before = await snapshotFiles(root, ['src/a.ts', 'src/new.ts']);
    await writeFile(join(root, 'src', 'new.ts'), 'fresh');
    await unlink(join(root, 'src', 'a.ts'));
    const after = await snapshotFiles(root, ['src/a.ts', 'src/new.ts']);
    assert.deepEqual(diffSnapshots(before, after), ['src/a.ts', 'src/new.ts']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a directory path is walked recursively, skipping node_modules, .git and dist', async () => {
  const root = await workspace();
  try {
    const snap = await snapshotFiles(root, ['src/']);
    assert.deepEqual([...snap.keys()].sort(), ['src/a.ts', 'src/nested/b.ts']);
    await writeFile(join(root, 'src', 'node_modules', 'pkg', 'index.js'), 'changed dep');
    await writeFile(join(root, 'src', 'nested', 'b.ts'), 'two, edited');
    await writeFile(join(root, 'src', 'added.ts'), 'added');
    const after = await snapshotFiles(root, ['src/']);
    assert.deepEqual(diffSnapshots(snap, after), ['src/added.ts', 'src/nested/b.ts']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('overlapping paths are fingerprinted once and each hash belongs to its own file', async () => {
  const root = await workspace();
  try {
    const snap = await snapshotFiles(root, ['src/', 'src/a.ts', 'top.md']);
    assert.deepEqual([...snap.keys()], ['src/a.ts', 'src/nested/b.ts', 'top.md']);
    const single = await snapshotFiles(root, ['src/nested/b.ts']);
    assert.equal(snap.get('src/nested/b.ts'), single.get('src/nested/b.ts'));
    assert.notEqual(snap.get('src/a.ts'), snap.get('top.md'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('paths outside the workspace are ignored', async () => {
  const root = await workspace();
  try {
    const snap = await snapshotFiles(root, ['../outside.txt', '/etc/hosts']);
    assert.equal(snap.size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
