// Sanity checks for src/renderer/shell/layout.ts. Bundles the module with esbuild, stubs its UI and persistence
// imports, and runs the assertions against the bundle. Run: node scripts/layout-check.mjs
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../src/renderer/shell/layout.ts');

// In-memory stand-in for persist.ts. `stored` is what a previous session left behind.
let stored;
const stubs = {
  '../bridge': 'export const bridge = () => ({});',
  '../persist': `
    export const readPersisted = (key, fallback) => (globalThis.__persisted && key in globalThis.__persisted ? globalThis.__persisted[key] : fallback);
    export const writePersisted = (key, value) => { globalThis.__written = { ...(globalThis.__written ?? {}), [key]: value }; };
  `,
  'solid-js': `
    export const createRoot = (fn) => fn(() => {});
    export const createSignal = (v) => [() => v, n => (v = typeof n === 'function' ? n(v) : n)];
    export const createMemo = (fn) => fn;
  `,
};

const stubPlugin = {
  name: 'stub-imports',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^(\.\.\/bridge|\.\.\/persist|solid-js)$/ }, args => ({ path: args.path, namespace: 'stub' }));
    buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
  },
};

const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [stubPlugin],
  logLevel: 'silent',
});

const dir = mkdtempSync(join(tmpdir(), 'layout-check-'));
const bundlePath = join(dir, 'layout.bundle.mjs');
writeFileSync(bundlePath, result.outputFiles[0].text);

let counter = 0;
/** Loads a fresh copy of the module (singleton state), optionally with a persisted value preset. */
async function load(persisted) {
  globalThis.__persisted = persisted === undefined ? undefined : { layout: persisted };
  counter += 1;
  return import(`${pathToFileURL(bundlePath).href}?run=${counter}`);
}

const EPS = 1e-9;
const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

/** Every node in the tree: fails on single-child splits, same-dir nesting, bad sizes, duplicate keys. */
function assertInvariants(api, label) {
  const root = api.layout().root;
  const keys = new Set();
  const walk = (node, parentDir) => {
    assert.ok(!keys.has(node.key), `${label}: duplicate key ${node.key}`);
    keys.add(node.key);
    if (node.type === 'leaf') return;
    assert.ok(node.children.length >= 2, `${label}: split with ${node.children.length} child(ren)`);
    assert.equal(node.children.length, node.sizes.length, `${label}: sizes/children length mismatch`);
    const total = node.sizes.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < EPS, `${label}: sizes sum to ${total}`);
    for (const size of node.sizes) assert.ok(size >= api.minPaneFraction - EPS, `${label}: size ${size} below minimum`);
    for (const child of node.children) {
      if (child.type === 'split') assert.notEqual(child.dir, node.dir, `${label}: same-direction split not flattened`);
      walk(child, node.dir);
    }
  };
  if (root) walk(root, null);
  const leaves = api.leafRects(root);
  const ids = new Set(leaves.map(l => l.paneId).filter(Boolean));
  assert.deepEqual(Object.keys(api.layout().panes).sort(), [...ids].sort(), `${label}: panes map not pruned to leaves`);
  const chats = api.panes().filter(p => p.kind === 'chat').map(p => p.chatId);
  assert.equal(new Set(chats).size, chats.length, `${label}: chat in more than one leaf`);
  const focused = api.layout().focused;
  if (leaves.length) assert.ok(leaves.some(l => l.key === focused), `${label}: focus not on a leaf`);
  else assert.equal(focused, null, `${label}: focus set with no leaves`);
  if (!leaves.length) assert.equal(root, null, `${label}: root should be null`);
}

function assertTiles(api, label) {
  const rects = api.leafRects(api.layout().root);
  const area = rects.reduce((sum, r) => sum + r.rect.width * r.rect.height, 0);
  assert.ok(Math.abs(area - 1) < EPS, `${label}: area ${area}`);
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i].rect;
      const b = rects[j].rect;
      const overlapW = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
      const overlapH = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
      assert.ok(!(overlapW > EPS && overlapH > EPS), `${label}: leaves ${i} and ${j} overlap`);
    }
    const r = rects[i].rect;
    assert.ok(r.left >= -EPS && r.top >= -EPS && r.left + r.width <= 1 + EPS && r.top + r.height <= 1 + EPS, `${label}: leaf outside [0,1]`);
  }
}

