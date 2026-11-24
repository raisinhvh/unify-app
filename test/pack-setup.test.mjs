/**
 * `hub/setup.ts`: token expansion, platform filtering, `check.exists`, tick persistence and the pending count.
 *
 * The module is bundled here so the test runs against the same TypeScript the engine ships.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
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
const { pendingPackages, readPackSetup, recordPackScriptResult, runPackUninstallScript, setPackSetupStepDone } = await import(pathToFileURL(bundleFile).href);

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

test('the uninstall script runs in the pack folder, and a pack without one is skipped', async () => {
  const uninstallDir = join(tempRoot, 'toolpacks', 'uninstall-pack');
  await mkdir(uninstallDir, { recursive: true });
  assert.equal(await runPackUninstallScript(uninstallDir), undefined);

  const outside = join(tempRoot, 'outside-plugin.txt');
  await writeFile(outside, 'plugin', 'utf8');
  await writeFile(join(uninstallDir, 'uninstall.js'), [
    "const fs = require('node:fs');",
    `fs.rmSync(${JSON.stringify(outside)}, { force: true });`,
    "console.log('removed from ' + process.env.UNIFY_PACK_DIR);",
  ].join('\n'), 'utf8');
  const result = await runPackUninstallScript(uninstallDir);
  assert.equal(result.ok, true);
  assert.equal(result.lastLine, `removed from ${uninstallDir}`);
  assert.equal(existsSync(outside), false);

  await writeFile(join(uninstallDir, 'uninstall.js'), "console.error('nope'); process.exit(3);\n", 'utf8');
  const failed = await runPackUninstallScript(uninstallDir);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /uninstall script exited with code 3/);
});

test('a missing setup.json is null and a malformed one is a clear error', async () => {
  const emptyDir = join(tempRoot, 'toolpacks', 'plain-pack');
  await mkdir(emptyDir, { recursive: true });
  assert.equal(await readPackSetup(emptyDir, 'plain-pack', 'Plain Pack'), null);

  await writeFile(join(emptyDir, 'setup.json'), '{"steps": "nope"}\n', 'utf8');
  await assert.rejects(readPackSetup(emptyDir, 'plain-pack', 'Plain Pack'), /must contain a "steps" array/);

  await writeFile(join(emptyDir, 'setup.json'), '{"steps": [{"id": "x", "title": "X", "kind": "sometimes"}]}\n', 'utf8');
  await assert.rejects(readPackSetup(emptyDir, 'plain-pack', 'Plain Pack'), /"kind" must be "auto" or "manual"/);

  await writeFile(join(emptyDir, 'setup.json'), '{"steps": [{"id": "x", "title": "X", "kind": "auto", "install": {"winget": "bad id; rm"}}]}\n', 'utf8');
  await assert.rejects(readPackSetup(emptyDir, 'plain-pack', 'Plain Pack'), /"install.winget" must be a package id/);
});

test('package steps: check.command, optional steps, the install command and pending packages', async () => {
  const binDir = join(tempRoot, 'fake-bin');
  await mkdir(binDir, { recursive: true });
  const fakeName = `unifyfake${process.pid}`;
  await writeFile(join(binDir, process.platform === 'win32' ? `${fakeName}.exe` : fakeName), '', 'utf8');
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${savedPath ?? ''}`;
  try {
    await writeFile(join(packDir, 'setup.json'), `${JSON.stringify({
      steps: [
        { id: 'present', title: 'Present', kind: 'auto', install: { winget: 'Demo.Present', brew: 'present', pip: 'present' }, check: { command: fakeName } },
        { id: 'missing', title: 'Missing', kind: 'auto', install: { winget: 'Demo.Missing', brew: 'missing', pip: 'missing' }, check: { command: 'unify-not-a-program' } },
        { id: 'extra', title: 'Extra', kind: 'auto', optional: true, install: { pip: 'extra[cli]' }, check: { command: 'unify-not-a-program' } },
      ],
    }, null, 2)}\n`, 'utf8');
    const setup = await readPackSetup(packDir, 'demo-pack', 'Demo Pack');
    const byId = Object.fromEntries(setup.steps.map(step => [step.id, step]));
    assert.equal(byId.present.status, 'done');
    assert.equal(byId.missing.status, 'failed');
    assert.match(byId.missing.error, /unify-not-a-program was not found/);
    assert.equal(byId.extra.status, 'todo');
    assert.equal(byId.extra.optional, true);
    assert.equal(byId.extra.install, 'python -m pip install --user "extra[cli]"');
    const expected = process.platform === 'win32' ? 'winget install --id Demo.Missing --exact' : process.platform === 'darwin' ? 'brew install missing' : 'python -m pip install --user "missing"';
    assert.equal(byId.missing.install, expected);
    // Optional steps that are not done yet do not hold setup open: only "missing" is pending.
    assert.equal(setup.pending, 1);
    // Packages make "Run setup again" available even without an install script.
    assert.equal(setup.canRerunScript, true);

    // Python is added only when it is missing on this machine, so it is checked separately.
    const steps = items => items.filter(item => item.stepId !== 'unify:python').map(item => item.stepId);
    const pending = await pendingPackages(packDir, 'Demo Pack');
    assert.deepEqual(steps(pending), ['missing']);
    const one = await pendingPackages(packDir, 'Demo Pack', 'extra');
    assert.deepEqual(steps(one), ['extra']);
    const all = await pendingPackages(packDir, 'Demo Pack', undefined, { includeOptional: true });
    assert.deepEqual(steps(all), ['missing', 'extra']);
    assert.equal(all.find(item => item.stepId === 'extra').optional, true);
    assert.equal(all.find(item => item.stepId === 'missing').optional, undefined);
    const python = all.find(item => item.stepId === 'unify:python');
    if (python) {
      assert.equal(all[0], python, 'Python comes first');
      assert.ok(python.neededBy.includes('extra'));
      assert.equal(python.command.manager === 'winget' || python.command.manager === 'brew', true);
    }
    // Only an optional pip step needs Python: the Python Unify adds is optional too.
    const oneExtraPython = one.find(item => item.stepId === 'unify:python');
    if (oneExtraPython) assert.equal(oneExtraPython.optional, true);
  } finally {
    process.env.PATH = savedPath;
  }
});
