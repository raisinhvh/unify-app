/**
 * Shared contracts for native local inference ("Local" provider).
 * Pure types and constants: no node, vscode or electron imports, so the renderer can `import type` from here.
 */

/** Provider id of accounts and models served by a Unify-managed local server. */
export const LOCAL_PROVIDER = 'local';

/** Engines Unify knows how to launch. */
export type LocalEngineKind = 'llama-cpp' | 'koboldcpp' | 'ollama' | 'polystrata' | 'custom';

export const LOCAL_ENGINE_KINDS: readonly LocalEngineKind[] = ['llama-cpp', 'koboldcpp', 'ollama', 'polystrata', 'custom'];

/** A value of one settings field. Files, folders, args and env are stored as strings. */
export type LocalValue = string | number | boolean;
export type LocalValues = Record<string, LocalValue>;

export type LocalFieldType =
  | 'text'
  | 'number'
  | 'toggle'
  | 'select'
  | 'file'
  | 'folder'
  /** Free-form extra command-line arguments, one string, split shell-style by the engine. */
  | 'args'
  /** Extra environment variables, one `NAME=value` per line. */
  | 'env';

export interface LocalFieldOption {
  value: string;
  label: string;
}

/** One editable setting of a server, rendered generically by the renderer. */
export interface LocalFieldSpec {
  id: string;
  label: string;
  type: LocalFieldType;
  help?: string;
  placeholder?: string;
  default?: LocalValue;
  /** For `select`. */
  options?: LocalFieldOption[];
  /** For `number`. */
  min?: number;
  max?: number;
  step?: number;
  /** For `file`: dialog filters, e.g. [{ name: 'GGUF model', extensions: ['gguf'] }]. */
  filters?: LocalFileFilter[];
  /** The server cannot start while this is empty. */
  required?: boolean;
  /** Shown under a collapsed "Advanced" section. */
  advanced?: boolean;
  /** Section heading, e.g. 'Model', 'Performance', 'Sampling'. Fields keep their array order inside a group. */
  group?: string;
}

export interface LocalFileFilter {
  name: string;
  extensions: string[];
}

/** What an engine definition asks the manager to spawn. */
export interface LaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  /** Added on top of process.env. */
  env?: Record<string, string>;
  /** Written (UTF-8) before spawning, e.g. a generated config. Paths are absolute. */
  files?: { path: string; content: string }[];
  /** OpenAI-compatible API root relative to http://host:port. Usually '/v1'. */
  apiPath: string;
  /** Polled with GET (Bearer apiKey) until it returns 2xx. Relative to http://host:port. Usually '/v1/models'. */
  healthPath: string;
  /** Model id the server answers to; what Unify puts in `model` of chat requests. */
  servedModel: string;
  /**
   * How to ask the server to stop. 'signal' (default): SIGTERM / taskkill without /F.
   * 'stdin-eof': close the server's stdin (PolyStrata's --owner-fd 0 guard), which also stops it cleanly if Unify dies.
   * After graceSec (default: the manager's stopGraceMs) the process tree is force-killed, except on app quit for
   * 'stdin-eof' servers, which are left to finish their own clean exit.
   */
  stop?: { method: 'signal' | 'stdin-eof'; graceSec?: number };
}

/** Everything an engine needs to know about where and how it will run. */
export interface LaunchContext {
  port: number;
  host: '127.0.0.1';
  /** Random per-server key. Engines that support it must require it; others ignore it. */
  apiKey: string;
  serverId: string;
  /** Per-server scratch folder (~/.unify/local-inference/servers/<id>). Exists before build() is called. */
  runDir: string;
  /** Configured engine path (binary, or folder for pathKind 'folder'). Empty when not set. */
  enginePath: string;
  platform: NodeJS.Platform;
}

/** A found engine install. */
export interface DetectedEngine {
  path: string;
  version?: string;
}

/** Static description of one engine. Lives in src/engine/local/engines.ts. */
export interface LocalEngineDefinition {
  kind: LocalEngineKind;
  label: string;
  description: string;
  homepage: string;
  /** Unify can download and install it (llama.cpp, KoboldCpp, Ollama). */
  installable: boolean;
  /** What the engine path points at. 'none' = custom command carries its own binary. */
  pathKind: 'file' | 'folder' | 'none';
  /** E.g. 'llama-server executable', 'PolyStrata terminal folder'. */
  pathLabel: string;
  fields: LocalFieldSpec[];
  defaultPort: number;
  startupTimeoutSec: number;
  supportsApiKey: boolean;
  /** Looks for an existing install on this machine (PATH, common folders). Never throws. */
  detect(): Promise<DetectedEngine | undefined>;
  /** Builds the launch. Throws an Error with a user-readable message when values are invalid. */
  build(values: LocalValues, context: LaunchContext): LaunchSpec;
  /** The model id this server will serve, from values alone (used for account metadata before starting). */
  servedModel(values: LocalValues): string;
  /** Human-readable problems that block starting (missing required fields, missing files). Empty = ok. */
  validate(values: LocalValues, enginePath: string): string[];
}

