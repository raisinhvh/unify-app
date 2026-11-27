/**
 * Dev-only fake of the engine's local inference manager (dev/mockBridge.ts forwards every `local*` request here).
 * It holds a realistic LocalInferenceState and answers requests the way the engine does: start goes
 * starting → running after 1.5 s, save marks a running server restartRequired, install reports progressNotice
 * ticks, browse returns a fake path, and running servers stream log lines every 500 ms.
 *
 * `?localState=error` puts the Inkling server in its error state.
 * All paths are fake (C:\models\..., C:\tools\...).
 */
import type {
  LocalEngineInfo,
  LocalEngineKind,
  LocalFieldSpec,
  LocalHostMessage,
  LocalInferenceState,
  LocalPreset,
  LocalRequest,
  LocalServerStatus,
  LocalServerView,
  LocalValues,
  ProgressNoticeMessage,
} from '../../../../engine/local/types';

type MockEmit = (message: LocalHostMessage | ProgressNoticeMessage | Record<string, unknown>) => void;

export interface LocalMockContext {
  /** The fixture's host messages, so a created server can be added to its accountsState / modelState. */
  fixtureMessages: { type: string }[];
}

/* ---------- fields ---------- */

const extraArgsField: LocalFieldSpec = {
  id: 'extraArgs',
  label: 'Extra arguments',
  type: 'args',
  help: 'Added to the end of the command line.',
  placeholder: '--flag value',
  advanced: true,
};

const envField: LocalFieldSpec = {
  id: 'env',
  label: 'Environment',
  type: 'env',
  help: 'One NAME=value per line.',
  placeholder: 'CUDA_VISIBLE_DEVICES=0',
  advanced: true,
};

const ggufFilter = [{ name: 'GGUF model', extensions: ['gguf'] }];

const llamaFields: LocalFieldSpec[] = [
  { id: 'model', label: 'Model file', type: 'file', required: true, filters: ggufFilter, group: 'Model', placeholder: 'C:\\models\\model.gguf' },
  { id: 'alias', label: 'Served name', type: 'text', group: 'Model', help: 'The model id chats use. Defaults to the file name.' },
  { id: 'mmproj', label: 'Vision projector', type: 'file', filters: ggufFilter, group: 'Model', advanced: true },
  { id: 'ctx', label: 'Context length', type: 'number', default: 32768, min: 512, step: 1024, group: 'Performance' },
  { id: 'gpuLayers', label: 'GPU layers', type: 'number', default: 999, min: 0, group: 'Performance', help: '999 puts every layer on the GPU.' },
  { id: 'cpuMoe', label: 'MoE experts on CPU', type: 'number', default: 0, min: 0, group: 'Performance', help: 'Layers whose experts stay in system memory.' },
  {
    id: 'flashAttn',
    label: 'Flash attention',
    type: 'select',
    default: 'auto',
    group: 'Performance',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ],
  },
  {
    id: 'cacheTypeK',
    label: 'K cache type',
    type: 'select',
    default: 'f16',
    group: 'Performance',
    options: [
      { value: 'f16', label: 'f16' },
      { value: 'q8_0', label: 'q8_0' },
      { value: 'q4_0', label: 'q4_0' },
    ],
  },
  {
    id: 'cacheTypeV',
    label: 'V cache type',
    type: 'select',
    default: 'f16',
    group: 'Performance',
    options: [
      { value: 'f16', label: 'f16' },
      { value: 'q8_0', label: 'q8_0' },
      { value: 'q4_0', label: 'q4_0' },
    ],
  },
  { id: 'threads', label: 'Threads', type: 'number', min: 0, group: 'Performance', placeholder: 'Auto' },
  { id: 'batch', label: 'Batch size', type: 'number', default: 2048, min: 1, group: 'Performance', advanced: true },
  { id: 'ubatch', label: 'Micro batch', type: 'number', default: 512, min: 1, group: 'Performance', advanced: true },
  { id: 'parallel', label: 'Parallel slots', type: 'number', default: 1, min: 1, group: 'Performance', advanced: true },
  { id: 'fit', label: 'Fit to memory', type: 'toggle', default: false, group: 'Memory', advanced: true },
  { id: 'mlock', label: 'Lock in memory', type: 'toggle', default: false, group: 'Memory', advanced: true },
  { id: 'noMmap', label: 'Disable mmap', type: 'toggle', default: false, group: 'Memory', advanced: true },
  { id: 'jinja', label: 'Use the model chat template', type: 'toggle', default: true, group: 'Chat' },
  {
    id: 'reasoningFormat',
    label: 'Reasoning format',
    type: 'select',
    default: 'auto',
    group: 'Chat',
    advanced: true,
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'deepseek', label: 'DeepSeek' },
      { value: 'none', label: 'None' },
    ],
  },
  { id: 'temp', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.05, group: 'Sampling', advanced: true, placeholder: 'Model default' },
  { id: 'topP', label: 'Top P', type: 'number', min: 0, max: 1, step: 0.01, group: 'Sampling', advanced: true, placeholder: 'Model default' },
  { id: 'topK', label: 'Top K', type: 'number', min: 0, group: 'Sampling', advanced: true, placeholder: 'Model default' },
  { id: 'minP', label: 'Min P', type: 'number', min: 0, max: 1, step: 0.01, group: 'Sampling', advanced: true, placeholder: 'Model default' },
  { id: 'repeatPenalty', label: 'Repeat penalty', type: 'number', min: 0, step: 0.05, group: 'Sampling', advanced: true, placeholder: 'Model default' },
  extraArgsField,
  envField,
];

