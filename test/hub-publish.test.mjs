/**
 * Tests for real Hub publishing (`src/engine/hub/publish.ts` and `hubPublish` through `handleUnifyRequest`).
 *
 * Every GitHub request uses a stubbed `fetch` injected into `GithubHubRegistry` / `publishHubPack`.
 * No test ever contacts GitHub.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tempRoot = join(here, '.tmp', `hub-publish-${process.pid}-${Date.now()}`);
const unifyHome = join(tempRoot, 'home/.unify');
const unifyRoot = join(unifyHome, 'unify');
const workspace = join(tempRoot, 'project');
const toolpacksDir = join(unifyRoot, 'storage/toolpacks');
await mkdir(toolpacksDir, { recursive: true });

const requestsFile = join(tempRoot, 'requests.mjs');
const hubFile = join(tempRoot, 'hub.mjs');
await build({
  entryPoints: [join(here, '../src/engine/unify/requests/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: requestsFile,
  external: ['esbuild'],
});
await build({
  entryPoints: [join(here, '../src/engine/hub/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: hubFile,
  external: ['esbuild'],
});

const { handleUnifyRequest } = await import(pathToFileURL(requestsFile).href);
const {
  GithubHubRegistry,
  PUBLISH_NOT_APPROVED,
  PUBLISH_SIGNED_OUT,
  publishHubPack,
  scanPublishFiles,
} = await import(pathToFileURL(hubFile).href);

const CLEAN_PACK_SOURCE = `
export default {
  name: 'sample_pack',
  description: 'A clean test toolpack for publishing.',
  tools: [
    { name: 'status', description: 'Report current status.', run() { return 'ok'; } },
    { name: 'list', description: 'List available items.', run() { return []; } },
  ],
};
`.trimStart();

async function writeInstalledPack(folderName, options = {}) {
  const dir = join(toolpacksDir, folderName);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pack.ts'), options.packSource ?? CLEAN_PACK_SOURCE, 'utf8');
  if (options.meta !== null) {
    const meta = options.meta ?? {
      description: 'A clean test toolpack for publishing.',
      enabled: true,
    };
    await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  }
  if (options.readme) {
    await writeFile(join(dir, 'README.md'), options.readme, 'utf8');
  }
  if (options.installScript) {
    await writeFile(join(dir, options.installScript.name), options.installScript.content, 'utf8');
  }
  return dir;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test('hubPublish refuses when signed out without making network calls', async () => {
  let calls = 0;
  const registry = new GithubHubRegistry(async () => {
    calls += 1;
    return jsonResponse({});
  });
  const replies = [];
  const handled = await handleUnifyRequest(
    { type: 'hubPublish', requestId: 'p1' },
    reply => replies.push(reply),
    { workspaceRoot: workspace, unifyHome, unifyRoot, hubRegistry: registry },
  );
  assert.equal(handled, true);
  assert.deepEqual(replies, [
    { type: 'hubPublishResult', requestId: 'p1', ok: false, message: PUBLISH_SIGNED_OUT },
  ]);
  assert.equal(calls, 0);
});

test('hubPublish refuses accounts not listed in publishers.json', async () => {
  const seen = [];
  const registry = new GithubHubRegistry(async url => {
    seen.push(String(url));
    return jsonResponse({ publishers: ['raisinhvh'] });
  });
  let pickerCalled = false;
  const replies = [];
  await handleUnifyRequest(
    { type: 'hubPublish', requestId: 'p2' },
    reply => replies.push(reply),
    {
      workspaceRoot: workspace,
      unifyHome,
      unifyRoot,
      hubRegistry: registry,
      getGithubAuth: async () => ({ login: 'stranger', token: 'tok', source: 'token' }),
      pickOption: async () => {
        pickerCalled = true;
        return undefined;
      },
    },
  );
  assert.deepEqual(replies, [
    { type: 'hubPublishResult', requestId: 'p2', ok: false, message: PUBLISH_NOT_APPROVED },
  ]);
  assert.equal(pickerCalled, false);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /publishers\.json$/);
});

test('hubPublish returns cancelled when the user cancels picking a toolpack', async () => {
  await writeInstalledPack('sample_pack');
  const seen = [];
  const registry = new GithubHubRegistry(async url => {
    seen.push(String(url));
    return jsonResponse({ publishers: ['raisinhvh'] });
  });
  let confirmCalled = false;
  const replies = [];
  await handleUnifyRequest(
    { type: 'hubPublish', requestId: 'p3' },
    reply => replies.push(reply),
    {
      workspaceRoot: workspace,
      unifyHome,
      unifyRoot,
      hubRegistry: registry,
      getGithubAuth: async () => ({ login: 'RAISINHVH', token: 'tok', source: 'token' }),
      pickOption: async items => {
        assert.ok(items.some(item => item.id === 'sample_pack'));
        return undefined;
      },
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    },
  );
  assert.deepEqual(replies, [
    { type: 'hubPublishResult', requestId: 'p3', ok: false, message: 'Publishing cancelled.' },
  ]);
  assert.equal(confirmCalled, false);
  assert.equal(seen.length, 1, 'only publishers.json was read');
});

test('safety scan detects keys, tokens, PEM blocks, emails and personal user paths and blocks upload', async () => {
  const cases = [
    { label: 'sk-', sample: 'const key = "sk-proj-1234567890abcdef";' },
    { label: 'ghp_', sample: 'const tok = "ghp_1234567890abcdef123456";' },
    { label: 'gho_', sample: 'const tok = "gho_1234567890abcdef123456";' },
    { label: 'github_pat_', sample: 'const tok = "github_pat_11ABCDEF_1234567890";' },
    { label: 'xox', sample: 'const tok = "xoxb-1234567890-abcdef1234";' },
    { label: 'AKIA', sample: 'const id = "AKIAIOSFODNN7EXAMPLE";' },
    { label: 'AIza', sample: 'const key = "AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBG";' },
    { label: 'PEM', sample: 'const pem = "-----BEGIN RSA PRIVATE KEY-----";' },
    { label: 'email', sample: 'const contact = "alice@example.com";' },
    { label: 'win path', sample: 'const p = "C:\\\\Users\\\\alice\\\\secret.txt";' },
    { label: 'mac path', sample: 'const p = "/Users/alice/secret.txt";' },
    { label: 'linux path', sample: 'const p = "/home/bob/secret.txt";' },
  ];
  for (const testCase of cases) {
    const findings = scanPublishFiles([{ name: 'pack.ts', content: `// ok\n${testCase.sample}\n` }]);
    assert.equal(findings.length, 1, `expected finding for ${testCase.label}`);
    assert.equal(findings[0].file, 'pack.ts');
    assert.equal(findings[0].line, 2);
  }

  const leakySource = [
    'export default {',
    "  name: 'leaky_pack',",
    "  description: 'Leaky test pack.',",
    '  tools: [{',
    "    name: 'ping',",
    "    description: 'Ping.',",
    '    run() {',
    '      const token = "ghp_1234567890abcdef123456";',
    '      return token;',
    '    },',
    '  }],',
    '};',
    '',
  ].join('\n');
  await writeInstalledPack('leaky_pack', { packSource: leakySource });

  const apiCalls = [];
  const result = await publishHubPack(
    { login: 'raisinhvh', token: 'tok', source: 'token' },
    {
      toolpacksDir,
      pickOption: async () => 'leaky_pack',
      confirm: async () => {
        throw new Error('confirm should never run when safety scan fails');
      },
      fetch: async url => {
        apiCalls.push(String(url));
        return jsonResponse({ publishers: ['raisinhvh'] });
      },
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /pack\.ts:8/);
  assert.match(result.message, /ghp_/i);
  assert.equal(apiCalls.length, 1, 'no GitHub write calls were made after safety refusal');
});

test('happy path validates, confirms and executes the exact GitHub Git Data API + PR sequence', async () => {
  await writeInstalledPack('sample_pack', {
    meta: {
      hubId: 'sample-pack',
      description: 'Old meta description.',
      version: '1.0.0',
      enabled: true,
    },
    installScript: {
      name: 'install.js',
      content: "console.log('ready');\n",
    },
  });

  const existingPublishedAt = 1_780_000_000_000;
  const existingIndex = {
    packs: [
      {
        id: 'figma',
        name: 'Figma',
        author: 'otherdev',
        category: 'design',
        description: 'Inspect Figma.',
        icon: 'figma',
        installs: 10,
        tools: ['figma_pages'],
        version: '1.0.0',
        updatedAt: 1_790_000_000_000,
        publishedAt: 1_785_000_000_000,
        license: 'MIT',
      },
      {
        id: 'sample-pack',
        name: 'Sample Pack',
        author: 'oldauthor',
        category: 'dev',
        description: 'Previous version.',
        icon: 'engine',
        installs: 7,
        tools: ['sample_pack_status'],
        version: '1.0.0',
        updatedAt: 1_785_000_000_000,
        publishedAt: existingPublishedAt,
        license: 'MIT',
      },
    ],
    categories: [{ id: 'dev', label: 'Dev' }],
    featured: ['figma'],
    authors: 2,
    devices: [{ id: 'desktop', label: 'Desktop', current: true }],
  };

  const calls = [];
  let blobCount = 0;
  const stubFetch = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), headers: init.headers, body });

    if (String(url).endsWith('/publishers.json')) {
      return jsonResponse({ publishers: ['raisinhvh'] });
    }
    if (method === 'GET' && String(url).endsWith('/contents/index.json?ref=main')) {
      return new Response(JSON.stringify(existingIndex), { status: 200 });
    }
    if (method === 'GET' && String(url).endsWith('/git/ref/heads/main')) {
      return jsonResponse({ object: { sha: 'base-commit-sha' } });
    }
    if (method === 'GET' && String(url).endsWith('/git/commits/base-commit-sha')) {
      return jsonResponse({ tree: { sha: 'base-tree-sha' } });
    }
    if (method === 'POST' && String(url).endsWith('/git/blobs')) {
      blobCount += 1;
      return jsonResponse({ sha: `blob-sha-${blobCount}` }, 201);
    }
    if (method === 'POST' && String(url).endsWith('/git/trees')) {
      return jsonResponse({ sha: 'new-tree-sha' }, 201);
    }
    if (method === 'POST' && String(url).endsWith('/git/commits')) {
      return jsonResponse({ sha: 'new-commit-sha' }, 201);
    }
    if (method === 'POST' && String(url).endsWith('/git/refs')) {
      return jsonResponse({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if (method === 'POST' && String(url).endsWith('/pulls')) {
      return jsonResponse({ html_url: 'https://github.com/raisinhvh/unify-hub/pull/42' }, 201);
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  let confirmArgs;
  const registry = new GithubHubRegistry(stubFetch);
  const replies = [];
  const beforeTime = Date.now();
  await handleUnifyRequest(
    { type: 'hubPublish', requestId: 'p-happy' },
    reply => replies.push(reply),
    {
      workspaceRoot: workspace,
      unifyHome,
      unifyRoot,
      hubRegistry: registry,
      getGithubAuth: async () => ({ login: 'raisinhvh', token: 'secret-token', source: 'token' }),
      pickOption: async () => 'sample_pack',
      confirm: async (message, detail) => {
        confirmArgs = { message, detail };
        return true;
      },
    },
  );
  const afterTime = Date.now();

  assert.deepEqual(replies, [
    {
      type: 'hubPublishResult',
      requestId: 'p-happy',
      ok: true,
      message: 'Opened a pull request to the Hub.',
      url: 'https://github.com/raisinhvh/unify-hub/pull/42',
    },
  ]);

  // Confirm showed pack id, bumped version, and all files to be committed.
  assert.match(confirmArgs.message, /sample-pack/);
  assert.match(confirmArgs.message, /1\.0\.1/);
  assert.match(confirmArgs.detail, /packs\/sample-pack\/pack\.ts/);
  assert.match(confirmArgs.detail, /packs\/sample-pack\/README\.md/);
  assert.match(confirmArgs.detail, /packs\/sample-pack\/install\.js/);
  assert.match(confirmArgs.detail, /index\.json/);

  // Exact sequence of GitHub API calls.
  const sequence = calls.map(call => `${call.method} ${new URL(call.url).pathname}`);
  assert.deepEqual(sequence, [
    'GET /raisinhvh/unify-hub/main/publishers.json',
    'GET /repos/raisinhvh/unify-hub/contents/index.json',
    'GET /repos/raisinhvh/unify-hub/git/ref/heads/main',
    'GET /repos/raisinhvh/unify-hub/git/commits/base-commit-sha',
    'POST /repos/raisinhvh/unify-hub/git/blobs',
    'POST /repos/raisinhvh/unify-hub/git/blobs',
    'POST /repos/raisinhvh/unify-hub/git/blobs',
    'POST /repos/raisinhvh/unify-hub/git/blobs',
    'POST /repos/raisinhvh/unify-hub/git/trees',
    'POST /repos/raisinhvh/unify-hub/git/commits',
    'POST /repos/raisinhvh/unify-hub/git/refs',
    'POST /repos/raisinhvh/unify-hub/pulls',
  ]);

  // Every authenticated GitHub REST API call carries the Bearer token.
  for (const call of calls.slice(1)) {
    assert.equal(call.headers.authorization, 'Bearer secret-token');
  }

  // Blobs: pack.ts, generated README.md, install.js, index.json.
  const blobCalls = calls.filter(call => call.url.endsWith('/git/blobs'));
  assert.equal(blobCalls[0].body.content, CLEAN_PACK_SOURCE);
  assert.match(blobCalls[1].body.content, /^# Sample Pack/);
  assert.match(blobCalls[1].body.content, /sample_pack_status/);
  assert.match(blobCalls[1].body.content, /sample_pack_list/);
  assert.equal(blobCalls[2].body.content, "console.log('ready');\n");

  const uploadedIndex = JSON.parse(blobCalls[3].body.content);
  assert.equal(uploadedIndex.packs.length, 2);
  assert.equal(uploadedIndex.authors, 2);
  const updatedEntry = uploadedIndex.packs.find(pack => pack.id === 'sample-pack');
  assert.deepEqual(updatedEntry.tools, ['sample_pack_status', 'sample_pack_list']);
  assert.equal(updatedEntry.version, '1.0.1');
  assert.equal(updatedEntry.author, 'raisinhvh');
  assert.equal(updatedEntry.publishedAt, existingPublishedAt, 'publishedAt preserved for existing pack');
  assert.ok(updatedEntry.updatedAt >= beforeTime && updatedEntry.updatedAt <= afterTime);
  assert.equal(updatedEntry.installs, 7);
  assert.equal(updatedEntry.icon, 'engine');

  // Tree, single commit, branch ref, and PR payloads.
  const treeCall = calls.find(call => call.url.endsWith('/git/trees'));
  assert.equal(treeCall.body.base_tree, 'base-tree-sha');
  assert.deepEqual(
    treeCall.body.tree.map(item => ({ path: item.path, sha: item.sha })),
    [
      { path: 'packs/sample-pack/pack.ts', sha: 'blob-sha-1' },
      { path: 'packs/sample-pack/README.md', sha: 'blob-sha-2' },
      { path: 'packs/sample-pack/install.js', sha: 'blob-sha-3' },
      { path: 'index.json', sha: 'blob-sha-4' },
    ],
  );

  const commitCall = calls.find(call => call.url.endsWith('/git/commits'));
  assert.equal(commitCall.body.tree, 'new-tree-sha');
  assert.deepEqual(commitCall.body.parents, ['base-commit-sha']);

  const refCall = calls.find(call => call.url.endsWith('/git/refs'));
  assert.equal(refCall.body.ref, 'refs/heads/publish/sample-pack-1.0.1');
  assert.equal(refCall.body.sha, 'new-commit-sha');

  const prCall = calls.find(call => call.url.endsWith('/pulls'));
  assert.equal(prCall.body.head, 'publish/sample-pack-1.0.1');
  assert.equal(prCall.body.base, 'main');
});

test('GitHub API error returns a clear failure message instead of throwing', async () => {
  await writeInstalledPack('sample_pack', {
    meta: { hubId: 'sample-pack', description: 'Clean pack.', enabled: true },
  });
  const stubFetch = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    if (String(url).endsWith('/publishers.json')) return jsonResponse({ publishers: ['raisinhvh'] });
    if (String(url).endsWith('/contents/index.json?ref=main')) {
      return new Response(JSON.stringify({ packs: [], categories: [], featured: [], authors: 0 }), { status: 200 });
    }
    if (method === 'GET' && String(url).endsWith('/git/ref/heads/main')) {
      return jsonResponse({ message: 'Resource not accessible by personal access token' }, 403);
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  const result = await publishHubPack(
    { login: 'raisinhvh', token: 'tok', source: 'token' },
    {
      toolpacksDir,
      pickOption: async () => 'sample_pack',
      confirm: async () => true,
      fetch: stubFetch,
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /403/);
  assert.match(result.message, /Resource not accessible/);
});

test('pack validation failure and cancelled confirm both abort before any GitHub write', async () => {
  await writeInstalledPack('broken_pack', {
    packSource: 'export default { name: "broken_pack", description: "Missing tools.", tools: [] };\n',
  });
  const invalidCalls = [];
  const invalidResult = await publishHubPack(
    { login: 'raisinhvh', token: 'tok', source: 'token' },
    {
      toolpacksDir,
      pickOption: async () => 'broken_pack',
      confirm: async () => {
        throw new Error('confirm should not run for invalid pack');
      },
      fetch: async url => {
        invalidCalls.push(String(url));
        return jsonResponse({ publishers: ['raisinhvh'] });
      },
    },
  );
  assert.equal(invalidResult.ok, false);
  assert.match(invalidResult.message, /Pack validation failed/);
  assert.equal(invalidCalls.length, 1);

  await writeInstalledPack('new_pack', {
    packSource: `
export default {
  name: 'new_pack',
  description: 'A brand new pack.',
  tools: [{ name: 'run', description: 'Run once.', run() { return 'done'; } }],
};
`.trimStart(),
    readme: '# Custom New Pack\n\nAuthor supplied README.\n',
    meta: { description: 'A brand new pack.', enabled: true },
  });
  const cancelCalls = [];
  const cancelResult = await publishHubPack(
    { login: 'raisinhvh', token: 'tok', source: 'token' },
    {
      toolpacksDir,
      pickOption: async () => 'new_pack',
      confirm: async () => false,
      fetch: async url => {
        cancelCalls.push(String(url));
        if (String(url).endsWith('/publishers.json')) return jsonResponse({ publishers: ['raisinhvh'] });
        if (String(url).endsWith('/contents/index.json?ref=main')) {
          return new Response(JSON.stringify({ packs: [], categories: [], featured: [], authors: 0 }), { status: 200 });
        }
        throw new Error(`Unexpected write after cancel: ${url}`);
      },
    },
  );
  assert.deepEqual(cancelResult, { ok: false, message: 'Publishing cancelled.' });
  assert.equal(cancelCalls.length, 2, 'only publishers.json and index.json were read before cancel');
});

