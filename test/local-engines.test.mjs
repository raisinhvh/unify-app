import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_ENGINES, localEngine } from '../dist/local/engines.mjs';
import { BUILTIN_PRESETS, defaultValues, presetValues } from '../dist/local/presets.mjs';
import { maskedCommand, parseEnv, splitArgs } from '../dist/local/args.mjs';

function context(overrides = {}) {
  return {
    port: 8123,
    host: '127.0.0.1',
    apiKey: 'sekret',
    serverId: 'srv1',
    runDir: join(tmpdir(), 'unify-run'),
    enginePath: join(tmpdir(), 'engine.exe'),
    platform: process.platform,
    ...overrides,
  };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  assert.ok(index >= 0, `missing ${flag} in ${args.join(' ')}`);
  return args[index + 1];
}

test('splitArgs handles quotes and keeps Windows backslashes', () => {
  assert.deepEqual(splitArgs('--a 1 "two words" \'single q\''), ['--a', '1', 'two words', 'single q']);
  assert.deepEqual(splitArgs('-m C:\\models\\a.gguf'), ['-m', 'C:\\models\\a.gguf']);
  assert.deepEqual(splitArgs('  x   ""  '), ['x', '']);
  assert.deepEqual(splitArgs(''), []);
});

test('parseEnv skips blanks and comments', () => {
  const env = parseEnv('# note\n\nA=1\r\nB = two words \nC=x=y\nbad line\n');
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x=y' });
});

test('maskedCommand hides the key and quotes spaces', () => {
  const text = maskedCommand('C:\\a b\\srv.exe', ['--api-key', 'sekret', '-m', 'my model.gguf'], 'sekret');
  assert.equal(text, '"C:\\a b\\srv.exe" --api-key •••• -m "my model.gguf"');
  assert.ok(!text.includes('sekret'));
});

test('llama.cpp builds tuned flags', () => {
  const engine = localEngine('llama-cpp');
  const values = {
    ...defaultValues(engine),
    model: 'C:\\m\\model-q4.gguf',
    jinja: true,
    fit: 'off',
    flashAttn: 'on',
    cacheTypeK: 'q8_0',
    cacheTypeV: 'q8_0',
    ubatch: 256,
    parallel: 1,
    temp: 1,
    topP: 1,
    topK: 0,
    minP: 0,
    alias: 'my-model',
    ctx: 32768,
  };
  const spec = engine.build(values, context());
  const args = spec.args;
  assert.equal(spec.command, context().enginePath);
  assert.equal(valueAfter(args, '-m'), 'C:\\m\\model-q4.gguf');
  assert.equal(valueAfter(args, '--host'), '127.0.0.1');
  assert.equal(valueAfter(args, '--port'), '8123');
  assert.equal(valueAfter(args, '--api-key'), 'sekret');
  assert.equal(valueAfter(args, '-c'), '32768');
  assert.equal(valueAfter(args, '--alias'), 'my-model');
  assert.equal(valueAfter(args, '-ngl'), '99');
  assert.equal(valueAfter(args, '--flash-attn'), 'on');
  assert.equal(valueAfter(args, '--cache-type-k'), 'q8_0');
  assert.equal(valueAfter(args, '--cache-type-v'), 'q8_0');
  assert.equal(valueAfter(args, '--ubatch-size'), '256');
  assert.equal(valueAfter(args, '--fit'), 'off');
  assert.equal(valueAfter(args, '--temp'), '1');
  assert.equal(valueAfter(args, '--top-k'), '0');
  assert.equal(valueAfter(args, '--min-p'), '0');
  assert.ok(args.includes('--jinja'));
  assert.ok(!args.includes('--n-cpu-moe'));
  assert.ok(!args.includes('--repeat-penalty'));
  assert.equal(spec.servedModel, 'my-model');
  assert.equal(spec.apiPath, '/v1');
  assert.equal(spec.healthPath, '/v1/models');
});

test('llama.cpp defaults, served model fallback, extra args and bad input', () => {
  const engine = localEngine('llama-cpp');
  const values = { ...defaultValues(engine), model: '/x/Qwen3-8B.gguf', cpuMoe: 12, extraArgs: '--foo "a b"', env: 'K=v' };
  const spec = engine.build(values, context());
  assert.equal(spec.servedModel, 'Qwen3-8B');
  assert.equal(valueAfter(spec.args, '--n-cpu-moe'), '12');
  assert.ok(!spec.args.includes('--cache-type-k'));
  assert.deepEqual(spec.args.slice(-2), ['--foo', 'a b']);
  assert.deepEqual(spec.env, { K: 'v' });
  assert.throws(() => engine.build({ ...values, ctx: 'abc' }, context()), /Context size must be a number/);
  assert.throws(() => engine.build({ ...values, flashAttn: 'maybe' }, context()), /Flash attention/);
  assert.throws(() => engine.build({ ...values, model: '' }, context()), /Choose a model file/);
  assert.equal(valueAfter(engine.build({ ...values, ctx: undefined, gpuLayers: true }, context()).args, '-c'), '32768');
});

