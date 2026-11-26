/** Models, accounts and usage: choices, routing, account pools, pickers and the model/account management screens. */
import type { Host as ExtensionHost } from '../extension';
import * as vscode from 'vscode';
import { ModelEntry } from '../accounts';
import { UsageTarget } from '../accounts/usageService';
import { OAuthCliAccount, checkOAuthAccount } from '../accounts/oauthCli';
import { SELF_HOSTED, SELF_HOSTED_ENV, parseModelIds } from '../runtime/selfHosted';
import { accountForModel } from '../sync/configSync';
import { SidebarWebviewMessage } from '../sidebar/provider';
import { SidebarNameModel } from '../sidebar/view';
import { SMART_AUTO } from '../runtime/smartAuto';
import type { SessionRecord, ModelChoice, ModelSettingKey, ResolvedRoute, Chat } from './types';
import { SELECTED_MODEL_KEY, ACTIVE_SESSION_KEY, MODEL_CHOICES_KEY, LIMIT_COOLDOWN_MS } from './constants';
import { isOAuthProvider, isCliProvider } from './helpers';

export function refreshModels(this: ExtensionHost): void {
  const current = this.availableModel(this.selectedModel);
  const choice = this.choiceFor(current);
  this.sidebar.postMessage({
    type: 'modelState',
    models: this.availableModels().map(model => {
      // Config Sync can carry a context size for a model even though the core entry does not require one.
      const contextWindow = (model as ModelEntry & { contextWindow?: unknown }).contextWindow;
      return { id: model.name, name: model.name, provider: model.provider,
        backend: model.backend, enabled: model.enabled, usable: this.providerUsable(model.provider),
        speedOptions: model.speedOptions, effortOptions: model.effortOptions,
        ...(typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}) };
    }),
    cursorBackends: this.cursorModels.map(model => ({ value: model.backend, name: model.name.replace(/^Cursor /, '') })),
    selectedModelId: this.selectedModel, selectedSpeed: choice.speed, selectedEffort: choice.effort,
  });
}

export function choiceFor(this: ExtensionHost, model?: ModelEntry): ModelChoice {
  if (!model) return {};
  const stored = this.modelChoices[model.name] || {};
  return {
    speed: model.speedOptions?.some(item => item.label === stored.speed) ? stored.speed : model.speedOptions?.[0]?.label,
    effort: model.effortOptions?.includes(stored.effort || '') ? stored.effort : '',
  };
}

export function effectiveModel(this: ExtensionHost, model: ModelEntry): ModelEntry {
  const choice = this.choiceFor(model);
  const backend = model.speedOptions?.find(item => item.label === choice.speed)?.backend || model.backend;
  return { ...model, backend };
}

export function usageTargets(this: ExtensionHost): UsageTarget[] {
  return [
    ...this.oauthAccounts.list().map(account => ({ id: account.id, provider: account.provider, oauth: account })),
    ...this.accounts.list().map(account => ({ id: account.id, provider: account.provider, secret: () => this.accounts.getSecret(account.id) })),
    ...(this.cursorAccount.connected ? [{ id: 'cursor-login', provider: 'cursor-acp' }] : []),
  ];
}

export function refreshUsage(this: ExtensionHost, force = false, accountId?: string): void {
  try {
    const targets = this.usageTargets();
    const target = accountId === undefined ? undefined : targets.find(item => item.id === accountId);
    const refresh = accountId === undefined ? this.usage.refresh(targets, force) : target ? this.usage.refreshOne(target, force) : undefined;
    void refresh?.then(() => this.removeInvalidOAuthAccounts())
      .catch(error => this.output.appendLine(`Usage refresh failed: ${String(error)}`));
  } catch (error) { this.output.appendLine(`Usage refresh failed: ${String(error)}`); }
}

/**
 * Removes a ChatGPT or Claude account whose sign-in the CLI now reports as gone. Only an explicit "invalid" removes;
 * a network error or an unknown answer keeps the account. Accounts whose usage loaded are signed in and are skipped.
 */
