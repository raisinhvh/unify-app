import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { maskedCommand } from './args';
import { LOCAL_ENGINES } from './engines';
import { installEngine as downloadEngine } from './install';
import { gracefulStop, killOrphan, pickPort, isPortFree, removePidFile, spawnServer, writePidFile } from './process';
import { BUILTIN_PRESETS, defaultValues, presetValues } from './presets';
import { LocalStore } from './store';
import type {
  LaunchContext,
  LaunchSpec,
  DetectedEngine,
  LocalEngineDefinition,
  LocalEngineInfo,
  LocalEngineInstall,
  LocalEngineKind,
  LocalHostMessage,
  LocalInferenceFile,
  LocalInferenceManagerApi,
  LocalInferenceManagerOptions,
  LocalInferenceState,
  LocalPreset,
  LocalServerConfig,
  LocalServerCreateInput,
  LocalServerStatus,
  LocalServerUpdateInput,
  LocalServerView,
} from './types';

const LOG_LIMIT = 3000;
const LOG_FLUSH_MS = 200;
const NOTICE_MS = 5000;
const TAIL_LINES = 20;
const STOPPED = 'Stopped';

/** Longest graceful wait during app quit; main/index.ts exits 3 s after asking the engine to shut down. */
const QUIT_GRACE_MS = 2000;

/** Everything the manager tracks about one server while Unify runs. */
interface Runtime {
  status: LocalServerStatus;
  child?: ChildProcessWithoutNullStreams;
  /** How the running process asks to be stopped (from its LaunchSpec). */
  stopSpec?: LaunchSpec['stop'];
  log: string[];
  pendingLog: string[];
  flushTimer?: NodeJS.Timeout;
  startPromise?: Promise<string>;
  stopPromise?: Promise<void>;
  /** Cancels the start in flight (rejects it with 'Stopped'). */
  abortStart?: () => void;
  /** Called when the process exits while the start is still waiting. */
  exitWaiter?: (code: number | null) => void;
  cancelled: boolean;
  apiKey: string;
  /** Values and port the running process was started with. */
  startedSignature: string;
}

function randomId(prefix: string): string {
  return `${prefix}${randomBytes(4).toString('hex')}`;
}

function signature(config: LocalServerConfig): string {
  return JSON.stringify({ values: config.values, port: config.port });
}

