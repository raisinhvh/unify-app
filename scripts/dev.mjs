/**
 * Development launcher: builds the engine/shell, starts Vite for the new
 * renderer when it exists, then runs Electron. A rebuild of the main bundle
 * restarts Electron so engine changes are picked up immediately.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

/**
 * Agent sandboxes label the workspace folder "Low Mandatory Level" so sandboxed tools can write
 * to it. Windows starts any executable that carries that label at low integrity, so Electron
 * would run unable to write AppData or ~/.unify: it then crashes on start (0x80000003), fails its
 * single-instance lock, or shows an EPERM dialog. Relabel Electron's own folder to medium.
 */
function ensureElectronRunsAtMediumIntegrity() {
  if (!isWindows) return;
  const electronDist = dirname(electronPath);
  const check = spawnSync('icacls', [electronPath], { encoding: 'utf8' });
  if (!/Low Mandatory Level/i.test(check.stdout || '')) return;
  const fix = spawnSync('icacls', [electronDist, '/setintegritylevel', '(OI)(CI)M', '/T', '/C', '/Q'], { encoding: 'utf8' });
  const recheck = spawnSync('icacls', [electronPath], { encoding: 'utf8' });
  if (fix.status === 0 && !/Low Mandatory Level/i.test(recheck.stdout || '')) {
    console.log('Relabelled Electron to medium integrity (the workspace folder is labelled low by an agent sandbox).');
    return;
  }
  console.error(`\nElectron is labelled low integrity and could not be relabelled from this terminal.`);
  console.error('Run this once from a normal (non-sandboxed) terminal, then start Unify again:');
  console.error(`  icacls "${electronDist}" /setintegritylevel (OI)(CI)M /T /C /Q\n`);
  process.exit(1);
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

// Unify keeps its state in ~/.unify (or UNIFY_HOME). Sandboxed terminals (agent shells, some IDE
// terminals) block writes outside the project, and Electron would then die on an EPERM dialog.
const stateRoot = process.env.UNIFY_HOME ? resolve(process.env.UNIFY_HOME) : join(homedir(), '.unify');
try {
  mkdirSync(join(stateRoot, 'storage'), { recursive: true });
  const probe = join(stateRoot, `.write-probe-${process.pid}`);
  writeFileSync(probe, '');
  rmSync(probe);
} catch (error) {
  console.error(`\nUnify cannot write to ${stateRoot} (${error.code || error.message}).`);
  console.error('This terminal is sandboxed and blocks writes outside the project folder.');
  console.error('Start Unify from a normal terminal or by double-clicking run.cmd in Explorer.\n');
  process.exit(1);
}

ensureElectronRunsAtMediumIntegrity();

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
