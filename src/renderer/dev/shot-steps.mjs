#!/usr/bin/env node
/**
 * DEV ONLY. Screenshots after interaction: like tools/shot.mjs, but each shot can run steps first (click a
 * thumbnail, open the viewer) and crop to an element. One vite server and one headless Edge serve the whole plan,
 * on a port of your choice, so several agents can shoot side by side.
 *
 *   node dev/shot-steps.mjs --plan dev/my-plan.json [--port 5181] [--out screens/chats/__screens__]
 *
 * Plan:
 *   {
 *     "size": "1100x760",                       default window size
 *     "themes": ["walnutDark", "walnutLight"],  each shot is taken once per theme, named <name>-<theme>.png
 *     "shots": [
 *       {
 *         "name": "media-expanded",
 *         "page": "chat-media?timed=end",       fixture name plus extra query
 *         "wait": 1500,                         ms after load before the steps (default 1500)
 *         "steps": [                            run in order in the page
 *           { "click": ".media-print" },        clicks the first match (or { "click": "...", "index": 1 })
 *           { "eval": "document.body.dataset.x = 1" },
 *           { "wait": 600 }
 *         ],
 *         "settle": 700,                        ms after the last step before capture (default 700)
 *         "clip": ".timeline",                  optional: crop to this element (plus "pad" px, default 0)
 *         "size": "900x700"                     optional per-shot size
 *       }
 *     ]
 *   }
 *
 * Needs Node 22+ (WebSocket). Stops the vite server and Edge it started.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const devDir = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(devDir, '..');

function parseArgs(argv) {
  const options = { plan: '', port: 5181, out: join(rendererRoot, 'tools', 'out') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--plan') options.plan = argv[++index];
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--out') options.out = resolve(argv[++index]);
  }
  if (!options.plan) throw new Error('Pass --plan <file.json>.');
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

function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

async function serverIsUp(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    return response.ok;
  } catch {
    return false;
  }
}

async function startVite(port) {
  if (await serverIsUp(port)) return undefined;
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: join(rendererRoot, 'vite.config.ts'),
    root: rendererRoot,
    server: { port, strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/tools/out/**', '**/.ref/**', '**/__screens__/**'] } },
    logLevel: 'warn',
  });
  await server.listen();
  return server;
}

async function launchEdge(edge, size, debugPort) {
  const [width, height] = size.split('x');
  const args = [
    '--headless=new',
    '--hide-scrollbars',
    '--no-first-run',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${join(tmpdir(), `unify-shot-steps-${debugPort}`)}`,
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

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(`step failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
  }
  return result.result?.value;
}

/** Clicks like a person: a real mouse press and release at the element's centre (pressable and Esc paths run). */
async function click(cdp, selector, index = 0) {
  const point = await evaluate(cdp, `(() => {
    const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!element) return null;
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`no element for ${selector} [${index}]`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
}

async function key(cdp, name) {
  const codes = { Escape: 27, ArrowRight: 39, ArrowLeft: 37, Enter: 13 };
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: codes[name] ?? 0 });
  }
}

async function shoot(cdp, options, shot, theme, size) {
  const [width, height] = size.split('x').map(Number);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const [fixtureName, extraQuery] = shot.page.split('?');
  const query = new URLSearchParams(extraQuery ?? '');
  query.set('fixture', fixtureName);
  if (theme) query.set('theme', theme);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${options.port}/?${query}` });
  await delay(shot.wait ?? 1500);
  for (const step of shot.steps ?? []) {
    if (step.click) await click(cdp, step.click, step.index ?? 0);
    else if (step.key) await key(cdp, step.key);
    else if (step.eval) await evaluate(cdp, step.eval);
    if (step.wait) await delay(step.wait);
  }
  await delay(shot.settle ?? 700);
  const capture = { format: 'png' };
  if (shot.clip) {
    const rect = await evaluate(cdp, `(() => {
      const element = document.querySelector(${JSON.stringify(shot.clip)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    })()`);
    if (rect) {
      const pad = shot.pad ?? 0;
      const x = Math.max(0, rect.x - pad);
      const y = Math.max(0, rect.y - pad);
      capture.clip = {
        x,
        y,
        width: Math.min(width - x, rect.width + pad * 2),
        height: Math.min(height - y, rect.height + pad * 2),
        scale: 1,
      };
    }
  }
  const { data } = await cdp.send('Page.captureScreenshot', capture);
  const name = theme ? `${shot.name}-${theme}` : shot.name;
  const file = join(options.out, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`wrote ${file}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = JSON.parse(readFileSync(resolve(options.plan), 'utf8'));
  const size = plan.size || '1100x760';
  const themes = plan.themes?.length ? plan.themes : [''];
  mkdirSync(options.out, { recursive: true });
  const edge = findEdge();
  const server = await startVite(options.port);
  const browser = await launchEdge(edge, size, options.port + 4000);
  const cdp = await connectCdp(browser.pageSocketUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    for (const shot of plan.shots) {
      for (const theme of themes) {
        try {
          await shoot(cdp, options, shot, theme, shot.size || size);
        } catch (error) {
          console.error(`FAILED ${shot.name} ${theme}: ${error.message}`);
          process.exitCode = 1;
        }
      }
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
