import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalInferenceManager } from '../dist/local/manager.mjs';
import { loadFile } from '../dist/local/store.mjs';
import { pickAssets } from '../dist/local/install.mjs';

const KEY = 'test-key-123';

// A tiny HTTP server: /v1/models answers only for the right key. Modes: ok, exit, hang.
const SCRIPT = `
const http = require('http');
const [port, key, mode] = process.argv.slice(1);
if (mode === 'exit') { console.log('boom before ready'); process.exit(3); }
console.log('\\x1b[32mgreen\\x1b[0m hello\\rsecond');
console.log('plain line');
process.on('SIGTERM', () => process.exit(0));
if (mode === 'stdin') {
  process.stdin.on('end', () => { require('fs').writeFileSync(process.env.UNIFY_TEST_MARK, 'clean'); process.exit(0); });
  process.stdin.resume();
}
if (mode === 'hang') { setInterval(() => {}, 1000); }
else {
  http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + key) { res.statusCode = 401; return res.end('no'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fake' }] }));
  }).listen(Number(port), '127.0.0.1');
}
`;

const fakeEngine = {
  kind: 'custom',
  label: 'Fake',
  description: 'test engine',
  homepage: '',
  installable: false,
  pathKind: 'none',
  pathLabel: 'none',
  fields: [{ id: 'mode', label: 'Mode', type: 'text', default: 'ok' }],
  defaultPort: 0,
  startupTimeoutSec: 10,
  supportsApiKey: true,
  detect: async () => undefined,
  build: (values, context) => ({
    command: process.execPath,
    args: ['-e', SCRIPT, String(context.port), context.apiKey, String(values.mode ?? 'ok')],
    apiPath: '/v1',
    healthPath: '/v1/models',
    servedModel: 'fake',
  }),
  servedModel: () => 'fake',
  validate: () => [],
};

const builtinPreset = { id: 'b1', label: 'Built in', description: '', engine: 'custom', values: { mode: 'ok' }, builtin: true };

async function freePort() {
  return new Promise(resolve => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function setup(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'unify-local-'));
  const messages = [];
  const manager = new LocalInferenceManager({
    home,
    post: message => messages.push(message),
    isInUse: () => false,
    engines: [fakeEngine],
    presets: [builtinPreset],
    healthIntervalMs: 50,
    idleCheckMs: 40,
    stopGraceMs: 1500,
    ...extra,
  });
  await manager.load();
  const create = async (values = {}, label = 'Fake server') => manager.createServer({ engine: 'custom', label, values, port: await freePort() });
  return { home, messages, manager, create };
}

async function finish(context) {
  await context.manager.dispose();
  await rm(context.home, { recursive: true, force: true }).catch(() => undefined);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a server is created, started, healthy, and its log has ANSI stripped', async () => {
  const context = await setup();
  try {
    const config = await context.create();
    assert.match(config.id, /^ls_[0-9a-f]{8}$/);
    assert.equal(config.autoStart, true);
    assert.equal(config.idleStopMinutes, 15);
    const view = context.manager.state().servers[0];
    assert.equal(view.servedModel, 'fake');
    assert.equal(view.status.state, 'stopped');
    assert.deepEqual(view.problems, []);
    assert.ok(view.commandPreview.includes('-e'));
    assert.equal(context.manager.state().presets[0].id, 'b1');

    const baseURL = await context.manager.start(config.id, KEY);
    assert.equal(baseURL, `http://127.0.0.1:${config.port}/v1`);
    const status = context.manager.status(config.id);
    assert.equal(status.state, 'running');
    assert.ok(status.readyAt);
    assert.ok(!status.command.includes(KEY));
    const response = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
    assert.equal(response.status, 200);

    await new Promise(resolve => setTimeout(resolve, 400));
    const logs = context.manager.logs(config.id);
    assert.ok(logs.some(line => line.startsWith('— started')));
    assert.ok(logs.includes('green hello'));
    assert.ok(logs.includes('second'));
    assert.ok(logs.every(line => !line.includes('\u001b')));
    assert.ok(context.messages.some(message => message.type === 'localServerLog' && message.lines.includes('plain line')));
    assert.ok(context.messages.some(message => message.type === 'progressNotice' && message.state === 'done'));

    await context.manager.stop(config.id);
    assert.equal(context.manager.status(config.id).state, 'stopped');
    assert.ok(!alive(status.pid));
  } finally {
    await finish(context);
  }
});

