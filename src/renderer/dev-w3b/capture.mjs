#!/usr/bin/env node
/**
 * DEV ONLY: filmstrips for the wave-3b organic motion wiring (vite dev + headless Edge over CDP).
 *
 *   node dev-w3b/capture.mjs [name-filter ...]
 *
 * Starts vite (real renderer root) on 5197, loads dev-w3b/w3b.html (the whole app on the mock bridge), fires one
 * `__w3b` trigger per scene and screenshots the region at fixed times after it. The frames are laid side by side
 * in the same browser and saved as dev-w3b/__screens__/<scene>-<theme>.png. Stops Edge and vite.
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
const profileDir = join(tmpdir(), 'unify-w3b-shot-profile');

const themesToShoot = ['walnutDark', 'walnutLight'];
const frameTimes = [0, 120, 260, 420, 650, 1000, 1600];

const scenes = [
  {
    name: 'chat-rename',
    route: 'chats',
    region: '.chats-panel',
    trigger: "__w3b.renameChat('s-mistral', 'Route Mistral system prompts')",
  },
  {
    name: 'chat-reorder',
    route: 'chats',
    region: '.chats-panel',
    setup: ['__w3b.startActive()'],
    trigger: '__w3b.reorderActive()',
  },
  {
    name: 'usage-roll',
    route: 'providers',
    region: '.pv-usage-page',
    setup: ["document.querySelector('.pv-panel-usage').click()"],
    trigger: '__w3b.setUsage(67)',
  },
  {
    name: 'usage-rail',
    route: 'providers',
    region: '.usage-meter',
    pad: 40,
    trigger: '__w3b.setUsage(67)',
  },
  {
    name: 'file-create',
    route: 'files',
    region: '.files-screen-panel',
    trigger: "__w3b.createFile('src/toolpacks/loader.ts')",
  },
  {
    name: 'file-delete',
    route: 'files',
    region: '.files-screen-panel',
    trigger: "__w3b.deleteFile('src/toolpacks/worker.ts')",
  },
  {
    name: 'file-rename',
    route: 'files',
    region: '.files-screen-panel',
    trigger: "__w3b.renameFile('src/mcp/tools.ts', 'src/mcp/toolTable.ts')",
  },
  {
    name: 'file-edit',
    params: { standalone: 'editor' },
    region: '.files-editor',
    setup: ["__w3b.openFile('src/toolpacks/registry.ts')", 'WAIT', '__w3b.editFile(0)'],
    trigger: '__w3b.editFile(1)',
  },
  {
    name: 'doc-create',
    route: 'knowledge',
    region: '.knowledge-panel',
    setup: ['__w3b.seedDocs()'],
    trigger: "__w3b.createDoc('Ask before deleting files')",
  },
  {
    name: 'doc-rename',
    route: 'knowledge',
    region: '.knowledge-panel',
    setup: ['__w3b.seedDocs()', 'WAIT', "__w3b.createDoc('Ask before deleting files')"],
    trigger: "__w3b.renameDoc('Ask before deleting files', 'Confirm every delete')",
  },
  {
    name: 'doc-delete',
    route: 'knowledge',
    region: '.knowledge-panel',
    setup: ['__w3b.seedDocs()', 'WAIT', "__w3b.createDoc('Ask before deleting files')"],
    trigger: "__w3b.deleteDoc('Ask before deleting files')",
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
      if (process.env.W3B_DEBUG && message.method === 'Runtime.consoleAPICalled') {
        console.log('[page]', message.params.args.map(arg => arg.value ?? arg.description).join(' '));
      }
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
  if (result.exceptionDetails) throw new Error(`eval failed: ${expression}\n${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  return result.result.value;
}

async function regionClip(cdp, selector, pad = 0) {
  const rect = await evaluate(
    cdp,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`,
  );
  if (!rect) throw new Error(`region ${selector} not found`);
  const x = Math.max(0, Math.floor(rect.x - pad));
  const y = Math.max(0, Math.floor(rect.y - pad));
  return {
    x,
    y,
    width: Math.min(1440 - x, Math.ceil(rect.width + pad * 2)),
    height: Math.min(900 - y, Math.ceil(rect.height + pad * 2)),
    scale: 1,
  };
}

/** Lays the frames out in one row on a blank page and screenshots that row. */
async function composeStrip(cdp, frames, clip, label) {
  const width = clip.width;
  const height = clip.height;
  const html = `<!doctype html><html><body style="margin:0;background:#888;font:12px system-ui;color:#fff">
    <div style="display:flex;gap:6px;padding:6px">${frames
      .map(
        frame => `<figure style="margin:0"><img style="display:block;width:${width}px;height:${height}px" src="data:image/png;base64,${frame.data}">
        <figcaption style="padding:2px 0">${label} +${frame.at}ms</figcaption></figure>`,
      )
      .join('')}</div></body></html>`;
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await delay(200);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
  await delay(400);
  const stripWidth = frames.length * (width + 6) + 6;
  const stripHeight = height + 32;
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: stripWidth, height: stripHeight, scale: 1 },
  });
  return data;
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
      const query = new URLSearchParams({ fixture: 'home', theme: shot.theme, ...(shot.route ? { route: shot.route } : {}), ...shot.params });
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/dev-w3b/w3b.html?${query}` });
      await delay(3000);
      if (shot.features) {
        await evaluate(
          cdp,
          `(async () => {
            const { viewState } = await import('/store/index.ts');
            const features = { ...viewState.unifyFeatures, ...${JSON.stringify(shot.features)} };
            window.__unifyMock.emit({ type: 'unifyFeaturesState', features });
            __w3b.go(${JSON.stringify(shot.route)});
          })()`,
        );
        await delay(400);
      }
      for (const step of shot.setup ?? []) {
        if (step === 'WAIT') await delay(1200);
        else await evaluate(cdp, step);
        await delay(300);
      }
      await delay(1500);
      if (process.env.W3B_DEBUG) {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(outDir, `debug-${shot.file}.png`), Buffer.from(data, 'base64'));
      }
      const clip = await regionClip(cdp, shot.region, shot.pad ?? 0);
      const frames = [];
      const started = Date.now();
      await evaluate(cdp, shot.trigger);
      for (const at of frameTimes) {
        const wait = started + at - Date.now();
        if (wait > 0) await delay(wait);
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
        frames.push({ at: Date.now() - started, data });
      }
      const strip = await composeStrip(cdp, frames, clip, shot.name);
      const file = join(outDir, `${shot.file}.png`);
      writeFileSync(file, Buffer.from(strip, 'base64'));
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
