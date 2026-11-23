#!/usr/bin/env node
/**
 * DEV ONLY: screenshots of the Hub install-script consent dialog (vite dev + headless Edge over CDP).
 *
 *   node screens/hub/__screens__/capture.mjs
 *
 * Opens the dev-o2 Hub preview (hubMock answers: Unity Editor ships an install script), installs Unity Editor,
 * and writes hub-consent[-entering|-scrolled]-<theme>.png here. Starts vite on 5183, stops Edge and vite after.
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, '../../..');
const port = 5183;
const debugPort = 9453;
const themes = ['walnutDark', 'walnutLight'];

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
      `--user-data-dir=${join(tmpdir(), 'unify-hub-consent-shot-profile')}`,
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
  const evaluate = async expression => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const shoot = async name => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(here, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`wrote ${file}`);
  };
  try {
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of themes) {
      const query = new URLSearchParams({ screen: 'hub', theme, github: 'in' });
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/dev-o2/screens-o2.html?${query}` });
      await delay(3000);
      const clicked = await evaluate(`(() => {
        const row = [...document.querySelectorAll('.hub-row')].find(r => r.textContent.includes('Unity Editor'));
        row?.querySelector('.hub-install')?.click();
        return !!row;
      })()`);
      if (!clicked) throw new Error('Unity Editor row not found');
      await delay(500);
      await evaluate(`document.querySelector('.confirm-bar .confirm-danger')?.click()`);
      // Catch the dialog mid-entrance to check it animates like the other dialogs.
      let entering;
      for (let attempt = 0; attempt < 200 && !entering; attempt += 1) {
        entering = await evaluate(`(() => { const s = document.querySelector('.hub-scrim'); return s ? { opacity: s.style.opacity, transform: s.style.transform } : undefined; })()`);
        if (!entering) await delay(10);
      }
      if (!entering) throw new Error('Consent dialog did not open');
      await delay(40);
      await shoot(`hub-consent-entering-${theme}`);
      await delay(900);
      console.log(theme, 'entering frame', entering);
      console.log(theme, 'checks', await evaluate(`(() => {
        const script = document.querySelector('.hub-script');
        const clipped = [...document.querySelectorAll('.hub-dialog *')]
          .filter(el => el.children.length === 0 && el.textContent.trim() && el !== script && !script.contains(el))
          .filter(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
          .map(el => el.className || el.tagName);
        return { scrolls: script.scrollHeight > script.clientHeight, scrollHeight: script.scrollHeight, clientHeight: script.clientHeight, clipped };
      })()`));
      await shoot(`hub-consent-${theme}`);
      await evaluate(`(() => { const s = document.querySelector('.hub-script'); s.scrollTop = s.scrollHeight; })()`);
      await delay(200);
      await shoot(`hub-consent-scrolled-${theme}`);
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
