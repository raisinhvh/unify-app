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
const unifyHome = join(tempRoot, 'home/.unify');
const unifyRoot = join(unifyHome, 'unify');
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
const { createHubRegistry, installHubPack } = await import(pathToFileURL(hubFile).href);

const context = { workspaceRoot: workspace, unifyHome, unifyRoot, version: '0.1.0-test' };

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

test('hubBrowse answers with the catalogue and publish requires approved GitHub login', async () => {
  const browse = await send({ type: 'hubBrowse' });
  assert.equal(browse.handled, true);
  const hub = ofType(browse.replies, 'hubState')[0].hub;
  assert.equal(hub.packs.length, 14);
  assert.equal(hub.error, undefined);

  const publish = await send({ type: 'hubPublish' });
  assert.deepEqual(ofType(publish.replies, 'hubPublishResult')[0], {
    type: 'hubPublishResult', ok: false, message: 'Sign in to GitHub to publish.',
  });
  context.getGithubAuth = async () => ({ login: 'not-approved', token: 'secret' });
  try {
    const unlisted = await send({ type: 'hubPublish' });
    assert.deepEqual(ofType(unlisted.replies, 'hubPublishResult')[0], {
      type: 'hubPublishResult', ok: false, message: 'Publishing is limited to approved accounts.',
    });
    context.getGithubAuth = async () => ({ login: 'RAISINHVH', token: 'secret' });
    const approved = await send({ type: 'hubPublish' });
    assert.deepEqual(ofType(approved.replies, 'hubPublishResult')[0], {
      type: 'hubPublishResult', ok: false,
      message: 'Publishing is not wired yet: the Hub repository takes packs through a pull request.',
    });
  } finally {
    delete context.getGithubAuth;
  }
});

test('installHubPack returns the script without consent and runs it only when allowed', async () => {
  const registry = createHubRegistry();
  const firstReplies = [];
  const blocked = await installHubPack({
    registry,
    id: 'spreadsheets',
    toolpacksDir,
    reply: message => firstReplies.push(message),
  });
  assert.deepEqual(
    { ok: blocked.ok, needsScriptConsent: blocked.needsScriptConsent, scriptName: blocked.scriptName },
    { ok: false, needsScriptConsent: true, scriptName: 'install.js' },
  );
  assert.match(blocked.scriptText, /install-ran\.txt/);
  assert.equal(blocked.error, undefined);
  assert.equal(existsSync(join(toolpacksDir, 'spreadsheets')), false, 'nothing was installed');
  assert.ok(!firstReplies.some(step => step.state === 'done'));
  assert.equal(firstReplies.at(-1).state, 'installing');

  const replies = [];
  let recorded;
  const installed = await installHubPack({
    registry,
    id: 'spreadsheets',
    toolpacksDir,
    reply: message => replies.push(message),
    target: 'this',
    allowScript: true,
    onInstalled: pack => { recorded = pack; },
  });
  assert.equal(installed.ok, true);
  assert.equal(installed.needsScriptConsent, undefined);
  const progress = replies.filter(message => message.type === 'hubInstallProgress');
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
  assert.equal(recorded.id, 'spreadsheets');
  assert.equal(recorded.syncedDevices, 1);

  const require = createRequire(import.meta.url);
  const pack = require(join(folder, 'pack.js'));
  assert.equal(pack.default.name, 'spreadsheets');
  assert.ok(Array.isArray(pack.default.tools) && pack.default.tools.length === 12);
  assert.ok(pack.default.tools.every(tool => typeof tool.run === 'function'));
});

test('hubInstall maps hyphenated ids to valid toolpack ids and keeps the enabled flag', async () => {
  const registry = createHubRegistry();
  const install = await installHubPack({
    registry,
    id: 'roblox-studio',
    toolpacksDir,
    reply: () => undefined,
    target: 'all',
    allowScript: true,
  });
  assert.equal(install.ok, true);
  const folder = join(toolpacksDir, 'roblox_studio');
  assert.ok(existsSync(join(folder, 'pack.js')));
  const meta = JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8'));
  assert.equal(meta.hubId, 'roblox-studio');
  const require = createRequire(import.meta.url);
  const pack = require(join(folder, 'pack.js'));
  assert.equal(pack.default.name, 'roblox_studio');
  assert.ok(pack.default.tools.some(tool => tool.name === 'tree'));

  await writeFile(join(folder, 'meta.json'), JSON.stringify({
    description: meta.description,
    enabled: false,
    hubId: 'roblox-studio',
  }), 'utf8');
  const reinstall = await installHubPack({
    registry,
    id: 'roblox-studio',
    toolpacksDir,
    reply: () => undefined,
    target: 'all',
    allowScript: true,
  });
  assert.equal(reinstall.ok, true);
  const kept = JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8'));
  assert.equal(kept.enabled, false);
  assert.equal(reinstall.pack.syncedDevices, 2);
});

