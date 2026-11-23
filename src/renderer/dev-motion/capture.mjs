#!/usr/bin/env node
/**
 * DEV ONLY: mid-transition and settled frames of the shared components (vite dev + headless Edge over CDP).
 *
 *   node dev-motion/capture.mjs [name-filter ...]
 *
 * Starts vite (real renderer root) on 5199 and loads dev-motion/motion.html. For every scene it runs the setup at
 * normal speed, then slows time 6x (springs read a scaled clock, CSS transitions get a lower playback rate), runs
 * the action, shoots `<scene>-mid-<theme>.png`, restores speed and shoots `<scene>-settled-<theme>.png` into
 * dev-motion/__screens__/. Stops Edge and vite.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, '..');
const outDir = join(here, '__screens__');
const port = 5199;
const debugPort = 9479;
const profileDir = join(tmpdir(), 'unify-motion-shot-profile');
const slow = 6;

const themesToShoot = ['walnutLight', 'walnutDark'];

const act = name => `[data-act="${name}"]`;
const emit = message => `window.__unifyMock.emit(${JSON.stringify(message)})`;

/**
 * setup: steps at normal speed. action: steps under slow time. mid: virtual ms after the action for the mid frame
 * (plus realDelay for plain timers, like the tooltip's hover delay). cell: which cell to clip ('page' = viewport).
 */
const scenes = [
  { name: 'button-press', cell: 'buttons', action: [{ down: act('primary') }], mid: 30, after: [{ up: act('primary') }] },
  { name: 'button-release', cell: 'buttons', setup: [{ down: act('primary') }, { wait: 300 }], action: [{ up: act('primary') }], mid: 40 },
  { name: 'icon-press', cell: 'buttons', action: [{ down: act('icon') }], mid: 30, after: [{ up: act('icon') }] },
  { name: 'toggle-press', cell: 'toggle', action: [{ down: '.toggle' }], mid: 40, after: [{ up: '.toggle' }] },
  { name: 'toggle-on', cell: 'toggle', action: [{ click: '.toggle' }], mid: 70 },
  { name: 'select-open', cell: 'select', action: [{ click: '.select' }], mid: 80 },
  { name: 'select-change', cell: 'select', setup: [{ click: '.select' }, { wait: 600 }], action: [{ clickText: ['.menu-item', 'extra high'] }], mid: 70 },
  { name: 'menu-open', cell: 'menu', action: [{ click: act('menu') }], mid: 80 },
  { name: 'menu-close', cell: 'menu', setup: [{ click: act('menu') }, { wait: 600 }], action: [{ key: 'Escape' }], mid: 40 },
  { name: 'popover-open', cell: 'popover', action: [{ click: act('popover') }], mid: 80 },
  { name: 'tooltip-in', cell: 'buttons', action: [{ hover: act('tooltip') }], realDelay: 460, mid: 50 },
  { name: 'tooltip-glide', cell: 'page', setup: [{ hover: act('tooltip') }, { wait: 1000 }], action: [{ hover: act('chip') }], mid: 90 },
  { name: 'tree-expand', cell: 'tree', action: [{ click: '.tree-folder-row' }], mid: 100 },
  { name: 'tree-collapse', cell: 'tree', setup: [{ click: '.tree-folder-row' }, { wait: 700 }], action: [{ click: '.tree-folder-row' }], mid: 80 },
  { name: 'notice-in', cell: 'notice', action: [{ click: act('notice') }], mid: 80 },
  { name: 'notice-replace', cell: 'notice', setup: [{ click: act('notice') }, { wait: 800 }], action: [{ click: act('notice') }], mid: 80 },
  { name: 'notice-out', cell: 'notice', setup: [{ click: act('notice') }, { wait: 800 }], action: [{ click: act('notice-clear') }], mid: 50 },
  {
    name: 'shutdown-in',
    cell: 'shutdown',
    action: [{ eval: emit({ type: 'shutdownArmed', armed: true }) }, { eval: emit({ type: 'shutdownCountdown', secondsLeft: 43 }) }],
    mid: 140,
  },
  { name: 'edited-lines', cell: 'edited-lines', action: [{ click: act('code-edit') }], mid: 160 },
  { name: 'nav-rail-hide', cell: 'nav-rail', action: [{ click: act('rail-files') }], mid: 120 },
  { name: 'nav-rail-show', cell: 'nav-rail', setup: [{ click: act('rail-files') }, { wait: 900 }], action: [{ click: act('rail-files') }], mid: 120 },
];