test('koboldcpp backend flags', () => {
  const engine = localEngine('koboldcpp');
  const base = { ...defaultValues(engine), model: '/x/m.gguf' };
  const cuda = engine.build(base, context()).args;
  assert.ok(cuda.includes('--usecublas'));
  assert.ok(cuda.includes('--skiplauncher'));
  assert.equal(valueAfter(cuda, '--password'), 'sekret');
  assert.equal(valueAfter(cuda, '--contextsize'), '8192');
  assert.equal(valueAfter(cuda, '--gpulayers'), '999');
  assert.ok(!cuda.includes('--quantkv'));
  const vulkan = engine.build({ ...base, backend: 'vulkan' }, context()).args;
  assert.ok(vulkan.includes('--usevulkan') && !vulkan.includes('--usecublas'));
  const cpu = engine.build({ ...base, backend: 'cpu', flashAttention: true, quantKv: '1' }, context()).args;
  assert.ok(!cpu.includes('--usevulkan') && !cpu.includes('--usecublas'));
  assert.ok(cpu.includes('--flashattention'));
  assert.equal(valueAfter(cpu, '--quantkv'), '1');
});

test('ollama launches serve with env', () => {
  const engine = localEngine('ollama');
  const values = {
    ...defaultValues(engine),
    model: 'qwen3:8b',
    flashAttention: true,
    kvCacheType: 'q8_0',
    keepAlive: '10m',
    modelsDir: '/models',
    env: 'EXTRA=1',
  };
  const spec = engine.build(values, context());
  assert.deepEqual(spec.args, ['serve']);
  assert.equal(spec.servedModel, 'qwen3:8b');
  assert.equal(spec.env.OLLAMA_HOST, '127.0.0.1:8123');
  assert.equal(spec.env.OLLAMA_CONTEXT_LENGTH, '8192');
  assert.equal(spec.env.OLLAMA_FLASH_ATTENTION, '1');
  assert.equal(spec.env.OLLAMA_KV_CACHE_TYPE, 'q8_0');
  assert.equal(spec.env.OLLAMA_KEEP_ALIVE, '10m');
  assert.equal(spec.env.OLLAMA_MODELS, '/models');
  assert.equal(spec.env.EXTRA, '1');
  assert.throws(() => engine.build({ ...values, model: '' }, context()), /model tag/);
});

async function polyFixture() {
  const base = await mkdtemp(join(tmpdir(), 'unify-poly-'));
  const folder = join(base, 'terminal');
  const win = process.platform === 'win32';
  const python = win ? join(folder, '.venv', 'Scripts', 'python.exe') : join(folder, '.venv', 'bin', 'python');
  const exe = join(folder, 'engine-poly', win ? 'strata-poly.exe' : 'strata-poly');
  await mkdir(join(folder, 'serve'), { recursive: true });
  await mkdir(join(folder, 'engine-poly'), { recursive: true });
  await mkdir(join(python, '..'), { recursive: true });
  await writeFile(join(folder, 'serve', 'server.py'), '');
  await writeFile(exe, '');
  await writeFile(python, '');
  const model = join(base, 'model.gguf');
  const tokenizer = join(base, 'tokenizer');
  await writeFile(model, '');
  await mkdir(tokenizer);
  const runDir = join(base, 'run');
  await mkdir(runDir);
  return { base, folder, python, exe, model, tokenizer, runDir };
}

