import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const home = await mkdtemp(join(tmpdir(), 'unify-media-protocol-'));
const originalUnifyHome = process.env.UNIFY_HOME;
process.env.UNIFY_HOME = home;

const bundled = await build({
  stdin: {
    contents: "export * from './main/mediaProtocol.ts'; export * from './engine/unify/media/store.ts';",
    resolveDir: 'src',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [{
    name: 'electron-stub',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `
          export const app = { isReady: () => true };
          export const protocol = {
            registerSchemesAsPrivileged() {},
            handle(_scheme, handler) { globalThis.__mediaHandler = handler; },
          };
        `,
      }));
    },
  }],
});
const { DiskMediaStore, installMediaProtocol } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);
installMediaProtocol();
const handle = globalThis.__mediaHandler;
const store = new DiskMediaStore(join(home, 'media'));

after(async () => {
  if (originalUnifyHome === undefined) delete process.env.UNIFY_HOME;
  else process.env.UNIFY_HOME = originalUnifyHome;
  await rm(home, { recursive: true, force: true });
});

async function serve(hash, query = '') {
  const response = await handle(new Request(`unify-media://${hash}${query}`));
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    disposition: response.headers.get('content-disposition'),
    nosniff: response.headers.get('x-content-type-options'),
    csp: response.headers.get('content-security-policy'),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

test('known raster images keep their real content type inline', async () => {
  const png = await store.put(Buffer.from('png bytes'), 'image/png', 'chat');
  const response = await serve(png.hash);
  assert.equal(response.status, 200);
  assert.equal(response.type, 'image/png');
  assert.equal(response.disposition, null);
  assert.equal(response.nosniff, 'nosniff');
  assert.equal(response.csp, 'sandbox');
  assert.equal(response.body.toString(), 'png bytes');
});

test('audio and video keep their real content type inline', async () => {
  const audio = await store.put(Buffer.from('audio bytes'), 'audio/mpeg', 'chat');
  const video = await store.put(Buffer.from('video bytes'), 'video/mp4', 'chat');
  assert.equal((await serve(audio.hash)).type, 'audio/mpeg');
  assert.equal((await serve(video.hash)).type, 'video/mp4');
});

test('svg, html and unknown types are forced to a download', async () => {
  for (const [mimeType, bytes] of [
    ['image/svg+xml', '<svg onload="alert(1)"></svg>'],
    ['text/html', '<script>alert(1)</script>'],
    ['application/octet-stream', 'whatever'],
  ]) {
    const media = await store.put(Buffer.from(bytes), mimeType, 'chat');
    const response = await serve(media.hash);
    assert.equal(response.status, 200);
    assert.equal(response.type, 'application/octet-stream', mimeType);
    assert.equal(response.disposition, 'attachment', mimeType);
    assert.equal(response.nosniff, 'nosniff');
    assert.equal(response.csp, 'sandbox');
    assert.equal(response.body.toString(), bytes);
  }
});

test('every 404 is a fresh readable response with the security headers', async () => {
  const missingHash = 'a'.repeat(64);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await serve(missingHash);
    assert.equal(response.status, 404);
    assert.equal(response.body.toString(), 'Not found');
    assert.equal(response.nosniff, 'nosniff');
    assert.equal(response.csp, 'sandbox');
  }
});

test('thumbnails respect SAFE_IMAGE_TYPES, refresh store index, and fall back to original on failure', async () => {
  // Prime the protocol handler's store cache with one image, then write a second image via a separate store instance.
  const first = await store.put(Buffer.from('first invalid png'), 'image/png', 'chat');
  const firstThumb = await serve(first.hash, '?thumb=1');
  assert.equal(firstThumb.status, 200);
  assert.equal(firstThumb.type, 'image/png');
  assert.equal(firstThumb.body.toString(), 'first invalid png');

  const secondStore = new DiskMediaStore(join(home, 'media'));
  const second = await secondStore.put(Buffer.from('second invalid png'), 'image/png', 'chat');
  assert.ok(store.pathOf(second.hash), 'existing DiskMediaStore refreshes indexCache for new entries');
  const secondThumb = await serve(second.hash, '?thumb=1');
  assert.equal(secondThumb.status, 200);
  assert.equal(secondThumb.type, 'image/png');
  assert.equal(secondThumb.body.toString(), 'second invalid png');

  // SVG must never be rendered through sharp even when ?thumb=1 is requested.
  const svg = await store.put(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml', 'chat');
  const svgThumb = await serve(svg.hash, '?thumb=1');
  assert.equal(svgThumb.status, 200);
  assert.equal(svgThumb.type, 'application/octet-stream');
  assert.equal(svgThumb.disposition, 'attachment');
});
