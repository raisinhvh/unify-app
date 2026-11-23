import { readFileSync, writeFileSync } from 'node:fs';

// Resolve DSH next to this repo instead of a hard-coded absolute path.
const dshPackagePath = new URL('../../DSH/package.json', import.meta.url);
const dsh = JSON.parse(readFileSync(dshPackagePath, 'utf8'));
// Tests compile engine modules straight from the copied src/engine tree.
const buildTest = dsh.scripts['build:test'].replace(/\bsrc\//g, 'src/engine/');
const pkg = {
  name: 'unify',
  displayName: 'Unify',
  description: 'The DeepSeek Harness agent engine in a native desktop app.',
  version: '0.1.0',
  license: 'MIT',
  private: true,
  repository: { type: 'git', url: 'https://github.com/raisinhvh/Unify.git' },
  main: 'dist/main.js',
  scripts: {
    build: 'node scripts/build.mjs',
    watch: 'node scripts/build.mjs --watch',
    dev: 'node scripts/dev.mjs',
    start: 'electron .',
    'build:renderer': 'vite build src/renderer',
    'build:test': buildTest,
    test: 'npm run build:test && node test/run.mjs',
    dist: 'npm run build && electron-builder --win',
    'dist:mac': 'npm run build && electron-builder --mac',
    'dist:linux': 'npm run build && electron-builder --linux'
  },
  dependencies: { ...dsh.dependencies },
  devDependencies: {
    ...dsh.devDependencies,
    electron: '31.7.7',
    'electron-builder': '^25.1.8',
    vite: '^6.0.0',
    'vite-plugin-solid': '^2.11.0',
    'solid-js': '^1.9.0',
    'monaco-editor': '^0.52.0'
  },
  contributes: dsh.contributes
};
delete pkg.devDependencies['@vscode/vsce'];
writeFileSync(new URL('../package.json', import.meta.url), JSON.stringify(pkg, null, 2) + '\n');
console.log('wrote package.json');