check('every preset tiles the unit square with presetCellCount leaves', async () => {
  const api = await load();
  for (const preset of api.presetOrder) {
    const tree = api.presetTree(preset);
    const rects = api.leafRects(tree);
    assert.equal(rects.length, api.presetCellCount(preset), `${preset}: leaf count`);
    assert.ok(rects.every(r => r.paneId === null), `${preset}: leaves should be empty`);
    const area = rects.reduce((sum, r) => sum + r.rect.width * r.rect.height, 0);
    assert.ok(Math.abs(area - 1) < EPS, `${preset}: area ${area}`);
    assertTiles({ ...api, layout: () => ({ root: tree }) }, preset);
    assert.equal(new Set(rects.map(r => r.key)).size, rects.length, `${preset}: keys not unique`);
  }
});

check('openChat x3 + openPane terminal + files twice gives one files pane and 5 panes', async () => {
  const api = await load();
  api.openChat('a');
  api.openChat('b', { beside: true });
  api.openChat('c', { beside: true });
  const terminalId = api.openPane('terminal');
  const filesId = api.openPane('files');
  const filesAgain = api.openPane('files');
  assert.equal(filesAgain, filesId, 'second files open should return the existing id');
  assert.equal(api.panes().length, 5);
  assert.equal(api.panes().filter(p => p.kind === 'files').length, 1);
  assert.ok(api.paneById(terminalId));
  assert.deepEqual(api.openChats().sort(), ['a', 'b', 'c']);
  assertInvariants(api, 'open sequence');
  assertTiles(api, 'open sequence');
});

check('openChat on screen focuses; popped-out chat is never placed', async () => {
  const api = await load();
  api.openChat('a');
  api.openChat('b', { beside: true });
  api.openChat('a');
  assert.equal(api.focusedChatId(), 'a');
  api.setPoppedOutChats(['b']);
  assert.deepEqual(api.openChats(), ['a']);
  api.openChat('b', { beside: true });
  assert.deepEqual(api.openChats(), ['a']);
  assertInvariants(api, 'popout');
});

check('movePane to every edge and to a chat leaf keeps invariants and tiling', async () => {
  const api = await load();
  api.openChat('a');
  api.openChat('b', { beside: true });
  api.openChat('c', { beside: true });
  api.openPane('terminal');
  for (const edge of ['left', 'right', 'top', 'bottom', 'center']) {
    const pane = api.panes()[0];
    const targets = api.leafRects(api.layout().root);
    const target = targets.find(t => t.key !== api.leafOfPane(pane.id)) ?? targets[0];
    api.movePane(pane.id, target.key, edge);
    assertInvariants(api, `movePane ${edge}`);
    assertTiles(api, `movePane ${edge}`);
    assert.equal(api.panes().length, 4, `movePane ${edge}: pane count`);
  }
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    const pane = api.panes()[api.panes().length - 1];
    api.movePaneToEdge(pane.id, edge);
    assertInvariants(api, `movePaneToEdge ${edge}`);
    assertTiles(api, `movePaneToEdge ${edge}`);
    assert.equal(api.panes().length, 4, `movePaneToEdge ${edge}: pane count`);
  }
  const first = api.panes()[0];
  const leaf = api.leafOfPane(first.id);
  api.movePane(first.id, leaf, 'left');
  assert.equal(api.leafOfPane(first.id), leaf, 'moving onto own leaf is a no-op');
});

check('closePane collapses splits (no single-child splits anywhere)', async () => {
  const api = await load();
  api.applyPreset('grid3x2');
  const ids = api.leafRects(api.layout().root).map(r => r.key);
  for (const leafKey of ids) api.closeSlot(leafKey);
  api.openChat('a');
  api.openChat('b', { beside: true });
  api.openChat('c', { beside: true });
  api.closeChat('b');
  assertInvariants(api, 'close collapse');
  api.closeChat('a');
  assertInvariants(api, 'close collapse 2');
  api.closeChat('c');
  assert.equal(api.layout().root, null, 'closing everything leaves no root');
});

