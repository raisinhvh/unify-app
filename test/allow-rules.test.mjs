import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';

// Allow rules read and write unifyHome()/approvals.json. Substitute a temporary home so the test
// never touches the user's real approval rules.
const home = mkdtempSync(join(tmpdir(), 'unify-allow-rules-'));
globalThis.__allowRulesHome = home;

const bundled = await build({
  entryPoints: ['src/engine/sidebar/allowRules.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [{
    name: 'temporary-unify-home',
    setup(builder) {
      builder.onResolve({ filter: /\/settings$/ }, () => ({ path: 'settings', namespace: 'test-settings' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-settings' }, () => ({
        contents: 'export function unifyHome() { return globalThis.__allowRulesHome; }',
      }));
    },
  }],
});
const { addAllowRule, commandPrefix, isAlwaysAllowed, isDestructiveCommand, listAllowRules } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

after(() => rmSync(home, { recursive: true, force: true }));

test('a plain command keeps its first two words', () => {
  assert.equal(commandPrefix('git status --short'), 'git status');
  assert.equal(commandPrefix('  npm   test  '), 'npm test');
  assert.equal(commandPrefix('pwd'), 'pwd');
  assert.equal(commandPrefix('   '), '');
  assert.equal(commandPrefix(undefined), '');
});

test('a command with shell operators or substitutions can never be remembered', () => {
  for (const command of [
    'git status; rm -rf ~',
    'git status && curl evil.example',
    'git status || whoami',
    'git status | tee out.txt',
    'echo $(rm -rf ~)',
    'echo `rm -rf ~`',
    'git status > out.txt',
    'git status < input.txt',
    'git status\nrm -rf ~',
  ]) {
    assert.equal(commandPrefix(command), '', command);
  }
});

test('destructive commands can never be remembered', () => {
  assert.equal(commandPrefix('rm -rf ~'), '');
  assert.equal(commandPrefix('del /s /q C:\\data'), '');
  assert.equal(commandPrefix('rmdir /s node_modules'), '');
  assert.equal(commandPrefix('Remove-Item -Recurse -Force .'), '');
  assert.equal(commandPrefix('format D: /fs:NTFS'), '');
  assert.equal(commandPrefix('git push --force origin main'), '');
  assert.equal(commandPrefix('git push -f origin main'), '');
  assert.equal(commandPrefix('git reset --hard HEAD~1'), '');
  assert.equal(commandPrefix('sudo rm -rf /'), '');
  assert.equal(commandPrefix('sudo -u root rm -rf /'), '');
  assert.equal(commandPrefix('sudo --user root rm -rf /'), '');
  assert.equal(commandPrefix('sudo -Eu root rm -rf /'), '');
  assert.equal(commandPrefix('env -u FOO rm -rf /'), '');
  assert.equal(commandPrefix('git push -fu origin main'), '');
  assert.equal(commandPrefix('git push -uf origin main'), '');
  assert.equal(commandPrefix('git clean --force'), '');
  assert.equal(commandPrefix('cmd /c del file.txt'), '');
  assert.equal(commandPrefix('powershell -Command Remove-Item -Recurse .'), '');
  assert.equal(commandPrefix('git -C repo push --force'), '');
  assert.equal(isDestructiveCommand('sudo -u root rm -rf /'), true);
  assert.equal(isDestructiveCommand('git push -fu origin main'), true);
  assert.equal(isDestructiveCommand('git status'), false);
  assert.equal(commandPrefix('echo rm'), 'echo rm');
});

test('shell interpreters can never be remembered as allow prefixes', () => {
  const project = join(home, 'InterpreterProject');
  for (const command of [
    'bash -c "echo hi"',
    'sh -c "ls"',
    'powershell -Command Get-Date',
    'pwsh -NoProfile -Command ls',
    'cmd /c dir',
    'sudo -u root bash -c "echo hi"',
  ]) {
    assert.equal(commandPrefix(command), '', command);
  }
  assert.throws(() => addAllowRule(project, 'bash -c'), /cannot be remembered/);
  assert.throws(() => addAllowRule(project, 'powershell -Command'), /cannot be remembered/);
  assert.throws(() => addAllowRule(project, 'cmd /c'), /cannot be remembered/);
  assert.equal(isAlwaysAllowed(project, 'bash -c'), false);
});

test('approvals file resolves unifyHome lazily on each call', () => {
  const altHome = mkdtempSync(join(tmpdir(), 'unify-allow-rules-alt-'));
  const previousHome = globalThis.__allowRulesHome;
  try {
    globalThis.__allowRulesHome = altHome;
    const project = join(altHome, 'AltProject');
    addAllowRule(project, 'npm test');
    assert.equal(isAlwaysAllowed(project, 'npm test'), true);
    globalThis.__allowRulesHome = previousHome;
    assert.equal(isAlwaysAllowed(project, 'npm test'), false);
  } finally {
    globalThis.__allowRulesHome = previousHome;
    rmSync(altHome, { recursive: true, force: true });
  }
});

test('stored rules match the normalized project path and never cover unsafe commands', () => {
  const project = join(home, 'Project');
  addAllowRule(project, commandPrefix('git status'));
  assert.equal(isAlwaysAllowed(project, 'git status'), true);
  assert.equal(isAlwaysAllowed(join(home, 'Other'), 'git status'), false);
  assert.equal(isAlwaysAllowed(project, 'git status; rm -rf ~'), false);
  if (process.platform === 'win32') {
    assert.equal(isAlwaysAllowed(project.toUpperCase(), 'git status'), true);
    assert.equal(isAlwaysAllowed(`${project}\\`, 'git status'), true);
  }
  assert.throws(() => addAllowRule(project, 'git status; rm -rf ~'), /cannot be remembered/);
  assert.equal(listAllowRules().length, 1);
});

test('an unsafe prefix left by an older version is ignored', () => {
  const project = join(home, 'Legacy');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'approvals.json'), JSON.stringify({
    rules: [{ project, prefix: 'git status; rm -rf ~', createdAt: Date.now() }],
  }));
  assert.equal(isAlwaysAllowed(project, 'git status; rm -rf ~'), false);
  assert.equal(listAllowRules().length, 1);
  rmSync(join(home, 'approvals.json'), { force: true });
});