export async function removeInvalidOAuthAccounts(this: ExtensionHost): Promise<void> {
  const usage = this.usage.snapshot();
  for (const account of this.oauthAccounts.list()) {
    if (usage[account.id]?.status === 'ready') continue;
    try {
      if (await checkOAuthAccount(account) !== 'invalid') continue;
      this.output.appendLine(`Removed "${account.label}": its sign-in is no longer valid. Sign in again to use it.`);
      await this.removeAccount(account.id);
    } catch (error) { this.output.appendLine(`Could not remove "${account.label}": ${String(error)}`); }
  }
}

export async function refreshAccounts(this: ExtensionHost, checkCursor = true): Promise<void> {
  if (checkCursor && !this.cursorAccount.busy) {
    try {
      const output = await this.runCursorCommand('status', undefined, 15000);
      const connected = !/not authenticated|not logged in|unauthenticated/i.test(output) && /authenticated|logged in/i.test(output);
      const email = output.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/i)?.[0];
      this.cursorAccount = { connected, label: connected ? email || 'Cursor account' : 'Not connected' };
    } catch { this.cursorAccount = { connected: false, label: 'Cursor CLI unavailable' }; }
  }
  this.sidebar.postMessage({ type: 'accountsState', accounts: [
    ...this.oauthAccounts.list().map(account => ({ id: account.id, provider: account.provider, label: account.label,
      email: account.email, isDefault: this.oauthAccounts.getDefault(account.provider)?.id === account.id, authType: 'oauth' as const })),
    ...this.accounts.list().map(account => ({ id: account.id, provider: account.provider, label: account.label, email: account.email,
      isDefault: this.accounts.getDefault(account.provider)?.id === account.id, authType: 'api-key' as const,
      ...(account.provider === SELF_HOSTED && typeof account.metadata?.baseURL === 'string' ? { baseURL: account.metadata.baseURL } : {}) })),
  ], cursor: this.cursorAccount });
  await this.refreshAccount();
  this.refreshUsage();
}

export function availableModels(this: ExtensionHost): ModelEntry[] {
  return this.models.list();
}

export function availableModel(this: ExtensionHost, name: string): ModelEntry | undefined {
  return this.availableModels().find(model => model.name === name);
}

/** Whether this PC can run the provider: Cursor when connected, otherwise the provider has a signed-in account. */
export function providerUsable(this: ExtensionHost, provider: string): boolean {
  if (provider === 'cursor-acp') return this.cursorAccount.connected;
  if (isOAuthProvider(provider)) return !!this.oauthAccounts.getDefault(provider);
  return !!this.accounts.getDefault(provider);
}

/** Enabled and runnable here. A model synced from another PC can be enabled yet have no account on this one. */
export function isUsable(this: ExtensionHost, model: ModelEntry): boolean {
  return model.enabled !== false && this.providerUsable(model.provider);
}

/** The picked model; when it was renamed, removed, turned off or has no account here, falls back to (and saves) the first usable one. */
export function selectedEntry(this: ExtensionHost): ModelEntry | undefined {
  const current = this.availableModel(this.selectedModel);
  if (current && this.isUsable(current)) return current;
  const fallback = this.availableModels().find(model => this.isUsable(model));
  if (fallback) {
    this.selectedModel = fallback.name;
    void this.context.workspaceState.update(SELECTED_MODEL_KEY, fallback.name);
    this.refreshModels();
  }
  return fallback ?? current;
}

export async function refreshAccount(this: ExtensionHost): Promise<void> {
  const model = this.availableModel(this.selectedModel);
  if (!model) return;
  if (model.provider === 'cursor-acp') {
    this.sidebar.postMessage({ type: 'accountState', provider: 'Cursor', label: this.cursorAccount.connected ? this.cursorAccount.label : 'Connect Cursor account', connected: this.cursorAccount.connected });
    return;
  }
  if (isOAuthProvider(model.provider)) {
    const account = accountForModel(this.oauthAccounts, model);
    this.sidebar.postMessage({ type: 'accountState', provider: model.provider, label: account?.label || 'Connect an account', connected: !!account });
    return;
  }
  const account = accountForModel(this.accounts, model);
  this.sidebar.postMessage({ type: 'accountState', provider: model.provider, label: account?.label || 'Add an account', connected: !!account });
}

