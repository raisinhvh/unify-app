import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalUnifyHome = process.env.UNIFY_HOME;
const isolatedUnifyHome = await mkdtemp(join(tmpdir(), 'unify-codex-cli-'));
process.env.UNIFY_HOME = isolatedUnifyHome;

// Checks the native Codex command line, JSON event stream and cancellation without starting the CLI.
const launches = [];
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4321;
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.unref = () => undefined;
  child.input = '';
  child.stdin.on('data', chunk => { child.input += chunk.toString(); });
  return child;
}
globalThis.__dshCodexCliTestSpawn = (command, args, options) => {
  const child = fakeChild();
  launches.push({ command, args, options, child });
  return child;
};

const bundled = await build({
  stdin: {
    contents: "export * from './runtime/codexCli.ts'; export { setUnifyFeature } from './unify/settings.ts';",
    resolveDir: 'src/engine', loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'fake-cli', setup(builder) {
    builder.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'process', namespace: 'fake' }));
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }) => ({ contents: path === 'process'
      ? 'export const spawn = (...args) => globalThis.__dshCodexCliTestSpawn(...args);'
      : 'export const workspace = { getConfiguration: () => ({ get: key => globalThis.__dshCodexCliConfig?.[key] }) };' }));
  } }],
});
const {
  CodexCliRuntime, codexArgs, codexCliCommand, codexEnv, codexPrompt, codexSandboxMode, parseCodexUsage, setCodexCommand, setUnifyFeature,
} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

after(async () => {
  if (originalUnifyHome === undefined) delete process.env.UNIFY_HOME;
  else process.env.UNIFY_HOME = originalUnifyHome;
  delete process.env.UNIFY_CODEX_PATH;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.CODEX_API_KEY;
  globalThis.__dshCodexCliConfig = undefined;
  await rm(isolatedUnifyHome, { recursive: true, force: true });
});

const account = { id: 'codex:test', provider: 'codex-cli', label: 'Work', directory: 'C:\\unify\\oauth\\codex-cli\\one' };
const delegate = {
  command: 'node', args: ['delegate-server.js', '--port', '0'],
  env: { UNIFY_OWNER: 'owner', 'ODD.KEY': 'line\n"quoted"' },
};
const turn = (extras = {}) => ({
  account, cwd: process.cwd(), backend: 'gpt-5-codex', prompt: 'Say hi',
  onText() {}, onTool() {}, command: 'codex-test', ...extras,
});
const cliLaunch = () => launches.filter(launch => launch.command !== 'taskkill').at(-1);
const send = (child, event) => child.stdout.write(JSON.stringify(event) + '\n');
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

test('new Codex turns get JSON exec arguments, sandbox, bridge, images and stdin prompt', () => {
  const args = codexArgs(turn({
    effort: 'high', system: 'Use Unify tools', delegate, readOnly: true,
    images: [{ path: 'C:\\images\\one.png', mimeType: 'image/png' }, { path: 'C:\\docs\\notes.pdf', mimeType: 'application/pdf' }],
  }));
  assert.deepEqual(args, [
    'exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"',
    '-m', 'gpt-5-codex',
    '-c', 'model_reasoning_effort="high"',
    '-c', 'developer_instructions="Use Unify tools"',
    '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
    '-c', 'mcp_servers.unify.command="node"',
    '-c', 'mcp_servers.unify.args=["delegate-server.js", "--port", "0"]',
    '-c', 'mcp_servers.unify.env={ UNIFY_OWNER = "owner", "ODD.KEY" = "line\\n\\"quoted\\"" }',
    '-i', 'C:\\images\\one.png',
    '-',
  ]);
  assert.equal(codexPrompt(turn({
    images: [{ path: 'C:\\images\\one.png', mimeType: 'image/png' }, { path: 'C:\\docs\\notes.pdf', mimeType: 'application/pdf' }],
  })), 'Say hi\n\nAttached files (read these files):\nC:\\docs\\notes.pdf');
  assert.equal(codexPrompt(turn()), 'Say hi');
});

test('resumed Codex turns use only shared options and honour sandbox precedence', () => {
  const args = codexArgs(turn({ sessionId: 'thread-1', backend: 'default', fullAccess: true, readOnly: true, effort: 'low', system: 'Rules' }));
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'thread-1']);
  assert.equal(args[args.indexOf('-c') + 1], 'sandbox_mode="danger-full-access"');
  assert.ok(!args.includes('-m'));
  assert.ok(!args.includes('-s'));
  assert.ok(!args.includes('--sandbox'));
  assert.ok(!args.includes('-C'));
  assert.ok(!args.includes('--add-dir'));
  assert.equal(args.at(-1), '-');
  assert.equal(codexSandboxMode({}), 'workspace-write');
  assert.equal(codexSandboxMode({ readOnly: true }), 'read-only');
  assert.equal(codexSandboxMode({ readOnly: true, fullAccess: true }), 'danger-full-access');
});