const koboldFields: LocalFieldSpec[] = [
  { id: 'model', label: 'Model file', type: 'file', required: true, filters: ggufFilter, group: 'Model' },
  { id: 'alias', label: 'Served name', type: 'text', group: 'Model' },
  { id: 'contextSize', label: 'Context length', type: 'number', default: 8192, min: 512, step: 1024, group: 'Performance' },
  { id: 'gpuLayers', label: 'GPU layers', type: 'number', default: -1, group: 'Performance', help: '-1 picks automatically.' },
  {
    id: 'backend',
    label: 'Backend',
    type: 'select',
    default: 'cuda',
    group: 'Performance',
    options: [
      { value: 'cuda', label: 'CUDA' },
      { value: 'vulkan', label: 'Vulkan' },
      { value: 'cpu', label: 'CPU' },
    ],
  },
  { id: 'flashAttention', label: 'Flash attention', type: 'toggle', default: true, group: 'Performance' },
  {
    id: 'quantKv',
    label: 'KV cache',
    type: 'select',
    default: '0',
    group: 'Performance',
    options: [
      { value: '0', label: 'f16' },
      { value: '1', label: 'q8' },
      { value: '2', label: 'q4' },
    ],
  },
  { id: 'threads', label: 'Threads', type: 'number', min: 0, group: 'Performance', placeholder: 'Auto' },
  extraArgsField,
  envField,
];

const ollamaFields: LocalFieldSpec[] = [
  { id: 'model', label: 'Model', type: 'text', required: true, group: 'Model', placeholder: 'qwen3:8b', help: 'Pulled on first start if missing.' },
  { id: 'modelsDir', label: 'Models folder', type: 'folder', group: 'Model', advanced: true },
  { id: 'contextLength', label: 'Context length', type: 'number', default: 8192, min: 512, step: 1024, group: 'Performance' },
  { id: 'flashAttention', label: 'Flash attention', type: 'toggle', default: true, group: 'Performance' },
  {
    id: 'kvCacheType',
    label: 'KV cache',
    type: 'select',
    default: 'f16',
    group: 'Performance',
    options: [
      { value: 'f16', label: 'f16' },
      { value: 'q8_0', label: 'q8_0' },
      { value: 'q4_0', label: 'q4_0' },
    ],
  },
  { id: 'keepAlive', label: 'Keep loaded', type: 'text', default: '5m', group: 'Performance', advanced: true },
  extraArgsField,
  envField,
];

