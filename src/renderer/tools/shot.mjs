#!/usr/bin/env node
/**
 * Screenshots renderer pages with headless Edge against the vite dev server and the dev mock bridge.
 *
 *   node tools/shot.mjs                      every fixture in tools/fixtures (except base)
 *   node tools/shot.mjs home shell2x2        just these
 *   node tools/shot.mjs home --size 1440x900 --theme walnutLight --wait 2500
 *   node tools/shot.mjs "home?open=picker"   extra query params reach the page (and the file name)
 *
 * Captures through the Chrome DevTools Protocol after a real-time wait (needs Node 22+ for WebSocket).
 * Starts vite on 5173 itself (or reuses one already running there) and stops what it started.
 * Output: tools/out/<fixture>[-<theme>].png. Compare with the Figma exports in .ref/.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(toolsDir, '..');
const outDir = join(toolsDir, 'out');
const port = 5173;

function parseArgs(argv) {
  const options = { fixtures: [], size: '1440x900', theme: '', wait: 2500 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--size') options.size = argv[++index];
    else if (arg === '--theme') options.theme = argv[++index];
    else if (arg === '--wait') options.wait = Number(argv[++index]);
    else options.fixtures.push(arg);
  }
  if (!options.fixtures.length) {
    options.fixtures = readdirSync(join(toolsDir, 'fixtures'))
      .filter(name => name.endsWith('.json') && name !== 'base.json')
      .map(name => name.replace(/\.json$/, ''));
  }
  return options;
}

function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean);
  const found = candidates.find(path => existsSync(path));
  if (!found) throw new Error('Microsoft Edge not found; set EDGE_PATH.');
  return found;
}

async function serverIsUp() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    return response.ok;
  } catch {
    return false;
  }
}

async function startVite() {
  if (await serverIsUp()) return undefined;
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: join(rendererRoot, 'vite.config.ts'),
    root: rendererRoot,
    server: { port, strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/tools/out/**', '**/.ref/**'] } },
    logLevel: 'warn',
  });
  await server.listen();
  return server;
}

const debugPort = 9333;

function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

/**
 * Launches headless Edge with remote debugging. Screenshots go through CDP (Page.captureScreenshot)
 * after a real-time wait: Edge's `--screenshot` + `--virtual-time-budget` captured a stale frame
 * mid-animation even though the DOM had settled.
 */
async function launchEdge(edge, size) {
  const [width, height] = size.split('x');
  const args = [
    '--headless=new',
    '--hide-scrollbars',
    '--no-first-run',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${join(tmpdir(), 'unify-shot-edge-profile')}`,
    'about:blank',
  ];
  const child = spawn(edge, args, { stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find(target => target.type === 'page');
      if (page) return { child, pageSocketUrl: page.webSocketDebuggerUrl };
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
          return new Promise((resolveSend, rejectSend) => pending.set(id, { resolve: resolveSend, reject: rejectSend }));
        },
        close() {
          socket.close();
        },
      });
    });
  });
}

async function screenshot(cdp, url, file, size, wait) {
  const [width, height] = size.split('x').map(Number);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url });
  await delay(wait);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });
  const edge = findEdge();
  const server = await startVite();
  const browser = await launchEdge(edge, options.size);
  const cdp = await connectCdp(browser.pageSocketUrl);
  try {
    await cdp.send('Page.enable');
    for (const fixture of options.fixtures) {
      const [fixtureName, extraQuery] = fixture.split('?');
      const query = new URLSearchParams(extraQuery ?? '');
      query.set('fixture', fixtureName);
      if (options.theme) query.set('theme', options.theme);
      const suffix = [options.theme, ...[...query.entries()].filter(([key]) => key !== 'fixture' && key !== 'theme').map(([key, value]) => `${key}-${value}`)]
        .filter(Boolean)
        .join('-');
      const name = suffix ? `${fixtureName}-${suffix}` : fixtureName;
      const file = join(outDir, `${name}.png`);
      await screenshot(cdp, `http://127.0.0.1:${port}/?${query}`, file, options.size, options.wait);
      console.log(existsSync(file) ? `wrote ${file}` : `FAILED ${file}`);
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
