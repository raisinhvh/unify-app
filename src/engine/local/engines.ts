/**
 * Definitions of the local inference engines Unify can launch (llama.cpp, KoboldCpp, Ollama, PolyStrata, custom).
 * Each one describes its settings fields, builds the launch command and finds an existing install.
 * Pure node: no vscode or electron imports.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseEnv, splitArgs } from './args';
import type {
  DetectedEngine,
  LaunchContext,
  LaunchSpec,
  LocalEngineDefinition,
  LocalEngineKind,
  LocalFieldOption,
  LocalFieldSpec,
  LocalValue,
  LocalValues,
} from './types';

/* ---------- Value readers ---------- */

/** Reads settings values with the defaults and limits of the field specs. Wrong types fall back to the default. */
interface ValueReader {
  str(id: string): string;
  num(id: string): number | undefined;
  bool(id: string): boolean;
  choice(id: string): string;
}

function fieldSpec(fields: LocalFieldSpec[], id: string): LocalFieldSpec {
  const spec = fields.find(field => field.id === id);
  if (!spec) throw new Error(`Unknown field: ${id}`);
  return spec;
}

function rawValue(fields: LocalFieldSpec[], values: LocalValues, id: string): LocalValue | undefined {
  const given = values[id];
  if (given === undefined || given === null) return fieldSpec(fields, id).default;
  return given;
}

function createReader(fields: LocalFieldSpec[], values: LocalValues): ValueReader {
  const str = (id: string): string => {
    const value = rawValue(fields, values, id);
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return String(value);
    return '';
  };

  const num = (id: string): number | undefined => {
    const spec = fieldSpec(fields, id);
    const value = rawValue(fields, values, id);
    let parsed: number | undefined;
    if (typeof value === 'number') {
      parsed = value;
    } else if (typeof value === 'string' && value.trim() !== '') {
      parsed = Number(value.trim());
    } else if (typeof spec.default === 'number') {
      parsed = spec.default;
    }
    if (parsed === undefined) return undefined;
    if (!Number.isFinite(parsed)) throw new Error(`${spec.label} must be a number`);
    if (spec.min !== undefined && parsed < spec.min) throw new Error(`${spec.label} must be at least ${spec.min}`);
    if (spec.max !== undefined && parsed > spec.max) throw new Error(`${spec.label} must be at most ${spec.max}`);
    return parsed;
  };

  const bool = (id: string): boolean => {
    const value = rawValue(fields, values, id);
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fieldSpec(fields, id).default === true;
  };

  const choice = (id: string): string => {
    const spec = fieldSpec(fields, id);
    const value = str(id);
    const options = spec.options ?? [];
    if (options.some(option => option.value === value)) return value;
    if (value !== '') throw new Error(`${spec.label}: "${value}" is not one of ${options.map(option => option.value).join(', ')}`);
    return typeof spec.default === 'string' ? spec.default : (options[0]?.value ?? '');
  };

  return { str, num, bool, choice };
}

/** Number as a command-line string. */
function numArg(value: number): string {
  return String(value);
}

function options(...values: string[]): LocalFieldOption[] {
  return values.map(value => ({ value, label: value }));
}

/** Model name without folder and .gguf extension. */
function modelBaseName(modelPath: string): string {
  return basename(modelPath.replace(/\\/g, '/')).replace(/\.gguf$/i, '');
}

