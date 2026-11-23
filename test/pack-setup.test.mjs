/**
 * `hub/setup.ts`: token expansion, platform filtering, `check.exists`, tick persistence and the pending count.
 *
 * The module is bundled here so the test runs against the same TypeScript the engine ships.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tempRoot = join(here, '.tmp', `pack-setup-${process.pid}-${Date.now()}`);
const packDir = join(tempRoot, 'toolpacks', 'demo-pack');
const bundleFile = join(tempRoot, 'setup.mjs');
await mkdir(packDir, { recursive: true });
await build({
  entryPoints: [join(here, '../src/engine/hub/setup.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundleFile,
});
const { readPackSetup, recordPackScriptResult, setPackSetupStepDone } = await import(pathToFileURL(bundleFile).href);

after(async () => {
  delete process.env.PACK_SETUP_TEST_DIR;
  await rm(tempRoot, { recursive: true, force: true });
});

const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';
const envDir = join(tempRoot, 'env-dir');
process.env.PACK_SETUP_TEST_DIR = envDir;

await writeFile(join(packDir, 'setup.json'), `${JSON.stringify({
  steps: [
    {
      id: 'import-plugin',
      title: 'Import the demo plugin',
      detail: 'Copied from ${PACK} into ${PACK_SETUP_TEST_DIR}. Unify home is ${HOME}.',
      kind: 'auto',
      check: { exists: '${PACK}/bin/tool.exe' },
    },
    {
      id: 'manual-copy',
      title: 'Paste the key',
      detail: 'Use the copied value.',
      kind: 'manual',
      copy: '${PACK}/keys/demo.txt',
      open: '${PACK}/docs',
    },
  ],
}, null, 2)}\n`, 'utf8');
await writeFile(join(packDir, 'install.js'), 'console.log("done");\n', 'utf8');

test('tokens expand and paths use platform separators', async () => {
  const setup = await readPackSetup(packDir, 'demo-pack', 'Demo Pack');
  assert.ok(setup);
  const step = setup.steps.find(item => item.id === 'manual-copy');
  assert.ok(step);
  assert.match(step.detail, /Use the copied value\./);
  assert.equal(step.copy, join(packDir, 'keys', 'demo.txt'));
  assert.equal(step.open, join(packDir, 'docs'));

  const auto = setup.steps.find(item => item.id === 'import-plugin');
  assert.ok(auto);
  assert.match(auto.detail, new RegExp(envDir.replace(/\\/g, '\\\\')));
  assert.ok(auto.detail.includes(packDir));
  assert.ok(auto.detail.includes(`Unify home is ${homedir()}.`));
});

test('a missing check.exists path fails an automatic step', async () => {
  const setup = await readPackSetup(packDir, 'demo-pack', 'Demo Pack');
  const step = setup.steps.find(item => item.id === 'import-plugin');
  assert.equal(step.status, 'failed');
  assert.match(step.error, /was not found/);
});

test('check.exists is done once the path exists', async () => {
  await mkdir(join(packDir, 'bin'), { recursive: true });
  await writeFile(join(packDir, 'bin', 'tool.exe'), '', 'utf8');
  const setup = await readPackSetup(packDir, 'demo-pack', 'Demo Pack');
  const step = setup.steps.find(item => item.id === 'import-plugin');
  assert.equal(step.status, 'done');
  assert.equal(step.error, undefined);
});

test('steps for another platform are dropped', async () => {
  await writeFile(join(packDir, 'setup.json'), `${JSON.stringify({
    steps: [
      { id: 'here', title: 'On this platform', kind: 'manual' },
      { id: 'elsewhere', title: 'On another platform', kind: 'manual', platforms: [otherPlatform] },
      { id: 'both', title: 'On both', kind: 'manual', platforms: [process.platform, otherPlatform] },
    ],
  }, null, 2)}\n`, 'utf8');
  const setup = await readPackSetup(packDir, 'demo-pack', 'Demo Pack');
  assert.deepEqual(setup.steps.map(step => step.id), ['here', 'both']);
});

test('manual ticks persist across reads and change the pending count', async () => {
  let setup = await readPackSetup(packDir, 'demo-pack', 'Demo Pack');
  assert.equal(setup.pending, 2);
  assert.equal(setup.steps.find(step => step.id === 'here').status, 'todo');

  await setPackSetupStepDone(packDir, 'here', true);
  setup = await readPackSetup(packDir, 'demo-pack', 'Demo Pack');
  assert.equal(setup.steps.find(step => step.id === 'here').status, 'done');
  assert.equal(setup.pending, 1);

  await setPackSetupStepDone(packDir, 'here', false);
  setup = await readPackSetup(packDir, 'demo-pack', 'Demo Pack');
  assert.equal(setup.steps.find(step => step.id === 'here').status, 'todo');
  assert.equal(setup.pending, 2);
});

test('an automatic step without a check follows the last script result', async () => {
  await writeFile(join(packDir, 'setup.json'), `${JSON.stringify({
    steps: [{ id: 'copy-files', title: 'Copy files', kind: 'auto' }],
  }, null, 2)}\n`, 'utf8');
  let setup = await readPackSetup(packDir, 'demo-pack', 'Demo Pack');
  assert.equal(setup.steps[0].status, 'failed');
  assert.match(setup.steps[0].error, /has not run successfully/);

  await recordPackScriptResult(packDir, true, 'copied 3 files');
  setup = await readPackSetup(packDir, 'demo-pack', 'Demo Pack');
  assert.equal(setup.steps[0].status, 'done');

  await recordPackScriptResult(packDir, false, 'permission denied');
  setup = await readPackSetup(packDir, 'demo-pack', 'Demo Pack');
  assert.equal(setup.steps[0].status, 'failed');
  assert.equal(setup.steps[0].error, 'permission denied');
});

test('canRerunScript follows the presence of an install script', async () => {
  const setup = await readPackSetup(packDir, 'demo-pack', 'Demo Pack');
  assert.equal(setup.canRerunScript, true);
  await rm(join(packDir, 'install.js'));
  const withoutScript = await readPackSetup(packDir, 'demo-pack', 'Demo Pack');
  assert.equal(withoutScript.canRerunScript, false);
});

test('a missing setup.json is null and a malformed one is a clear error', async () => {
  const emptyDir = join(tempRoot, 'toolpacks', 'plain-pack');
  await mkdir(emptyDir, { recursive: true });
  assert.equal(await readPackSetup(emptyDir, 'plain-pack', 'Plain Pack'), null);

  await writeFile(join(emptyDir, 'setup.json'), '{"steps": "nope"}\n', 'utf8');
  await assert.rejects(readPackSetup(emptyDir, 'plain-pack', 'Plain Pack'), /must contain a "steps" array/);

  await writeFile(join(emptyDir, 'setup.json'), '{"steps": [{"id": "x", "title": "X", "kind": "sometimes"}]}\n', 'utf8');
  await assert.rejects(readPackSetup(emptyDir, 'plain-pack', 'Plain Pack'), /"kind" must be "auto" or "manual"/);
});
