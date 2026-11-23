/**
 * Development launcher: builds the engine/shell, starts Vite for the new
 * renderer when it exists, then runs Electron. A rebuild of the main bundle
 * restarts Electron so engine changes are picked up immediately.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import electronPath from 'electron';

const root = process.cwd();
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';
const rendererConfig = join(root, 'src', 'renderer', 'vite.config.ts');
const hasRenderer = existsSync(rendererConfig);
const devUrl = process.env.UNIFY_DEV_URL || 'http://localhost:5173';

const children = [];
let electron;
let restarting = false;
let shuttingDown = false;

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows && command.endsWith('.cmd'),
    ...options,
  });
  children.push(child);
  return child;
}

function startElectron() {
  // DSH itself may set ELECTRON_RUN_AS_NODE in the environment it hands to
  // tools; Electron would then run as plain Node and never open a window.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = start(electronPath, ['.'], {
    env: {
      ...env,
      UNIFY_DEV: hasRenderer ? '1' : '0',
      UNIFY_LEGACY: hasRenderer ? '0' : '1',
      UNIFY_DEV_URL: devUrl,
    },
  });
  electron.on('exit', code => {
    if (shuttingDown || restarting) return;
    shutdown(code ?? 0);
  });
}

function restartElectron() {
  if (!electron || electron.exitCode !== null) {
    startElectron();
    return;
  }
  restarting = true;
  electron.once('exit', () => {
    restarting = false;
    startElectron();
  });
  electron.kill();
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (!existsSync(join(root, 'node_modules'))) {
  console.log('Installing dependencies...');
  const install = spawn(npm, ['install'], { cwd: root, stdio: 'inherit', shell: isWindows });
  await new Promise(resolve => install.on('exit', resolve));
}

if (hasRenderer) {
  start(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), join(root, 'src', 'renderer')]);
} else {
  console.log('No src/renderer/vite.config.ts yet: using the legacy DSH sidebar.');
}

const builder = start(process.execPath, [join(root, 'scripts', 'build.mjs'), '--watch']);
let pendingRestart;
const onBuilderOutput = chunk => {
  const text = String(chunk);
  process.stdout.write(text);
  if (!text.includes('BUILD_OK')) return;
  clearTimeout(pendingRestart);
  pendingRestart = setTimeout(() => {
    if (electron) restartElectron();
  }, 250);
};
builder.stdout?.on('data', onBuilderOutput);
builder.stderr?.on('data', chunk => process.stderr.write(chunk));

// Give the first build a moment, then open the window.
setTimeout(startElectron, 1500);

builder.on('exit', code => {
  if (!shuttingDown) shutdown(code ?? 0);
});