test('polystrata writes its config and server args', async () => {
  const engine = localEngine('polystrata');
  const fx = await polyFixture();
  const values = {
    ...defaultValues(engine),
    model: fx.model,
    tokenizer: fx.tokenizer,
    servedModel: 'my-moe',
    window: 2,
    conversationCacheMib: 'auto',
    tailSkip: 4,
    ramExpertsMib: -1,
    vramReserveMib: 512,
    threads: 12,
    extraEngineArgs: '--x 1',
    extraArgs: '--y',
  };
  assert.deepEqual(engine.validate(values, fx.folder), []);
  const spec = engine.build(values, context({ enginePath: fx.folder, runDir: fx.runDir }));
  assert.equal(spec.command, fx.python);
  assert.equal(spec.cwd, fx.folder);
  assert.equal(spec.args[0], join(fx.folder, 'serve', 'server.py'));
  assert.equal(valueAfter(spec.args, '--engine'), 'strata');
  assert.equal(valueAfter(spec.args, '--config'), join(fx.runDir, 'polystrata-config.json'));
  assert.equal(valueAfter(spec.args, '--host'), '127.0.0.1');
  assert.equal(valueAfter(spec.args, '--port'), '8123');
  assert.equal(valueAfter(spec.args, '--api-key'), 'sekret');
  assert.equal(spec.args.at(-1), '--y');
  assert.equal(spec.env.PYTHONUNBUFFERED, '1');
  assert.equal(spec.env.PYTHONIOENCODING, 'utf-8');
  assert.equal(spec.servedModel, 'my-moe');
  assert.equal(spec.files.length, 1);
  assert.equal(spec.files[0].path, join(fx.runDir, 'polystrata-config.json'));
  const config = JSON.parse(spec.files[0].content);
  assert.equal(config.exe, fx.exe);
  assert.equal(config.cwd, fx.folder);
  assert.equal(config.tokenizer, fx.tokenizer);
  assert.equal(config.model_name, 'my-moe');
  assert.equal(config.display_name, 'my-moe');
  assert.equal(config.port, 8123);
  assert.equal(config.gpu, 0);
  assert.equal(config.gpus_asked, true);
  assert.deepEqual(config.lib_dirs, []);
  assert.equal(config.log, join(fx.runDir, 'engine.log'));
  const args = config.args;
  assert.equal(valueAfter(args, '--model'), fx.model);
  assert.equal(valueAfter(args, '--max-context'), '32768');
  assert.equal(valueAfter(args, '--expert-profile'), join(fx.runDir, 'expert-profile.txt'));
  assert.equal(valueAfter(args, '--conversation-cache-mib'), 'auto');
  assert.equal(valueAfter(args, '--tail-skip'), '4');
  assert.equal(valueAfter(args, '--ram-experts-mib'), '-1');
  assert.equal(valueAfter(args, '--vram-reserve-mib'), '512');
  assert.equal(valueAfter(args, '--threads'), '12');
  assert.equal(valueAfter(args, '--window'), '2');
  assert.deepEqual(args.slice(-2), ['--x', '1']);
  assert.ok(args.every(arg => typeof arg === 'string'));

  // Defaults pass only what Unify needs; PolyStrata picks the rest for the model and machine.
  const plainValues = { ...defaultValues(engine), model: fx.model, tokenizer: fx.tokenizer };
  const plain = engine.build(plainValues, context({ enginePath: fx.folder, runDir: fx.runDir }));
  assert.equal(plain.servedModel, 'model');
  const plainArgs = JSON.parse(plain.files[0].content).args;
  assert.deepEqual(plainArgs, [
    '--model', fx.model,
    '--max-context', '32768',
    '--expert-profile', join(fx.runDir, 'expert-profile.txt'),
  ]);
});

test('polystrata on Windows owns the server through stdin and passes a launch key', async () => {
  const engine = localEngine('polystrata');
  const fx = await polyFixture();
  const values = { ...defaultValues(engine), model: fx.model, tokenizer: fx.tokenizer };
  const windows = engine.build(values, context({ enginePath: fx.folder, runDir: fx.runDir, platform: 'win32' }));
  assert.equal(valueAfter(windows.args, '--owner-fd'), '0');
  assert.equal(windows.stop.method, 'stdin-eof');
  assert.match(windows.env.STRATA_OWNER_ATTEST_KEY, /^[0-9a-f]{64}$/);
  const again = engine.build(values, context({ enginePath: fx.folder, runDir: fx.runDir, platform: 'win32' }));
  assert.notEqual(again.env.STRATA_OWNER_ATTEST_KEY, windows.env.STRATA_OWNER_ATTEST_KEY);

  const linux = engine.build(values, context({ enginePath: fx.folder, runDir: fx.runDir, platform: 'linux' }));
  assert.ok(!linux.args.includes('--owner-fd'));
  assert.equal(linux.stop.method, 'signal');
  assert.equal(linux.env.STRATA_OWNER_ATTEST_KEY, undefined);
});

