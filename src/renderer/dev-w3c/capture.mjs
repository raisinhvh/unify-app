#!/usr/bin/env node
/**
 * DEV ONLY: screenshots for the wave-3c Power settings and usage-popover arm switch (vite dev + headless Edge over CDP).
 *
 *   node dev-w3c/capture.mjs [name-filter ...]
 *
 * Starts vite (real renderer root) on 5197, loads dev-w3c/w3c.html (the whole app on the mock bridge), drives it
 * through `__unifyMock.emit` and clicks, and writes dev-w3c/__screens__/<name>-<theme>.png. Stops Edge and vite.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, '..');
const outDir = join(here, '__screens__');
const port = 5197;
const debugPort = 9477;
const profileDir = join(tmpdir(), 'unify-w3c-shot-profile');

const themesToShoot = ['walnutDark', 'walnutLight'];

const emit = message => `window.__unifyMock.emit(${JSON.stringify(message)})`;
const openPopover = [
  { eval: `document.querySelector('.usage-meter').click()` },
  { wait: 500 },
  { eval: 'window.__w3cMountArmRow()' },
  { wait: 300 },
];
const popoverClip = { selector: '.popover.usage-popover', pad: 16 };

const agentModels = [
  { eval: 'window.__w3cAgentModels()' },
  { wait: 800 },
  { eval: `[...document.querySelectorAll('.settings-pages .model-picker')].at(-1).scrollIntoView({ block: 'end' })` },
  { wait: 400 },
];
const openFirstPicker = [{ eval: `document.querySelector('.settings-pages .model-picker').click()` }, { wait: 500 }];

const scenes = [
  { name: 'settings-power-off', route: 'settings', steps: [] },
  { name: 'settings-agents-models', route: 'settings', section: 'agents', steps: agentModels },
  { name: 'settings-agents-picker-open', route: 'settings', section: 'agents', steps: [...agentModels, ...openFirstPicker] },
  { name: 'agents-general', route: 'agents', steps: [{ eval: 'window.__w3cAgentModels()' }, { wait: 800 }] },
  {
    name: 'agents-general-lower',
    route: 'agents',
    steps: [
      { eval: 'window.__w3cAgentModels()' },
      { wait: 800 },
      { eval: `[...document.querySelectorAll('.setting-row')].at(-1).scrollIntoView({ block: 'end' })` },
      { wait: 400 },
    ],
  },
  {
    name: 'agents-profile',
    route: 'agents',
    steps: [
      { eval: 'window.__w3cAgentModels()' },
      { wait: 800 },
      { eval: `[...document.querySelectorAll('button, [role="treeitem"], a')].find(element => element.textContent.trim().startsWith('explorer')).click()` },
      { wait: 800 },
    ],
  },
  { name: 'composer', route: 'chats', steps: [], clip: { selector: '.composer', pad: 24 } },
  { name: 'popover-hover', route: 'chats', steps: [...openPopover, { hover: '.shutdown-arm-label' }, { wait: 300 }], clip: popoverClip },
  { name: 'settings-power-armed', route: 'settings', steps: [{ eval: emit({ type: 'shutdownArmed', armed: true }) }] },
  { name: 'popover-off', route: 'chats', steps: openPopover, clip: popoverClip },
  { name: 'popover-armed', route: 'chats', steps: [{ eval: emit({ type: 'shutdownArmed', armed: true }) }, ...openPopover], clip: popoverClip },
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

/** A clip around an element (selector + padding), at 2x for detail. */
async function clipFor(cdp, clip) {
  const expression = `(() => {
    const rect = document.querySelector(${JSON.stringify(clip.selector)}).getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`;
  const box = await evaluate(cdp, expression);
  return { x: Math.max(0, box.x - clip.pad), y: Math.max(0, box.y - clip.pad), width: box.width + clip.pad * 2, height: box.height + clip.pad * 2, scale: 2 };
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
      const query = new URLSearchParams({ fixture: 'home', theme: shot.theme, route: shot.route, ...(shot.section ? { section: shot.section } : {}) });
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/dev-w3c/w3c.html?${query}` });
      await delay(3000);
      for (const step of shot.steps) {
        if (step.eval) await evaluate(cdp, step.eval);
        if (step.hover) await hover(cdp, step.hover);
        if (step.wait) await delay(step.wait);
      }
      await delay(1200);
      const clip = shot.clip ? { clip: await clipFor(cdp, shot.clip) } : {};
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