/** A configured local server. One server = one Unify account = one served model. */
export interface LocalServerConfig {
  id: string;
  label: string;
  engine: LocalEngineKind;
  values: LocalValues;
  port: number;
  /** Start automatically on first use. */
  autoStart: boolean;
  /** Stop after this many idle minutes. 0 = never. */
  idleStopMinutes: number;
  /** Preset it was created from, if any. */
  presetId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LocalPreset {
  id: string;
  label: string;
  description: string;
  engine: LocalEngineKind;
  values: LocalValues;
  /** Shipped with Unify (read-only) vs saved by the user. */
  builtin: boolean;
  port?: number;
  /** Shown under the preset in the picker, e.g. '~115 tok/s on a 24 GB GPU'. */
  note?: string;
}

export interface LocalEngineInstall {
  path: string;
  version?: string;
  source: 'installed' | 'detected' | 'manual';
}

/** ~/.unify/local-inference.json */
export interface LocalInferenceFile {
  version: 1;
  engines: Partial<Record<LocalEngineKind, LocalEngineInstall>>;
  servers: LocalServerConfig[];
  /** User presets only; built-ins come from presets.ts. */
  presets: LocalPreset[];
  /** Only one server runs at a time (they share the GPU). Default true. */
  exclusive: boolean;
}

export type LocalServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface LocalServerStatus {
  id: string;
  state: LocalServerState;
  port: number;
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:8080/v1. Set while starting/running. */
  baseURL?: string;
  pid?: number;
  startedAt?: number;
  readyAt?: number;
  error?: string;
  exitCode?: number | null;
  /** Saved settings differ from what the running process was started with. */
  restartRequired: boolean;
  /** Command line the process was started with (API key masked). */
  command?: string;
  lastActivityAt?: number;
}

/** Engine data the renderer needs (definition minus functions, plus install state). */
export interface LocalEngineInfo {
  kind: LocalEngineKind;
  label: string;
  description: string;
  homepage: string;
  installable: boolean;
  pathKind: 'file' | 'folder' | 'none';
  pathLabel: string;
  fields: LocalFieldSpec[];
  defaultPort: number;
  install?: LocalEngineInstall;
  /** Found by the last detect, when not yet configured. */
  detected?: DetectedEngine;
  installing: boolean;
}

export interface LocalServerView {
  config: LocalServerConfig;
  status: LocalServerStatus;
  /** Linked Unify account (provider 'local'). */
  accountId?: string;
  servedModel: string;
  /** Command line that Start would run (API key masked). Empty when it cannot be built. */
  commandPreview: string;
  /** From the engine's validate() plus a missing engine path. */
  problems: string[];
}

export interface LocalInferenceState {
  engines: LocalEngineInfo[];
  /** Built-in first, then user presets. */
  presets: LocalPreset[];
  servers: LocalServerView[];
  exclusive: boolean;
}

/* ---------- Host → renderer messages ---------- */

export type LocalHostMessage =
  | { type: 'localInferenceState'; state: LocalInferenceState }
  | { type: 'localServerStatus'; status: LocalServerStatus }
  | { type: 'localServerLog'; id: string; lines: string[]; reset: boolean }
  | { type: 'localInferenceError'; requestId?: string; id?: string; message: string }
  | { type: 'localBrowseResult'; requestId?: string; path?: string }
  | { type: 'localServerCreated'; requestId?: string; id: string; accountId: string };

/* ---------- Renderer → host requests (all may carry requestId) ---------- */

export type LocalRequest =
  | { type: 'localInferenceGet'; requestId?: string }
  | { type: 'localServerCreate'; requestId?: string; presetId?: string; engine?: LocalEngineKind; label: string; values?: LocalValues; port?: number }
  | { type: 'localServerSave'; requestId?: string; id: string; label?: string; values?: LocalValues; port?: number; autoStart?: boolean; idleStopMinutes?: number }
  | { type: 'localServerStart'; requestId?: string; id: string }
  | { type: 'localServerStop'; requestId?: string; id: string }
  | { type: 'localServerRestart'; requestId?: string; id: string }
  /** Replies with localServerLog { reset: true } holding the whole buffer. */
  | { type: 'localServerLogs'; requestId?: string; id: string }
  /** Also removes the linked account and its models. */
  | { type: 'localServerDelete'; requestId?: string; id: string }
  | { type: 'localEngineInstall'; requestId?: string; engine: LocalEngineKind }
  | { type: 'localEngineSetPath'; requestId?: string; engine: LocalEngineKind; path: string }
  | { type: 'localEngineDetect'; requestId?: string }
  | { type: 'localBrowse'; requestId?: string; kind: 'file' | 'folder'; title?: string; filters?: LocalFileFilter[]; defaultPath?: string }
  | { type: 'localPresetSave'; requestId?: string; serverId: string; label: string }
  | { type: 'localPresetDelete'; requestId?: string; id: string }
  | { type: 'localInferenceSettings'; requestId?: string; exclusive: boolean };

export const LOCAL_REQUEST_TYPES: readonly LocalRequest['type'][] = [
  'localInferenceGet',
  'localServerCreate',
  'localServerSave',
  'localServerStart',
  'localServerStop',
  'localServerRestart',
  'localServerLogs',
  'localServerDelete',
  'localEngineInstall',
  'localEngineSetPath',
  'localEngineDetect',
  'localBrowse',
  'localPresetSave',
  'localPresetDelete',
  'localInferenceSettings',
];

/** Account metadata keys for provider 'local'. */
export interface LocalAccountMetadata {
  localServerId: string;
  servedModel: string;
}

/* ---------- Manager contract (implemented in manager.ts, used by host/local.ts) ---------- */

export interface LocalInferenceManagerOptions {
  /** Unify home (~/.unify). Config file and run dirs live under it. */
  home: string;
  /** Sends a host→renderer message (LocalHostMessage or progressNotice). */
  post(message: LocalHostMessage | ProgressNoticeMessage): void;
  /** True while a chat or run is using this server (blocks idle stop). */
  isInUse(serverId: string): boolean;
  log?(message: string): void;
  now?(): number;
  /** Defaults to the built-in engines from engines.ts. Tests pass fakes. */
  engines?: LocalEngineDefinition[];
  /** Defaults to the built-in presets from presets.ts. */
  presets?: LocalPreset[];
  /** Health poll interval, ms (default 500). Tests shorten it. */
  healthIntervalMs?: number;
  /** Idle check interval, ms (default 30000). */
  idleCheckMs?: number;
  /** Graceful stop wait before force kill, ms (default 5000). */
  stopGraceMs?: number;
}

export interface ProgressNoticeMessage {
  type: 'progressNotice';
  id: string;
  title: string;
  message: string;
  percent?: number;
  state: 'running' | 'done' | 'error';
}

export interface LocalServerCreateInput {
  presetId?: string;
  engine?: LocalEngineKind;
  label: string;
  values?: LocalValues;
  port?: number;
}

export interface LocalServerUpdateInput {
  label?: string;
  values?: LocalValues;
  port?: number;
  autoStart?: boolean;
  idleStopMinutes?: number;
}

/** Public surface of LocalInferenceManager. host/local.ts codes against this. */
export interface LocalInferenceManagerApi {
  /** Loads the config file. Call once before anything else. */
  load(): Promise<void>;
  state(): LocalInferenceState;
  server(id: string): LocalServerConfig | undefined;
  servedModel(id: string): string;
  createServer(input: LocalServerCreateInput): Promise<LocalServerConfig>;
  updateServer(id: string, input: LocalServerUpdateInput): Promise<LocalServerConfig>;
  /** Stops it first. */
  deleteServer(id: string): Promise<void>;
  /** Resolves with the base URL once healthy. Rejects with a readable error (incl. last log lines). */
  start(id: string, apiKey: string): Promise<string>;
  /** Returns the base URL if running, starts it if not (dedupes concurrent calls). */
  ensureRunning(id: string, apiKey: string): Promise<string>;
  stop(id: string): Promise<void>;
  restart(id: string, apiKey: string): Promise<string>;
  /** Marks activity (resets the idle timer). */
  touch(id: string): void;
  status(id: string): LocalServerStatus;
  logs(id: string): string[];
  setEnginePath(kind: LocalEngineKind, path: string): Promise<void>;
  installEngine(kind: LocalEngineKind): Promise<LocalEngineInstall>;
  detectEngines(): Promise<void>;
  savePreset(serverId: string, label: string): Promise<LocalPreset>;
  deletePreset(id: string): Promise<void>;
  setExclusive(exclusive: boolean): Promise<void>;
  /** Stops every server (graceful, then force) and clears timers. */
  dispose(): Promise<void>;
}