const polystrataFields: LocalFieldSpec[] = [
  { id: 'model', label: 'Model file', type: 'file', required: true, filters: ggufFilter, group: 'Model' },
  { id: 'tokenizer', label: 'Tokenizer folder', type: 'folder', required: true, group: 'Model' },
  { id: 'servedModel', label: 'Served name', type: 'text', default: 'inkling-2-mini', group: 'Model' },
  { id: 'displayName', label: 'Display name', type: 'text', group: 'Model', advanced: true },
  { id: 'maxContext', label: 'Context length', type: 'number', default: 65536, min: 1024, step: 1024, group: 'Performance' },
  { id: 'expertProfile', label: 'Expert profile', type: 'file', group: 'Performance', filters: [{ name: 'Profile', extensions: ['json'] }] },
  { id: 'window', label: 'Expert window', type: 'number', default: 8, min: 1, group: 'Performance' },
  { id: 'threads', label: 'Threads', type: 'number', min: 0, group: 'Performance', placeholder: 'Auto' },
  { id: 'python', label: 'Python', type: 'file', group: 'Advanced', advanced: true, filters: [{ name: 'Python', extensions: ['exe'] }] },
  { id: 'cudaLibDir', label: 'CUDA libraries', type: 'folder', group: 'Advanced', advanced: true },
  { id: 'extraEngineArgs', label: 'Engine arguments', type: 'args', group: 'Advanced', advanced: true },
  extraArgsField,
  envField,
];

const customFields: LocalFieldSpec[] = [
  { id: 'command', label: 'Command', type: 'file', required: true, group: 'Command' },
  { id: 'args', label: 'Arguments', type: 'args', group: 'Command', help: '{port} and {apiKey} are replaced at launch.', placeholder: '--port {port}' },
  { id: 'cwd', label: 'Working folder', type: 'folder', group: 'Command', advanced: true },
  { id: 'servedModel', label: 'Served model', type: 'text', required: true, group: 'Server' },
  { id: 'apiPath', label: 'API path', type: 'text', default: '/v1', group: 'Server', advanced: true },
  { id: 'healthPath', label: 'Health path', type: 'text', default: '/v1/models', group: 'Server', advanced: true },
  envField,
];

/* ---------- state ---------- */

const mockParams = new URLSearchParams(window.location.search);
const errorMode = mockParams.get('localState') === 'error' || mockParams.get('fixture') === 'providers-local-error';

const engines: LocalEngineInfo[] = [
  {
    kind: 'polystrata',
    label: 'PolyStrata',
    description: 'Streams mixture-of-experts weights from disk, for models larger than your GPU.',
    homepage: 'https://example.com/polystrata',
    installable: false,
    pathKind: 'folder',
    pathLabel: 'PolyStrata terminal folder',
    fields: polystrataFields,
    defaultPort: 8090,
    install: { path: 'C:\\tools\\polystrata', source: 'manual' },
    installing: false,
  },
  {
    kind: 'llama-cpp',
    label: 'llama.cpp',
    description: 'Fast GGUF inference on GPU or CPU.',
    homepage: 'https://github.com/ggml-org/llama.cpp',
    installable: true,
    pathKind: 'file',
    pathLabel: 'llama-server executable',
    fields: llamaFields,
    defaultPort: 8080,
    install: { path: 'C:\\tools\\llama.cpp\\llama-server.exe', version: 'b6123', source: 'installed' },
    installing: false,
  },
  {
    kind: 'koboldcpp',
    label: 'KoboldCpp',
    description: 'Single-file GGUF runner with its own UI.',
    homepage: 'https://github.com/LostRuins/koboldcpp',
    installable: true,
    pathKind: 'file',
    pathLabel: 'koboldcpp executable',
    fields: koboldFields,
    defaultPort: 5001,
    installing: false,
  },
  {
    kind: 'ollama',
    label: 'Ollama',
    description: 'Pulls and runs models by name.',
    homepage: 'https://ollama.com',
    installable: true,
    pathKind: 'file',
    pathLabel: 'ollama executable',
    fields: ollamaFields,
    defaultPort: 11434,
    install: { path: 'C:\\Program Files\\Ollama\\ollama.exe', version: '0.12.3', source: 'detected' },
    installing: false,
  },
  {
    kind: 'custom',
    label: 'Custom',
    description: 'Any command that starts an OpenAI-compatible server.',
    homepage: '',
    installable: false,
    pathKind: 'none',
    pathLabel: '',
    fields: customFields,
    defaultPort: 8000,
    installing: false,
  },
];