function requireText(value: string, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function requireEnginePath(context: LaunchContext, label: string): string {
  return requireText(context.enginePath.trim(), `Set the ${label} first`);
}

/* ---------- Shared fields ---------- */

const GGUF_FILTER = [{ name: 'GGUF model', extensions: ['gguf'] }];

function extraArgsField(): LocalFieldSpec {
  return {
    id: 'extraArgs',
    label: 'Extra arguments',
    type: 'args',
    advanced: true,
    group: 'Advanced',
    placeholder: '--some-flag value',
    help: 'Added to the end of the command line.',
    default: '',
  };
}

function envField(): LocalFieldSpec {
  return {
    id: 'env',
    label: 'Environment variables',
    type: 'env',
    advanced: true,
    group: 'Advanced',
    placeholder: 'NAME=value',
    help: 'One NAME=value per line.',
    default: '',
  };
}

/* ---------- Detection helpers ---------- */

function exeNames(base: string): string[] {
  return process.platform === 'win32' ? [`${base}.exe`] : [base];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Scans process.env.PATH by hand for the first match of any name. */
function findOnPath(names: string[]): string | undefined {
  const pathText = process.env.PATH ?? process.env.Path ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  for (const rawFolder of pathText.split(separator)) {
    const folder = rawFolder.trim().replace(/^"|"$/g, '');
    if (!folder) continue;
    for (const name of names) {
      const candidate = join(folder, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** ~/.unify/local-inference/engines/<kind> */
function installRoot(kind: LocalEngineKind): string {
  return join(homedir(), '.unify', 'local-inference', 'engines', kind);
}

/** Finds an executable at the root of a folder or one subfolder level below. */
function findExeInFolder(folder: string, names: string[]): string | undefined {
  for (const name of names) {
    const direct = join(folder, name);
    if (isFile(direct)) return direct;
  }
  let entries: string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const subfolder = join(folder, entry);
    if (!isFolder(subfolder)) continue;
    for (const name of names) {
      const nested = join(subfolder, name);
      if (isFile(nested)) return nested;
    }
  }
  return undefined;
}

/** The newest install under ~/.unify/local-inference/engines/<kind>/*, if it holds one of the executables. */
function findInstalled(kind: LocalEngineKind, names: string[]): string | undefined {
  const root = installRoot(kind);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  const folders = entries
    .map(entry => join(root, entry))
    .filter(isFolder)
    .map(path => ({ path, modified: statSync(path).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  for (const folder of folders) {
    const found = findExeInFolder(folder.path, names);
    if (found) return found;
  }
  return undefined;
}

/** Runs `<exe> --version` and keeps the first line with a digit. */
function readVersion(exe: string): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      execFile(exe, ['--version'], { timeout: 5000, windowsHide: true }, (_error, stdout, stderr) => {
        const lines = `${stdout ?? ''}\n${stderr ?? ''}`.split(/\r?\n/);
        const line = lines.map(text => text.trim()).find(text => /\d/.test(text));
        resolve(line ? line.slice(0, 120) : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

async function describeExe(path: string): Promise<DetectedEngine> {
  const version = await readVersion(path);
  return version ? { path, version } : { path };
}

/** Looks on PATH, in known folders and in Unify's own install folder. Never throws. */
async function detectExecutable(kind: LocalEngineKind, names: string[], extraPaths: string[]): Promise<DetectedEngine | undefined> {
  try {
    const onPath = findOnPath(names);
    if (onPath) return await describeExe(onPath);
    const installed = findInstalled(kind, names);
    if (installed) return await describeExe(installed);
    for (const candidate of extraPaths) {
      if (candidate && isFile(candidate)) return await describeExe(candidate);
    }
  } catch {
    // Detection is best effort.
  }
  return undefined;
}

/* ---------- Validation helpers ---------- */

function checkEnginePath(problems: string[], kind: 'file' | 'folder', enginePath: string, label: string): void {
  const path = enginePath.trim();
  if (!path) {
    problems.push(`Set the ${label}`);
    return;
  }
  if (kind === 'file' && !isFile(path)) problems.push(`${label} not found: ${path}`);
  if (kind === 'folder' && !isFolder(path)) problems.push(`${label} not found: ${path}`);
}

/** Pushes 'Choose …' for an empty value and 'Missing: …' for a path that does not exist. */
function checkPath(problems: string[], value: string, kind: 'file' | 'folder', chooseText: string, missingText: string): void {
  if (!value) {
    problems.push(chooseText);
    return;
  }
  const exists = kind === 'file' ? isFile(value) : isFolder(value);
  if (!exists) problems.push(`${missingText}: ${value}`);
}

function checkOptionalPath(problems: string[], value: string, missingText: string): void {
  if (value && !existsSync(value)) problems.push(`${missingText}: ${value}`);
}

/* ---------- llama.cpp ---------- */

const LLAMA_FIELDS: LocalFieldSpec[] = [
  { id: 'model', label: 'Model file', type: 'file', group: 'Model', required: true, filters: GGUF_FILTER, help: 'GGUF model to load.' },
  { id: 'alias', label: 'Model name', type: 'text', group: 'Model', placeholder: 'defaults to the file name', help: 'Name the server answers to.' },
  { id: 'mmproj', label: 'Vision projector', type: 'file', group: 'Model', advanced: true, filters: GGUF_FILTER, help: 'mmproj GGUF for image input.' },
  { id: 'ctx', label: 'Context size', type: 'number', group: 'Performance', default: 32768, min: 256, step: 1024, help: 'Tokens of context (-c).' },
  { id: 'gpuLayers', label: 'GPU layers', type: 'number', group: 'Performance', default: 99, min: 0, help: 'Layers offloaded to the GPU (-ngl). 99 = all.' },
  { id: 'cpuMoe', label: 'MoE layers on CPU', type: 'number', group: 'Performance', default: 0, min: 0, help: 'Keeps the experts of the first N layers on the CPU (--n-cpu-moe). 0 = off.' },
  { id: 'flashAttn', label: 'Flash attention', type: 'select', group: 'Performance', default: 'auto', options: options('on', 'off', 'auto') },
  { id: 'cacheTypeK', label: 'K cache type', type: 'select', group: 'Performance', default: 'f16', options: options('f16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0') },
  { id: 'cacheTypeV', label: 'V cache type', type: 'select', group: 'Performance', default: 'f16', options: options('f16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0') },
  { id: 'threads', label: 'Threads', type: 'number', group: 'Performance', default: 0, min: 0, help: '0 = automatic.' },
  { id: 'batch', label: 'Batch size', type: 'number', group: 'Performance', default: 0, min: 0, help: '0 = engine default.' },
  { id: 'ubatch', label: 'Micro batch size', type: 'number', group: 'Performance', default: 0, min: 0, help: '0 = engine default.' },
  { id: 'parallel', label: 'Parallel slots', type: 'number', group: 'Performance', default: 1, min: 1 },
  { id: 'fit', label: 'Fit to memory', type: 'select', group: 'Performance', advanced: true, default: 'default', options: options('default', 'on', 'off') },
  { id: 'mlock', label: 'Lock model in RAM', type: 'toggle', group: 'Performance', advanced: true, default: false },
  { id: 'noMmap', label: 'Disable mmap', type: 'toggle', group: 'Performance', advanced: true, default: false },
  { id: 'jinja', label: 'Jinja chat template', type: 'toggle', group: 'Chat', default: true, help: 'Needed for tool calling.' },
  { id: 'reasoningFormat', label: 'Reasoning format', type: 'select', group: 'Chat', advanced: true, default: 'auto', options: options('none', 'auto', 'deepseek') },
  { id: 'temp', label: 'Temperature', type: 'number', group: 'Sampling', advanced: true, min: 0, step: 0.05, help: 'Empty = engine default.' },
  { id: 'topP', label: 'Top P', type: 'number', group: 'Sampling', advanced: true, min: 0, max: 1, step: 0.05 },
  { id: 'topK', label: 'Top K', type: 'number', group: 'Sampling', advanced: true, min: 0 },
  { id: 'minP', label: 'Min P', type: 'number', group: 'Sampling', advanced: true, min: 0, max: 1, step: 0.01 },
  { id: 'repeatPenalty', label: 'Repeat penalty', type: 'number', group: 'Sampling', advanced: true, min: 0, step: 0.05 },
  extraArgsField(),
  envField(),
];

function llamaServedModel(values: LocalValues): string {
  const read = createReader(LLAMA_FIELDS, values);
  return read.str('alias') || modelBaseName(read.str('model'));
}

function buildLlama(values: LocalValues, context: LaunchContext): LaunchSpec {
  const read = createReader(LLAMA_FIELDS, values);
  const command = requireEnginePath(context, 'llama-server executable');
  const model = requireText(read.str('model'), 'Choose a model file');
  const servedModel = llamaServedModel(values);
  const args: string[] = ['-m', model, '--host', context.host, '--port', numArg(context.port)];
  if (context.apiKey) args.push('--api-key', context.apiKey);
  args.push('-c', numArg(read.num('ctx') ?? 32768), '--alias', servedModel);
  args.push('-ngl', numArg(read.num('gpuLayers') ?? 99));

  const cpuMoe = read.num('cpuMoe') ?? 0;
  if (cpuMoe > 0) args.push('--n-cpu-moe', numArg(cpuMoe));
  args.push('--flash-attn', read.choice('flashAttn'));
  const cacheK = read.choice('cacheTypeK');
  if (cacheK !== 'f16') args.push('--cache-type-k', cacheK);
  const cacheV = read.choice('cacheTypeV');
  if (cacheV !== 'f16') args.push('--cache-type-v', cacheV);

  pushPositive(args, '--threads', read.num('threads'));
  pushPositive(args, '--batch-size', read.num('batch'));
  pushPositive(args, '--ubatch-size', read.num('ubatch'));
  args.push('--parallel', numArg(read.num('parallel') ?? 1));
  const fit = read.choice('fit');
  if (fit !== 'default') args.push('--fit', fit);
  if (read.bool('mlock')) args.push('--mlock');
  if (read.bool('noMmap')) args.push('--no-mmap');
  const mmproj = read.str('mmproj');
  if (mmproj) args.push('--mmproj', mmproj);

  if (read.bool('jinja')) args.push('--jinja');
  const reasoning = read.choice('reasoningFormat');
  if (reasoning !== 'auto') args.push('--reasoning-format', reasoning);

  pushDefined(args, '--temp', read.num('temp'));
  pushDefined(args, '--top-p', read.num('topP'));
  pushDefined(args, '--top-k', read.num('topK'));
  pushDefined(args, '--min-p', read.num('minP'));
  pushDefined(args, '--repeat-penalty', read.num('repeatPenalty'));

  args.push(...splitArgs(read.str('extraArgs')));
  return {
    command,
    args,
    env: parseEnv(read.str('env')),
    apiPath: '/v1',
    healthPath: '/v1/models',
    servedModel,
  };
}

function pushPositive(args: string[], flag: string, value: number | undefined): void {
  if (value !== undefined && value > 0) args.push(flag, numArg(value));
}

function pushDefined(args: string[], flag: string, value: number | undefined): void {
  if (value !== undefined) args.push(flag, numArg(value));
}

function validateLlama(values: LocalValues, enginePath: string): string[] {
  const read = createReader(LLAMA_FIELDS, values);
  const problems: string[] = [];
  checkEnginePath(problems, 'file', enginePath, 'llama-server executable');
  checkPath(problems, read.str('model'), 'file', 'Choose a model file', 'Model file not found');
  checkOptionalPath(problems, read.str('mmproj'), 'Vision projector not found');
  return problems;
}

const LLAMA_ENGINE: LocalEngineDefinition = {
  kind: 'llama-cpp',
  label: 'llama.cpp',
  description: 'Fast, lightweight GGUF inference with llama-server.',
  homepage: 'https://github.com/ggml-org/llama.cpp',
  installable: true,
  pathKind: 'file',
  pathLabel: 'llama-server executable',
  fields: LLAMA_FIELDS,
  defaultPort: 8080,
  startupTimeoutSec: 300,
  supportsApiKey: true,
  detect: () => detectExecutable('llama-cpp', exeNames('llama-server'), []),
  build: buildLlama,
  servedModel: llamaServedModel,
  validate: validateLlama,
};

/* ---------- KoboldCpp ---------- */

const KOBOLD_FIELDS: LocalFieldSpec[] = [
  { id: 'model', label: 'Model file', type: 'file', group: 'Model', required: true, filters: GGUF_FILTER, help: 'GGUF model to load.' },
  { id: 'alias', label: 'Model name', type: 'text', group: 'Model', placeholder: 'defaults to the file name', help: 'Name Unify uses for this model. KoboldCpp answers to any name.' },
  { id: 'contextSize', label: 'Context size', type: 'number', group: 'Performance', default: 8192, min: 256, step: 1024 },
  { id: 'gpuLayers', label: 'GPU layers', type: 'number', group: 'Performance', default: 999, min: 0, help: '999 = all.' },
  { id: 'backend', label: 'Backend', type: 'select', group: 'Performance', default: 'cuda', options: options('cuda', 'vulkan', 'cpu') },
  { id: 'flashAttention', label: 'Flash attention', type: 'toggle', group: 'Performance', default: false },
  {
    id: 'quantKv',
    label: 'KV cache type',
    type: 'select',
    group: 'Performance',
    default: '0',
    options: [
      { value: '0', label: 'f16' },
      { value: '1', label: 'q8' },
      { value: '2', label: 'q4' },
    ],
    help: 'Quantized cache needs flash attention.',
  },
  { id: 'threads', label: 'Threads', type: 'number', group: 'Performance', default: 0, min: 0, help: '0 = automatic.' },
  extraArgsField(),
  envField(),
];

function koboldServedModel(values: LocalValues): string {
  const read = createReader(KOBOLD_FIELDS, values);
  return read.str('alias') || modelBaseName(read.str('model'));
}

function buildKobold(values: LocalValues, context: LaunchContext): LaunchSpec {
  const read = createReader(KOBOLD_FIELDS, values);
  const command = requireEnginePath(context, 'KoboldCpp executable');
  const model = requireText(read.str('model'), 'Choose a model file');
  const args: string[] = ['--model', model, '--skiplauncher', '--host', context.host, '--port', numArg(context.port)];
  if (context.apiKey) args.push('--password', context.apiKey);
  args.push('--contextsize', numArg(read.num('contextSize') ?? 8192));
  args.push('--gpulayers', numArg(read.num('gpuLayers') ?? 999));

  const backend = read.choice('backend');
  if (backend === 'cuda') args.push('--usecublas');
  if (backend === 'vulkan') args.push('--usevulkan');

  const flashAttention = read.bool('flashAttention');
  if (flashAttention) {
    args.push('--flashattention');
    args.push('--quantkv', read.choice('quantKv'));
  }
  pushPositive(args, '--threads', read.num('threads'));
  args.push(...splitArgs(read.str('extraArgs')));
  return {
    command,
    args,
    env: parseEnv(read.str('env')),
    apiPath: '/v1',
    healthPath: '/v1/models',
    servedModel: koboldServedModel(values),
  };
}

function validateKobold(values: LocalValues, enginePath: string): string[] {
  const read = createReader(KOBOLD_FIELDS, values);
  const problems: string[] = [];
  checkEnginePath(problems, 'file', enginePath, 'KoboldCpp executable');
  checkPath(problems, read.str('model'), 'file', 'Choose a model file', 'Model file not found');
  return problems;
}

const KOBOLD_ENGINE: LocalEngineDefinition = {
  kind: 'koboldcpp',
  label: 'KoboldCpp',
  description: 'Single-file llama.cpp fork with CUDA, Vulkan and CPU backends.',
  homepage: 'https://github.com/LostRuins/koboldcpp',
  installable: true,
  pathKind: 'file',
  pathLabel: 'KoboldCpp executable',
  fields: KOBOLD_FIELDS,
  defaultPort: 5001,
  startupTimeoutSec: 300,
  supportsApiKey: true,
  detect: () => detectExecutable('koboldcpp', [...exeNames('koboldcpp'), ...exeNames('koboldcpp_nocuda')], []),
  build: buildKobold,
  servedModel: koboldServedModel,
  validate: validateKobold,
};

/* ---------- Ollama ---------- */

const OLLAMA_FIELDS: LocalFieldSpec[] = [
  { id: 'model', label: 'Model tag', type: 'text', group: 'Model', required: true, placeholder: 'qwen3:8b', help: 'Must already be pulled: run `ollama pull <tag>` first.' },
  { id: 'modelsDir', label: 'Models folder', type: 'folder', group: 'Model', advanced: true, help: 'Sets OLLAMA_MODELS. Blank = Ollama default.' },
  { id: 'contextLength', label: 'Context length', type: 'number', group: 'Performance', default: 8192, min: 256, step: 1024 },
  { id: 'flashAttention', label: 'Flash attention', type: 'toggle', group: 'Performance', default: false },
  { id: 'kvCacheType', label: 'KV cache type', type: 'select', group: 'Performance', default: 'f16', options: options('f16', 'q8_0', 'q4_0'), help: 'Quantized cache needs flash attention.' },
  { id: 'keepAlive', label: 'Keep alive', type: 'text', group: 'Performance', advanced: true, placeholder: '5m', help: 'How long Ollama keeps the model loaded (OLLAMA_KEEP_ALIVE).' },
  extraArgsField(),
  envField(),
];

function ollamaServedModel(values: LocalValues): string {
  return createReader(OLLAMA_FIELDS, values).str('model');
}

function buildOllama(values: LocalValues, context: LaunchContext): LaunchSpec {
  const read = createReader(OLLAMA_FIELDS, values);
  const command = requireEnginePath(context, 'Ollama executable');
  const model = requireText(read.str('model'), 'Enter a model tag, e.g. qwen3:8b');
  const env: Record<string, string> = {
    OLLAMA_HOST: `${context.host}:${context.port}`,
    OLLAMA_CONTEXT_LENGTH: numArg(read.num('contextLength') ?? 8192),
  };
  const modelsDir = read.str('modelsDir');
  if (modelsDir) env.OLLAMA_MODELS = modelsDir;
  if (read.bool('flashAttention')) env.OLLAMA_FLASH_ATTENTION = '1';
  const kvCacheType = read.choice('kvCacheType');
  if (kvCacheType !== 'f16') env.OLLAMA_KV_CACHE_TYPE = kvCacheType;
  const keepAlive = read.str('keepAlive');
  if (keepAlive) env.OLLAMA_KEEP_ALIVE = keepAlive;
  Object.assign(env, parseEnv(read.str('env')));
  return {
    command,
    args: ['serve', ...splitArgs(read.str('extraArgs'))],
    env,
    apiPath: '/v1',
    healthPath: '/v1/models',
    servedModel: model,
  };
}

function validateOllama(values: LocalValues, enginePath: string): string[] {
  const read = createReader(OLLAMA_FIELDS, values);
  const problems: string[] = [];
  checkEnginePath(problems, 'file', enginePath, 'Ollama executable');
  if (!read.str('model')) problems.push('Enter a model tag, e.g. qwen3:8b');
  const modelsDir = read.str('modelsDir');
  if (modelsDir && !isFolder(modelsDir)) problems.push(`Models folder not found: ${modelsDir}`);
  return problems;
}

function ollamaExtraPaths(): string[] {
  const paths = ['/usr/local/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama'];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) paths.unshift(join(localAppData, 'Programs', 'Ollama', 'ollama.exe'));
  return paths;
}

const OLLAMA_ENGINE: LocalEngineDefinition = {
  kind: 'ollama',
  label: 'Ollama',
  description: 'Model manager and server. Pull models with `ollama pull`.',
  homepage: 'https://ollama.com',
  installable: true,
  pathKind: 'file',
  pathLabel: 'Ollama executable',
  fields: OLLAMA_FIELDS,
  defaultPort: 11435,
  startupTimeoutSec: 60,
  supportsApiKey: false,
  detect: () => detectExecutable('ollama', exeNames('ollama'), ollamaExtraPaths()),
  build: buildOllama,
  servedModel: ollamaServedModel,
  validate: validateOllama,
};

/* ---------- PolyStrata ---------- */

const POLYSTRATA_FIELDS: LocalFieldSpec[] = [
  { id: 'model', label: 'Model file', type: 'file', group: 'Model', required: true, filters: GGUF_FILTER },
  { id: 'tokenizer', label: 'Tokenizer folder', type: 'folder', group: 'Model', required: true, help: 'tokenizer folder from the PolyStrata pack' },
  { id: 'servedModel', label: 'Model name', type: 'text', group: 'Model', help: 'Name the server answers to. Blank = the model file name.' },
  { id: 'displayName', label: 'Display name', type: 'text', group: 'Model', advanced: true },
  { id: 'maxContext', label: 'Max context', type: 'number', group: 'Performance', default: 32768, min: 256, step: 1024 },
  { id: 'expertProfile', label: 'Expert profile', type: 'file', group: 'Performance', filters: [{ name: 'Text file', extensions: ['txt'] }], help: "blank = kept in Unify's run folder; PolyStrata writes it on exit" },
  { id: 'window', label: 'Window', type: 'number', group: 'Performance', min: 1, placeholder: 'Engine default' },
  { id: 'conversationCacheMib', label: 'Conversation cache (MiB)', type: 'text', group: 'Performance', placeholder: 'Engine default', help: 'A size in MiB, or auto.' },
  { id: 'tailSkip', label: 'Tail skip', type: 'number', group: 'Performance', min: 0, placeholder: 'Engine default' },
  { id: 'ramExpertsMib', label: 'Experts in RAM (MiB)', type: 'number', group: 'Performance', min: -1, placeholder: 'Engine default', help: '-1 = automatic.' },
  { id: 'vramReserveMib', label: 'VRAM reserve (MiB)', type: 'number', group: 'Performance', min: 0, placeholder: 'Engine default' },
  { id: 'threads', label: 'Threads', type: 'number', group: 'Performance', min: 1, placeholder: 'Engine default' },
  { id: 'gpu', label: 'GPU index', type: 'number', group: 'Performance', default: 0, min: 0 },
  { id: 'python', label: 'Python', type: 'file', group: 'Advanced', advanced: true, help: 'Blank = the .venv inside the PolyStrata folder.' },
  { id: 'cudaLibDir', label: 'CUDA library folder', type: 'folder', group: 'Advanced', advanced: true, help: 'Blank = the nvidia folder inside the .venv.' },
  { id: 'extraEngineArgs', label: 'Engine arguments', type: 'args', group: 'Advanced', advanced: true, default: '', help: 'Added to the strata-poly arguments, e.g. flags that only some model families support.' },
  extraArgsField(),
  envField(),
];

function polyServedModel(values: LocalValues): string {
  const read = createReader(POLYSTRATA_FIELDS, values);
  return read.str('servedModel') || modelBaseName(read.str('model'));
}

function polyServerScript(folder: string): string {
  return join(folder, 'serve', 'server.py');
}

function polyEngineExe(folder: string, platform: NodeJS.Platform): string {
  return join(folder, 'engine-poly', platform === 'win32' ? 'strata-poly.exe' : 'strata-poly');
}

function polyPython(folder: string, custom: string, platform: NodeJS.Platform): string {
  if (custom) return custom;
  if (platform === 'win32') return join(folder, '.venv', 'Scripts', 'python.exe');
  return join(folder, '.venv', 'bin', 'python');
}

function polyCudaLibDir(folder: string, custom: string, platform: NodeJS.Platform): string {
  if (custom) return custom;
  if (platform === 'win32') return join(folder, '.venv', 'Lib', 'site-packages', 'nvidia', 'cu13', 'bin', 'x86_64');
  return '';
}

function polyEngineArgs(read: ValueReader, runDir: string): string[] {
  const profile = read.str('expertProfile') || join(runDir, 'expert-profile.txt');
  const args: string[] = [
    '--model', requireText(read.str('model'), 'Choose a model file'),
    '--max-context', numArg(read.num('maxContext') ?? 32768),
    '--expert-profile', profile,
  ];
  // Blank settings are left out so PolyStrata picks its own default for the model and machine.
  const conversationCache = read.str('conversationCacheMib');
  if (conversationCache) args.push('--conversation-cache-mib', conversationCache);
  pushDefined(args, '--tail-skip', read.num('tailSkip'));
  pushDefined(args, '--ram-experts-mib', read.num('ramExpertsMib'));
  pushDefined(args, '--vram-reserve-mib', read.num('vramReserveMib'));
  pushDefined(args, '--threads', read.num('threads'));
  pushDefined(args, '--window', read.num('window'));
  args.push(...splitArgs(read.str('extraEngineArgs')));
  return args;
}

function buildPolyStrata(values: LocalValues, context: LaunchContext): LaunchSpec {
  const read = createReader(POLYSTRATA_FIELDS, values);
  const folder = requireEnginePath(context, 'PolyStrata terminal folder');
  const tokenizer = requireText(read.str('tokenizer'), 'Choose the tokenizer folder');
  const servedModel = polyServedModel(values);
  const engineArgs = polyEngineArgs(read, context.runDir);
  const cudaLibDir = polyCudaLibDir(folder, read.str('cudaLibDir'), context.platform);
  const libDirs = cudaLibDir && existsSync(cudaLibDir) ? [cudaLibDir] : [];
  const configPath = join(context.runDir, 'polystrata-config.json');
  const config = {
    exe: polyEngineExe(folder, context.platform),
    args: engineArgs,
    cwd: folder,
    tokenizer,
    model_name: servedModel,
    display_name: read.str('displayName') || servedModel,
    log: join(context.runDir, 'engine.log'),
    lib_dirs: libDirs,
    port: context.port,
    gpu: read.num('gpu') ?? 0,
    gpus_asked: true,
  };
  const args = [
    polyServerScript(folder),
    '--engine', 'strata',
    '--config', configPath,
    '--host', context.host,
    '--port', numArg(context.port),
    '--api-key', context.apiKey,
  ];
  // Windows has no SIGTERM: with --owner-fd 0, closing the server's stdin (or Unify exiting) takes its clean stop path,
  // which QUITs the engine so it writes the expert profile.
  const ownerGuard = context.platform === 'win32';
  if (ownerGuard) args.push('--owner-fd', '0');
  args.push(...splitArgs(read.str('extraArgs')));
  return {
    stop: { method: ownerGuard ? 'stdin-eof' : 'signal', graceSec: 30 },
    command: polyPython(folder, read.str('python'), context.platform),
    args,
    cwd: folder,
    env: {
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      // server.py refuses --owner-fd without a private 64-hex launch key (it pops it from the environment).
      ...(ownerGuard ? { STRATA_OWNER_ATTEST_KEY: randomBytes(32).toString('hex') } : {}),
      ...parseEnv(read.str('env')),
    },
    files: [{ path: configPath, content: JSON.stringify(config, null, 2) }],
    apiPath: '/v1',
    healthPath: '/v1/models',
    servedModel,
  };
}

function validatePolyStrata(values: LocalValues, enginePath: string): string[] {
  const read = createReader(POLYSTRATA_FIELDS, values);
  const problems: string[] = [];
  const folder = enginePath.trim();
  if (!folder) {
    problems.push('Set the PolyStrata terminal folder');
  } else if (!isFolder(folder)) {
    problems.push(`PolyStrata terminal folder not found: ${folder}`);
  } else {
    if (!isFile(polyServerScript(folder))) problems.push(`serve/server.py not found in ${folder}`);
    const exe = polyEngineExe(folder, process.platform);
    if (!isFile(exe)) problems.push(`PolyStrata engine not found: ${exe}`);
    const python = polyPython(folder, read.str('python'), process.platform);
    if (!isFile(python)) problems.push(`Python not found: ${python}`);
  }
  checkPath(problems, read.str('model'), 'file', 'Choose a model file', 'Model file not found');
  checkPath(problems, read.str('tokenizer'), 'folder', 'Choose the tokenizer folder', 'Tokenizer folder not found');
  return problems;
}

async function detectPolyStrata(): Promise<DetectedEngine | undefined> {
  try {
    const home = process.env.POLYSTRATA_HOME;
    if (home && isFolder(home)) return { path: home };
  } catch {
    // Detection is best effort.
  }
  return undefined;
}

const POLYSTRATA_ENGINE: LocalEngineDefinition = {
  kind: 'polystrata',
  label: 'PolyStrata',
  description: 'Runs large mixture-of-experts models with experts streamed from RAM and disk.',
  homepage: '',
  installable: false,
  pathKind: 'folder',
  pathLabel: 'PolyStrata terminal folder',
  fields: POLYSTRATA_FIELDS,
  defaultPort: 8080,
  startupTimeoutSec: 600,
  supportsApiKey: true,
  detect: detectPolyStrata,
  build: buildPolyStrata,
  servedModel: polyServedModel,
  validate: validatePolyStrata,
};

/* ---------- Custom command ---------- */

const CUSTOM_FIELDS: LocalFieldSpec[] = [
  { id: 'command', label: 'Command', type: 'file', group: 'Command', required: true, help: 'Executable to run.' },
  { id: 'args', label: 'Arguments', type: 'args', group: 'Command', default: '', placeholder: '--port {port} --host {host}', help: 'Tokens {port}, {host} and {apiKey} are replaced.' },
  { id: 'cwd', label: 'Working folder', type: 'folder', group: 'Command', advanced: true },
  { id: 'servedModel', label: 'Model name', type: 'text', group: 'Server', required: true, help: 'Model id the server answers to.' },
  { id: 'apiPath', label: 'API path', type: 'text', group: 'Server', advanced: true, default: '/v1' },
  { id: 'healthPath', label: 'Health path', type: 'text', group: 'Server', advanced: true, default: '/v1/models' },
  { id: 'env', label: 'Environment variables', type: 'env', group: 'Advanced', advanced: true, default: '', help: 'One NAME=value per line. Same tokens as arguments.' },
];

function customServedModel(values: LocalValues): string {
  return createReader(CUSTOM_FIELDS, values).str('servedModel');
}

function substituteTokens(text: string, context: LaunchContext): string {
  return text
    .split('{port}').join(numArg(context.port))
    .split('{host}').join(context.host)
    .split('{apiKey}').join(context.apiKey);
}

function buildCustom(values: LocalValues, context: LaunchContext): LaunchSpec {
  const read = createReader(CUSTOM_FIELDS, values);
  const command = requireText(read.str('command'), 'Choose a command to run');
  const servedModel = requireText(read.str('servedModel'), 'Enter the model name the server answers to');
  const args = splitArgs(read.str('args')).map(arg => substituteTokens(arg, context));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parseEnv(read.str('env')))) {
    env[name] = substituteTokens(value, context);
  }
  const cwd = read.str('cwd');
  const spec: LaunchSpec = {
    command,
    args,
    env,
    apiPath: read.str('apiPath') || '/v1',
    healthPath: read.str('healthPath') || '/v1/models',
    servedModel,
  };
  if (cwd) spec.cwd = cwd;
  return spec;
}

function validateCustom(values: LocalValues): string[] {
  const read = createReader(CUSTOM_FIELDS, values);
  const problems: string[] = [];
  const command = read.str('command');
  if (!command) {
    problems.push('Choose a command to run');
  } else if (/[\\/]/.test(command) && !isFile(command)) {
    problems.push(`Command not found: ${command}`);
  }
  if (!read.str('servedModel')) problems.push('Enter the model name the server answers to');
  const cwd = read.str('cwd');
  if (cwd && !isFolder(cwd)) problems.push(`Working folder not found: ${cwd}`);
  return problems;
}

const CUSTOM_ENGINE: LocalEngineDefinition = {
  kind: 'custom',
  label: 'Custom command',
  description: 'Any command that starts an OpenAI-compatible server.',
  homepage: '',
  installable: false,
  pathKind: 'none',
  pathLabel: '',
  fields: CUSTOM_FIELDS,
  defaultPort: 8080,
  startupTimeoutSec: 300,
  supportsApiKey: false,
  detect: async () => undefined,
  build: buildCustom,
  servedModel: customServedModel,
  validate: validateCustom,
};

/* ---------- Registry ---------- */

export const LOCAL_ENGINES: LocalEngineDefinition[] = [
  LLAMA_ENGINE,
  KOBOLD_ENGINE,
  OLLAMA_ENGINE,
  POLYSTRATA_ENGINE,
  CUSTOM_ENGINE,
];

/** The definition of an engine kind. Throws on an unknown kind. */
export function localEngine(kind: LocalEngineKind): LocalEngineDefinition {
  const engine = LOCAL_ENGINES.find(candidate => candidate.kind === kind);
  if (!engine) throw new Error(`Unknown local engine: ${kind}`);
  return engine;
}