test('Codex agent features are disabled only while native agents are blocked', () => {
  assert.ok(codexArgs(turn()).join(' ').includes('--disable multi_agent --disable multi_agent_v2'));
  try {
    setUnifyFeature('agents.blockNativeAgents', false);
    assert.ok(!codexArgs(turn()).includes('--disable'));
  } finally {
    setUnifyFeature('agents.blockNativeAgents', true);
  }
});

test('Codex CLI command resolution follows setting, env, detection and defaults', () => {
  globalThis.__dshCodexCliConfig = { 'runtime.codexPath': 'C:\\settings\\codex.exe' };
  assert.equal(codexCliCommand(), 'C:\\settings\\codex.exe');
  globalThis.__dshCodexCliConfig = undefined;
  process.env.UNIFY_CODEX_PATH = 'C:\\env\\codex.exe';
  assert.equal(codexCliCommand(), 'C:\\env\\codex.exe');
  delete process.env.UNIFY_CODEX_PATH;
  setCodexCommand('C:\\detected\\codex.exe');
  assert.equal(codexCliCommand(), 'C:\\detected\\codex.exe');
  setCodexCommand(undefined);
  assert.equal(typeof codexCliCommand(), 'string');
  assert.ok(codexCliCommand().length > 0);
});

test('Codex streams message text, tool rows and usage, then reports the thread id', async () => {
  const texts = [];
  const tools = [];
  const usages = [];
  let breaks = 0;
  const runtime = new CodexCliRuntime();
  const result = runtime.prompt(turn({
    onText: text => texts.push(text), onTool: (...args) => tools.push(args), onUsage: usage => usages.push(usage),
    onMessageBreak: () => { breaks++; },
  }));
  const { child } = cliLaunch();
  send(child, { type: 'thread.started', thread_id: 'thread-9' });
  send(child, { type: 'item.started', item: { id: 'msg-1', type: 'agent_message', text: '' } });
  send(child, { type: 'item.updated', item: { id: 'msg-1', type: 'agent_message', text: 'Hel' } });
  send(child, { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Hello' } });
  send(child, { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'npm test', status: 'in_progress' } });
  send(child, { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'npm test', exit_code: 0, status: 'completed' } });
  send(child, { type: 'item.completed', item: { id: 'edit-1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'modified' }], status: 'completed' } });
  send(child, { type: 'item.completed', item: { id: 'mcp-1', type: 'mcp_tool_call', server: 'unify', tool: 'delegate_task', arguments: { task: 'x' }, status: 'completed' } });
  send(child, { type: 'item.completed', item: { id: 'web-1', type: 'web_search', query: 'codex cli' } });
  send(child, {
    type: 'turn.completed',
    usage: { input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 10, output_tokens: 30, reasoning_output_tokens: 5 },
  });
  await flush();
  child.emit('close', 0);
  assert.equal(await result, 'thread-9');
  assert.deepEqual(texts, ['Hel', 'lo']);
  assert.equal(breaks, 1);
  assert.deepEqual(tools, [
    ['cmd-1', 'Command', 'npm test', 'running'],
    ['cmd-1', 'Command', 'npm test', 'complete'],
    ['edit-1', 'Edit', 'modified src/a.ts', 'running'],
    ['edit-1', 'Edit', 'modified src/a.ts', 'complete'],
    ['mcp-1', 'unify.delegate_task', '{"task":"x"}', 'running'],
    ['mcp-1', 'unify.delegate_task', '{"task":"x"}', 'complete'],
    ['web-1', 'Web search', 'codex cli', 'running'],
    ['web-1', 'Web search', 'codex cli', 'complete'],
  ]);
  assert.deepEqual(usages, [{
    total: { input: 90, cacheRead: 20, cacheWrite: 10, cacheWrite1h: 0, cacheWrite5m: 0, output: 30 },
    context: 120,
  }]);
});

test('Codex reads its prompt from stdin and authenticates only through the account CODEX_HOME', async () => {
  process.env.OPENAI_API_KEY = 'sk-should-not-leak';
  process.env.OPENAI_BASE_URL = 'https://example.test';
  process.env.CODEX_API_KEY = 'codex-should-not-leak';
  const runtime = new CodexCliRuntime();
  const result = runtime.prompt(turn({
    prompt: 'Do the thing',
    images: [{ path: 'C:\\images\\one.png', mimeType: 'image/png' }, { path: 'C:\\docs\\notes.pdf', mimeType: 'application/pdf' }],
  }));
  const launch = cliLaunch();
  await flush();
  assert.equal(launch.command, 'codex-test');
  assert.equal(launch.options.env.CODEX_HOME, account.directory);
  assert.equal(launch.options.env.OPENAI_API_KEY, undefined);
  assert.equal(launch.options.env.OPENAI_BASE_URL, undefined);
  assert.equal(launch.options.env.CODEX_API_KEY, undefined);
  assert.equal(launch.options.env.HOME, process.env.HOME, 'the rest of the environment is preserved');
  assert.equal(launch.child.input, 'Do the thing\n\nAttached files (read these files):\nC:\\docs\\notes.pdf');
  assert.ok(launch.args.includes('-i'));
  assert.ok(launch.args.includes('C:\\images\\one.png'));
  assert.ok(!launch.child.input.includes('one.png'), 'images travel with -i, not the prompt');
  send(launch.child, { type: 'thread.started', thread_id: 'thread-stdin' });
  send(launch.child, { type: 'turn.completed' });
  await flush();
  launch.child.emit('close', 0);
  assert.equal(await result, 'thread-stdin');
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.CODEX_API_KEY;
});

test('Codex turn failures, stream errors and usage limits reject the turn', async () => {
  const runtime = new CodexCliRuntime();
  const failed = runtime.prompt(turn());
  send(cliLaunch().child, { type: 'thread.started', thread_id: 'thread-2' });
  send(cliLaunch().child, { type: 'turn.failed', error: { message: 'model exploded' } });
  await assert.rejects(failed, /Codex turn failed\. model exploded/);

  const errored = runtime.prompt(turn());
  send(cliLaunch().child, { type: 'error', message: 'stream closed unexpectedly' });
  await assert.rejects(errored, /Codex turn failed\. stream closed unexpectedly/);

  const limited = runtime.prompt(turn());
  send(cliLaunch().child, { type: 'turn.failed', error: { message: 'Usage limit reached. Try later.' } });
  await assert.rejects(limited, error => error.usageLimit === true && /Codex usage limit/.test(error.message));

  const stderrLimited = runtime.prompt(turn());
  cliLaunch().child.stderr.write('unexpected status 429 Too Many Requests\n');
  await flush();
  cliLaunch().child.emit('close', 1);
  await assert.rejects(stderrLimited, error => error.usageLimit === true && /429/.test(error.message));
});

test('a non-zero Codex exit without a stream failure reports sign-in help', async () => {
  const runtime = new CodexCliRuntime();
  const result = runtime.prompt(turn());
  cliLaunch().child.stderr.write('Not logged in. Run codex login.\n');
  await flush();
  cliLaunch().child.emit('close', 2);
  await assert.rejects(result, /Codex CLI exited with code 2\..*Sign in again from Accounts/);
});

test('cancelling a Codex turn stops its process tree and the runtime can start again', async () => {
  const runtime = new CodexCliRuntime();
  const first = runtime.prompt(turn());
  const firstChild = cliLaunch().child;
  runtime.cancel();
  assert.equal(await first, undefined);
  assert.equal(firstChild.stdout.destroyed, true);
  assert.equal(firstChild.stdin.destroyed, true);
  const second = runtime.prompt(turn());
  const secondChild = cliLaunch().child;
  send(secondChild, { type: 'thread.started', thread_id: 'thread-3' });
  send(secondChild, { type: 'turn.completed' });
  await flush();
  secondChild.emit('close', 0);
  assert.equal(await second, 'thread-3');
});

test('a Codex process that exited ends the turn even when its output pipes stay open', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runtime = new CodexCliRuntime();
  const result = runtime.prompt(turn());
  send(cliLaunch().child, { type: 'turn.completed' });
  await flush();
  cliLaunch().child.emit('exit', 0);
  t.mock.timers.tick(3_000);
  assert.equal(await result, undefined);
});

test('a zero exit without a completed turn rejects rather than losing the prompt', async () => {
  const runtime = new CodexCliRuntime();
  const result = runtime.prompt(turn());
  send(cliLaunch().child, { type: 'thread.started', thread_id: 'thread-partial' });
  await flush();
  cliLaunch().child.emit('close', 0);
  await assert.rejects(result, /exited without completing its turn/);
});

test('Codex usage parsing keeps cached tokens apart and clamps inconsistent counts', () => {
  assert.equal(parseCodexUsage(undefined), undefined);
  assert.equal(parseCodexUsage({ service_tier: 'standard' }), undefined);
  assert.deepEqual(parseCodexUsage({
    input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 10, output_tokens: 30, reasoning_output_tokens: 5,
  }), { total: { input: 90, cacheRead: 20, cacheWrite: 10, cacheWrite1h: 0, cacheWrite5m: 0, output: 30 }, context: 120 });
  assert.equal(parseCodexUsage({ input_tokens: 1, cached_input_tokens: 5 }).total.input, 0);
  assert.deepEqual(parseCodexUsage({ output_tokens: 2 }), {
    total: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0, output: 2 }, context: 0,
  });
});
