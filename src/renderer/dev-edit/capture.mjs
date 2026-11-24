#!/usr/bin/env node
/**
 * DEV ONLY: screenshots of the live edit preview (vite dev + headless Edge over CDP).
 *
 *   node dev-edit/capture.mjs [name-filter ...]
 *
 * Starts vite (real renderer root) on 5187, opens /dev-edit/edit.html per theme and captures frames while the
 * last row streams (stream-1..3), once it has landed (landed) and with the first diff opened (expanded), then
 * stops Edge and vite.
 * Writes dev-edit/__screens__/<frame>-<theme>.png.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, '..');
const outDir = join(here, '__screens__');
const port = 5187;
const debugPort = 9457;

const themesToShoot = ['walnutDark', 'walnutLight'];
/** Frames after load (ms): the stream starts at 400 ms and lands at about 3.4 s. */
// agent-* frames are the subagent row: its removed-line chip, mid crossfade to the next added line, an added
// line typing, and back to "Working…" after its edit lands.
const frames = [
  { name: 'agent-removed', at: 600 },
  { name: 'stream-1', at: 900 },
  { name: 'stream-2', at: 1900 },
  { name: 'agent-swap', at: 2120 },
  { name: 'stream-3', at: 3000 },
  { name: 'agent-typing', at: 3600 },
  { name: 'landed', at: 5200 },
  // Clicks the first "Show N more lines" and captures once the window has sprung open.
  { name: 'expanded', at: 6400, click: '.edit-more' },
  { name: 'agent-back', at: 7400 },
];
const width = 760;
const height = 960;

const wanted = process.argv.slice(2);
const shots = themesToShoot
  .map(theme => ({
    theme,
    frames: frames.filter(frame => !wanted.length || wanted.some(filter => `${frame.name}-${theme}`.includes(filter))),
  }))
  .filter(shot => shot.frames.length);

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
      `--window-size=${width},${height}`,
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${join(tmpdir(), 'unify-edit-shot-profile')}`,
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
    for (const shot of shots) {
      const query = new URLSearchParams({ theme: shot.theme, manual: '1' });
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/dev-edit/edit.html?${query}` });
      // Wait for the page, then start the stream so frame times are measured from a known start.
      await delay(2500);
      await cdp.send('Runtime.evaluate', { expression: 'window.__editPreview && window.__editPreview.restart()' });
      const started = Date.now();
      for (const frame of shot.frames) {
        if (frame.click) {
          await delay(Math.max(0, frame.at - 800 - (Date.now() - started)));
          await cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(frame.click)})?.click()` });
        }
        await delay(Math.max(0, frame.at - (Date.now() - started)));
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const file = join(outDir, `${frame.name}-${shot.theme}.png`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        console.log(`wrote ${file}`);
      }
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
