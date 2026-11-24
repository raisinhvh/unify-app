/**
 * Tests for Hub browsing, installation, script consent and `GithubHubRegistry.state()`.
 *
 * Every install and request test uses a small in-test `HubRegistry` injected directly instead of contacting
 * GitHub. The `GithubHubRegistry` test stubs `globalThis.fetch` so no test ever hits the network.
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
const { GithubHubRegistry, installHubPack, toolpackIdFor } = await import(pathToFileURL(hubFile).href);

const SAMPLE_PACKS = [
  {
    id: 'notes',
    name: 'Notes',
    author: 'tester',
    category: 'dev',
    description: 'Read and append local notes.',
    icon: 'sheet',
    installs: 12,
    tools: ['notes_list', 'notes_add'],
    version: '1.0.0',
    updatedAt: 1_790_000_000_000,
    publishedAt: 1_780_000_000_000,
    license: 'MIT',
    withScript: true,
  },
  {
    id: 'scene-tools',
    name: 'Scene Tools',
    author: 'tester',
    category: 'studio',
    description: 'Inspect and query 3D scene hierarchies.',
    icon: 'blender',
    installs: 5,
    tools: ['scene_tools_tree', 'scene_tools_find'],
    version: '2.1.0',
    updatedAt: 1_791_000_000_000,
    publishedAt: 1_781_000_000_000,
    license: 'MIT',
    withScript: false,
  },
  {
    id: 'clip-runner',
    name: 'Clip Runner',
    author: 'tester',
    category: 'media',
    description: 'Run local clip utilities.',
    icon: 'recorder',
    installs: 3,
    tools: ['clip_runner_info'],
    version: '1.0.0',
    updatedAt: 1_792_000_000_000,
    publishedAt: 1_782_000_000_000,
    license: 'MIT',
    withScript: true,
  },
];

function minimalPackSource(pack) {
  const packName = toolpackIdFor(pack.id);
  const toolNames = pack.tools.map(full => {
    const prefix = `${packName}_`;
    return full.startsWith(prefix) ? full.slice(prefix.length) : full;
  });
  const toolEntries = toolNames.map(
    name => `    { name: ${JSON.stringify(name)}, description: 'Tool ${name}.', run() { return 'ok'; } }`,
  );
  return [
    'export default {',
    `  name: ${JSON.stringify(packName)},`,
    `  description: ${JSON.stringify(pack.description)},`,
    '  tools: [',
    toolEntries.join(',\n'),
    '  ],',
    '};',
    '',
  ].join('\n');
}

function createTestRegistry() {
  return {
    id: 'test-in-memory',
    async state() {
      return {
        packs: SAMPLE_PACKS.map(({ withScript: _ignored, ...pack }) => ({ ...pack, tools: [...pack.tools] })),
        categories: [
          { id: 'studio', label: 'Studio & 3D' },
          { id: 'dev', label: 'Dev' },
          { id: 'media', label: 'Media' },
        ],
        featured: ['notes', 'scene-tools'],
        authors: 1,
        devices: [{ id: 'desktop', label: 'Desktop', current: true }],
        fetchedAt: Date.now(),
      };
    },
    async detail(id) {
      const found = SAMPLE_PACKS.find(pack => pack.id === id);
      if (!found) return undefined;
      const { withScript: _ignored, ...pack } = found;
      return { pack, readme: `# ${pack.name}\n\n${pack.description}\n` };
    },
    async download(id, destination) {
      const found = SAMPLE_PACKS.find(pack => pack.id === id);
      if (!found) throw new Error(`Unknown pack "${id}".`);
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'pack.ts'), minimalPackSource(found), 'utf8');
      if (found.withScript) {
        await writeFile(
          join(destination, 'install.js'),
          "const fs = require('node:fs');\nfs.writeFileSync('install-ran.txt', 'ok', 'utf8');\n",
          'utf8',
        );
        await writeFile(join(destination, 'uninstall.js'), "console.log('cleaned up');\n", 'utf8');
      }
    },
    async publish() {
      return { ok: false, message: 'Test registry does not publish.' };
    },
  };
}

const registry = createTestRegistry();
const context = { workspaceRoot: workspace, unifyHome, unifyRoot, version: '0.1.0-test', hubRegistry: registry };

async function send(message) {
  const replies = [];
  const handled = await handleUnifyRequest(message, reply => replies.push(reply), context);
  return { handled, replies };
}

const ofType = (replies, type) => replies.filter(message => message.type === type);

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test('hubBrowse answers with hubState from the injected registry', async () => {
  const browse = await send({ type: 'hubBrowse', requestId: 'b1' });
  assert.equal(browse.handled, true);
  const reply = ofType(browse.replies, 'hubState')[0];
  assert.equal(reply.requestId, 'b1');
  assert.equal(reply.hub.packs.length, SAMPLE_PACKS.length);
  assert.deepEqual(reply.hub.featured, ['notes', 'scene-tools']);
  assert.equal(reply.hub.error, undefined);

  const detail = await registry.detail('notes');
  assert.equal(detail.pack.id, 'notes');
  assert.match(detail.readme, /Notes/);
  assert.equal(await registry.detail('missing-pack'), undefined);
});

test('installHubPack returns the script without consent and runs it only when allowed', async () => {
  const firstReplies = [];
  const blocked = await installHubPack({
    registry,
    id: 'notes',
    toolpacksDir,
    reply: message => firstReplies.push(message),
  });
  assert.deepEqual(
    { ok: blocked.ok, needsScriptConsent: blocked.needsScriptConsent, scriptName: blocked.scriptName },
    { ok: false, needsScriptConsent: true, scriptName: 'install.js' },
  );
  assert.match(blocked.scriptText, /install-ran\.txt/);
  // The uninstall script, which runs when the pack is removed, is shown on the same consent.
  assert.equal(blocked.uninstallScriptName, 'uninstall.js');
  assert.match(blocked.uninstallScriptText, /cleaned up/);
  assert.equal(blocked.error, undefined);
  assert.equal(existsSync(join(toolpacksDir, 'notes')), false, 'nothing was installed');
  assert.ok(!firstReplies.some(step => step.state === 'done'));
  assert.equal(firstReplies.at(-1).state, 'installing');

  const replies = [];
  let recorded;
  const installed = await installHubPack({
    registry,
    id: 'notes',
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

  const folder = join(toolpacksDir, 'notes');
  assert.ok(existsSync(join(folder, 'pack.ts')));
  assert.ok(existsSync(join(folder, 'pack.js')));
  assert.ok(existsSync(join(folder, 'meta.json')));
  assert.ok(existsSync(join(folder, 'install-ran.txt')), 'the install script ran');
  const meta = JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8'));
  assert.equal(meta.enabled, true);
  assert.equal(meta.hubId, 'notes');
  assert.equal(recorded.id, 'notes');
  assert.equal(recorded.syncedDevices, 1);

  const require = createRequire(import.meta.url);
  const pack = require(join(folder, 'pack.js'));
  assert.equal(pack.default.name, 'notes');
  assert.equal(pack.default.tools.length, 2);
  assert.ok(pack.default.tools.every(tool => typeof tool.run === 'function'));
});

test('installHubPack maps hyphenated ids to valid toolpack ids and keeps the enabled flag', async () => {
  const install = await installHubPack({
    registry,
    id: 'scene-tools',
    toolpacksDir,
    reply: () => undefined,
    target: 'all',
  });
  assert.equal(install.ok, true);
  const folder = join(toolpacksDir, 'scene_tools');
  assert.ok(existsSync(join(folder, 'pack.js')));
  const meta = JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8'));
  assert.equal(meta.hubId, 'scene-tools');
  const require = createRequire(import.meta.url);
  const pack = require(join(folder, 'pack.js'));
  assert.equal(pack.default.name, 'scene_tools');
  assert.ok(pack.default.tools.some(tool => tool.name === 'tree'));

  await writeFile(join(folder, 'meta.json'), JSON.stringify({
    description: meta.description,
    enabled: false,
    hubId: 'scene-tools',
  }), 'utf8');
  const reinstall = await installHubPack({
    registry,
    id: 'scene-tools',
    toolpacksDir,
    reply: () => undefined,
    target: 'all',
  });
  assert.equal(reinstall.ok, true);
  const kept = JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8'));
  assert.equal(kept.enabled, false);
  assert.equal(reinstall.pack.syncedDevices, 2);
});

test('installHubPack throws on an empty id instead of writing the toolpacks folder itself', async () => {
  await assert.rejects(
    installHubPack({ registry, id: '', toolpacksDir, reply: () => undefined }),
    /empty id/,
  );
});

test('installHubPack refuses to replace a folder that belongs to a different Hub pack', async () => {
  const folder = join(toolpacksDir, 'clip_runner');
  await mkdir(folder, { recursive: true });
  const originalMeta = `${JSON.stringify({ description: 'not ours', enabled: true, hubId: 'another-pack' })}\n`;
  await writeFile(join(folder, 'meta.json'), originalMeta, 'utf8');
  await writeFile(join(folder, 'keep.txt'), 'do not delete', 'utf8');

  const install = await installHubPack({
    registry,
    id: 'clip-runner',
    toolpacksDir,
    reply: () => undefined,
    target: 'this',
    allowScript: true,
  });
  assert.equal(install.ok, false);
  assert.match(install.error, /belongs to Hub pack "another-pack"/);
  assert.equal(await readFile(join(folder, 'meta.json'), 'utf8'), originalMeta);
  assert.equal(await readFile(join(folder, 'keep.txt'), 'utf8'), 'do not delete');
  await rm(folder, { recursive: true, force: true });
});

test('hubInstall forwards allowScript and posts hubInstallResult for consent, success and failure', async () => {
  const blocked = await send({ type: 'hubInstall', id: 'clip-runner', target: 'all', requestId: 'h1' });
  const consent = ofType(blocked.replies, 'hubInstallResult')[0];
  assert.equal(consent.type, 'hubInstallResult');
  assert.equal(consent.requestId, 'h1');
  assert.deepEqual(
    { ok: consent.ok, id: consent.id, needsScriptConsent: consent.needsScriptConsent, scriptName: consent.scriptName },
    { ok: false, id: 'clip-runner', needsScriptConsent: true, scriptName: 'install.js' },
  );
  assert.match(consent.scriptText, /install-ran\.txt/);
  assert.equal(existsSync(join(toolpacksDir, 'clip_runner')), false, 'nothing was installed without consent');

  const retried = await send({ type: 'hubInstall', id: 'clip-runner', target: 'this', requestId: 'h2', allowScript: true });
  const installed = ofType(retried.replies, 'hubInstallResult')[0];
  assert.equal(installed.type, 'hubInstallResult');
  assert.equal(installed.requestId, 'h2');
  assert.equal(installed.ok, true);
  assert.equal(installed.pack.id, 'clip-runner');
  assert.equal(installed.pack.syncedDevices, 1);
  assert.ok(existsSync(join(toolpacksDir, 'clip_runner/install-ran.txt')), 'allowScript ran the script');

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

test('GithubHubRegistry.state parses a live-format index.json and reports error on non-200 without throwing', async () => {
  const originalFetch = globalThis.fetch;
  const ghRegistry = new GithubHubRegistry();
  assert.equal(ghRegistry.id, 'github');

  try {
    const sampleIndex = {
      packs: [
        {
          id: 'figma',
          name: 'Figma',
          author: 'raisinhvh',
          category: 'design',
          description: 'Inspect and edit Figma files.',
          icon: 'figma',
          installs: 42,
          tools: ['figma_pages', 'figma_tree'],
          version: '1.0.0',
          updatedAt: 1793769078638,
          publishedAt: 1793769078638,
          license: 'MIT',
        },
        { id: 'BAD ID', name: 'Ignored', description: 'Invalid id', tools: [] },
      ],
      categories: [{ id: 'design', label: 'Design' }],
      featured: ['figma', 'missing-pack'],
      authors: 1,
      devices: [{ id: 'desktop', label: 'Desktop', current: true }],
    };

    globalThis.fetch = async url => {
      assert.match(String(url), /raw\.githubusercontent\.com\/raisinhvh\/unify-hub\/main\/index\.json$/);
      return new Response(JSON.stringify(sampleIndex), { status: 200 });
    };

    const okState = await ghRegistry.state();
    assert.equal(okState.error, undefined);
    assert.equal(okState.packs.length, 1);
    assert.equal(okState.packs[0].id, 'figma');
    assert.equal(okState.packs[0].author, 'raisinhvh');
    assert.deepEqual(okState.featured, ['figma']);
    assert.equal(okState.authors, 1);
    assert.equal(okState.categories[0].id, 'design');

    globalThis.fetch = async () => new Response('Service Unavailable', { status: 503 });
    const errState = await ghRegistry.state();
    assert.equal(errState.packs.length, 0);
    assert.match(errState.error, /503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