/** The error for a model whose provider has no signed-in account on this PC. */
export function missingAccountError(this: ExtensionHost, model: { name: string; provider: string }): Error {
  this.sidebar.postMessage({ type: 'showPage', page: 'accounts' });
  return new Error(`No account for ${model.name} (${model.provider}). Sign in to a provider in Providers.`);
}

/** `accountId` is the account a pooled chat is running on; without it the provider's default account is used. */
export async function resolveRoute(this: ExtensionHost, override?: ModelEntry, accountId?: string): Promise<ResolvedRoute> {
  await this.ensureNode();
  await this.refreshDependencies();
  const selected = override ?? this.selectedEntry();
  if (!selected) throw new Error('Turn on a model in Accounts first.');
  const model = override ?? this.effectiveModel(selected);
  if (model.provider === 'cursor-acp') return { model };
  if (isOAuthProvider(model.provider)) {
    const oauthAccount = (accountId && this.oauthAccounts.get(accountId)) || accountForModel(this.oauthAccounts, model);
    if (!oauthAccount) throw this.missingAccountError(model);
    return { model, oauthAccount };
  }
  if (!accountForModel(this.accounts, model)) throw this.missingAccountError(model);
  const route = await this.models.resolve(model.name);
  await this.refreshAccount();
  return { ...route, model };
}

export function selfHostedBaseURL(this: ExtensionHost, account: { metadata?: Record<string, unknown> }): string {
  const baseURL = account.metadata?.baseURL;
  if (typeof baseURL !== 'string' || !baseURL) throw new Error('This self-hosted account has no base URL. Remove it and add it again.');
  return baseURL;
}

/** Asks a self-hosted account's server which models it serves. Errors never include the key. */
export async function listProviderModels(this: ExtensionHost, accountId: string): Promise<void> {
  const post = (models: string[], error?: string) => this.sidebar.postMessage({ type: 'providerModels', accountId, models, ...(error ? { error } : {}) });
  try {
    const account = this.accounts.get(accountId);
    if (!account || account.provider !== SELF_HOSTED) throw new Error('Choose a self-hosted account.');
    const baseURL = this.selfHostedBaseURL(account);
    const secret = await this.accounts.getSecret(accountId);
    if (!secret) throw new Error('This account has no API key. Replace the key and try again.');
    const response = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`The server answered ${response.status}${response.status === 401 || response.status === 403 ? ' (check the API key)' : ''}.`);
    post(parseModelIds(await response.json()));
  } catch (error) {
    const raw = error instanceof Error ? (error.name === 'TimeoutError' ? 'The server did not answer within 20 seconds.' : error.message) : String(error);
    let text = raw;
    try { const key = await this.accounts.getSecret(accountId); if (key) text = text.split(key).join('[key]'); } catch { /* keep text */ }
    post([], text || 'Could not load models.');
  }
}

export function envName(this: ExtensionHost, provider: string): string {
  const configured: Record<string, string> = {
    'deepseek-official': 'DEEPSEEK_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    'opencode-go': 'OPENCODE_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    [SELF_HOSTED]: SELF_HOSTED_ENV,
  };
  const name = configured[provider];
  if (!name) throw new Error(`Provider '${provider}' needs an explicit Unify adapter and credential mapping before it can run.`);
  return name;
}

