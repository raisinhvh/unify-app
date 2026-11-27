/**
 * Providers screen actions: per-model enable toggles, account labels, an account's default model, OAuth
 * sign-out, and opening a provider's usage page.
 *
 * Unify keeps account metadata in the shim's globalState (`~/.unify/state.json`) and models in the
 * `unify.models` setting. Labels and default models live in `~/.unify/providers.json`. Models belong to a
 * provider; the default model is stored per provider (`providerDefaults`).
 *
 * `signOutAccount` removes the account completely through the engine (`context.removeAccount`), so the record,
 * its credentials, the default pointer and the in-memory state all change together.
 */
import { RequestPaths, isRecord, readJsonFile, writeJsonFile } from './state';

/** Usage pages Unify already opens for `viewProviderUsage` (extension.ts). */
const PROVIDER_USAGE_URLS: Record<string, string> = {
  'codex-cli': 'https://chatgpt.com/settings/usage?tab=overview',
  'claude-cli': 'https://claude.ai/settings/usage',
  'cursor-acp': 'https://cursor.com/dashboard?tab=usage',
  'deepseek-official': 'https://platform.deepseek.com/usage',
  'openrouter': 'https://openrouter.ai/activity',
  'opencode-go': 'https://opencode.ai/console',
  'mistral': 'https://console.mistral.ai/usage',
};

interface ProviderStore {
  /** Model id -> whether the screen should offer it. */
  modelEnabled: Record<string, boolean>;
  /** Account id -> display label. */
  accountLabels: Record<string, string>;
  /** Provider -> the model new chats on that provider start with. */
  providerDefaults: Record<string, string>;
}

