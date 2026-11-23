#!/usr/bin/env node
/**
 * DEV ONLY: screenshots for the O6 logos-and-dots pass (vite dev + headless Edge over CDP).
 *
 *   node dev-o6/capture.mjs [name-filter ...]
 *
 * Starts vite (real renderer root) on 5186, writes dev-o6/__screens__/<name>.png, then stops Edge and vite.
 * Shots: the glyph contact sheet, then Providers (usage, account, add), Settings (appearance, usage, accounts),
 * Knowledge, Toolpacks and Hub in Walnut Dark and Walnut Light.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, '..');
const outDir = join(here, '__screens__');
const port = 5186;
const debugPort = 9456;

const themesToShoot = ['walnutDark', 'walnutLight'];
const screens = [
  { name: 'providers-usage', path: '/screens/providers/preview.html', query: { state: 'usage' } },
  { name: 'providers-account', path: '/screens/providers/preview.html', query: { state: 'account' } },
  { name: 'providers-add', path: '/screens/providers/preview.html', query: { state: 'add' } },
  { name: 'settings-appearance', path: '/dev-o3/o3-settings.html', query: { section: 'appearance' } },
  { name: 'settings-usage', path: '/dev-o3/o3-settings.html', query: { section: 'usage' } },
  { name: 'settings-accounts', path: '/dev-o3/o3-settings.html', query: { section: 'accounts' } },
  { name: 'knowledge', path: '/dev-o2/screens-o2.html', query: { screen: 'knowledge' } },
  { name: 'toolpacks', path: '/dev-o2/screens-o2.html', query: { screen: 'toolpacks' } },
  { name: 'hub', path: '/dev-o2/screens-o2.html', query: { screen: 'hub' } },
];

const wanted = process.argv.slice(2);
const shots = [
  { name: 'glyphs', path: '/dev-o6/glyphs.html', query: {}, width: 1760, height: 380 },
  ...screens.flatMap(screen =>
    themesToShoot.map(theme => ({
      name: `${screen.name}-${theme}`,
      path: screen.path,
      query: { ...screen.query, theme },
      width: 1440,
      height: 900,
    })),
  ),
].filter(shot => !wanted.length || wanted.some(filter => shot.name.includes(filter)));

const delay = ms => new Promise(done => setTimeout(done, ms));

async function startVite() {
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

async function launchEdge(edge) {
  const child = spawn(
    edge,
    [
      '--headless=new',
      '--hide-scrollbars',
      '--no-first-run',
      '--force-device-scale-factor=1',
      '--window-size=1440,900',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${join(tmpdir(), 'unify-o6-shot-profile')}`,
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
  const server = await startVite();
  const browser = await launchEdge(findEdge());
  const cdp = await connectCdp(browser.socketUrl);
  mkdirSync(outDir, { recursive: true });
  try {
    await cdp.send('Page.enable');
    for (const shot of shots) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: shot.width,
        height: shot.height,
        deviceScaleFactor: shot.name === 'glyphs' ? 2 : 1,
        mobile: false,
      });
      const query = new URLSearchParams(shot.query);
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}${shot.path}?${query}` });
      await delay(3000);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(outDir, `${shot.name}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`wrote ${file}`);
    }
  } finally {
    cdp.close();
    browser.child.kill();
    await server.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