/** `effort` replaces the chat's effort; without it an override keeps the chat's effort and a picker switch uses the picker's. */
/** `pinnedAccountId` keeps a chat on its own account (a pooled failover target, or the chat's current account). */
export async function switchModel(this: ExtensionHost, chat: Chat, override?: ModelEntry, effort?: string, pinnedAccountId?: string): Promise<void> {
  const record = chat.record;
  const route = await this.resolveRoute(override, pinnedAccountId);
  const model = route.model;
  effort = effort ?? (override ? record.effort : this.choiceFor(this.availableModel(model.name)).effort);
  const accountId = 'oauthAccount' in route ? route.oauthAccount.id : 'account' in route ? route.account.id : 'cursor-login';
  const cwd = chat.mirror.cwd;
  const oauth = isCliProvider(model.provider) || (model.provider === 'codex-cli' && record.codexRuntime === false);
  const sameBackendSession = record.provider === model.provider && (oauth || model.provider === 'cursor-acp') && record.accountId === accountId;
  const slot = await this.ensureRuntime(route, cwd, chat.ownerId, { kind: 'main' }, oauth && model.provider === 'codex-cli');
  const previous = { runtime: chat.runtime, key: chat.runtimeKey };
  if (oauth || !slot) {
    if (!sameBackendSession) { record.cliSessionId = undefined; record.explorerTokens = 0; chat.handoffPending = true; }
    if (previous.runtime) await previous.runtime.closeSession(this.rid(record)).catch(() => undefined);
    chat.runtime = undefined; chat.runtimeKey = undefined;
  } else {
    const reuse = previous.runtime === slot.runtime && previous.key === slot.key && record.provider === model.provider && model.provider === 'cursor-acp';
    if (!reuse) {
      if (previous.runtime) await previous.runtime.closeSession(this.rid(record)).catch(() => undefined);
      record.runtimeId = await slot.runtime.newSession(cwd, this.mcpServers(chat.ownerId));
      this.freshSessions?.add(record.runtimeId);
      record.explorerTokens = 0;
      chat.handoffPending = true;
    }
    chat.runtime = slot.runtime; chat.runtimeKey = slot.key;
    const id = this.rid(record);
    if (model.provider === 'cursor-acp') {
      await this.refreshCursorModels(slot.runtime, id);
      if (model.backend !== 'auto' || slot.runtime.models(id).some(option => option.value === 'auto')) await slot.runtime.setModel(id, model.backend);
    }
    if (effort) await slot.runtime.setConfigOption(id, 'reasoning_effort', effort);
  }
  if (previous.key !== chat.runtimeKey) await this.releaseRuntime(previous.key);
  Object.assign(record, { modelName: model.name, provider: model.provider, backend: model.backend, effort, accountId });
  record.updatedAt = Date.now();
  await this.saveSession(record);
  this.refreshSessions();
}

/** The account a saved chat runs on. When that account is gone, the provider's default takes over and the chat is saved to it. */
export async function chatAccount<T extends { id: string; provider: string; label: string }>(this: ExtensionHost, record: SessionRecord,
  bound: () => T | undefined, fallback: () => T | undefined): Promise<T> {
  const account = bound();
  if (account) return account;
  const replacement = fallback();
  if (!replacement) throw new Error(`No account for ${record.modelName} (${record.provider}). Sign in to a provider in Providers.`);
  record.accountId = replacement.id;
  await this.saveSession(record);
  return replacement;
}

/** Accounts of the same provider in failover order: `first`, then the rest in list order, with recently limited ones last. */
export function accountPool(this: ExtensionHost, first: OAuthCliAccount): OAuthCliAccount[] {
  const all = this.oauthAccounts.list(first.provider);
  const index = all.findIndex(account => account.id === first.id);
  const ordered = index < 0 ? [first, ...all] : [...all.slice(index), ...all.slice(0, index)];
  const limited = (account: OAuthCliAccount): boolean => Date.now() - (this.limitedAt.get(account.id) || 0) < LIMIT_COOLDOWN_MS;
  return [...ordered.filter(account => !limited(account)), ...ordered.filter(limited)];
}

export function modelSetting(this: ExtensionHost, key: ModelSettingKey): SidebarNameModel {
  const value = vscode.workspace.getConfiguration?.('unify').get<unknown>(key);
  if (!value || typeof value !== 'object') return {};
  const { model, effort, speed } = value as Record<string, unknown>;
  const text = (item: unknown): string | undefined => typeof item === 'string' && item.trim() ? item.trim() : undefined;
  return { model: text(model), effort: text(effort), speed: text(speed) };
}