interface AccountRecord {
  id: string;
  provider: string;
  label: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

export interface AccountStateEntry {
  id: string;
  provider: string;
  label: string;
  email?: string;
  isDefault: boolean;
  authType: 'oauth' | 'api-key';
  baseURL?: string;
  /** Provider 'local': the Unify-managed server this account runs, and the model id it serves. */
  localServerId?: string;
  servedModel?: string;
  defaultModel?: string;
}

export interface AccountsStatePayload {
  type: 'accountsState';
  accounts: AccountStateEntry[];
  /** Provider -> the model new chats on that provider start with. */
  providerDefaults: Record<string, string>;
}

const OAUTH_KEY = 'unify.oauthCliAccounts.v1';
const OAUTH_DEFAULTS_KEY = 'unify.oauthCliDefaults.v1';
const ACCOUNTS_KEY = 'unify.accounts.v1';
const ACCOUNTS_DEFAULTS_KEY = 'unify.accountDefaults.v1';
const MODEL_SETTING = 'unify.models';

export function providerStore(paths: RequestPaths): ProviderStore {
  const stored = readJsonFile<Partial<ProviderStore> & { accountDefaults?: unknown }>(paths.providersFile, {});
  const store: ProviderStore = {
    modelEnabled: isRecord(stored.modelEnabled) ? stored.modelEnabled as Record<string, boolean> : {},
    accountLabels: isRecord(stored.accountLabels) ? stored.accountLabels as Record<string, string> : {},
    providerDefaults: isRecord(stored.providerDefaults) ? stored.providerDefaults as Record<string, string> : {},
  };
  // Defaults used to be per account. Each one moves to its account's provider, unless that provider has one already.
  if (isRecord(stored.accountDefaults)) {
    const state = readState(paths);
    const providerOf = new Map<string, string>();
    for (const item of [...records(state, OAUTH_KEY), ...records(state, ACCOUNTS_KEY)]) providerOf.set(item.id, item.provider);
    for (const [accountId, modelId] of Object.entries(stored.accountDefaults)) {
      const provider = providerOf.get(accountId);
      if (provider && typeof modelId === 'string' && modelId && !store.providerDefaults[provider]) store.providerDefaults[provider] = modelId;
    }
    saveProviderStore(paths, store);
  }
  return store;
}

function saveProviderStore(paths: RequestPaths, store: ProviderStore): void {
  writeJsonFile(paths.providersFile, store);
}

interface ShimState {
  [key: string]: unknown;
}

function readState(paths: RequestPaths): ShimState {
  return readJsonFile<ShimState>(paths.stateFile, {});
}

function saveState(paths: RequestPaths, state: ShimState): void {
  writeJsonFile(paths.stateFile, state);
}

function records(state: ShimState, key: string): AccountRecord[] {
  const value = state[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AccountRecord =>
    !!item && typeof item === 'object' && typeof (item as AccountRecord).id === 'string' && typeof (item as AccountRecord).provider === 'string');
}

function defaults(state: ShimState, key: string): Record<string, string> {
  const value = state[key];
  return isRecord(value) ? value as Record<string, string> : {};
}

/** Updates one account record in both state.json arrays; returns whether it was found. */
function patchAccount(state: ShimState, accountId: string, patch: Partial<AccountRecord>): { oauth: boolean; apiKey: boolean } {
  const result = { oauth: false, apiKey: false };
  for (const [key, field] of [[OAUTH_KEY, 'oauth'], [ACCOUNTS_KEY, 'apiKey']] as const) {
    const list = records(state, key);
    const index = list.findIndex(account => account.id === accountId);
    if (index < 0) continue;
    list[index] = { ...list[index], ...patch, id: list[index].id, provider: list[index].provider };
    state[key] = list;
    result[field] = true;
  }
  return result;
}

/** The accountsState payload the renderer expects, built from disk. Cursor's login is engine-owned and omitted. */
export function accountsState(paths: RequestPaths): AccountsStatePayload {
  const state = readState(paths);
  const store = providerStore(paths);
  const oauthDefaults = defaults(state, OAUTH_DEFAULTS_KEY);
  const apiDefaults = defaults(state, ACCOUNTS_DEFAULTS_KEY);
  const accounts: AccountStateEntry[] = [];
  for (const account of records(state, OAUTH_KEY)) {
    accounts.push({
      id: account.id,
      provider: account.provider,
      label: store.accountLabels[account.id] ?? account.label,
      email: account.email,
      isDefault: (oauthDefaults[account.provider] ?? records(state, OAUTH_KEY).find(item => item.provider === account.provider)?.id) === account.id,
      authType: 'oauth',
      ...(store.providerDefaults[account.provider] ? { defaultModel: store.providerDefaults[account.provider] } : {}),
    });
  }
  for (const account of records(state, ACCOUNTS_KEY)) {
    accounts.push({
      id: account.id,
      provider: account.provider,
      label: store.accountLabels[account.id] ?? account.label,
      email: account.email,
      isDefault: (apiDefaults[account.provider] ?? records(state, ACCOUNTS_KEY).find(item => item.provider === account.provider)?.id) === account.id,
      authType: 'api-key',
      ...(account.provider === 'self-hosted' && typeof account.metadata?.baseURL === 'string' ? { baseURL: account.metadata.baseURL } : {}),
      ...(account.provider === 'local' && typeof account.metadata?.localServerId === 'string' ? { localServerId: account.metadata.localServerId } : {}),
      ...(account.provider === 'local' && typeof account.metadata?.servedModel === 'string' ? { servedModel: account.metadata.servedModel } : {}),
      ...(store.providerDefaults[account.provider] ? { defaultModel: store.providerDefaults[account.provider] } : {}),
    });
  }
  return { type: 'accountsState', accounts, providerDefaults: store.providerDefaults };
}

/** Applies `enabled` to a stored `unify.models` entry; returns whether the setting held the model. */
function setModelSetting(paths: RequestPaths, modelId: string, enabled: boolean): void {
  const state = readJsonFile<Record<string, unknown>>(paths.settingsFile, {});
  const value = state[MODEL_SETTING];
  if (!Array.isArray(value)) return;
  let changed = false;
  state[MODEL_SETTING] = value.map(entry => {
    if (!entry || typeof entry !== 'object') return entry;
    const model = entry as Record<string, unknown>;
    if (model.name !== modelId) return entry;
    changed = true;
    return { ...model, enabled };
  });
  if (changed) writeJsonFile(paths.settingsFile, state);
}

/** Persists a per-model toggle from the Providers screen. */
export function setModelEnabled(paths: RequestPaths, modelId: string, enabled: boolean): void {
  if (!modelId) throw new Error('Choose a model first.');
  const store = providerStore(paths);
  store.modelEnabled[modelId] = enabled;
  saveProviderStore(paths, store);
  setModelSetting(paths, modelId, enabled);
}

/** Renames an account everywhere it is stored. Returns the fresh accounts state. */
export function renameAccount(paths: RequestPaths, accountId: string, label: string): AccountsStatePayload {
  const trimmed = String(label || '').trim();
  if (!trimmed) throw new Error('The account name is required.');
  const store = providerStore(paths);
  const state = readState(paths);
  const found = patchAccount(state, accountId, { label: trimmed });
  if (!found.oauth && !found.apiKey) throw new Error('Account not found.');
  saveState(paths, state);
  store.accountLabels[accountId] = trimmed;
  saveProviderStore(paths, store);
  return accountsState(paths);
}

/** Remembers which model new chats on this provider should start with. */
export function setProviderDefaultModel(paths: RequestPaths, provider: string, modelId: string): AccountsStatePayload {
  const name = String(provider || '').trim();
  if (!name) throw new Error('Choose a provider first.');
  const store = providerStore(paths);
  if (modelId) store.providerDefaults[name] = String(modelId);
  else delete store.providerDefaults[name];
  saveProviderStore(paths, store);
  return accountsState(paths);
}

/** Alias kept for older screens: the account's provider gets the default. */
export function setAccountDefaultModel(paths: RequestPaths, accountId: string, modelId: string): AccountsStatePayload {
  const provider = providerOfAccount(paths, accountId);
  if (!provider) throw new Error('Account not found.');
  return setProviderDefaultModel(paths, provider, modelId);
}

/**
 * Removes an account completely (record, credentials directory, default pointer), for OAuth and API-key
 * accounts alike. The engine does the removal through `removeAccount`, which keeps its in-memory state in step.
 */
export async function signOutAccount(
  paths: RequestPaths,
  accountId: string,
  removeAccount?: (accountId: string) => Promise<void>,
): Promise<AccountsStatePayload> {
  if (!providerOfAccount(paths, accountId)) throw new Error('Account not found.');
  if (!removeAccount) throw new Error('Signing out needs the Unify engine. Restart Unify and try again.');
  await removeAccount(accountId);
  return accountsState(paths);
}

/** The provider whose usage page "View usage" opens for an account. */
function providerOfAccount(paths: RequestPaths, accountId: string): string | undefined {
  if (accountId === 'cursor-login') return 'cursor-acp';
  const state = readState(paths);
  return records(state, OAUTH_KEY).find(item => item.id === accountId)?.provider
    ?? records(state, ACCOUNTS_KEY).find(item => item.id === accountId)?.provider;
}

export interface ProviderUsageHooks {
  refreshUsageState?: (accountId?: string) => void;
  openExternal?: (url: string) => void | Promise<void>;
}

/**
 * "View usage": schedule a usage refresh for the account and open its provider dashboard when one is known.
 * Answers immediately, as the in-app Usage page opens on its own; the refresh is never awaited.
 */
export function openProviderUsage(
  paths: RequestPaths,
  accountId: string,
  hooks: ProviderUsageHooks,
): { type: 'providerRequestResult'; ok: boolean; error?: string } {
  const provider = providerOfAccount(paths, accountId);
  if (!provider) return { type: 'providerRequestResult', ok: false, error: 'Account not found.' };
  hooks.refreshUsageState?.(accountId);
  const url = PROVIDER_USAGE_URLS[provider];
  if (url && hooks.openExternal) {
    void Promise.resolve()
      .then(() => hooks.openExternal?.(url))
      .catch(() => undefined);
  }
  return { type: 'providerRequestResult', ok: true };
}
