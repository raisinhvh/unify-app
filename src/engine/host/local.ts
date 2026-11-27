/** Native local inference: Unify-managed local servers as accounts, their models, and starting them on demand. */
import type { Host as ExtensionHost } from '../extension';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { LOCAL_PROVIDER } from '../local/types';
import type { LocalHostMessage, LocalInferenceState, LocalRequest, LocalServerConfig } from '../local/types';
import type { SidebarHostMessage } from '../sidebar/view';
import type { AcpRuntime } from '../runtime/acp';

/** Requests that can take minutes (loading a model, downloading an engine). They run without holding up the message queue. */
const LONG_REQUESTS = new Set<LocalRequest['type']>(['localServerStart', 'localServerRestart', 'localEngineInstall']);

/** Runtimes already wrapped so a local server is started before each prompt. */
const guardedRuntimes = new WeakSet<AcpRuntime>();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestIdOf(message: LocalRequest): string | undefined {
  return message.requestId;
}

function serverIdOf(message: LocalRequest): string | undefined {
  return 'id' in message && typeof message.id === 'string' ? message.id : undefined;
}

/** The managed server config behind a local account. */
function localServerIdOf(account: { metadata?: Record<string, unknown> }): string | undefined {
  const id = account.metadata?.localServerId;
  return typeof id === 'string' && id ? id : undefined;
}

function servedModelOf(account: { metadata?: Record<string, unknown> }): string | undefined {
  const model = account.metadata?.servedModel;
  return typeof model === 'string' && model ? model : undefined;
}

/** The Unify account that runs a local server. */
export function localAccountForServer(this: ExtensionHost, serverId: string) {
  return this.accounts.list(LOCAL_PROVIDER).find(account => localServerIdOf(account) === serverId);
}

function postLocal(host: ExtensionHost, message: LocalHostMessage): void {
  host.sidebar.postMessage(message as SidebarHostMessage);
}

/** The manager's state with each server's linked account filled in. */
export function localInferenceState(this: ExtensionHost): LocalInferenceState {
  const state = this.localInference.state();
  return {
    ...state,
    servers: state.servers.map(view => ({ ...view, accountId: this.localAccountForServer(view.config.id)?.id })),
  };
}

export function postLocalInferenceState(this: ExtensionHost): void {
  postLocal(this, { type: 'localInferenceState', state: this.localInferenceState() });
}

/** Loads the manager's config file once. */
export function loadLocalInference(this: ExtensionHost): Promise<void> {
  this.localInferenceLoaded ??= this.localInference.load();
  return this.localInferenceLoaded;
}

/** Handles one request from the Providers → Local screen. Never throws: failures are posted as localInferenceError. */
export async function handleLocalMessage(this: ExtensionHost, message: LocalRequest): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      await this.loadLocalInference();
      await this.runLocalRequest(message);
    } catch (error) {
      postLocal(this, { type: 'localInferenceError', requestId: requestIdOf(message), id: serverIdOf(message), message: errorText(error) });
      this.postLocalInferenceState();
    }
  };
  if (LONG_REQUESTS.has(message.type)) {
    void run();
    return;
  }
  await run();
}

export async function runLocalRequest(this: ExtensionHost, message: LocalRequest): Promise<void> {
  const manager = this.localInference;
  switch (message.type) {
    case 'localInferenceGet':
      break;
    case 'localServerCreate':
      await this.createLocalServer(message);
      return;
    case 'localServerSave':
      await this.saveLocalServer(message);
      break;
    case 'localServerStart':
    case 'localServerRestart': {
      const secret = await this.localServerSecret(message.id);
      this.postLocalInferenceState();
      if (message.type === 'localServerStart') await manager.start(message.id, secret);
      else await manager.restart(message.id, secret);
      break;
    }
    case 'localServerStop':
      await manager.stop(message.id);
      break;
    case 'localServerLogs':
      postLocal(this, { type: 'localServerLog', id: message.id, lines: manager.logs(message.id), reset: true });
      return;
    case 'localServerDelete': {
      const account = this.localAccountForServer(message.id);
      if (account) await this.removeAccount(account.id);
      else await this.deleteLocalServerData(message.id);
      await this.refreshAccounts(false);
      break;
    }
    case 'localEngineInstall':
      await manager.installEngine(message.engine);
      break;
    case 'localEngineSetPath':
      await manager.setEnginePath(message.engine, message.path);
      break;
    case 'localEngineDetect':
      await manager.detectEngines();
      break;
    case 'localBrowse':
      await this.browseLocalPath(message);
      return;
    case 'localPresetSave':
      await manager.savePreset(message.serverId, message.label);
      break;
    case 'localPresetDelete':
      await manager.deletePreset(message.id);
      break;
    case 'localInferenceSettings':
      await manager.setExclusive(message.exclusive);
      break;
  }
  this.postLocalInferenceState();
}