const inklingValues: LocalValues = {
  model: 'C:\\models\\inkling-2-mini-IQ3_XXS.gguf',
  tokenizer: 'C:\\models\\inkling-2-mini-tokenizer',
  servedModel: 'inkling-2-mini',
  maxContext: 65536,
  window: 8,
};

const presets: LocalPreset[] = [
  {
    id: 'polystrata-inkling-iq3xxs',
    label: 'Inkling 2 Mini IQ3_XXS',
    description: 'Fastest. Smallest quant that keeps quality.',
    engine: 'polystrata',
    values: inklingValues,
    builtin: true,
    note: 'About 115 tok/s on a 24 GB GPU',
  },
  {
    id: 'polystrata-inkling-q3kxl',
    label: 'Inkling 2 Mini Q3_K_XL',
    description: 'Best quality that still streams quickly.',
    engine: 'polystrata',
    values: { ...inklingValues, model: 'C:\\models\\inkling-2-mini-Q3_K_XL.gguf' },
    builtin: true,
  },
  {
    id: 'polystrata-inkling-q2kxl',
    label: 'Inkling 2 Mini Q2_K_XL',
    description: 'Favors speed on smaller GPUs.',
    engine: 'polystrata',
    values: { ...inklingValues, model: 'C:\\models\\inkling-2-mini-Q2_K_XL.gguf' },
    builtin: true,
  },
  {
    id: 'llama-gpu',
    label: 'GPU, all layers',
    description: 'Every layer on the GPU. Best when the model fits in VRAM.',
    engine: 'llama-cpp',
    values: { gpuLayers: 999, flashAttn: 'auto', jinja: true },
    builtin: true,
  },
  {
    id: 'llama-moe-cpu',
    label: 'MoE experts on CPU',
    description: 'Attention on the GPU, experts in system memory. For large MoE models.',
    engine: 'llama-cpp',
    values: { gpuLayers: 999, cpuMoe: 99, flashAttn: 'auto', jinja: true },
    builtin: true,
  },
  {
    id: 'llama-cpu',
    label: 'CPU only',
    description: 'No GPU needed. Slow for large models.',
    engine: 'llama-cpp',
    values: { gpuLayers: 0, jinja: true },
    builtin: true,
  },
  {
    id: 'llama-inkling',
    label: 'Inkling 2 Mini',
    description: 'Inkling 2 Mini on llama.cpp with its recommended sampling.',
    engine: 'llama-cpp',
    values: { model: 'C:\\models\\inkling-2-mini-Q4_K_M.gguf', alias: 'inkling-2-mini', ctx: 32768, gpuLayers: 999, jinja: true, temp: 0.6, topP: 0.95 },
    builtin: true,
  },
  {
    id: 'koboldcpp-default',
    label: 'KoboldCpp default',
    description: 'Automatic GPU layers with flash attention.',
    engine: 'koboldcpp',
    values: { gpuLayers: -1, flashAttention: true },
    builtin: true,
  },
  {
    id: 'ollama-default',
    label: 'Ollama default',
    description: 'Runs a model by name, pulled on first start.',
    engine: 'ollama',
    values: { model: 'qwen3:8b' },
    builtin: true,
  },
  {
    id: 'custom',
    label: 'Custom command',
    description: 'Start any OpenAI-compatible server yourself.',
    engine: 'custom',
    values: { args: '--port {port}' },
    builtin: true,
  },
];

const baseTime = Date.now();

function inklingCommand(port: number): string {
  return `C:\\tools\\polystrata\\.venv\\Scripts\\python.exe -m polystrata.serve --model C:\\models\\inkling-2-mini-IQ3_XXS.gguf --tokenizer C:\\models\\inkling-2-mini-tokenizer --served-model-name inkling-2-mini --host 127.0.0.1 --port ${port} --max-context 65536 --window 8 --api-key ******** --owner-fd 0`;
}