function clockTime(timestamp: number): string {
  return new Date(timestamp).toTimeString().slice(0, 8);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleepable(): { sleep(ms: number): Promise<void>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  let release: (() => void) | undefined;
  return {
    sleep(ms) {
      return new Promise<void>(resolve => {
        release = resolve;
        timer = setTimeout(resolve, ms);
      });
    },
    cancel() {
      if (timer) clearTimeout(timer);
      release?.();
    },
  };
}

export class LocalInferenceManager implements LocalInferenceManagerApi {
  private readonly store: LocalStore;
  private readonly engines: LocalEngineDefinition[];
  private readonly builtinPresets: LocalPreset[];
  private readonly runtimes = new Map<string, Runtime>();
  private readonly detected = new Map<LocalEngineKind, DetectedEngine>();
  private readonly installing = new Set<LocalEngineKind>();
  private file: LocalInferenceFile = { version: 1, engines: {}, servers: [], presets: [], exclusive: true };
  private idleTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly options: LocalInferenceManagerOptions) {
    this.store = new LocalStore(options.home);
    this.engines = options.engines ?? LOCAL_ENGINES;
    this.builtinPresets = options.presets ?? BUILTIN_PRESETS;
  }

  /* ---------- Setup and state ---------- */

  async load(): Promise<void> {
    this.file = this.store.load();
    this.startIdleTimer();
  }

  state(): LocalInferenceState {
    return {
      engines: this.engines.map(definition => this.engineInfo(definition)),
      presets: [...this.builtinPresets, ...this.file.presets],
      servers: this.file.servers.map(config => this.serverView(config)),
      exclusive: this.file.exclusive,
    };
  }

  server(id: string): LocalServerConfig | undefined {
    return this.file.servers.find(candidate => candidate.id === id);
  }

  servedModel(id: string): string {
    const config = this.server(id);
    const definition = config && this.definition(config.engine);
    if (!config || !definition) return '';
    try {
      return definition.servedModel(config.values);
    } catch {
      return '';
    }
  }

  status(id: string): LocalServerStatus {
    const runtime = this.runtimes.get(id);
    if (runtime) return { ...runtime.status };
    return { id, state: 'stopped', port: this.server(id)?.port ?? 0, restartRequired: false };
  }

  logs(id: string): string[] {
    return [...(this.runtimes.get(id)?.log ?? [])];
  }

  touch(id: string): void {
    const runtime = this.runtimes.get(id);
    if (runtime) runtime.status.lastActivityAt = this.now();
  }

  /* ---------- Server configuration ---------- */

  async createServer(input: LocalServerCreateInput): Promise<LocalServerConfig> {
    const preset = input.presetId ? this.allPresets().find(candidate => candidate.id === input.presetId) : undefined;
    if (input.presetId && !preset) throw new Error(`Unknown preset: ${input.presetId}`);
    const kind = preset?.engine ?? input.engine;
    const definition = kind ? this.definition(kind) : undefined;
    if (!kind || !definition) throw new Error('Choose an engine for the new server.');
    const base = preset ? presetValues(preset, definition) : defaultValues(definition);
    const taken = new Set(this.file.servers.map(candidate => candidate.port));
    const port = await pickPort(input.port || preset?.port || definition.defaultPort, taken);
    const timestamp = this.now();
    const config: LocalServerConfig = {
      id: randomId('ls_'),
      label: input.label,
      engine: kind,
      values: { ...base, ...(input.values ?? {}) },
      port,
      autoStart: true,
      idleStopMinutes: 15,
      presetId: preset?.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.file.servers.push(config);
    await this.save();
    this.postState();
    return config;
  }

  async updateServer(id: string, input: LocalServerUpdateInput): Promise<LocalServerConfig> {
    const config = this.requireServer(id);
    if (input.label !== undefined) config.label = input.label;
    if (input.values !== undefined) config.values = { ...input.values };
    if (input.port !== undefined) config.port = input.port;
    if (input.autoStart !== undefined) config.autoStart = input.autoStart;
    if (input.idleStopMinutes !== undefined) config.idleStopMinutes = input.idleStopMinutes;
    config.updatedAt = this.now();
    await this.save();
    const runtime = this.runtimes.get(id);
    if (runtime) {
      const running = runtime.status.state === 'running' || runtime.status.state === 'starting';
      if (running) runtime.status.restartRequired = signature(config) !== runtime.startedSignature;
      else runtime.status.port = config.port;
      this.postStatus(runtime);
    }
    this.postState();
    return config;
  }

  async deleteServer(id: string): Promise<void> {
    this.requireServer(id);
    await this.stop(id);
    this.file.servers = this.file.servers.filter(candidate => candidate.id !== id);
    const runtime = this.runtimes.get(id);
    if (runtime?.flushTimer) clearTimeout(runtime.flushTimer);
    this.runtimes.delete(id);
    await this.save();
    await rm(this.runDir(id), { recursive: true, force: true }).catch(() => undefined);
    this.postState();
  }

  /* ---------- Start, stop, restart ---------- */

  start(id: string, apiKey: string): Promise<string> {
    const runtime = this.runtime(id);
    if (runtime.status.state === 'running' && runtime.status.baseURL) return Promise.resolve(runtime.status.baseURL);
    if (runtime.startPromise) return runtime.startPromise;
    const promise = this.runStart(id, runtime, apiKey);
    runtime.startPromise = promise;
    const clear = () => {
      if (runtime.startPromise === promise) runtime.startPromise = undefined;
    };
    promise.then(clear, clear);
    return promise;
  }

  async ensureRunning(id: string, apiKey: string): Promise<string> {
    const runtime = this.runtime(id);
    if (runtime.status.state === 'running' && runtime.status.baseURL) {
      this.touch(id);
      return runtime.status.baseURL;
    }
    if (runtime.status.state === 'stopping' && runtime.stopPromise) await runtime.stopPromise;
    return this.start(id, apiKey);
  }

  stop(id: string): Promise<void> {
    const runtime = this.runtime(id);
    if (runtime.stopPromise) return runtime.stopPromise;
    const promise = this.runStop(id, runtime);
    runtime.stopPromise = promise;
    const clear = () => {
      if (runtime.stopPromise === promise) runtime.stopPromise = undefined;
    };
    promise.then(clear, clear);
    return promise;
  }

  async restart(id: string, apiKey: string): Promise<string> {
    await this.stop(id);
    return this.start(id, apiKey);
  }

  private async runStop(id: string, runtime: Runtime): Promise<void> {
    runtime.cancelled = true;
    const child = runtime.child;
    const inFlight = runtime.startPromise;
    if (child || runtime.status.state === 'starting' || runtime.status.state === 'running') {
      this.setStatus(runtime, { state: 'stopping' });
    }
    runtime.abortStart?.();
    if (child) await this.stopChild(child, runtime);
    if (inFlight) await inFlight.catch(() => undefined);
    runtime.child = undefined;
    removePidFile(this.runDir(id));
    this.setStatus(runtime, {
      state: 'stopped',
      pid: undefined,
      baseURL: undefined,
      error: undefined,
      restartRequired: false,
    });
  }

  private async runStart(id: string, runtime: Runtime, apiKey: string): Promise<string> {
    const config = this.requireServer(id);
    const definition = this.definition(config.engine);
    if (!definition) throw new Error(`Unknown engine: ${config.engine}`);
    runtime.cancelled = false;
    runtime.apiKey = apiKey;
    runtime.startedSignature = signature(config);
    const startedAt = this.now();
    this.setStatus(runtime, {
      state: 'starting',
      port: config.port,
      startedAt,
      readyAt: undefined,
      error: undefined,
      exitCode: undefined,
      restartRequired: false,
      baseURL: undefined,
      pid: undefined,
    });
    this.addLog(runtime, `— started ${clockTime(startedAt)} —`);
    const notice = this.startNotice(id, config.label, startedAt);
    try {
      const url = await this.launch(id, runtime, config, definition, apiKey);
      notice.finish('done', 'Ready');
      return url;
    } catch (error) {
      const message = errorText(error);
      notice.finish('error', message);
      if (message === STOPPED || runtime.cancelled) throw new Error(STOPPED);
      await this.failStart(id, runtime, message);
      throw new Error(message);
    }
  }

  /** Does the work of a start. Throws with the user-facing message on failure. */
  private async launch(
    id: string,
    runtime: Runtime,
    config: LocalServerConfig,
    definition: LocalEngineDefinition,
    apiKey: string,
  ): Promise<string> {
    const runDir = this.runDir(id);
    if (this.file.exclusive) await this.stopOthers(id);
    this.assertNotCancelled(runtime);
    await mkdir(runDir, { recursive: true });
    await killOrphan(runDir);
    this.assertNotCancelled(runtime);
    if (!(await isPortFree(config.port))) {
      throw new Error(`Port ${config.port} is in use by another program. Change the port or stop that program.`);
    }
    this.assertNotCancelled(runtime);
    const enginePath = this.enginePath(config.engine);
    if (definition.pathKind !== 'none' && !enginePath) throw new Error(`Set the ${definition.pathLabel} path.`);
    const context = this.context(id, config, apiKey, enginePath);
    const spec = definition.build(config.values, context);
    const child = this.spawn(id, runtime, spec);
    const baseURL = `http://127.0.0.1:${config.port}${spec.apiPath}`;
    this.setStatus(runtime, {
      baseURL,
      command: maskedCommand(spec.command, spec.args, apiKey),
      pid: child.pid,
    });
    await this.waitUntilReady(runtime, config.port, spec, apiKey, definition.startupTimeoutSec);
    this.setStatus(runtime, { state: 'running', readyAt: this.now(), lastActivityAt: this.now() });
    return baseURL;
  }

  private spawn(id: string, runtime: Runtime, spec: LaunchSpec): ChildProcessWithoutNullStreams {
    const child = spawnServer(
      spec,
      line => this.addLog(runtime, line),
      code => this.handleExit(id, runtime, child, code),
    );
    runtime.child = child;
    runtime.stopSpec = spec.stop;
    if (child.pid) writePidFile(this.runDir(id), child.pid, basename(spec.command));
    return child;
  }

  /** Resolves when the health URL answers 2xx. Rejects on exit, timeout or cancellation. */
  private waitUntilReady(
    runtime: Runtime,
    port: number,
    spec: LaunchSpec,
    apiKey: string,
    timeoutSec: number,
  ): Promise<void> {
    const interval = this.options.healthIntervalMs ?? 500;
    const pause = sleepable();
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        pause.cancel();
        runtime.abortStart = undefined;
        runtime.exitWaiter = undefined;
        if (error) reject(error);
        else resolve();
      };
      const deadline = setTimeout(() => {
        finish(new Error(`The server did not answer within ${timeoutSec}s.\n${this.tail(runtime)}`));
      }, timeoutSec * 1000);
      runtime.abortStart = () => finish(new Error(STOPPED));
      runtime.exitWaiter = code => {
        finish(new Error(`The server exited (code ${code}) before it was ready.\n${this.tail(runtime)}`));
      };
      const poll = async () => {
        while (!finished) {
          if (await this.probe(port, spec.healthPath, apiKey)) return finish();
          if (finished) return;
          await pause.sleep(interval);
        }
      };
      poll().catch(error => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }

  /** One health request over node:http (a plain GET to loopback; independent of any patched fetch). */
  private probe(port: number, healthPath: string, apiKey: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const request = httpRequest(
        { host: '127.0.0.1', port, path: healthPath, method: 'GET', headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, timeout: 3000 },
        response => {
          response.resume();
          resolve((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300);
        },
      );
      request.on('timeout', () => request.destroy());
      request.on('error', () => resolve(false));
      request.end();
    });
  }

  private handleExit(id: string, runtime: Runtime, child: ChildProcessWithoutNullStreams, code: number | null): void {
    if (runtime.child !== child) return;
    runtime.child = undefined;
    removePidFile(this.runDir(id));
    this.setStatus(runtime, { exitCode: code });
    if (runtime.status.state === 'stopping') return;
    if (runtime.exitWaiter) {
      runtime.exitWaiter(code);
      return;
    }
    if (runtime.status.state === 'running') {
      this.setStatus(runtime, {
        state: 'error',
        pid: undefined,
        baseURL: undefined,
        error: `The server exited unexpectedly (code ${code}).\n${this.tail(runtime)}`,
      });
    }
  }

  /** After a failed start: kill anything left and show the error. */
  private async failStart(id: string, runtime: Runtime, message: string): Promise<void> {
    const child = runtime.child;
    if (child) await this.stopChild(child, runtime);
    runtime.child = undefined;
    removePidFile(this.runDir(id));
    this.setStatus(runtime, { state: 'error', error: message, pid: undefined, baseURL: undefined });
  }

  /**
   * Graceful stop with the engine's own method and grace period, then a force kill.
   * On app quit the wait is capped (the app exits ~3 s after asking), and stdin-eof servers are never force-killed:
   * they finish their clean exit on their own (PolyStrata writes its expert profile then).
   */
  private stopChild(child: ChildProcessWithoutNullStreams, runtime: Runtime): Promise<void> {
    const method = runtime.stopSpec?.method ?? 'signal';
    const defaultGrace = this.options.stopGraceMs ?? 5000;
    const graceMs = runtime.stopSpec?.graceSec !== undefined ? runtime.stopSpec.graceSec * 1000 : defaultGrace;
    if (this.disposed) {
      return gracefulStop(child, Math.min(graceMs, QUIT_GRACE_MS), { method, force: method !== 'stdin-eof' });
    }
    return gracefulStop(child, graceMs, { method });
  }

  private assertNotCancelled(runtime: Runtime): void {
    if (runtime.cancelled) throw new Error(STOPPED);
  }

  private async stopOthers(id: string): Promise<void> {
    const others = [...this.runtimes.entries()].filter(([otherId, other]) => {
      return otherId !== id && (other.status.state === 'running' || other.status.state === 'starting');
    });
    await Promise.all(others.map(([otherId]) => this.stop(otherId)));
  }

  /** Progress notice that ticks every few seconds while the server starts. */
  private startNotice(id: string, label: string, startedAt: number): { finish(state: 'done' | 'error', message: string): void } {
    const noticeId = `local-start-${id}`;
    const title = `Starting ${label}`;
    const post = () => {
      const seconds = Math.round((this.now() - startedAt) / 1000);
      this.options.post({ type: 'progressNotice', id: noticeId, title, message: `Waiting for the server (${seconds}s)`, state: 'running' });
    };
    post();
    const timer = setInterval(post, NOTICE_MS);
    timer.unref();
    return {
      finish: (state, message) => {
        clearInterval(timer);
        this.options.post({ type: 'progressNotice', id: noticeId, title, message, state });
      },
    };
  }

  /* ---------- Idle stop ---------- */

  private startIdleTimer(): void {
    if (this.idleTimer || this.disposed) return;
    this.idleTimer = setInterval(() => {
      try {
        this.checkIdle();
      } catch (error) {
        this.options.log?.(`Idle check failed: ${errorText(error)}`);
      }
    }, this.options.idleCheckMs ?? 30_000);
    this.idleTimer.unref();
  }

  private checkIdle(): void {
    const now = this.now();
    for (const config of this.file.servers) {
      const runtime = this.runtimes.get(config.id);
      if (!runtime || runtime.status.state !== 'running' || config.idleStopMinutes <= 0) continue;
      if (this.options.isInUse(config.id)) {
        runtime.status.lastActivityAt = now;
        continue;
      }
      const last = runtime.status.lastActivityAt ?? runtime.status.readyAt ?? now;
      if (now - last <= config.idleStopMinutes * 60_000) continue;
      this.stop(config.id)
        .then(() => this.addLog(runtime, `— stopped after ${config.idleStopMinutes} idle minutes —`))
        .catch(error => this.options.log?.(`Idle stop failed: ${errorText(error)}`));
    }
  }

  /* ---------- Engines and presets ---------- */

  async setEnginePath(kind: LocalEngineKind, path: string): Promise<void> {
    if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);
    this.file.engines[kind] = { path, source: 'manual' };
    await this.save();
    this.postState();
  }

  async installEngine(kind: LocalEngineKind): Promise<LocalEngineInstall> {
    const definition = this.definition(kind);
    if (!definition || !definition.installable) throw new Error(`${definition?.label ?? kind} cannot be installed by Unify.`);
    if (this.installing.has(kind)) throw new Error(`${definition.label} is already being installed.`);
    const noticeId = `local-install-${kind}`;
    const title = `Installing ${definition.label}`;
    this.installing.add(kind);
    this.postState();
    try {
      const root = join(this.options.home, 'local-inference', 'engines', kind);
      const install = await downloadEngine(kind, root, (percent, message) => {
        this.options.post({ type: 'progressNotice', id: noticeId, title, message, percent, state: 'running' });
      });
      this.file.engines[kind] = install;
      await this.save();
      this.options.post({ type: 'progressNotice', id: noticeId, title, message: 'Installed', percent: 100, state: 'done' });
      this.installing.delete(kind);
      await this.detectEngines();
      return install;
    } catch (error) {
      this.installing.delete(kind);
      this.options.post({ type: 'progressNotice', id: noticeId, title, message: errorText(error), state: 'error' });
      this.postState();
      throw error;
    }
  }

  async detectEngines(): Promise<void> {
    await Promise.all(this.engines.map(async definition => {
      try {
        const found = await definition.detect();
        if (found) this.detected.set(definition.kind, found);
        else this.detected.delete(definition.kind);
      } catch {
        this.detected.delete(definition.kind);
      }
    }));
    for (const [kind, found] of this.detected) {
      if (this.file.engines[kind]?.path) continue;
      this.file.engines[kind] = { path: found.path, version: found.version, source: 'detected' };
    }
    await this.save();
    this.postState();
  }

  async savePreset(serverId: string, label: string): Promise<LocalPreset> {
    const config = this.requireServer(serverId);
    const preset: LocalPreset = {
      id: randomId('up_'),
      label,
      description: '',
      engine: config.engine,
      values: { ...config.values },
      port: config.port,
      builtin: false,
    };
    this.file.presets.push(preset);
    await this.save();
    this.postState();
    return preset;
  }

  async deletePreset(id: string): Promise<void> {
    if (this.builtinPresets.some(preset => preset.id === id)) throw new Error('Built-in presets cannot be deleted.');
    const before = this.file.presets.length;
    this.file.presets = this.file.presets.filter(preset => preset.id !== id);
    if (this.file.presets.length === before) throw new Error(`Unknown preset: ${id}`);
    await this.save();
    this.postState();
  }

  async setExclusive(exclusive: boolean): Promise<void> {
    this.file.exclusive = exclusive;
    await this.save();
    this.postState();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    await Promise.all([...this.runtimes.keys()].map(id => this.stop(id).catch(() => undefined)));
    for (const runtime of this.runtimes.values()) this.flushLog(runtime.status.id, runtime);
  }

  /* ---------- Helpers ---------- */

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private save(): Promise<void> {
    return this.store.save(this.file);
  }

  private definition(kind: LocalEngineKind): LocalEngineDefinition | undefined {
    return this.engines.find(candidate => candidate.kind === kind);
  }

  private allPresets(): LocalPreset[] {
    return [...this.builtinPresets, ...this.file.presets];
  }

  private requireServer(id: string): LocalServerConfig {
    const config = this.server(id);
    if (!config) throw new Error(`Unknown local server: ${id}`);
    return config;
  }

  private runDir(id: string): string {
    return join(this.options.home, 'local-inference', 'servers', id);
  }

  private enginePath(kind: LocalEngineKind): string {
    return this.file.engines[kind]?.path ?? '';
  }

  private context(id: string, config: LocalServerConfig, apiKey: string, enginePath: string): LaunchContext {
    return {
      port: config.port,
      host: '127.0.0.1',
      apiKey,
      serverId: id,
      runDir: this.runDir(id),
      enginePath,
      platform: process.platform,
    };
  }

  private runtime(id: string): Runtime {
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const config = this.requireServer(id);
    const created: Runtime = {
      status: { id, state: 'stopped', port: config.port, restartRequired: false },
      log: [],
      pendingLog: [],
      cancelled: false,
      apiKey: '',
      startedSignature: '',
    };
    this.runtimes.set(id, created);
    return created;
  }

  private tail(runtime: Runtime): string {
    return runtime.log.slice(-TAIL_LINES).join('\n');
  }

  private setStatus(runtime: Runtime, patch: Partial<LocalServerStatus>): void {
    Object.assign(runtime.status, patch);
    this.postStatus(runtime);
  }

  private postStatus(runtime: Runtime): void {
    this.post({ type: 'localServerStatus', status: { ...runtime.status } });
  }

  private postState(): void {
    this.post({ type: 'localInferenceState', state: this.state() });
  }

  private post(message: LocalHostMessage): void {
    try {
      this.options.post(message);
    } catch (error) {
      this.options.log?.(`Posting failed: ${errorText(error)}`);
    }
  }

  /* ---------- Logs ---------- */

  private addLog(runtime: Runtime, line: string): void {
    runtime.log.push(line);
    if (runtime.log.length > LOG_LIMIT) runtime.log.splice(0, runtime.log.length - LOG_LIMIT);
    runtime.pendingLog.push(line);
    if (runtime.status.state === 'running') runtime.status.lastActivityAt = this.now();
    if (runtime.flushTimer) return;
    runtime.flushTimer = setTimeout(() => this.flushLog(runtime.status.id, runtime), LOG_FLUSH_MS);
    runtime.flushTimer.unref();
  }

  private flushLog(serverId: string, runtime: Runtime): void {
    if (runtime.flushTimer) clearTimeout(runtime.flushTimer);
    runtime.flushTimer = undefined;
    if (runtime.pendingLog.length === 0) return;
    const lines = runtime.pendingLog;
    runtime.pendingLog = [];
    this.post({ type: 'localServerLog', id: serverId, lines, reset: false });
  }

  /* ---------- Views ---------- */

  private engineInfo(definition: LocalEngineDefinition): LocalEngineInfo {
    return {
      kind: definition.kind,
      label: definition.label,
      description: definition.description,
      homepage: definition.homepage,
      installable: definition.installable,
      pathKind: definition.pathKind,
      pathLabel: definition.pathLabel,
      fields: definition.fields,
      defaultPort: definition.defaultPort,
      install: this.file.engines[definition.kind],
      detected: this.detected.get(definition.kind),
      installing: this.installing.has(definition.kind),
    };
  }

  private serverView(config: LocalServerConfig): LocalServerView {
    const definition = this.definition(config.engine);
    const enginePath = this.enginePath(config.engine);
    const problems = definition ? [...definition.validate(config.values, enginePath)] : [`Unknown engine: ${config.engine}`];
    if (definition && definition.pathKind !== 'none' && !enginePath) problems.push(`Set the ${definition.pathLabel} path`);
    return {
      config,
      status: this.status(config.id),
      servedModel: this.servedModel(config.id),
      commandPreview: definition ? this.preview(config, definition, enginePath) : '',
      problems,
    };
  }

  private preview(config: LocalServerConfig, definition: LocalEngineDefinition, enginePath: string): string {
    const key = 'unify-preview-key';
    try {
      const spec = definition.build(config.values, this.context(config.id, config, key, enginePath));
      return maskedCommand(spec.command, spec.args, key);
    } catch {
      return '';
    }
  }
}
