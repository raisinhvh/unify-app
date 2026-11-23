/**
 * `searchWorkspaceFiles`: fuzzy ranking, folder results, ignore rules and recently-modified order.
 *
 * The engine module is bundled with esbuild so `npm test` does not need the main build.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tempRoot = join(here, '.tmp', `workspace-search-${process.pid}-${Date.now()}`);
const project = join(tempRoot, 'project');
const bundleFile = join(tempRoot, 'workspace.mjs');
await mkdir(project, { recursive: true });
await build({
  entryPoints: [join(here, '../src/engine/unify/requests/workspace.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundleFile,
});
const { searchWorkspaceFiles } = await import(pathToFileURL(bundleFile).href);

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const files = [
  'src/button.ts',
  'src/components/button.tsx',
  'src/my-button.ts',
  'src/buttons.ts',
  'docs/buttons.md',
  'src/button/panel.ts',
  'src/q-w-x.ts',
  'src/index.ts',
  'README.md',
  'node_modules/pkg/button.js',
  'dist/button.js',
  'build/button.js',
  'out/button.js',
  'coverage/button.js',
  '.next/button.js',
  'ignored.txt',
  'generated/button.ts',
  'compiled/button.ts',
];

for (const [index, relative] of files.entries()) {
  const full = join(project, ...relative.split('/'));
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, `// ${relative}\n`, 'utf8');
  const modified = new Date(2026, 0, 1, 0, 0, index);
  await utimes(full, modified, modified);
}
await writeFile(join(project, '.gitignore'), 'ignored.txt\ngenerated/\ncompiled/\n', 'utf8');
const newest = new Date(2026, 0, 2);
await utimes(join(project, '.gitignore'), newest, newest);

const paths = results => results.map(item => item.path);

test('ranks basename prefix, basename substring, path substring and subsequence', () => {
  const ranked = searchWorkspaceFiles(project, 'button');
  assert.deepEqual(paths(ranked), [
    'src/button/',
    'src/button.ts',
    'src/buttons.ts',
    'docs/buttons.md',
    'src/components/button.tsx',
    'src/my-button.ts',
    'src/button/panel.ts',
  ]);
  assert.equal(ranked[0].kind, 'folder');
  assert.equal(ranked[1].kind, 'file');
});

test('finds folders and subsequences and honours the limit', () => {
  assert.deepEqual(paths(searchWorkspaceFiles(project, 'components')), ['src/components/', 'src/components/button.tsx']);
  assert.deepEqual(paths(searchWorkspaceFiles(project, 'qwx')), ['src/q-w-x.ts']);
  assert.equal(searchWorkspaceFiles(project, 'button', 2).length, 2);
});

test('skips generated folders, dependencies and gitignored paths', () => {
  const ranked = paths(searchWorkspaceFiles(project, 'button'));
  for (const skipped of ['node_modules', 'dist/', 'build/', 'out/', 'coverage/', '.next/', 'ignored.txt', 'generated/', 'compiled/']) {
    assert.ok(ranked.every(item => !item.startsWith(skipped)), `unexpected result from ${skipped}`);
  }
  assert.ok(!ranked.includes('.gitignore'));
});

test('an empty query lists recently modified files first', () => {
  const recent = searchWorkspaceFiles(project, '');
  assert.equal(recent.length, 10);
  assert.ok(recent.every(item => item.kind === 'file'));
  assert.equal(recent[0].path, '.gitignore');
  assert.equal(recent[1].path, 'README.md');
  assert.equal(recent[recent.length - 1].path, 'src/button.ts');
});

test('a missing project is reported, not silently searched', () => {
  assert.throws(() => searchWorkspaceFiles(undefined, 'button'), /Open a project folder first/);
});