const servers: LocalServerView[] = [
  {
    config: {
      id: 'srv-inkling',
      label: 'Inkling 2 Mini',
      engine: 'polystrata',
      values: { ...inklingValues },
      port: 8090,
      autoStart: true,
      idleStopMinutes: 30,
      presetId: 'polystrata-inkling-iq3xxs',
      createdAt: baseTime - 86400000 * 3,
      updatedAt: baseTime - 3600000,
    },
    status: errorMode
      ? {
          id: 'srv-inkling',
          state: 'error',
          port: 8090,
          error: [
            'Server exited with code 1 before it was ready.',
            'RuntimeError: CUDA out of memory. Tried to allocate 2.50 GiB (GPU 0; 23.99 GiB total capacity; 21.12 GiB already allocated)',
            'Lower the expert window or context length, or close other GPU apps.',
          ].join('\n'),
          exitCode: 1,
          restartRequired: false,
        }
      : {
          id: 'srv-inkling',
          state: 'running',
          port: 8090,
          baseURL: 'http://127.0.0.1:8090/v1',
          pid: 21844,
          startedAt: baseTime - 1260000,
          readyAt: baseTime - 1238000,
          restartRequired: false,
          command: inklingCommand(8090),
          lastActivityAt: baseTime - 40000,
        },
    accountId: 'acc-local-inkling',
    servedModel: 'inkling-2-mini',
    commandPreview: inklingCommand(8090),
    problems: [],
  },
  {
    config: {
      id: 'srv-qwen',
      label: 'Qwen3 30B A3B',
      engine: 'llama-cpp',
      values: { alias: 'qwen3-30b-a3b', ctx: 32768, gpuLayers: 999, cpuMoe: 24, flashAttn: 'auto', jinja: true },
      port: 8080,
      autoStart: true,
      idleStopMinutes: 15,
      presetId: 'llama-moe-cpu',
      createdAt: baseTime - 86400000,
      updatedAt: baseTime - 86400000,
    },
    status: { id: 'srv-qwen', state: 'stopped', port: 8080, restartRequired: false },
    accountId: 'acc-local-qwen',
    servedModel: 'qwen3-30b-a3b',
    commandPreview: '',
    problems: ['Choose a model file.'],
  },
];

const logs: Record<string, string[]> = {
  'srv-inkling': errorMode
    ? [
        '[polystrata] loading C:\\models\\inkling-2-mini-IQ3_XXS.gguf',
        '[polystrata] tokenizer: C:\\models\\inkling-2-mini-tokenizer',
        '[polystrata] allocating KV cache for 65536 tokens',
        'Traceback (most recent call last):',
        '  File "polystrata\\serve.py", line 214, in <module>',
        'RuntimeError: CUDA out of memory. Tried to allocate 2.50 GiB',
      ]
    : [
        '[polystrata] loading C:\\models\\inkling-2-mini-IQ3_XXS.gguf',
        '[polystrata] tokenizer: C:\\models\\inkling-2-mini-tokenizer',
        '[polystrata] experts streamed from disk, window 8',
        '[polystrata] allocating KV cache for 65536 tokens (3.1 GiB)',
        '[polystrata] warmup done in 18.4 s',
        'INFO:     Uvicorn running on http://127.0.0.1:8090 (Press CTRL+C to quit)',
        'INFO:     127.0.0.1:52114 - "GET /v1/models HTTP/1.1" 200 OK',
      ],
  'srv-qwen': [],
};

let exclusive = true;
let started = false;
let emitRef: MockEmit = () => undefined;
let contextRef: LocalMockContext = { fixtureMessages: [] };
let serverCount = 0;
let logTick = 0;

function snapshot(): LocalInferenceState {
  return structuredClone({ engines, presets, servers, exclusive });
}

function sendState(): void {
  emitRef({ type: 'localInferenceState', state: snapshot() });
}

function find(id: string): LocalServerView | undefined {
  return servers.find(server => server.config.id === id);
}