const wanted = process.argv.slice(2);
const shots = scenes
  .flatMap(scene => themesToShoot.map(theme => ({ ...scene, theme })))
  .filter(shot => !wanted.length || wanted.some(filter => `${shot.name}-${shot.theme}`.includes(filter)));

const delay = ms => new Promise(done => setTimeout(done, ms));

/** Installed before the page loads: a clock springs read that window.__timeScale(n) slows down n times. */
const clockScript = `(() => {
  const realNow = performance.now.bind(performance);
  let scale = 1, realBase = realNow(), virtualBase = realBase;
  const now = () => virtualBase + (realNow() - realBase) / scale;
  performance.now = now;
  const realRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => realRaf(() => callback(now()));
  window.__timeScale = next => { virtualBase = now(); realBase = realNow(); scale = next; };
})();`;

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
      '--window-size=1200,1300',
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

async function centre(cdp, selector, text) {
  const find = text
    ? `[...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.includes(${JSON.stringify(text)}))`
    : `document.querySelector(${JSON.stringify(selector)})`;
  return evaluate(cdp, `(() => { const rect = (${find}).getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`);
}

const mouse = (cdp, type, point, buttons) =>
  cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: 1 });

async function runStep(cdp, step) {
  if (step.wait) await delay(step.wait);
  if (step.eval) await evaluate(cdp, step.eval);
  if (step.key) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: step.key, code: step.key, windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: step.key, code: step.key, windowsVirtualKeyCode: 27 });
  }
  const target = step.hover ?? step.down ?? step.up ?? step.click;
  const point = step.clickText ? await centre(cdp, step.clickText[0], step.clickText[1]) : target ? await centre(cdp, target) : undefined;
  if (!point) return;
  await mouse(cdp, 'mouseMoved', point, 0);
  if (step.down || step.click || step.clickText) await mouse(cdp, 'mousePressed', point, 1);
  if (step.up || step.click || step.clickText) await mouse(cdp, 'mouseReleased', point, 0);
}

async function setSpeed(cdp, scale) {
  await evaluate(cdp, `window.__timeScale(${scale})`);
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / scale });
}

async function clipFor(cdp, cell) {
  if (cell === 'page') return undefined;
  const rect = await evaluate(
    cdp,
    `(() => { const r = document.querySelector('[data-cell="${cell}"]').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
  );
  const pad = 12;
  return { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.width + pad * 2, height: rect.height + pad * 2, scale: 2 };
}

async function shoot(cdp, clip, file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`wrote ${file}`);
}

async function main() {
  const server = await startVite();
  const browser = await launchEdge(findEdge());
  const cdp = await connectCdp(browser.socketUrl);
  mkdirSync(outDir, { recursive: true });
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Animation.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: clockScript });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1300, deviceScaleFactor: 1, mobile: false });
    for (const shot of shots) {
      const query = new URLSearchParams({ theme: shot.theme });
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/dev-motion/motion.html?${query}` });
      await delay(2500);
      await mouse(cdp, 'mouseMoved', { x: 1190, y: 1290 }, 0);
      for (const step of shot.setup ?? []) await runStep(cdp, step);
      await delay(200);
      const clip = await clipFor(cdp, shot.cell);
      await setSpeed(cdp, slow);
      for (const step of shot.action) await runStep(cdp, step);
      await delay((shot.realDelay ?? 0) + shot.mid * slow);
      await shoot(cdp, clip, join(outDir, `${shot.name}-mid-${shot.theme}.png`));
      await setSpeed(cdp, 1);
      await delay(1000);
      await shoot(cdp, clip, join(outDir, `${shot.name}-settled-${shot.theme}.png`));
      for (const step of shot.after ?? []) await runStep(cdp, step);
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