check('resizeSplit sets the gutter and clamps both neighbours', async () => {
  const api = await load();
  api.openChat('a');
  api.openChat('b', { beside: true });
  const split = api.layout().root;
  assert.equal(split.type, 'split');
  api.resizeSplit(split.key, 0, 0.7);
  let sizes = api.layout().root.sizes;
  assert.ok(Math.abs(sizes[0] - 0.7) < EPS, `gutter at 0.7, got ${sizes[0]}`);
  api.resizeSplit(split.key, 0, 0.0);
  sizes = api.layout().root.sizes;
  assert.ok(Math.abs(sizes[0] - api.minPaneFraction) < EPS, `clamped low, got ${sizes[0]}`);
  api.resizeSplit(split.key, 0, 1.0);
  sizes = api.layout().root.sizes;
  assert.ok(Math.abs(sizes[1] - api.minPaneFraction) < EPS, `clamped high, got ${sizes[1]}`);
  assertInvariants(api, 'resize');
  const gut = api.gutters(api.layout().root);
  assert.equal(gut.length, 1);
  assert.equal(gut[0].dir, 'row');
  assert.ok(Math.abs(gut[0].rect.width) < EPS);
});

check('applyPreset grid3x2 with 7 panes keeps all 7', async () => {
  const api = await load();
  api.openChat('a');
  for (const id of ['b', 'c', 'd', 'e', 'f']) api.openChat(id, { beside: true });
  const terminalId = api.openPane('terminal');
  assert.equal(api.panes().length, 7);
  const dropId = api.panes()[2].id;
  api.applyPreset('grid3x2', dropId, 4);
  assert.equal(api.panes().length, 7, 'all 7 panes survive');
  assert.equal(api.leafOfPane(dropId), api.layout().focused, 'dropped pane is focused');
  assert.ok(api.paneById(terminalId));
  assertInvariants(api, 'grid3x2 7');
  assertTiles(api, 'grid3x2 7');
});

check('applyPreset with fewer panes leaves empty leaves and keeps panes', async () => {
  const api = await load();
  api.openChat('a');
  api.openChat('b', { beside: true });
  api.applyPreset('cols3Stack');
  assert.equal(api.panes().length, 2);
  assert.equal(api.leafRects(api.layout().root).length, 4);
  assertInvariants(api, 'cols3Stack');
});

check('old-shape migration of a three layout yields 3 chat leaves with matching rects', async () => {
  const api = await load({ preset: 'three', cells: ['c1', 'c2', 'c3'], splits: { x: 0.6, y: 0.3 }, focused: 1 });
  assert.deepEqual(api.openChats(), ['c1', 'c2', 'c3']);
  const rects = api.leafRects(api.layout().root).map(r => r.rect);
  const expect = [
    { left: 0, top: 0, width: 0.6, height: 1 },
    { left: 0.6, top: 0, width: 0.4, height: 0.3 },
    { left: 0.6, top: 0.3, width: 0.4, height: 0.7 },
  ];
  rects.forEach((rect, index) => {
    for (const field of ['left', 'top', 'width', 'height']) {
      assert.ok(Math.abs(rect[field] - expect[index][field]) < EPS, `leaf ${index} ${field}: ${rect[field]}`);
    }
  });
  assert.equal(api.focusedChatId(), 'c2');
  assertInvariants(api, 'migration three');
});