function setStatus(server: LocalServerView, status: Partial<LocalServerStatus>): void {
  server.status = { id: server.config.id, port: server.config.port, restartRequired: false, ...status } as LocalServerStatus;
  emitRef({ type: 'localServerStatus', status: structuredClone(server.status) });
}

function log(id: string, lines: string[]): void {
  logs[id] = [...(logs[id] || []), ...lines].slice(-3000);
  emitRef({ type: 'localServerLog', id, lines, reset: false });
}

function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** Running servers print a decode line every 500 ms, like a busy server would. */
function streamLogs(): void {
  window.setInterval(() => {
    for (const server of servers) {
      if (server.status.state !== 'running') continue;
      logTick += 1;
      const tokens = 40 + ((logTick * 37) % 400);
      const speed = (108 + ((logTick * 13) % 14) + (logTick % 10) / 10).toFixed(1);
      const line = logTick % 6 === 0
        ? `INFO:     127.0.0.1:52${100 + (logTick % 90)} - "POST /v1/chat/completions HTTP/1.1" 200 OK`
        : `${clock()} [decode] slot 0: ${tokens} tokens, ${speed} tok/s, kv ${(12 + (logTick % 40)).toFixed(0)}% used`;
      log(server.config.id, [line]);
    }
  }, 500);
}

function startServer(server: LocalServerView): void {
  if (server.problems.length) {
    emitRef({ type: 'localInferenceError', id: server.config.id, message: server.problems[0] });
    return;
  }
  if (exclusive) {
    for (const other of servers) {
      if (other !== server && other.status.state === 'running') {
        setStatus(other, { state: 'stopped' });
        log(other.config.id, ['[unify] stopped: another local server started (one model at a time)']);
      }
    }
  }
  const startedAt = Date.now();
  const command = server.commandPreview;
  setStatus(server, { state: 'starting', startedAt, baseURL: `http://127.0.0.1:${server.config.port}/v1`, command, pid: 20000 + (startedAt % 9000) });
  emitRef({ type: 'localServerLog', id: server.config.id, lines: [`[unify] ${command}`, '[server] loading model…'], reset: true });
  logs[server.config.id] = [`[unify] ${command}`, '[server] loading model…'];
  window.setTimeout(() => {
    if (server.status.state !== 'starting') return;
    setStatus(server, {
      ...server.status,
      state: 'running',
      readyAt: Date.now(),
      restartRequired: false,
    });
    log(server.config.id, [`[server] listening on http://127.0.0.1:${server.config.port}`]);
  }, 1500);
}

function stopServer(server: LocalServerView): void {
  if (server.status.state === 'stopped') return;
  setStatus(server, { ...server.status, state: 'stopping' });
  window.setTimeout(() => {
    setStatus(server, { state: 'stopped', exitCode: 0 });
    log(server.config.id, ['[unify] stopped']);
  }, 400);
}

function engineOf(kind: LocalEngineKind): LocalEngineInfo {
  return engines.find(engine => engine.kind === kind)!;
}

function servedModelOf(engine: LocalEngineKind, values: LocalValues, label: string): string {
  const named = values.servedModel || values.alias || (engine === 'ollama' ? values.model : '');
  if (named) return String(named);
  const model = String(values.model || '');
  const file = model.split(/[\\/]/).pop() || '';
  return file.replace(/\.gguf$/i, '') || label.toLowerCase().replace(/\s+/g, '-');
}

/** Problems the way the engine's validate() phrases them. */
function problemsOf(server: LocalServerView): string[] {
  const engine = engineOf(server.config.engine);
  const problems: string[] = [];
  if (engine.pathKind !== 'none' && !engine.install) problems.push(`Set the ${engine.pathLabel} first.`);
  for (const field of engine.fields) {
    const value = server.config.values[field.id];
    if (field.required && (value === undefined || value === '')) {
      problems.push(field.type === 'file' ? `Choose a ${field.label.toLowerCase()}.` : `${field.label} is required.`);
    }
  }
  return problems;
}