test('ensureRunning dedupes concurrent calls into one spawn', async () => {
  const context = await setup();
  try {
    const config = await context.create();
    const urls = await Promise.all([
      context.manager.ensureRunning(config.id, KEY),
      context.manager.ensureRunning(config.id, KEY),
      context.manager.ensureRunning(config.id, KEY),
    ]);
    assert.equal(new Set(urls).size, 1);
    const started = context.manager.logs(config.id).filter(line => line.startsWith('— started'));
    assert.equal(started.length, 1);
    assert.equal(await context.manager.ensureRunning(config.id, KEY), urls[0]);
  } finally {
    await finish(context);
  }
});

test('exclusive mode stops the other running server', async () => {
  const context = await setup();
  try {
    const first = await context.create({}, 'one');
    const second = await context.create({}, 'two');
    await context.manager.start(first.id, KEY);
    const firstPid = context.manager.status(first.id).pid;
    await context.manager.start(second.id, KEY);
    assert.equal(context.manager.status(first.id).state, 'stopped');
    assert.equal(context.manager.status(second.id).state, 'running');
    assert.ok(!alive(firstPid));
  } finally {
    await finish(context);
  }
});

test('changing a running server marks restartRequired', async () => {
  const context = await setup();
  try {
    const config = await context.create();
    await context.manager.start(config.id, KEY);
    assert.equal(context.manager.status(config.id).restartRequired, false);
    await context.manager.updateServer(config.id, { label: 'renamed' });
    assert.equal(context.manager.status(config.id).restartRequired, false);
    await context.manager.updateServer(config.id, { values: { mode: 'ok', extra: 'x' } });
    assert.equal(context.manager.status(config.id).restartRequired, true);
    assert.ok(context.messages.some(message => message.type === 'localServerStatus' && message.status.restartRequired));
  } finally {
    await finish(context);
  }
});

