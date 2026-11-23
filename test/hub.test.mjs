/**
 * Tests for the local Hub registry and the install flow.
 *
 * Everything runs against the fixture catalogue and a temporary toolpacks folder. No test contacts GitHub or
 * uses the GitHub registry class beyond importing its module.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tempRoot = join(here, '.tmp', `hub-${process.pid}-${Date.now()}`);
const dshHome = join(tempRoot, 'home/.dsh');
const unifyRoot = join(dshHome, 'unify');
const workspace = join(tempRoot, 'project');
const toolpacksDir = join(unifyRoot, 'storage/toolpacks');
await mkdir(tempRoot, { recursive: true });

const requestsFile = join(tempRoot, 'requests.mjs');
const hubFile = join(tempRoot, 'hub.mjs');
await build({
  entryPoints: [join(here, '../src/engine/unify/requests/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: requestsFile,
  external: ['esbuild'],
});
await build({
  entryPoints: [join(here, '../src/engine/hub/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: hubFile,
  external: ['esbuild'],
});
const { handleUnifyRequest } = await import(pathToFileURL(requestsFile).href);
const { createHubRegistry } = await import(pathToFileURL(hubFile).href);

const context = { workspaceRoot: workspace, dshHome, unifyRoot, version: '0.1.0-test' };

async function send(message) {
  const replies = [];
  const handled = await handleUnifyRequest(message, reply => replies.push(reply), context);
  return { handled, replies };
}

const ofType = (replies, type) => replies.filter(message => message.type === type);

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test('local registry serves the fixture catalogue and pack detail', async () => {
  const registry = createHubRegistry();
  assert.equal(registry.id, 'local');
  const state = await registry.state();
  assert.equal(state.packs.length, 14);
  assert.deepEqual(state.categories.map(category => category.id), ['studio', 'design', 'media', 'dev', 'web', 'data']);
  assert.deepEqual(state.featured, ['containers', 'spreadsheets', 'screen-recorder']);
  assert.equal(state.authors, 74);
  assert.equal(state.devices.find(device => device.current).label, 'Desktop');
  const roblox = state.packs.find(pack => pack.id === 'roblox-studio');
  assert.equal(roblox.name, 'Roblox Studio');
  assert.equal(roblox.tools.length, 24);

  const detail = await registry.detail('spreadsheets');
  assert.equal(detail.pack.id, 'spreadsheets');
  assert.match(detail.readme, /Spreadsheets/);
  assert.equal(await registry.detail('missing-pack'), undefined);
});

test('hubBrowse answers with the catalogue and hubPublish explains the gap', async () => {
  const browse = await send({ type: 'hubBrowse' });
  assert.equal(browse.handled, true);
  const hub = ofType(browse.replies, 'hubState')[0].hub;
  assert.equal(hub.packs.length, 14);
  assert.equal(hub.error, undefined);

  const publish = await send({ type: 'hubPublish' });
  const published = ofType(publish.replies, 'hubState')[0].hub;
  assert.match(published.error, /Publishing is not available yet/);
});

test('hubInstall downloads, compiles, runs the install script and records the pack', async () => {
  const install = await send({ type: 'hubInstall', id: 'spreadsheets', target: 'this' });
  assert.equal(install.handled, true);
  const progress = ofType(install.replies, 'hubInstallProgress');
  assert.equal(progress[0].state, 'downloading');
  assert.ok(progress.some(step => step.state === 'installing'));
  assert.equal(progress.at(-1).state, 'done');
  assert.equal(progress.at(-1).percent, 100);

  const folder = join(toolpacksDir, 'spreadsheets');
  assert.ok(existsSync(join(folder, 'pack.ts')));
  assert.ok(existsSync(join(folder, 'pack.js')));
  assert.ok(existsSync(join(folder, 'meta.json')));
  assert.ok(existsSync(join(folder, 'install-ran.txt')), 'the install script ran');
  const meta = JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8'));
  assert.equal(meta.enabled, true);
  assert.equal(meta.hubId, 'spreadsheets');

  const require = createRequire(import.meta.url);
  const pack = require(join(folder, 'pack.js'));
  assert.equal(pack.default.name, 'spreadsheets');
  assert.ok(Array.isArray(pack.default.tools) && pack.default.tools.length === 12);
  assert.ok(pack.default.tools.every(tool => typeof tool.run === 'function'));

  const store = JSON.parse(await readFile(join(unifyRoot, 'toolpacks.json'), 'utf8'));
  assert.equal(store.installed.spreadsheets.source, 'hub');
  assert.equal(store.installed.spreadsheets.syncedDevices, 1);
  assert.equal(store.syncTargets.spreadsheets, 'this');
});

test('hubInstall maps hyphenated ids to valid toolpack ids and keeps the enabled flag', async () => {
  const install = await send({ type: 'hubInstall', id: 'roblox-studio', target: 'all' });
  assert.equal(ofType(install.replies, 'hubInstallProgress').at(-1).state, 'done');
  const folder = join(toolpacksDir, 'roblox_studio');
  assert.ok(existsSync(join(folder, 'pack.js')));
  const meta = JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8'));
  assert.equal(meta.hubId, 'roblox-studio');
  const require = createRequire(import.meta.url);
  const pack = require(join(folder, 'pack.js'));
  assert.equal(pack.default.name, 'roblox_studio');
  assert.ok(pack.default.tools.some(tool => tool.name === 'tree'));

  const store = JSON.parse(await readFile(join(unifyRoot, 'toolpacks.json'), 'utf8'));
  assert.equal(store.installed['roblox-studio'].syncedDevices, 2);
  assert.equal(store.syncTargets['roblox-studio'], 'all');

  await writeFile(join(folder, 'meta.json'), JSON.stringify({ description: meta.description, enabled: false }), 'utf8');
  const reinstall = await send({ type: 'hubInstall', id: 'roblox-studio', target: 'all' });
  assert.equal(ofType(reinstall.replies, 'hubInstallProgress').at(-1).state, 'done');
  const kept = JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8'));
  assert.equal(kept.enabled, false);
});

test('hubInstall of an unknown pack fails with an error progress and writes nothing', async () => {
  const install = await send({ type: 'hubInstall', id: 'not-in-the-hub', target: 'all' });
  const last = ofType(install.replies, 'hubInstallProgress').at(-1);
  assert.equal(last.state, 'error');
  assert.match(last.error, /no pack/);
  assert.equal(existsSync(join(toolpacksDir, 'not_in_the_hub')), false);
});
