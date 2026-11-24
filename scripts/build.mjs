/**
 * Bundles the Electron main process, the preload bridge and the engine's two
 * child-process entry points.
 *
 * The engine is compiled against `src/shim/vscode` through esbuild's alias, so
 * `import * as vscode from 'vscode'` resolves to the Electron shim.
 */
import { build, context } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const watch = process.argv.includes('--watch');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  alias: { vscode: join(root, 'src', 'shim', 'vscode', 'index.ts') },
  external: ['electron'],
};

const targets = [
  {
    name: 'main',
    entryPoints: [join(root, 'src', 'main', 'index.ts')],
    outfile: join(dist, 'main.js'),
    // esbuild is loaded at runtime for toolpack transforms; the DSH CLI (and
    // its plugin tree) is spawned as a separate Node process. electron-updater
    // is bundled with the app by electron-builder and required at runtime.
    // node-pty is a native module (integrated terminals) and must be loaded from node_modules at runtime.
    external: ['electron', 'esbuild', '@deepseek-ai/dsh', 'electron-updater', 'node-pty'],
  },
  {
    name: 'preload',
    entryPoints: [join(root, 'src', 'preload', 'index.ts')],
    outfile: join(dist, 'preload.js'),
    external: ['electron'],
  },
  {
    name: 'toolpack-worker',
    entryPoints: [join(root, 'src', 'engine', 'toolpacks', 'worker.ts')],
    outfile: join(dist, 'toolpack-worker.js'),
    external: ['electron'],
  },
  {
    name: 'delegate-server',
    entryPoints: [join(root, 'src', 'engine', 'mcp', 'delegateServer.ts')],
    outfile: join(dist, 'delegate-server.js'),
    external: ['electron'],
  },
];

const announce = {
  name: 'announce',
  setup(buildApi) {
    buildApi.onEnd(result => {
      if (result.errors.length === 0) {
        // scripts/dev.mjs restarts Electron when it sees this line.
        console.log(`BUILD_OK ${buildApi.initialOptions.outfile ?? ''}`.trim());
      }
    });
  },
};

const optionsFor = target => {
  const { name, ...options } = target;
  return { ...shared, ...options, plugins: [announce] };
};

if (!watch) {
  await Promise.all(targets.map(target => build(optionsFor(target))));
} else {
  const contexts = await Promise.all(targets.map(target => context(optionsFor(target))));
  await Promise.all(contexts.map(buildContext => buildContext.watch()));
  console.log('watching for changes; Ctrl+C to stop.');
}