export async function saveModelSetting(this: ExtensionHost, key: ModelSettingKey, value: SidebarNameModel): Promise<void> {
  const name = String(value?.model || '').trim();
  let next: SidebarNameModel | undefined;
  if (name) {
    const model = this.availableModel(name);
    if (!model) throw new Error(`Model "${name}" is not available.`);
    const effort = value.effort || undefined;
    const speed = value.speed || undefined;
    if (effort && !model.effortOptions?.includes(effort)) throw new Error(`Effort "${effort}" is not offered by ${model.name}.`);
    if (speed && !model.speedOptions?.some(item => item.label === speed)) throw new Error(`Speed "${speed}" is not offered by ${model.name}.`);
    next = { model: model.name, effort, speed };
  }
  await vscode.workspace.getConfiguration('unify').update(key, next, vscode.ConfigurationTarget.Global);
  this.refreshCustomize();
}

export async function pickModel(this: ExtensionHost): Promise<void> {
  const pick = await vscode.window.showQuickPick([
    ...(this.smartAutoReady() ? [{ label: SMART_AUTO, description: 'A decider model picks a ranked model for each message', name: SMART_AUTO }] : []),
    ...this.availableModels().filter(model => model.enabled).map(model => ({
      label: model.name, description: model.provider, detail: model.backend, name: model.name,
    })),
  ], { placeHolder: 'Select a model' });
  if (pick) await this.selectModel(pick.name);
}

export async function selectModel(this: ExtensionHost, name: string): Promise<void> {
  if (name === SMART_AUTO) {
    if (!this.smartAutoReady()) throw new Error('Smart Auto needs a decider model and at least one ranked model. Set them in Customize.');
    this.selectedModel = name;
    await this.context.workspaceState.update(SELECTED_MODEL_KEY, name);
    this.refreshModels();
    return;
  }
  const model = this.availableModel(name);
  if (!model || !model.enabled) throw new Error(`Model '${name}' is unavailable.`);
  if (!this.isUsable(model)) throw this.missingAccountError(model);
  this.selectedModel = name;
  await this.context.workspaceState.update(SELECTED_MODEL_KEY, name);
  this.refreshModels(); await this.refreshAccount();
}

export async function selectChoice(this: ExtensionHost, kind: 'speed' | 'effort', value: string): Promise<void> {
  const model = this.availableModel(this.selectedModel);
  if (!model) throw new Error('Choose a model first.');
  const valid = kind === 'speed'
    ? model.speedOptions?.some(item => item.label === value)
    : value === '' || model.effortOptions?.includes(value);
  if (!valid) throw new Error(`This ${kind} choice is unavailable for ${model.name}.`);
  this.modelChoices[model.name] = { ...this.modelChoices[model.name], [kind]: value };
  await this.context.workspaceState.update(MODEL_CHOICES_KEY, this.modelChoices);
  this.refreshModels();
}

export async function manageAccounts(this: ExtensionHost): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.unify');
  this.sidebar.postMessage({ type: 'showPage', page: 'accounts' });
  await this.refreshAccounts();
}

export async function manageModels(this: ExtensionHost): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.unify');
  this.sidebar.postMessage({ type: 'showPage', page: 'models' });
  this.refreshModels();
}