function previewOf(server: LocalServerView): string {
  if (server.config.id === 'srv-inkling') return inklingCommand(server.config.port);
  const engine = engineOf(server.config.engine);
  const values = server.config.values;
  if (server.problems.length) return '';
  if (engine.kind === 'llama-cpp') {
    const parts = [engine.install?.path || 'llama-server', '--model', String(values.model), '--host 127.0.0.1', `--port ${server.config.port}`];
    if (values.alias) parts.push('--alias', String(values.alias));
    if (values.ctx) parts.push('--ctx-size', String(values.ctx));
    if (values.gpuLayers !== undefined) parts.push('--n-gpu-layers', String(values.gpuLayers));
    if (values.cpuMoe) parts.push('--n-cpu-moe', String(values.cpuMoe));
    if (values.flashAttn) parts.push('--flash-attn', String(values.flashAttn));
    if (values.jinja) parts.push('--jinja');
    parts.push('--api-key ********');
    return parts.join(' ');
  }
  if (engine.kind === 'ollama') return `${engine.install?.path} serve (OLLAMA_HOST=127.0.0.1:${server.config.port})`;
  if (engine.kind === 'custom') return `${values.command} ${String(values.args || '').replace('{port}', String(server.config.port))}`;
  return `${engine.install?.path || engine.label} --model ${values.model} --port ${server.config.port}`;
}

function refresh(server: LocalServerView): void {
  server.problems = problemsOf(server);
  server.commandPreview = previewOf(server);
  server.servedModel = servedModelOf(server.config.engine, server.config.values, server.config.label);
}

function install(kind: LocalEngineKind, requestId?: string): void {
  const engine = engineOf(kind);
  engine.installing = true;
  sendState();
  const noticeId = `local-install-${kind}`;
  const steps = [0, 12, 31, 54, 72, 90, 100];
  steps.forEach((percent, index) => {
    window.setTimeout(() => {
      emitRef({
        type: 'progressNotice',
        id: noticeId,
        title: `Installing ${engine.label}`,
        message: percent < 90 ? `Downloading ${engine.label}` : 'Unpacking',
        percent,
        state: 'running',
      });
    }, index * 450);
  });
  window.setTimeout(() => {
    engine.installing = false;
    engine.install = { path: `C:\\tools\\${kind}\\${kind}.exe`, version: kind === 'koboldcpp' ? '1.98' : 'b6123', source: 'installed' };
    emitRef({ type: 'progressNotice', id: noticeId, title: `Installed ${engine.label}`, message: `${engine.label} is ready`, percent: 100, state: 'done' });
    for (const server of servers) if (server.config.engine === kind) refresh(server);
    sendState();
    void requestId;
  }, steps.length * 450);
}

function addAccount(server: LocalServerView): void {
  const accountsMessage = [...contextRef.fixtureMessages].reverse().find(message => message.type === 'accountsState') as
    | { type: 'accountsState'; accounts: Record<string, unknown>[] }
    | undefined;
  if (accountsMessage) {
    accountsMessage.accounts = [
      ...accountsMessage.accounts,
      { id: server.accountId, provider: 'local', label: server.config.label, isDefault: false, authType: 'api-key', defaultModel: `local-${server.config.id}` },
    ];
    emitRef(structuredClone(accountsMessage));
  }
  const modelsMessage = [...contextRef.fixtureMessages].reverse().find(message => message.type === 'modelState') as
    | { type: 'modelState'; models: Record<string, unknown>[] }
    | undefined;
  if (modelsMessage) {
    modelsMessage.models = [
      ...modelsMessage.models,
      {
        id: `local-${server.config.id}`,
        name: server.config.label,
        provider: 'local',
        backend: server.servedModel,
        accountId: server.accountId,
        usable: true,
        enabled: true,
      },
    ];
    emitRef(structuredClone(modelsMessage));
  }
}

