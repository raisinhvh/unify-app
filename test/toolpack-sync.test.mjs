import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, transform } from 'esbuild';
import { ToolpackRegistry } from '../dist/toolpacks/registry.mjs';

// The toolpack list builder and the reinstall request, run against a real registry. Toolpacks are never synced
// between PCs: a pack is reinstalled from the source in its own folder.
const bundles = await build({
  entryPoints: {
    listing: 'src/engine/toolpacks/sync-state.ts',
    requests: 'src/engine/unify/requests/toolpacks.ts',
    state: 'src/engine/unify/requests/state.ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node20', outdir: 'bundle',
});
const load = name => import(`data:text/javascript;base64,${Buffer.from(bundles.outputFiles.find(file => file.path.endsWith(`${name}.js`)).text).toString('base64')}`);
const { listToolpacks, readInstallErrors, setInstallError } = await load('listing');
const { handleToolpackInstallRequest } = await load('requests');
const { requestPaths } = await load('state');

const GADGET = `
export default {
  name: 'gadget',
  description: 'Gadget',
  tools: [{ name: 'ping', description: 'Ping', run: () => 'pong' }],
};
`;
const BROKEN = 'export const nothing = 1;';

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'unify-toolpack-sync-'));
  const storage = join(home, 'storage');
  const dir = join(storage, 'toolpacks');
  const registry = new ToolpackRegistry({
    dir,
    workerPath: resolve('dist/toolpack-worker.js'),
    compile: async source => (await transform(source, { loader: 'ts', format: 'cjs', target: 'node20' })).code,
    callTimeoutMs: 5000,
  });
  await registry.start();
  t.after(async () => {
    await registry.dispose();
    await rm(home, { recursive: true, force: true });
  });
  const writePackTs = async (id, source) => { await mkdir(join(dir, id), { recursive: true }); await writeFile(join(dir, id, 'pack.ts'), source); };
  return { home, storage, dir, registry, writePackTs };
}

test('the toolpack list shows Hub packs that are not working here, marked needsInstall', async t => {
  const { dir, registry, writePackTs } = await setup(t);
  await writePackTs('roblox_studio', GADGET);
  await writeFile(join(dir, 'roblox_studio', 'meta.json'), JSON.stringify({ description: 'Studio pack', enabled: false }));
  // A folder that is not a Hub pack and does not load is not listed as needing an install.
  await writePackTs('gadget', GADGET);
  const hub = {
    'roblox-studio': { id: 'roblox-studio', name: 'Roblox Studio', description: 'Studio', version: '1.0.0' },
    'web-search': { id: 'web-search', name: 'Web Search', description: 'Search', version: '1.0.0' },
  };
  const list = () => listToolpacks({ dir, installed: registry.list(), hub });

  const packs = list();
  assert.deepEqual(packs.find(pack => pack.id === 'roblox_studio'), {
    id: 'roblox_studio', description: 'Studio pack', enabled: false, state: 'stopped', status: '', tools: [], logs: [], needsInstall: true,
  });
  assert.equal(packs.find(pack => pack.id === 'gadget'), undefined, 'a local folder that is not from the Hub is not listed');
  assert.equal(packs.find(pack => pack.id === 'web_search'), undefined, 'a Hub pack with no folder is not listed');

  setInstallError(dir, 'roblox_studio', 'Could not compile');
  const failed = list().find(pack => pack.id === 'roblox_studio');
  assert.equal(failed?.state, 'error');
  assert.equal(failed?.error, 'Could not compile');
  assert.equal(failed?.installError, 'Could not compile');
  assert.equal(failed?.needsInstall, true);
});

test('reinstallToolpack installs from the pack folder, clears the error, and rebuilds the list', async t => {
  const { home, dir, registry, writePackTs } = await setup(t);
  await writePackTs('gadget', GADGET);
  setInstallError(dir, 'gadget', 'old failure');
  let refreshed = 0;
  const context = {
    workspaceRoot: undefined,
    unifyHome: home,
    unifyRoot: home,
    installToolpack: async sourcePath => { await registry.add(sourcePath); },
    refreshToolpacks: () => { refreshed++; },
  };
  const paths = requestPaths(context);

  assert.equal(await handleToolpackInstallRequest({ type: 'reinstallToolpack', id: 'gadget' }, paths, context), true);
  assert.deepEqual(readInstallErrors(dir), {});
  assert.equal(registry.list().find(item => item.id === 'gadget')?.state, 'running');
  assert.equal(refreshed, 1);

  // A pack whose source no longer compiles keeps its error and still rebuilds the list.
  await writePackTs('gadget', BROKEN);
  await handleToolpackInstallRequest({ type: 'reinstallToolpack', id: 'gadget' }, paths, context);
  assert.match(readInstallErrors(dir).gadget, /export default/);
  assert.equal(refreshed, 2);

  // An id with no source on this PC is refused and remembered the same way.
  await handleToolpackInstallRequest({ type: 'reinstallToolpack', id: 'missing' }, paths, context);
  assert.match(readInstallErrors(dir).missing, /no source on this PC/);
  assert.equal(await handleToolpackInstallRequest({ type: 'hubBrowse' }, paths, context), false);
});