export async function saveModel(this: ExtensionHost, message: Extract<SidebarWebviewMessage, { type: 'saveModel' }>): Promise<void> {
  const allowed = new Set(['deepseek-official', 'openai', 'anthropic', 'openrouter', 'opencode-go', 'mistral', SELF_HOSTED, 'cursor-acp', 'codex-cli', 'claude-cli']);
  if (!allowed.has(message.provider)) throw new Error('Choose a supported model provider.');
  const name = message.name.trim();
  const backend = message.backend.trim();
  if (!name || !backend || name.length > 80) throw new Error('A model name and backend ID are required.');
  if (name === SMART_AUTO) throw new Error(`"${SMART_AUTO}" is reserved for the model picker. Choose another name.`);
  const speedOptions = message.speedOptions || [];
  const effortOptions = message.effortOptions || [];
  if (!Array.isArray(speedOptions) || speedOptions.length > 8 || speedOptions.some(item =>
    !item || typeof item.label !== 'string' || typeof item.backend !== 'string' || !item.label.trim() || !item.backend.trim() || item.label.length > 30 || item.backend.length > 120) ||
    new Set(speedOptions.map(item => item.label.toLowerCase())).size !== speedOptions.length ||
    (speedOptions.length > 0 && (speedOptions[0].label !== 'None' || speedOptions[0].backend !== backend))) {
    throw new Error('Speed routes must have distinct names and valid model IDs.');
  }
  if (!Array.isArray(effortOptions) || effortOptions.length > 10 || effortOptions.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9_-]{0,29}$/.test(item)) ||
    new Set(effortOptions).size !== effortOptions.length) throw new Error('Effort choices must be distinct provider effort values.');
  // Cursor models may be typed as slugs before a session has listed them; Cursor itself rejects unknown ones when the chat starts.
  const cursorSlug = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]=,+-]{0,119}$/;
  if (message.provider === 'cursor-acp' && [backend, ...speedOptions.map(item => item.backend)].some(slug => !cursorSlug.test(slug))) {
    throw new Error('Cursor model slugs may only use letters, digits and . _ : / @ [ ] = , + -');
  }
  // A model names a provider, not an account: the provider's default account runs it on each PC.
  await this.models.set({ name, provider: message.provider, backend, enabled: true, speedOptions, effortOptions }, message.originalName);
  if (message.originalName && message.originalName !== name && this.modelChoices[message.originalName]) {
    this.modelChoices[name] = this.modelChoices[message.originalName];
    delete this.modelChoices[message.originalName];
    await this.context.workspaceState.update(MODEL_CHOICES_KEY, this.modelChoices);
  }
  if (message.originalName && this.selectedModel === message.originalName) {
    this.selectedModel = name;
    await this.context.workspaceState.update(SELECTED_MODEL_KEY, name);
    if (this.active && this.active.provider === message.provider && this.active.backend === backend) {
      this.active.modelName = name;
      await this.saveSession(this.active);
    }
  }
  this.refreshModels();
  await this.refreshAccount();
  this.sidebar.postMessage({ type: 'modelSaved' });
}

export async function removeModel(this: ExtensionHost, name: string): Promise<void> {
  if (!this.models.get(name)) throw new Error(`Model '${name}' is not configured.`);
  try { await this.models.remove(name); } catch (error) { this.sidebar.postMessage({ type: 'modelRemoveFailed', name }); this.refreshModels(); throw error; }
  if (this.selectedModel === name) {
    this.selectedModel = this.availableModels().find(model => this.isUsable(model))?.name || '';
    await this.context.workspaceState.update(SELECTED_MODEL_KEY, this.selectedModel);
  }
  this.refreshModels();
  await this.refreshAccount();
}

export async function removeAccount(this: ExtensionHost, accountId: string): Promise<void> {
  const affected = [...this.chats.values()].filter(chat => chat.record.accountId === accountId);
  if (affected.length) {
    if (affected.some(chat => chat.running)) throw new Error('Wait for running chats before removing their account.');
    if (affected.some(chat => chat.review.pending().length)) throw new Error('Apply or reject pending edits before removing the active account.');
    const wasActive = affected.some(chat => chat.record.id === this.active?.id);
    for (const chat of affected) await this.unloadChat(chat.record.id);
    if (wasActive) await this.context.workspaceState.update(ACTIVE_SESSION_KEY, undefined);
    this.refreshSessions();
    this.syncActiveView();
  }
  if (this.oauthAccounts.get(accountId)) await this.oauthAccounts.remove(accountId);
  else await this.accounts.remove(accountId);
  await this.refreshAccounts(false);
}
