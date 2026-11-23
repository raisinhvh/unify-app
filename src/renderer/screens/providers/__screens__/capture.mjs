#!/usr/bin/env node
/**
 * DEV ONLY: screenshots of the Providers preview (vite dev + headless Edge over CDP).
 *
 *   node screens/providers/__screens__/capture.mjs
 *
 * Starts vite (real renderer root) on 5181, captures each state/theme into this folder, stops
 * both Edge and vite. Mirrors tools/shot.mjs but navigates straight at preview.html so the folder
 * can be reviewed without touching the app shell.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, '../../..');
const outDir = here;
const port = 5181;
const debugPort = 9444;

const shots = [
  { state: 'usage', theme: 'walnutDark', name: 'providers-usage-walnutDark' },
  { state: 'account', theme: 'walnutDark', name: 'providers-account-walnutDark' },
  { state: 'account', theme: 'walnutDark', name: 'providers-account-open-walnutDark', click: '.pv-default-model' },
  { state: 'add', theme: 'walnutDark', name: 'providers-add-walnutDark' },
  { state: 'usage', theme: 'walnutLight', name: 'providers-usage-walnutLight' },
  { state: 'account', theme: 'walnutLight', name: 'providers-account-walnutLight' },
  { state: 'account', theme: 'walnutLight', name: 'providers-account-open-walnutLight', click: '.pv-default-model' },
  { state: 'add', theme: 'walnutLight', name: 'providers-add-walnutLight' },
  { state: 'add', theme: 'walnutDark', name: 'providers-add-selfhosted-walnutDark', add: 'Self-hosted' },
  { state: 'empty', theme: 'walnutDark', name: 'providers-empty-walnutDark' },
];

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
      `--user-data-dir=${join(tmpdir(), 'unify-providers-shot-profile')}`,
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
  mkdirSync(outDir, { recursive: true });
  const server = await startVite();
  const browser = await launchEdge(findEdge(), width, height);
  const cdp = await connectCdp(browser.socketUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const shot of shots) {
      const query = new URLSearchParams({ state: shot.state, theme: shot.theme });
      if (shot.add) query.set('add', shot.add);
      const url = `http://127.0.0.1:${port}/screens/providers/preview.html?${query}`;
      await cdp.send('Page.navigate', { url });
      await delay(2600);
      if (shot.click) {
        // Open a popover (e.g. the default-model picker) before capturing.
        await cdp.send('Runtime.evaluate', {
          expression: `(() => { const target = document.querySelector(${JSON.stringify(shot.click)});
            if (target) target.click(); return Boolean(target); })()`,
          returnByValue: true,
        });
        await delay(600);
      }
      if (shot.add) {
        // Expand a provider row to expose the inline form.
        await cdp.send('Runtime.evaluate', {
          expression: `(() => { const rows = [...document.querySelectorAll('.pv-add-row, .add-provider-row, button')];
            const row = rows.find(r => r.textContent && r.textContent.includes(${JSON.stringify(shot.add)}));
            if (row) row.click(); return Boolean(row); })()`,
          returnByValue: true,
        });
        await delay(600);
      }
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
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
