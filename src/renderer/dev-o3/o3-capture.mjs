#!/usr/bin/env node
/**
 * DEV ONLY: screenshots of the O3 previews (Settings and the Setup wizard), vite dev + headless Edge over CDP.
 *
 *   node dev-o3/o3-capture.mjs [settings|setup]
 *
 * Starts vite (renderer root) on 5183 unless it is already up, writes Settings shots to
 * screens/settings/__screens__/ and Setup shots to screens/setup/__screens__/, then stops Edge and vite.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, '..');
const settingsOut = join(rendererRoot, 'screens/settings/__screens__');
const setupOut = join(rendererRoot, 'screens/setup/__screens__');
const port = 5183;
const debugPort = 9483;
const themes = ['walnutDark', 'walnutLight'];

const settingsSections = [
  'appearance', 'motion', 'chats', 'agents', 'runtime', 'knowledge', 'editor', 'usage', 'toolpacks',
  'notifications', 'power', 'accessibility', 'accounts', 'sync', 'about',
];

function settingsShots() {
  const shots = [];
  for (const theme of themes) {
    for (const section of settingsSections) {
      shots.push({ page: 'o3-settings', out: settingsOut, name: `settings-${section}-${theme}`, query: { section, theme } });
    }
    shots.push({ page: 'o3-settings', out: settingsOut, name: `settings-sync-signed-out-${theme}`, query: { section: 'sync', github: 'out', theme } });
  }
  shots.push({ page: 'o3-settings', out: settingsOut, name: 'settings-sync-token-walnutDark', query: { section: 'sync', github: 'token', theme: 'walnutDark' } });
  shots.push({ page: 'o3-settings', out: settingsOut, name: 'settings-sync-error-walnutDark', query: { section: 'sync', github: 'error', theme: 'walnutDark' } });
  shots.push({ page: 'o3-settings', out: settingsOut, name: 'settings-power-armed-walnutDark', query: { section: 'power', power: 'armed', theme: 'walnutDark' } });
  shots.push({ page: 'o3-settings', out: settingsOut, name: 'settings-power-failed-walnutDark', query: { section: 'power', power: 'failed', theme: 'walnutDark' } });
  shots.push({ page: 'o3-settings', out: settingsOut, name: 'settings-power-off-walnutDark', query: { section: 'power', power: 'off', theme: 'walnutDark' } });
  return shots;
}

function setupShots() {
  const shots = [];
  for (const theme of themes) {
    for (const step of ['welcome', 'providers', 'project', 'tools', 'extras', 'done']) {
      shots.push({ page: 'o3-setup', out: setupOut, name: `setup-${step}-${theme}`, query: { step, theme } });
    }
  }
  shots.push({ page: 'o3-setup', out: setupOut, name: 'setup-providers-empty-walnutDark', query: { step: 'providers', accounts: 'none', theme: 'walnutDark' } });
  return shots;
}

const delay = ms => new Promise(done => setTimeout(done, ms));

async function startVite() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    if (response.ok) return undefined;
  } catch {
    // Not up yet.
  }
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: join(rendererRoot, 'vite.config.ts'),
    root: rendererRoot,
    server: { port, strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/.*.tmpdir/**', '**/*.tmp'] } },
    logLevel: 'warn',
  });
  await server.listen();
  return server;
}

function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  const found = candidates.find(path => existsSync(path));
  if (!found) throw new Error('Microsoft Edge not found; set EDGE_PATH.');
  return found;
}

async function launchEdge(edge, width, height) {
  const child = spawn(
    edge,
    [
      '--headless=new',
      '--hide-scrollbars',
      '--no-first-run',
      '--force-device-scale-factor=1',
      `--window-size=${width},${height}`,
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${join(tmpdir(), 'unify-o3-shot-profile')}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find(target => target.type === 'page');
      if (page) return { child, socketUrl: page.webSocketDebuggerUrl };
    } catch {
      // Not listening yet.
    }
    await delay(100);
  }
  child.kill();
  throw new Error('Edge remote debugging did not come up.');
}

function connectCdp(socketUrl) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(socketUrl);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    socket.addEventListener('error', reject);
    socket.addEventListener('open', () => {
      resolvePromise({
        send(method, params = {}) {
          const id = nextId;
          nextId += 1;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((done, fail) => pending.set(id, { resolve: done, reject: fail }));
        },
        close() {
          socket.close();
        },
      });
    });
  });
}

async function main() {
  const only = process.argv[2];
  const shots = [...(only === 'setup' ? [] : settingsShots()), ...(only === 'settings' ? [] : setupShots())];
  const width = 1440;
  const height = 900;
  mkdirSync(settingsOut, { recursive: true });
  mkdirSync(setupOut, { recursive: true });
  const server = await startVite();
  const browser = await launchEdge(findEdge(), width, height);
  const cdp = await connectCdp(browser.socketUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const shot of shots) {
      const url = `http://127.0.0.1:${port}/dev-o3/${shot.page}.html?${new URLSearchParams(shot.query)}`;
      await cdp.send('Page.navigate', { url });
      await delay(2000);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(shot.out, `${shot.name}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`wrote ${file}`);
    }
  } finally {
    cdp.close();
    browser.child.kill();
    await server?.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