/** Answers one `local*` request. */
export function handleLocalMock(message: LocalRequest, emit: MockEmit, context?: LocalMockContext): void {
  emitRef = emit;
  if (context) contextRef = context;
  if (!started) {
    started = true;
    streamLogs();
  }
  switch (message.type) {
    case 'localInferenceGet':
      sendState();
      break;
    case 'localServerLogs':
      emit({ type: 'localServerLog', id: message.id, lines: [...(logs[message.id] || [])], reset: true });
      break;
    case 'localServerStart': {
      const server = find(message.id);
      if (server) startServer(server);
      break;
    }
    case 'localServerStop': {
      const server = find(message.id);
      if (server) stopServer(server);
      break;
    }
    case 'localServerRestart': {
      const server = find(message.id);
      if (!server) break;
      setStatus(server, { state: 'stopped' });
      startServer(server);
      break;
    }
    case 'localServerSave': {
      const server = find(message.id);
      if (!server) break;
      const config = server.config;
      if (message.label !== undefined) config.label = message.label;
      if (message.values) config.values = { ...message.values };
      if (message.port !== undefined) config.port = message.port;
      if (message.autoStart !== undefined) config.autoStart = message.autoStart;
      if (message.idleStopMinutes !== undefined) config.idleStopMinutes = message.idleStopMinutes;
      config.updatedAt = Date.now();
      refresh(server);
      const live = server.status.state === 'running' || server.status.state === 'starting';
      server.status = { ...server.status, restartRequired: live };
      sendState();
      break;
    }
    case 'localServerCreate': {
      const preset = presets.find(item => item.id === message.presetId);
      const engine = message.engine || preset?.engine || 'custom';
      serverCount += 1;
      const id = `srv-new-${serverCount}`;
      const server: LocalServerView = {
        config: {
          id,
          label: message.label,
          engine,
          values: { ...(preset?.values || {}), ...(message.values || {}) },
          port: message.port || preset?.port || engineOf(engine).defaultPort + serverCount,
          autoStart: true,
          idleStopMinutes: 15,
          presetId: preset?.id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        status: { id, state: 'stopped', port: 0, restartRequired: false },
        accountId: `acc-local-new-${serverCount}`,
        servedModel: '',
        commandPreview: '',
        problems: [],
      };
      server.status.port = server.config.port;
      refresh(server);
      servers.push(server);
      logs[id] = [];
      window.setTimeout(() => {
        sendState();
        addAccount(server);
        emit({ type: 'localServerCreated', requestId: message.requestId, id, accountId: server.accountId! });
      }, 300);
      break;
    }
    case 'localServerDelete': {
      const index = servers.findIndex(server => server.config.id === message.id);
      if (index >= 0) servers.splice(index, 1);
      sendState();
      break;
    }
    case 'localEngineInstall':
      install(message.engine, message.requestId);
      break;
    case 'localEngineSetPath': {
      const engine = engineOf(message.engine);
      engine.install = { path: message.path, source: 'manual' };
      for (const server of servers) if (server.config.engine === message.engine) refresh(server);
      sendState();
      break;
    }
    case 'localEngineDetect':
      window.setTimeout(() => {
        const ollama = engineOf('ollama');
        if (!ollama.install) ollama.install = { path: 'C:\\Program Files\\Ollama\\ollama.exe', version: '0.12.3', source: 'detected' };
        sendState();
      }, 500);
      break;
    case 'localBrowse':
      window.setTimeout(() => {
        const path = message.kind === 'folder'
          ? 'C:\\models\\tokenizer'
          : message.title?.toLowerCase().includes('executable')
            ? 'C:\\tools\\engine\\server.exe'
            : 'C:\\models\\example.gguf';
        emit({ type: 'localBrowseResult', requestId: message.requestId, path });
      }, 200);
      break;
    case 'localPresetSave': {
      const server = find(message.serverId);
      if (!server) break;
      presets.push({
        id: `user-${Date.now().toString(36)}`,
        label: message.label,
        description: `Saved from ${server.config.label}`,
        engine: server.config.engine,
        values: { ...server.config.values },
        builtin: false,
        port: server.config.port,
      });
      sendState();
      break;
    }
    case 'localPresetDelete': {
      const index = presets.findIndex(preset => preset.id === message.id && !preset.builtin);
      if (index >= 0) presets.splice(index, 1);
      sendState();
      break;
    }
    case 'localInferenceSettings':
      exclusive = message.exclusive;
      sendState();
      break;
  }
}
