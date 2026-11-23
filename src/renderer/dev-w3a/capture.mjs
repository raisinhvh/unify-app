#!/usr/bin/env node
/**
 * DEV ONLY: screenshots for the wave-3a shell wiring (vite dev + headless Edge over CDP).
 *
 *   node dev-w3a/capture.mjs [name-filter ...]
 *
 * Starts vite (real renderer root) on 5193, loads dev-w3a/w3a.html (the whole app on the mock bridge), drives it
 * through `__unifyMock.emit` and clicks, and writes shell/__screens__/<name>-<theme>.png. Stops Edge and vite.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, '..');
const outDir = join(rendererRoot, 'shell', '__screens__');
const port = 5193;
const debugPort = 9473;
const profileDir = join(tmpdir(), 'unify-w3a-shot-profile');

const themesToShoot = ['walnutDark', 'walnutLight'];

const allOn = { 'editor.enabled': true, 'toolpacks.hub': true, 'usage.railMeter': true };
const allOff = { 'editor.enabled': false, 'toolpacks.hub': false, 'usage.railMeter': false };
const emit = message => `window.__unifyMock.emit(${JSON.stringify(message)})`;
const clickRail = id => `document.querySelector('[data-rail-entry="${id}"] button').click()`;

const scenes = [
  {
    name: 'nav-shown',
    setup: 'done',
    steps: [{ eval: emit({ type: 'unifyFeaturesState', features: allOn }) }, { eval: clickRail('toolpacks') }],
  },
  {
    name: 'nav-hidden',
    setup: 'done',
    steps: [
      { eval: clickRail('toolpacks') },
      { wait: 600 },
      { eval: emit({ type: 'unifyFeaturesState', features: allOff }) },
    ],
  },
  { name: 'setup-over-home', setup: 'open', steps: [] },
  {
    name: 'shutdown-armed',
    setup: 'done',
    steps: [
      { eval: emit({ type: 'shutdownArmed', armed: true }) },
      { wait: 600 },
      { hover: '[data-shutdown-armed]' },
      { wait: 900 },
    ],
    clip: { x: 1440 - 420, y: 0, width: 420, height: 90, scale: 2 },
  },
  {
    name: 'shutdown-countdown',
    setup: 'done',
    steps: [
      { eval: emit({ type: 'shutdownArmed', armed: true }) },
      { eval: emit({ type: 'shutdownCountdown', secondsLeft: 43 }) },
      { wait: 400 },
      { eval: emit({ type: 'shutdownCountdown', secondsLeft: 42 }) },
    ],
  },
];

const wanted = process.argv.slice(2);
const shots = scenes
  .flatMap(scene => themesToShoot.map(theme => ({ ...scene, theme, file: `${scene.name}-${theme}` })))
  .filter(shot => !wanted.length || wanted.some(filter => shot.file.includes(filter)));

const delay = ms => new Promise(done => setTimeout(done, ms));

async function startVite() {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: join(rendererRoot, 'vite.config.ts'),
    root: rendererRoot,
    server: { port, strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/__screens__/**', '**/.*.tmpdir/**', '**/*.tmp'] } },
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
      `--user-data-dir=${profileDir}`,
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

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(`eval failed: ${expression}\n${result.exceptionDetails.text}`);
  return result.result.value;
}

async function hover(cdp, selector) {
  const expression = `(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`;
  const point = await evaluate(cdp, expression);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
}

async function main() {
  const server = await startVite();
  const browser = await launchEdge(findEdge());
  const cdp = await connectCdp(browser.socketUrl);
  mkdirSync(outDir, { recursive: true });
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const shot of shots) {
      const query = new URLSearchParams({ fixture: 'home', theme: shot.theme, setup: shot.setup });
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/dev-w3a/w3a.html?${query}` });
      await delay(3000);
      for (const step of shot.steps) {
        if (step.eval) await evaluate(cdp, step.eval);
        if (step.hover) await hover(cdp, step.hover);
        if (step.wait) await delay(step.wait);
      }
      await delay(1200);
      const clip = shot.clip ? { clip: shot.clip } : {};
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...clip });
      const file = join(outDir, `${shot.file}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`wrote ${file}`);
    }
  } finally {
    cdp.close();
    browser.child.kill();
    await server.close();
    await delay(500);
    rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