test('installHubPack throws on an empty id instead of writing the toolpacks folder itself', async () => {
  await assert.rejects(
    installHubPack({ registry: createHubRegistry(), id: '', toolpacksDir, reply: () => undefined }),
    /empty id/,
  );
});

test('installHubPack refuses to replace a folder that belongs to a different Hub pack', async () => {
  const folder = join(toolpacksDir, 'screen_recorder');
  await mkdir(folder, { recursive: true });
  const originalMeta = `${JSON.stringify({ description: 'not ours', enabled: true, hubId: 'another-pack' })}\n`;
  await writeFile(join(folder, 'meta.json'), originalMeta, 'utf8');
  await writeFile(join(folder, 'keep.txt'), 'do not delete', 'utf8');

  const install = await installHubPack({
    registry: createHubRegistry(),
    id: 'screen-recorder',
    toolpacksDir,
    reply: () => undefined,
    target: 'this',
    allowScript: true,
  });
  assert.equal(install.ok, false);
  assert.match(install.error, /belongs to Hub pack "another-pack"/);
  assert.equal(await readFile(join(folder, 'meta.json'), 'utf8'), originalMeta);
  assert.equal(await readFile(join(folder, 'keep.txt'), 'utf8'), 'do not delete');
});

test('hubInstall forwards allowScript and posts hubInstallResult for consent, success and failure', async () => {
  const blocked = await send({ type: 'hubInstall', id: 'containers', target: 'all', requestId: 'h1' });
  const consent = ofType(blocked.replies, 'hubInstallResult')[0];
  assert.equal(consent.type, 'hubInstallResult');
  assert.equal(consent.requestId, 'h1');
  assert.deepEqual(
    { ok: consent.ok, id: consent.id, needsScriptConsent: consent.needsScriptConsent, scriptName: consent.scriptName },
    { ok: false, id: 'containers', needsScriptConsent: true, scriptName: 'install.js' },
  );
  assert.match(consent.scriptText, /install-ran\.txt/);
  assert.equal(existsSync(join(toolpacksDir, 'containers')), false, 'nothing was installed without consent');

  const retried = await send({ type: 'hubInstall', id: 'containers', target: 'this', requestId: 'h2', allowScript: true });
  const installed = ofType(retried.replies, 'hubInstallResult')[0];
  assert.equal(installed.type, 'hubInstallResult');
  assert.equal(installed.requestId, 'h2');
  assert.equal(installed.ok, true);
  assert.equal(installed.pack.id, 'containers');
  assert.equal(installed.pack.syncedDevices, 1);
  assert.ok(existsSync(join(toolpacksDir, 'containers/install-ran.txt')), 'allowScript ran the script');

  const failed = await send({ type: 'hubInstall', id: 'not-in-the-hub', target: 'all', requestId: 'h3' });
  const error = ofType(failed.replies, 'hubInstallResult')[0];
  assert.equal(error.type, 'hubInstallResult');
  assert.equal(error.requestId, 'h3');
  assert.equal(error.ok, false);
  assert.match(error.error, /no pack/);

  const empty = await send({ type: 'hubInstall', id: '', target: 'all', requestId: 'h4' });
  const choose = ofType(empty.replies, 'hubInstallResult')[0];
  assert.equal(choose.requestId, 'h4');
  assert.equal(choose.ok, false);
  assert.match(choose.error, /Choose a pack/);
});

test('hubInstall of an unknown pack fails with an error progress and writes nothing', async () => {
  const install = await send({ type: 'hubInstall', id: 'not-in-the-hub', target: 'all' });
  const last = ofType(install.replies, 'hubInstallProgress').at(-1);
  assert.equal(last.state, 'error');
  assert.match(last.error, /no pack/);
  assert.equal(existsSync(join(toolpacksDir, 'not_in_the_hub')), false);
});