/** A model name not used by any model yet: `base`, then `base 2`, `base 3`. */
function uniqueModelName(host: ExtensionHost, base: string): string {
  const taken = new Set(host.availableModels().map(model => model.name));
  if (!taken.has(base)) return base;
  for (let number = 2; ; number++) {
    const name = `${base} ${number}`;
    if (!taken.has(name)) return name;
  }
}

/** Another local server that serves the same model id, if any. Requests would be routed by that id, so it must be unique. */
function serverServing(host: ExtensionHost, servedModel: string, exceptId?: string): LocalServerConfig | undefined {
  return host.localInference.state().servers.find(view => view.config.id !== exceptId && view.servedModel === servedModel)?.config;
}

export async function createLocalServer(this: ExtensionHost, message: Extract<LocalRequest, { type: 'localServerCreate' }>): Promise<void> {
  const manager = this.localInference;
  const server = await manager.createServer({ presetId: message.presetId, engine: message.engine, label: message.label, values: message.values, port: message.port });
  const servedModel = manager.servedModel(server.id);
  try {
    const other = serverServing(this, servedModel, server.id);
    if (other) throw new Error(`"${other.label}" already serves the model id "${servedModel}". Give this server a different model name or alias.`);
    const account = await this.accounts.add({
      provider: LOCAL_PROVIDER,
      label: server.label,
      secret: randomBytes(24).toString('hex'),
      metadata: { localServerId: server.id, servedModel },
    });
    await this.models.set({ name: uniqueModelName(this, server.label), provider: LOCAL_PROVIDER, backend: servedModel, enabled: true, speedOptions: [], effortOptions: [] });
    await this.refreshAccounts(false);
    this.refreshModels();
    postLocal(this, { type: 'localServerCreated', requestId: message.requestId, id: server.id, accountId: account.id });
    this.postLocalInferenceState();
  } catch (error) {
    // Do not leave a server without an account behind.
    await manager.deleteServer(server.id).catch(() => undefined);
    throw error;
  }
}

export async function saveLocalServer(this: ExtensionHost, message: Extract<LocalRequest, { type: 'localServerSave' }>): Promise<void> {
  const manager = this.localInference;
  const before = manager.server(message.id);
  if (!before) throw new Error('This local server no longer exists.');
  const oldServed = manager.servedModel(message.id);
  const after = await manager.updateServer(message.id, {
    label: message.label, values: message.values, port: message.port, autoStart: message.autoStart, idleStopMinutes: message.idleStopMinutes,
  });
  const newServed = manager.servedModel(message.id);
  const other = newServed !== oldServed ? serverServing(this, newServed, message.id) : undefined;
  if (other) {
    await manager.updateServer(message.id, { label: before.label, values: before.values, port: before.port, autoStart: before.autoStart, idleStopMinutes: before.idleStopMinutes });
    throw new Error(`"${other.label}" already serves the model id "${newServed}". Give this server a different model name or alias.`);
  }
  const account = this.localAccountForServer(message.id);
  if (account) {
    if (newServed !== oldServed) await this.accounts.updateMetadata(account.id, { servedModel: newServed });
    if (after.label !== account.label) await this.accounts.rename(account.id, after.label);
  }
  if (newServed !== oldServed) await this.retargetLocalModels(oldServed, newServed);
  await this.refreshAccounts(false);
  this.refreshModels();
}

/** Points every local model that used the old served model id at the new one. */
export async function retargetLocalModels(this: ExtensionHost, oldServed: string, newServed: string): Promise<void> {
  for (const model of this.models.list().filter(item => item.provider === LOCAL_PROVIDER && item.backend === oldServed)) {
    await this.models.set({ ...model, backend: newServed }, model.name);
  }
}

/** Removes a server's config and the models that pointed at it. The account is removed by the caller. */
export async function deleteLocalServerData(this: ExtensionHost, serverId: string, servedModel?: string): Promise<void> {
  const served = servedModel ?? (this.localInference.server(serverId) ? this.localInference.servedModel(serverId) : undefined);
  await this.loadLocalInference();
  await this.localInference.deleteServer(serverId);
  if (!served) return;
  for (const model of this.models.list().filter(item => item.provider === LOCAL_PROVIDER && item.backend === served)) {
    await this.models.remove(model.name);
  }
  this.refreshModels();
}

/** Account removal hook: a local account takes its server and models with it. */
export async function removeLocalAccountData(this: ExtensionHost, account: { provider: string; metadata?: Record<string, unknown> }): Promise<void> {
  if (account.provider !== LOCAL_PROVIDER) return;
  const serverId = localServerIdOf(account);
  if (!serverId) return;
  await this.deleteLocalServerData(serverId, servedModelOf(account));
  this.postLocalInferenceState();
}

/** The generated API key of a local server's account. */
export async function localServerSecret(this: ExtensionHost, serverId: string): Promise<string> {
  const account = this.localAccountForServer(serverId);
  const secret = account ? await this.accounts.getSecret(account.id) : undefined;
  if (!secret) throw new Error('This local server has no account key. Delete the server and create it again.');
  return secret;
}

