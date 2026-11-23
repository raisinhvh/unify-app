/**
 * DEV ONLY: screenshots of the O4 previews (loader filmstrips, the pair matrix, the top notice), vite dev +
 * headless Edge over CDP.
 *
 *   node dev-o4/o4-capture.mjs [loaders|notice]
 *
 * Starts vite (renderer root) on 5184 unless it is already up, writes every shot to
 * components/loaders/__screens__/, then stops Edge and vite.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, '..');
const out = join(rendererRoot, 'components/loaders/__screens__');
const port = 5184;
const debugPort = 9484;
const themes = ['walnutDark', 'walnutLight'];

function loaderShots() {
  const shots = [];
  for (const theme of themes) {
    shots.push({ page: 'o4-loaders', name: `loaders-film-${theme}`, query: { mode: 'film', theme }, width: 900, height: 1290, ready: true, scale: 2 });
  }
  shots.push({ page: 'o4-loaders', name: 'loaders-matrix-walnutDark', query: { mode: 'matrix', theme: 'walnutDark' }, width: 720, height: 720, ready: true, scale: 2 });
  return shots;
}

function noticeShots() {
  const shots = [];
  for (const theme of themes) {
    shots.push({ page: 'o4-notice', name: `notice-shell-${theme}`, query: { notice: 'error', fixture: 'shell2x2', theme }, width: 1440, height: 900, wait: 2500 });
    shots.push({ page: 'o4-notice', name: `notice-tones-${theme}`, query: { view: 'tones', theme }, width: 900, height: 240, wait: 1500, scale: 2 });
  }
  shots.push({ page: 'o4-notice', name: 'notice-shell-long-walnutDark', query: { notice: 'long', fixture: 'shell2x2', theme: 'walnutDark' }, width: 1100, height: 700, wait: 2500 });
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
      `--user-data-dir=${join(tmpdir(), 'unify-o4-shot-profile')}`,
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
  const shots = [...(only === 'notice' ? [] : loaderShots()), ...(only === 'loaders' ? [] : noticeShots())];
  mkdirSync(out, { recursive: true });
  const server = await startVite();
  const browser = await launchEdge(findEdge(), 1440, 1200);
  const cdp = await connectCdp(browser.socketUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    for (const shot of shots) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: shot.width, height: shot.height, deviceScaleFactor: shot.scale ?? 1, mobile: false });
      const url = `http://127.0.0.1:${port}/dev-o4/${shot.page}.html?${new URLSearchParams(shot.query)}`;
      await cdp.send('Page.navigate', { url });
      if (shot.ready) {
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const { result } = await cdp.send('Runtime.evaluate', { expression: 'window.__o4Ready === true', returnByValue: true });
          if (result.value) break;
          await delay(100);
        }
        await delay(300);
      } else {
        await delay(shot.wait ?? 2000);
      }
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(out, `${shot.name}.png`);
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
