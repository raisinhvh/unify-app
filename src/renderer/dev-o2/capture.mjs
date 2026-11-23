#!/usr/bin/env node
/**
 * DEV ONLY: screenshots of the Knowledge / Toolpacks / Hub preview (vite dev + headless Edge over CDP).
 *
 *   node dev-o2/capture.mjs [screen ...] [--github=out] [--edit] [--out=<dir>]
 *
 * Starts vite (real renderer root) on 5182, writes screens/<screen>/__screens__/<screen>-<theme>.png,
 * then stops both Edge and vite.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, '..');
const port = 5182;
const debugPort = 9452;

const args = process.argv.slice(2);
const wanted = args.filter(arg => !arg.startsWith('--'));
const github = args.includes('--github=out') ? 'out' : 'in';
const edit = args.includes('--edit');
const outOverride = args.find(arg => arg.startsWith('--out='))?.slice('--out='.length);
const shots = ['knowledge', 'toolpacks', 'hub']
  .filter(screen => !wanted.length || wanted.includes(screen))
  .flatMap(screen => ['walnutDark', 'walnutLight'].map(theme => ({ screen, theme, name: `${screen}-${theme}` })));

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
      `--user-data-dir=${join(tmpdir(), 'unify-o2-shot-profile')}`,
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
  const width = 1440;
  const height = 900;
  const server = await startVite();
  const browser = await launchEdge(findEdge(), width, height);
  const cdp = await connectCdp(browser.socketUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const shot of shots) {
      const query = new URLSearchParams({ screen: shot.screen, theme: shot.theme, github });
      const url = `http://127.0.0.1:${port}/dev-o2/screens-o2.html?${query}`;
      await cdp.send('Page.navigate', { url });
      await delay(3000);
      if (edit) {
        await cdp.send('Runtime.evaluate', {
          expression: `(() => { const tab = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Edit'); tab?.click(); return !!tab; })()`,
          returnByValue: true,
        });
        await delay(800);
      }
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const outDir = outOverride ?? join(rendererRoot, 'screens', shot.screen, '__screens__');
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, `${shot.name}.png`);
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