test('polystrata validate reports missing pieces', async () => {
  const engine = localEngine('polystrata');
  const fx = await polyFixture();
  const empty = engine.validate(defaultValues(engine), '');
  assert.ok(empty.includes('Set the PolyStrata terminal folder'));
  assert.ok(empty.includes('Choose a model file'));
  assert.ok(empty.includes('Choose the tokenizer folder'));
  const gone = engine.validate({ ...defaultValues(engine), model: join(fx.base, 'nope.gguf'), tokenizer: join(fx.base, 'nope') }, join(fx.base, 'empty'));
  assert.ok(gone.some(text => text.startsWith('PolyStrata terminal folder not found')));
  assert.ok(gone.some(text => text.startsWith('Model file not found')));
  assert.ok(gone.some(text => text.startsWith('Tokenizer folder not found')));
  const bare = join(fx.base, 'bare');
  await mkdir(bare);
  const partial = engine.validate({ ...defaultValues(engine), model: fx.model, tokenizer: fx.tokenizer }, bare);
  assert.equal(partial.length, 3);
  assert.ok(partial.some(text => text.includes('server.py')));
  assert.ok(partial.some(text => text.startsWith('Python not found')));
});

test('custom command substitutes tokens', () => {
  const engine = localEngine('custom');
  const values = {
    ...defaultValues(engine),
    command: 'myserver',
    args: '--listen {host}:{port} --key "{apiKey}"',
    servedModel: 'my-model',
    env: 'PORT={port}\nKEY={apiKey}',
    cwd: '/work',
  };
  const spec = engine.build(values, context());
  assert.equal(spec.command, 'myserver');
  assert.deepEqual(spec.args, ['--listen', '127.0.0.1:8123', '--key', 'sekret']);
  assert.deepEqual(spec.env, { PORT: '8123', KEY: 'sekret' });
  assert.equal(spec.cwd, '/work');
  assert.equal(spec.apiPath, '/v1');
  assert.equal(spec.healthPath, '/v1/models');
  assert.equal(spec.servedModel, 'my-model');
  assert.throws(() => engine.build({ ...values, servedModel: '' }, context()), /model name/);
});

test('validate reports missing files and engine path', async () => {
  const llama = localEngine('llama-cpp');
  assert.deepEqual(llama.validate({}, '').sort(), ['Choose a model file', 'Set the llama-server executable']);
  const missing = llama.validate({ model: join(tmpdir(), 'no-such.gguf') }, join(tmpdir(), 'no-such-server.exe'));
  assert.ok(missing.some(text => text.startsWith('Model file not found: ')));
  assert.ok(missing.some(text => text.startsWith('llama-server executable not found')));
  const dir = await mkdtemp(join(tmpdir(), 'unify-ok-'));
  const exe = join(dir, 'srv.exe');
  const model = join(dir, 'm.gguf');
  await writeFile(exe, '');
  await writeFile(model, '');
  assert.deepEqual(llama.validate({ model }, exe), []);
  assert.deepEqual(localEngine('custom').validate({ command: 'x', servedModel: 'y' }, ''), []);
});

test('detect never throws and unknown engines throw', async () => {
  for (const engine of LOCAL_ENGINES) {
    const found = await engine.detect();
    assert.ok(found === undefined || typeof found.path === 'string');
  }
  assert.throws(() => localEngine('nope'), /Unknown local engine/);
});

test('every preset targets a real engine and real fields', () => {
  const ids = new Set();
  for (const preset of BUILTIN_PRESETS) {
    assert.ok(preset.builtin);
    assert.ok(!ids.has(preset.id), `duplicate ${preset.id}`);
    ids.add(preset.id);
    assert.ok(!/[·•]/.test(preset.label), preset.label);
    const engine = localEngine(preset.engine);
    const fieldIds = new Set(engine.fields.map(field => field.id));
    for (const key of Object.keys(preset.values)) {
      assert.ok(fieldIds.has(key), `${preset.id}: unknown field ${key}`);
    }
    const values = presetValues(preset, engine);
    for (const key of fieldIds) {
      if (engine.fields.find(field => field.id === key).default !== undefined) assert.ok(key in values);
    }
  }
  assert.ok(ids.has('polystrata-default'));
  // Built-in presets are for everyone: they never name a model or carry paths and tuning from one machine.
  const machineSpecific = [
    'model',
    'tokenizer',
    'servedModel',
    'alias',
    'displayName',
    'expertProfile',
    'threads',
    'vramReserveMib',
    'ramExpertsMib',
    'tailSkip',
    'window',
    'extraEngineArgs',
    'extraArgs',
  ];
  for (const preset of BUILTIN_PRESETS) {
    for (const key of machineSpecific) {
      assert.ok(!(key in preset.values), `${preset.id}: built-in preset sets ${key}`);
    }
  }
  // No engine field is tied to one model family; such flags go in the engine's extra arguments.
  for (const engine of LOCAL_ENGINES) {
    for (const field of engine.fields) {
      const text = `${field.label} ${field.help || ''}`;
      assert.ok(!/models? only/i.test(text), `${engine.kind}.${field.id} is model-specific`);
    }
  }
});