check('old grid migrates with x applying to the outer row', async () => {
  const api = await load({ preset: 'grid', cells: ['a', 'b', null, 'd'], splits: { x: 0.25, y: 0.5 }, focused: 0 });
  const rects = api.leafRects(api.layout().root);
  assert.equal(rects.length, 4);
  assert.ok(Math.abs(rects[0].rect.width - 0.25) < EPS);
  // Grid cells: TL=a, TR=b, BL=empty, BR=d. Reading order is TL, BL, TR, BR.
  const bottomLeft = rects.find(r => r.rect.left === 0 && r.rect.top > 0.4);
  assert.equal(bottomLeft.paneId, null, 'BL cell (index 2) stays empty');
  const topRight = rects.find(r => r.rect.left > 0.2 && r.rect.top === 0);
  assert.equal(api.paneById(topRight.paneId).chatId, 'b', 'TR cell (index 1) holds b');
  assert.deepEqual(api.openChats().sort(), ['a', 'b', 'd']);
  assertInvariants(api, 'migration grid');
});

check('invalid persisted data loads as an empty layout', async () => {
  for (const bad of [null, 42, 'x', { root: 5, panes: 'nope' }, { root: { type: 'split', dir: 'diag', children: [] } }, { preset: 'bogus', cells: 'no' }]) {
    const api = await load(bad);
    assert.equal(api.layout().root, null, `bad value ${JSON.stringify(bad)} -> root`);
  }
});

check('invalid nodes and NaN sizes are dropped; single-child splits collapse', async () => {
  const api = await load({
    root: {
      type: 'split',
      key: 'top',
      dir: 'row',
      children: [
        { type: 'leaf', key: 'l1', paneId: 'p1' },
        { type: 'leaf', key: 'l1', paneId: 'p2' },
        { type: 'bogus' },
        { type: 'leaf', key: 'l3', paneId: null },
      ],
      sizes: [1, 1, 1, Number.NaN],
    },
    panes: { p1: { id: 'p1', kind: 'chat', chatId: 'x' }, p2: { id: 'p2', kind: 'terminal' }, p9: { id: 'p9', kind: 'weird' } },
    focused: 'nope',
  });
  const rects = api.leafRects(api.layout().root);
  assert.equal(rects.length, 2, 'NaN-sized and bogus children dropped');
  assert.equal(new Set(rects.map(r => r.key)).size, 2, 'duplicate keys regenerated');
  assert.deepEqual(Object.keys(api.layout().panes).sort(), ['p1', 'p2']);
  assert.equal(api.layout().focused, rects[0].key, 'bad focus falls back to first leaf');
  assertInvariants(api, 'invalid nodes');
});

check('keys of untouched leaves survive operations', async () => {
  const api = await load();
  api.openChat('a');
  api.openChat('b', { beside: true });
  const before = api.leafRects(api.layout().root);
  const keyA = before.find(r => r.paneId && api.paneById(r.paneId).chatId === 'a').key;
  api.openPane('terminal', { beside: true });
  api.openChat('c', { beside: true });
  api.closeChat('b');
  assert.ok(api.leafRects(api.layout().root).some(r => r.key === keyA), 'leaf key of a survives');
  assertInvariants(api, 'key survival');
});

check('equalize and gutters agree with leaf geometry', async () => {
  const api = await load();
  api.applyPreset('three');
  api.resizeSplit(api.layout().root.key, 0, 0.3);
  api.equalize();
  for (const node of [api.layout().root]) {
    assert.ok(node.sizes.every(s => Math.abs(s - node.sizes[0]) < EPS), 'sizes equal after equalize');
  }
  const gut = api.gutters(api.layout().root);
  assert.ok(gut.length >= 2, 'three has at least two gutters');
  assertInvariants(api, 'equalize');
});

check('splitLeaf returns a new empty leaf key and resetLayout clears everything', async () => {
  const api = await load();
  api.openChat('a');
  const key = api.splitLeaf(api.layout().root.key, 'bottom');
  assert.ok(api.leafRects(api.layout().root).some(r => r.key === key && r.paneId === null));
  api.resetLayout();
  assert.equal(api.layout().root, null);
  assert.deepEqual(api.panes(), []);
});

let failed = 0;
try {
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name}\n     ${error.message}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} of ${checks.length} checks failed` : `\nAll ${checks.length} checks passed`);
process.exitCode = failed ? 1 : 0;
