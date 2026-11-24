#!/usr/bin/env node
/**
 * DEV ONLY: screenshots of the ModelPicker preview (every scenario in all 7 themes, as contact sheets) and of
 * the swap sites (chat pane header, composer, setup wizard) in Walnut Dark and Walnut Light.
 *
 *   node dev-o5/capture.mjs [picker|sites]
 *
 * Starts vite (renderer root) on 5185 unless it is already up, writes single shots to dev-o5/__screens__/tmp/,
 * lays the picker shots out as one contact sheet per theme in dev-o5/__screens__/, deletes tmp/ (pass --keep
 * to keep it), then stops Edge and vite.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, '..');
const outDir = join(here, '__screens__');
const tmpDir = join(outDir, 'tmp');
const port = 5185;
const debugPort = 9485;
const allThemes = ['walnutDark', 'walnutLight', 'graphite', 'paper', 'slate', 'moss', 'ink', 'dusk', 'tide', 'ember', 'linen', 'mist', 'sage'];
const siteThemes = ['walnutDark', 'walnutLight'];
const scenarios = ['default', 'long', 'many', 'nosmart', 'noeffort', 'search'];
const pickerSize = { width: 1000, height: 640 };
const siteSize = { width: 1440, height: 900 };

function pickerShots() {
  const shots = [];
  for (const theme of allThemes) {
    for (const scenario of scenarios) {
      shots.push({
        name: `picker-${scenario}-${theme}`,
        url: `/dev-o5/picker.html?${new URLSearchParams({ scenario, theme })}`,
        size: pickerSize,
        wait: 1400,
      });
    }
  }
  return shots;
}

function siteShots() {
  const shots = [];
  for (const theme of siteThemes) {
    const chat = `/index.html?${new URLSearchParams({ fixture: 'chatpane', theme })}`;
    // The chatpane fixture does not finish setup, so the wizard would cover the chat: tell the app it is done.
    const prepare = `window.__unifyMock?.emit({ type: 'setupState', complete: true })`;
    shots.push({ name: `site-chatpane-${theme}`, url: chat, size: siteSize, wait: 2500, prepare, out: outDir });
    shots.push({ name: `site-composer-open-${theme}`, url: chat, size: siteSize, wait: 2500, prepare, click: '.composer .model-picker', out: outDir });
    shots.push({ name: `site-header-open-${theme}`, url: chat, size: siteSize, wait: 2500, prepare, click: '.chat-pane-model', out: outDir });
    const setup = `/dev-o3/o3-setup.html?${new URLSearchParams({ step: 'providers', theme })}`;
    shots.push({ name: `site-setup-${theme}`, url: setup, size: siteSize, wait: 2200, out: outDir });
    shots.push({ name: `site-setup-open-${theme}`, url: setup, size: siteSize, wait: 2200, click: '.model-picker-regular', out: outDir });
  }
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
      `--user-data-dir=${join(tmpdir(), 'unify-o5-shot-profile')}`,
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

async function capture(cdp, shot) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: shot.size.width, height: shot.size.height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}${shot.url}` });
  await delay(shot.wait);
  if (shot.prepare) {
    await cdp.send('Runtime.evaluate', { expression: shot.prepare });
    await delay(900);
  }
  if (shot.click) {
    const { result } = await cdp.send('Runtime.evaluate', {
      // The first *visible* match: covered screens (Home under a chat) keep their own pickers in the DOM.
      expression: `(() => { const element = [...document.querySelectorAll(${JSON.stringify(shot.click)})].find(node => node.checkVisibility({ opacityProperty: true, visibilityProperty: true })); if (!element) return false; element.click(); return true; })()`,
      returnByValue: true,
    });
    if (!result.value) throw new Error(`${shot.name}: nothing matches ${shot.click}`);
    await delay(700);
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = join(shot.out ?? tmpDir, `${shot.name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`wrote ${file}`);
}

async function contactSheet(cdp, name, files, columns, cellWidth, cellHeight) {
  const rows = Math.ceil(files.length / columns);
  const width = 32 + columns * cellWidth + (columns - 1) * 16;
  const height = 32 + rows * (cellHeight + 22) + (rows - 1) * 16;
  const query = new URLSearchParams({ dir: '__screens__/tmp', files: files.join(','), cols: String(columns), width: String(cellWidth) });
  await capture(cdp, { name, url: `/dev-o5/contact.html?${query}`, size: { width, height }, wait: 1500, out: outDir });
}

async function main() {
  const only = process.argv.find(arg => arg === 'picker' || arg === 'sites');
  const keep = process.argv.includes('--keep');
  mkdirSync(tmpDir, { recursive: true });
  const server = await startVite();
  const browser = await launchEdge(findEdge());
  const cdp = await connectCdp(browser.socketUrl);
  try {
    await cdp.send('Page.enable');
    if (only !== 'sites') {
      for (const shot of pickerShots()) await capture(cdp, shot);
      for (const theme of allThemes) {
        const files = scenarios.map(scenario => `picker-${scenario}-${theme}`);
        await contactSheet(cdp, `contact-${theme}`, files, 2, pickerSize.width, pickerSize.height);
      }
    }
    if (only !== 'picker') {
      for (const shot of siteShots()) await capture(cdp, shot);
    }
  } finally {
    cdp.close();
    browser.child.kill();
    await server?.close();
    if (!keep) rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