export async function browseLocalPath(this: ExtensionHost, message: Extract<LocalRequest, { type: 'localBrowse' }>): Promise<void> {
  const filters: Record<string, string[]> = {};
  for (const filter of message.filters ?? []) filters[filter.name] = filter.extensions;
  const folder = message.kind === 'folder';
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: !folder,
    canSelectFolders: folder,
    canSelectMany: false,
    title: message.title,
    openLabel: 'Select',
    ...(message.defaultPath ? { defaultUri: vscode.Uri.file(message.defaultPath) } : {}),
    ...(!folder && Object.keys(filters).length ? { filters } : {}),
  });
  postLocal(this, { type: 'localBrowseResult', requestId: message.requestId, path: picked?.[0]?.fsPath });
}

/**
 * The base URL of a local account's server, starting it first when it is stopped and auto-start is on.
 * Throws a readable error when the server is missing or must be started by hand.
 */
export async function ensureLocalServer(this: ExtensionHost, account: { id: string; label: string; metadata?: Record<string, unknown> }): Promise<string> {
  await this.loadLocalInference();
  const serverId = localServerIdOf(account);
  const server = serverId ? this.localInference.server(serverId) : undefined;
  if (!serverId || !server) throw new Error(`The local server for "${account.label}" no longer exists. Remove this account and create the server again in Providers → Local.`);
  const status = this.localInference.status(serverId);
  if (status.state !== 'running' && status.state !== 'starting' && !server.autoStart) {
    throw new Error(`Local server "${server.label}" is stopped. Start it from Providers → Local.`);
  }
  const secret = await this.accounts.getSecret(account.id);
  if (!secret) throw new Error(`The local server "${server.label}" has no account key. Remove the account and create the server again.`);
  this.localInference.touch(serverId);
  return this.localInference.ensureRunning(serverId, secret);
}

/**
 * Makes every prompt on a local runtime start its server first (it may have been idle-stopped since the chat opened) and
 * count as server activity. Prompts in flight are tracked so the idle timer never stops a server mid-turn.
 * ensureRuntime only runs when a chat or subagent starts, not before each prompt, so this guards the runtime itself.
 */
export function guardLocalRuntime(
  this: ExtensionHost,
  runtime: AcpRuntime,
  account: { id: string; label: string; metadata?: Record<string, unknown> },
  baseURL: string,
): void {
  if (guardedRuntimes.has(runtime)) return;
  guardedRuntimes.add(runtime);
  const original = runtime.prompt.bind(runtime);
  runtime.prompt = async (...args: Parameters<AcpRuntime['prompt']>) => {
    this.localPrompts.set(account.id, (this.localPrompts.get(account.id) ?? 0) + 1);
    try {
      const current = await this.ensureLocalServer(account);
      // The runtime was started against one URL; a port change needs a new runtime, which a new chat gets.
      if (current !== baseURL) throw new Error(`The local server "${account.label}" now runs at ${current}. Start a new chat to use it.`);
      return await original(...args);
    } finally {
      const remaining = (this.localPrompts.get(account.id) ?? 1) - 1;
      if (remaining > 0) this.localPrompts.set(account.id, remaining);
      else this.localPrompts.delete(account.id);
      const serverId = localServerIdOf(account);
      if (serverId) this.localInference.touch(serverId);
    }
  };
}

/**
 * True while a chat turn or subagent run is using this server: a prompt is in flight on one of its runtimes
 * (tracked by guardLocalRuntime), or a running chat, job, background task or child run sits on its account.
 */
export function isLocalServerInUse(this: ExtensionHost, serverId: string): boolean {
  const account = this.localAccountForServer(serverId);
  if (!account) return false;
  if ((this.localPrompts.get(account.id) ?? 0) > 0) return true;
  const prefix = `${LOCAL_PROVIDER}:${account.id}:`;
  for (const chat of this.chats.values()) {
    const onServer = chat.record.accountId === account.id || !!chat.runtimeKey?.startsWith(prefix);
    if (onServer && (chat.running || chat.jobActive || chat.background.size > 0)) return true;
  }
  for (const run of this.childRuns) {
    if (run.runtimeKey?.startsWith(prefix)) return true;
  }
  return false;
}

/** After Config Sync replaced the models setting: gives each local server's model back when sync dropped it. */
export async function restoreLocalModels(this: ExtensionHost): Promise<void> {
  const present = new Set(this.models.list().filter(model => model.provider === LOCAL_PROVIDER).map(model => model.backend));
  for (const account of this.accounts.list(LOCAL_PROVIDER)) {
    const served = servedModelOf(account);
    if (!served || present.has(served)) continue;
    await this.models.set({ name: uniqueModelName(this, account.label), provider: LOCAL_PROVIDER, backend: served, enabled: true, speedOptions: [], effortOptions: [] });
  }
}
