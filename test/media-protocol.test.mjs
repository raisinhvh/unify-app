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

async function serve(hash) {
  const response = await handle(new Request(`unify-media://${hash}`));
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