test('an idle server is stopped, a used one is not', async () => {
  let clock = 1_000_000;
  let busy = true;
  const context = await setup({ now: () => clock, isInUse: () => busy });
  try {
    const config = await context.create();
    await context.manager.updateServer(config.id, { idleStopMinutes: 1 });
    await context.manager.start(config.id, KEY);
    clock += 10 * 60_000;
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(context.manager.status(config.id).state, 'running');
    busy = false;
    clock += 2 * 60_000;
    for (let attempt = 0; attempt < 60 && context.manager.status(config.id).state !== 'stopped'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(context.manager.status(config.id).state, 'stopped');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(context.manager.logs(config.id).some(line => line.includes('idle minutes')));
  } finally {
    await finish(context);
  }
});

test('a process that exits before it is ready gives an error with its log', async () => {
  const context = await setup();
  try {
    const config = await context.create({ mode: 'exit' });
    await assert.rejects(context.manager.start(config.id, KEY), error => {
      assert.match(error.message, /exited \(code 3\) before it was ready/);
      assert.match(error.message, /boom before ready/);
      return true;
    });
    const status = context.manager.status(config.id);
    assert.equal(status.state, 'error');
    assert.match(status.error, /boom before ready/);
  } finally {
    await finish(context);
  }
});

test('a busy port is reported', async () => {
  const context = await setup();
  const blocker = createServer();
  try {
    const config = await context.create();
    await new Promise(resolve => blocker.listen(config.port, '127.0.0.1', resolve));
    await assert.rejects(context.manager.start(config.id, KEY), /Port \d+ is in use by another program/);
    assert.equal(context.manager.status(config.id).state, 'error');
  } finally {
    await new Promise(resolve => blocker.close(resolve));
    await finish(context);
  }
});

test('stopping during start rejects the start', async () => {
  const context = await setup();
  try {
    const config = await context.create({ mode: 'hang' });
    const starting = context.manager.start(config.id, KEY);
    const outcome = assert.rejects(starting, /Stopped/);
    for (let attempt = 0; attempt < 100 && !context.manager.status(config.id).pid; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const pid = context.manager.status(config.id).pid;
    assert.ok(pid);
    await context.manager.stop(config.id);
    await outcome;
    assert.equal(context.manager.status(config.id).state, 'stopped');
    assert.ok(!alive(pid));
  } finally {
    await finish(context);
  }
});

test('dispose leaves no child alive', async () => {
  const context = await setup();
  try {
    const first = await context.create({}, 'one');
    await context.manager.start(first.id, KEY);
    const pid = context.manager.status(first.id).pid;
    assert.ok(alive(pid));
    await context.manager.dispose();
    assert.ok(!alive(pid));
  } finally {
    await finish(context);
  }
});

test('a stdin-eof server stops cleanly when its stdin closes, without a force kill', async () => {
  const home = await mkdtemp(join(tmpdir(), 'unify-local-stdin-'));
  const mark = join(home, 'clean-exit');
  const stdinEngine = {
    ...fakeEngine,
    build: (values, context) => ({
      ...fakeEngine.build({ mode: 'stdin' }, context),
      env: { UNIFY_TEST_MARK: mark },
      stop: { method: 'stdin-eof', graceSec: 20 },
    }),
  };
  const context = await setup({ engines: [stdinEngine] });
  try {
    const config = await context.create();
    await context.manager.start(config.id, KEY);
    const pid = context.manager.status(config.id).pid;
    const stoppedAt = Date.now();
    await context.manager.stop(config.id);
    assert.ok(Date.now() - stoppedAt < 5000, 'stopped by closing stdin, not after the 20 s grace');
    assert.ok(!alive(pid));
    assert.equal(await readFile(mark, 'utf8'), 'clean');
  } finally {
    await finish(context);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('the store survives a corrupt file and keeps a backup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'unify-local-store-'));
  try {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'local-inference.json'), '{ not json');
    const file = loadFile(home);
    assert.deepEqual(file, { version: 1, engines: {}, servers: [], presets: [], exclusive: true });
    assert.ok((await readdir(home)).includes('local-inference.json.bak'));
    assert.deepEqual(loadFile(join(home, 'missing')).servers, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('user presets save and delete, and built-ins cannot be deleted', async () => {
  const context = await setup();
  try {
    const config = await context.create({ mode: 'ok' });
    const preset = await context.manager.savePreset(config.id, 'Mine');
    assert.match(preset.id, /^up_[0-9a-f]+$/);
    assert.equal(preset.builtin, false);
    assert.equal(preset.port, config.port);
    assert.deepEqual(context.manager.state().presets.map(entry => entry.id), ['b1', preset.id]);
    assert.equal(loadFile(context.home).presets.length, 1);
    await assert.rejects(context.manager.deletePreset('b1'), /Built-in/);
    await context.manager.deletePreset(preset.id);
    assert.deepEqual(context.manager.state().presets.map(entry => entry.id), ['b1']);
    await context.manager.setExclusive(false);
    assert.equal(loadFile(context.home).exclusive, false);
  } finally {
    await finish(context);
  }
});

test('pickAssets chooses release files per platform', () => {
  const names = [
    'llama-b1-bin-win-cuda-12.4-x64.zip',
    'llama-b1-bin-win-cuda-13.1-x64.zip',
    'cudart-llama-bin-win-cuda-12.4-x64.zip',
    'cudart-llama-bin-win-cuda-13.1-x64.zip',
    'llama-b1-bin-win-vulkan-x64.zip',
    'llama-b1-bin-win-cpu-x64.zip',
    'llama-b1-bin-win-cpu-arm64.zip',
    'llama-b1-bin-macos-arm64.tar.gz',
    'llama-b1-bin-macos-x64.tar.gz',
    'llama-b1-bin-ubuntu-vulkan-x64.tar.gz',
    'llama-b1-bin-ubuntu-x64.tar.gz',
  ];
  const assets = names.map(name => ({ name, browser_download_url: `https://example.invalid/${name}` }));
  const win = { platform: 'win32', arch: 'x64', hasNvidia: false };
  let pick = pickAssets('llama-cpp', assets, { ...win, hasNvidia: true });
  assert.equal(pick.main.name, 'llama-b1-bin-win-cuda-13.1-x64.zip');
  assert.deepEqual(pick.extras.map(asset => asset.name), ['cudart-llama-bin-win-cuda-13.1-x64.zip']);
  assert.equal(pickAssets('llama-cpp', assets, win).main.name, 'llama-b1-bin-win-vulkan-x64.zip');
  assert.equal(pickAssets('llama-cpp', assets.filter(asset => !/vulkan/.test(asset.name)), win).main.name, 'llama-b1-bin-win-cpu-x64.zip');
  assert.equal(pickAssets('llama-cpp', assets, { ...win, arch: 'arm64' }).main.name, 'llama-b1-bin-win-cpu-arm64.zip');
  assert.equal(pickAssets('llama-cpp', assets, { platform: 'darwin', arch: 'arm64', hasNvidia: false }).main.name, 'llama-b1-bin-macos-arm64.tar.gz');
  assert.equal(pickAssets('llama-cpp', assets, { platform: 'linux', arch: 'x64', hasNvidia: false }).main.name, 'llama-b1-bin-ubuntu-vulkan-x64.tar.gz');
  assert.throws(() => pickAssets('llama-cpp', [assets[0]], { platform: 'linux', arch: 'x64', hasNvidia: false }), /Available files: llama-b1-bin-win-cuda-12\.4/);

  const kobold = ['koboldcpp.exe', 'koboldcpp_nocuda.exe', 'koboldcpp-linux-x64', 'koboldcpp-linux-x64-nocuda', 'koboldcpp-mac-arm64']
    .map(name => ({ name, browser_download_url: `https://example.invalid/${name}` }));
  assert.equal(pickAssets('koboldcpp', kobold, { ...win, hasNvidia: true }).main.name, 'koboldcpp.exe');
  assert.equal(pickAssets('koboldcpp', kobold, win).main.name, 'koboldcpp_nocuda.exe');
  assert.equal(pickAssets('koboldcpp', kobold, { platform: 'linux', arch: 'x64', hasNvidia: false }).main.name, 'koboldcpp-linux-x64-nocuda');
  assert.equal(pickAssets('koboldcpp', kobold, { platform: 'darwin', arch: 'arm64', hasNvidia: false }).main.name, 'koboldcpp-mac-arm64');

  const ollama = ['ollama-windows-amd64.zip', 'ollama-windows-arm64.zip', 'ollama-linux-amd64.tgz', 'Ollama-darwin.zip']
    .map(name => ({ name, browser_download_url: `https://example.invalid/${name}` }));
  assert.equal(pickAssets('ollama', ollama, win).main.name, 'ollama-windows-amd64.zip');
  assert.equal(pickAssets('ollama', ollama, { platform: 'linux', arch: 'x64', hasNvidia: false }).main.name, 'ollama-linux-amd64.tgz');
  assert.equal(pickAssets('ollama', ollama, { platform: 'darwin', arch: 'arm64', hasNvidia: false }).main.name, 'Ollama-darwin.zip');
  assert.throws(() => pickAssets('custom', ollama, win), /No custom download/);
});
