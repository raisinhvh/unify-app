/**
 * Accounts and models as the Providers screen sees them. Reads the engine's accounts, cursor login, usage and
 * models; the usage maths stays in store/usage.ts (DSH's, unchanged).
 *
 * Fields and actions the engine lacks (protocol-requests.md â€º Providers) go through typed requests here:
 * per-model on/off, model context size, account rename, account default model, OAuth sign-out.
 * Changes are optimistic until the engine's next accountsState / modelState.
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { post } from '../../bridge';
import type {
  SidebarAccount,
  SidebarAccountUsage,
  SidebarModel,
  SidebarPlan,
  SidebarUsageMetric,
  SidebarWebviewMessage,
} from '../../protocol';
import { onHostMessage, viewState } from '../../store';
import { accountGroupOrder, providerColor, providerNames } from '../../store/providers';
import { usageSummary } from '../../store/usage';
import { select } from './selection';

/** Company names as Figma shows them; the engine's names describe the CLI. */
const providerTitles: Record<string, string> = {
  'claude-cli': 'Anthropic',
  'codex-cli': 'OpenAI',
};

export const providerTitle = (provider: string): string => providerTitles[provider] || providerNames[provider] || provider;

/** How a plan is named in prose: "Claude Team", "ChatGPT Business". */
const planBrands: Record<string, string> = {
  'claude-cli': 'Claude',
  'codex-cli': 'ChatGPT',
  'cursor-acp': 'Cursor',
  'opencode-go': 'OpenCode Go',
  'mistral': 'Mistral',
  'google-gemini': 'Gemini',
};

/** Figma's panel order: Anthropic, OpenAI, Cursor, OpenCode Go, Mistral, Self-hosted. */
const displayOrder = ['claude-cli', 'codex-cli', 'cursor-acp', 'opencode-go', 'mistral', 'google-gemini', 'self-hosted'];

/** What "Signed in with" says for OAuth accounts. */
const oauthNames: Record<string, string> = {
  'claude-cli': 'Claude account',
  'codex-cli': 'ChatGPT account',
  'cursor-acp': 'Cursor account',
};

/** The cursor login behaves like one account; this is the id the usage store gives it. */
export const cursorAccountId = 'cursor-login';

export interface AccountExtension {
  /** Model id new chats on this account start with. */
  defaultModel?: string;
}

export type AccountStatus = 'connected' | 'signedOut' | 'error' | 'loading';

export interface AccountView {
  id: string;
  provider: string;
  label: string;
  email?: string;
  isDefault: boolean;
  authType: 'oauth' | 'api-key';
  baseURL?: string;
  defaultModel?: string;
  isCursor: boolean;
  status: AccountStatus;
  usage?: SidebarAccountUsage;
  /** Highest used percent across the account's limits, when it reports any. */
  binding?: SidebarUsageMetric & { usedPercent: number };
  /** Colour of the account's segment in the stacked usage bar. */
  color: string;
}

export interface ProviderGroup {
  provider: string;
  accounts: AccountView[];
}

/** Messages the engine does not handle yet; see protocol-requests.md. */
export type ProviderRequest =
  | { type: 'setModelEnabled'; modelId: string; enabled: boolean }
  | { type: 'renameAccount'; accountId: string; label: string }
  | { type: 'setAccountDefaultModel'; accountId: string; modelId: string }
  | { type: 'signOutAccount'; accountId: string }
  | { type: 'openProviderUsage'; accountId: string };

let requestCount = 0;

/** Correlates a request with its reply (see protocol-requests.md). */
export function providerRequestId(): string {
  requestCount += 1;
  return `providers-${Date.now().toString(36)}-${requestCount}`;
}

export function postProviderRequest(message: ProviderRequest): void {
  post({ ...message, requestId: providerRequestId() } as unknown as SidebarWebviewMessage);
}

interface Overrides {
  labels: Record<string, string>;
  defaults: Record<string, string>;
  models: Record<string, boolean>;
}

const [overrides, setOverrides] = createSignal<Overrides>({ labels: {}, defaults: {}, models: {} });
const [removingModels, setRemovingModels] = createSignal<string[]>([]);

export interface ServerModelsResult {
  loading: boolean;
  models: string[];
  error?: string;
  loaded: boolean;
}

const [serverModels, setServerModels] = createSignal<Record<string, ServerModelsResult>>({});
export { serverModels };

onHostMessage(message => {
  if (message.type === 'accountsState') setOverrides(current => ({ ...current, labels: {}, defaults: {} }));
  if (message.type === 'modelState') {
    setOverrides(current => ({ ...current, models: {} }));
    const present = new Set((message.models || []).map(model => model.name));
    setRemovingModels(current => (current.length ? current.filter(name => present.has(name)) : current));
  }
  if (message.type === 'modelRemoveFailed') {
    setRemovingModels(current => current.filter(name => name !== message.name));
  }
  if (message.type === 'error') {
    setRemovingModels(current => (current.length ? [] : current));
  }
  if (message.type === 'providerModels') {
    setServerModels(current => ({
      ...current,
      [message.accountId]: {
        loading: false,
        models: message.models || [],
        error: message.error,
        loaded: true,
      },
    }));
  }
});

function statusOf(usage: SidebarAccountUsage | undefined): AccountStatus {
  if (!usage) return 'connected';
  if (usage.fix === 'signin') return 'signedOut';
  if (usage.loading && !usage.metrics.length) return 'loading';
  if (usage.status === 'error') return 'error';
  return 'connected';
}

function bindingOf(usage: SidebarAccountUsage | undefined) {
  const metrics = (usage?.metrics || []).filter(
    (metric): metric is SidebarUsageMetric & { usedPercent: number } =>
      typeof metric.usedPercent === 'number' && Number.isFinite(metric.usedPercent),
  );
  return metrics.length ? metrics.reduce((best, metric) => (metric.usedPercent > best.usedPercent ? metric : best)) : undefined;
}

export const providerGroups = createRoot(() =>
  createMemo<ProviderGroup[]>(() => {
    const local = overrides();
    const colors = new Map(usageSummary().entries.map(entry => [entry.account.id, entry.color]));
    const view = (account: SidebarAccount & AccountExtension, isCursor = false): AccountView => {
      const usage = viewState.usage[account.id];
      return {
        id: account.id,
        provider: account.provider,
        label: local.labels[account.id] ?? account.label,
        email: account.email,
        isDefault: account.isDefault,
        authType: account.authType ?? (isCursor || account.provider === 'claude-cli' || account.provider === 'codex-cli' ? 'oauth' : 'api-key'),
        baseURL: account.baseURL,
        defaultModel: local.defaults[account.id] ?? account.defaultModel,
        isCursor,
        status: statusOf(usage),
        usage,
        binding: bindingOf(usage),
        color: colors.get(account.id) || providerColor(account.provider),
      };
    };
    const groups: ProviderGroup[] = [];
    const known = new Set(accountGroupOrder);
    const rest = [...new Set(viewState.accounts.map(account => account.provider))].filter(id => !displayOrder.includes(id));
    const providers = [...displayOrder, ...rest].filter(provider => known.has(provider) || rest.includes(provider));
    for (const provider of providers) {
      const accounts = viewState.accounts.filter(account => account.provider === provider).map(account => view(account));
      if (provider === 'cursor-acp' && viewState.cursor.connected) {
        accounts.push(view({ id: cursorAccountId, provider, label: viewState.cursor.label || 'Cursor account', isDefault: true, authType: 'oauth' }, true));
      }
      if (accounts.length) groups.push({ provider, accounts });
    }
    return groups;
  }),
);

export const allAccounts = (): AccountView[] => providerGroups().flatMap(group => group.accounts);

export const findAccount = (id: string | undefined): AccountView | undefined =>
  id ? allAccounts().find(account => account.id === id) : undefined;

/**
 * An account's name in two parts: the provider ("Anthropic") and the account label ("Work"). Screens show the label
 * muted after the provider, never joined with a separator glyph.
 */
export interface AccountName {
  provider: string;
  label: string;
}

export const accountName = (account: Pick<AccountView, 'provider' | 'label'>): AccountName => ({
  provider: providerTitle(account.provider),
  label: account.label,
});

/** What the "Signed in with" row says. */
export function signedInWith(account: AccountView): string {
  if (account.authType === 'oauth') return oauthNames[account.provider] || account.email || 'Account';
  if (account.provider === 'self-hosted') return account.baseURL || 'Server';
  return 'API key';
}

/** "Claude Team", "ChatGPT Business"; falls back to the provider's own plan name. */
export function brandedPlan(account: AccountView): string {
  const name = planName(account);
  const brand = planBrands[account.provider];
  return brand && account.usage?.plan ? `${brand} ${name}` : name;
}

export interface ModelView {
  id: string;
  name: string;
  provider: string;
  backend: string;
  account: string;
  speedOptions?: { label: string; backend: string }[];
  effortOptions?: string[];
  enabled: boolean;
  contextWindow?: number;
}

/** Models served through an account: bound to it, or unbound on its provider when it is the provider default. */
export function accountModels(account: AccountView): ModelView[] {
  const local = overrides();
  const removing = new Set(removingModels());
  return viewState.models
    .filter((model: SidebarModel) => {
      if (removing.has(model.name) || removing.has(model.id)) return false;
      return model.account && model.account !== 'default'
        ? model.account === account.id
        : model.provider === account.provider && account.isDefault;
    })
    .map(model => ({
      id: model.id,
      name: model.name,
      provider: model.provider,
      backend: model.backend,
      account: model.account || 'default',
      speedOptions: model.speedOptions,
      effortOptions: model.effortOptions,
      enabled: model.id in local.models ? local.models[model.id] : model.enabled !== false,
      contextWindow: model.contextWindow,
    }));
}

/** "1M context", "200K context". */
export function formatContext(tokens: number | undefined): string {
  if (!tokens) return '';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M context`;
  return `${Math.round(tokens / 1000)}K context`;
}

export function setModelEnabled(modelId: string, enabled: boolean): void {
  setOverrides(current => ({ ...current, models: { ...current.models, [modelId]: enabled } }));
  postProviderRequest({ type: 'setModelEnabled', modelId, enabled });
}

const allowedModelProviders = new Set([
  'deepseek-official',
  'openai',
  'anthropic',
  'openrouter',
  'opencode-go',
  'mistral',
  'self-hosted',
  'cursor-acp',
  'codex-cli',
  'claude-cli',
]);

const reservedModelName = 'Smart Auto';
const cursorModelSlug = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]=,+-]{0,119}$/;

export interface SaveModelInput {
  account: AccountView;
  backend: string;
  name?: string;
  originalName?: string;
  speedOptions?: { label: string; backend: string }[];
  effortOptions?: string[];
}

/** Client-side check matching src/engine/extension.ts saveModel rules. */
export function validateModelInput(input: SaveModelInput): string | undefined {
  if (!allowedModelProviders.has(input.account.provider)) {
    return 'Choose a supported model provider.';
  }
  const backend = input.backend.trim();
  if (!backend) return 'Enter a model ID.';
  if (backend.length > 120) return 'Model ID must be 120 characters or fewer.';
  const name = (input.name?.trim() || backend).trim();
  if (!name || name.length > 80) return 'Display name must be 80 characters or fewer.';
  if (name === reservedModelName) {
    return `"${reservedModelName}" is reserved for the model picker. Choose another name.`;
  }
  if (input.account.provider === 'cursor-acp' && !cursorModelSlug.test(backend)) {
    return 'Cursor model slugs may only use letters, digits and . _ : / @ [ ] = , + -';
  }
  const efforts = input.effortOptions || [];
  if (efforts.length > 10 || efforts.some(item => !/^[a-z][a-z0-9_-]{0,29}$/.test(item)) ||
    new Set(efforts).size !== efforts.length) {
    return 'Enter up to 10 distinct effort values (lowercase letters, digits, _ or -).';
  }
  return undefined;
}

export function saveModel(input: SaveModelInput): void {
  const backend = input.backend.trim();
  const name = (input.name?.trim() || backend).trim();
  const account = input.account.isCursor || input.account.provider === 'cursor-acp'
    ? cursorAccountId
    : input.account.id;
  post({
    type: 'saveModel',
    ...(input.originalName ? { originalName: input.originalName } : {}),
    name,
    provider: input.account.provider,
    backend,
    account,
    speedOptions: input.speedOptions || [],
    effortOptions: input.effortOptions || [],
  });
}

export function removeModel(name: string): void {
  if (!name) return;
  setRemovingModels(current => (current.includes(name) ? current : [...current, name]));
  post({ type: 'removeModel', name });
}

export function loadServerModels(accountId: string): void {
  if (!accountId) return;
  setServerModels(current => ({
    ...current,
    [accountId]: {
      loading: true,
      models: current[accountId]?.models ?? [],
      loaded: current[accountId]?.loaded ?? false,
    },
  }));
  post({ type: 'listProviderModels', accountId });
}

export interface ModelSuggestion {
  value: string;
  label?: string;
}

const staticSuggestions: Record<string, ModelSuggestion[]> = {
  'claude-cli': [
    { value: 'claude-opus-5-5' },
    { value: 'claude-sonnet-5-5' },
    { value: 'claude-haiku-5-5' },
    { value: 'claude-fable-5-2' },
    { value: 'opus', label: 'Latest Opus' },
    { value: 'sonnet', label: 'Latest Sonnet' },
    { value: 'haiku', label: 'Latest Haiku' },
  ],
  anthropic: [
    { value: 'claude-opus-5-5' },
    { value: 'claude-sonnet-5-5' },
    { value: 'claude-haiku-5-5' },
    { value: 'claude-fable-5-2' },
  ],
  'codex-cli': [
    { value: 'gpt-6-sol' },
    { value: 'gpt-6-luna' },
    { value: 'gpt-6-astra' },
    { value: 'gpt-5.6-sol' },
    { value: 'gpt-5.6-terra' },
    { value: 'gpt-5.6-luna' },
    { value: 'gpt-5.5' },
    { value: 'gpt-5.3-codex-spark' },
  ],
  openai: [
    { value: 'gpt-5.5' },
  ],
  'deepseek-official': [
    { value: 'deepseek-v4-flash' },
    { value: 'deepseek-chat' },
    { value: 'deepseek-reasoner' },
  ],
  mistral: [
    { value: 'codestral-latest' },
    { value: 'mistral-large-latest' },
    { value: 'devstral-latest' },
  ],
};

/** Datalist suggestions for the Add model form: Cursor backends, self-hosted server list, or known provider IDs. */
export function modelSuggestions(account: AccountView): ModelSuggestion[] {
  if (account.provider === 'cursor-acp') {
    const entries: ModelSuggestion[] = [
      { value: 'auto', label: 'Auto' },
      ...(viewState.cursorBackends || [])
        .filter(item => item.value !== 'auto')
        .map(item => ({ value: item.value, label: item.name })),
    ];
    const seen = new Set<string>();
    return entries.filter(item => {
      if (seen.has(item.value)) return false;
      seen.add(item.value);
      return true;
    });
  }
  if (account.provider === 'self-hosted') {
    return (serverModels()[account.id]?.models || []).map(value => ({ value }));
  }
  return staticSuggestions[account.provider] || [];
}

export function modelIdPlaceholder(provider: string): string {
  switch (provider) {
    case 'claude-cli':
    case 'anthropic':
      return 'e.g. claude-opus-4-1';
    case 'codex-cli':
    case 'openai':
      return 'e.g. gpt-5.5';
    case 'cursor-acp':
      return 'auto, or a Cursor model slug';
    case 'self-hosted':
      return 'e.g. llama3.3 or model ID';
    case 'deepseek-official':
      return 'e.g. deepseek-v4-flash';
    case 'mistral':
      return 'e.g. codestral-latest';
    case 'openrouter':
      return 'e.g. anthropic/claude-opus-4-1';
    case 'opencode-go':
      return 'An OpenCode Go model ID';
    default:
      return 'Provider model ID';
  }
}

export function renameAccount(accountId: string, label: string): void {
  const trimmed = label.trim();
  if (!trimmed) return;
  setOverrides(current => ({ ...current, labels: { ...current.labels, [accountId]: trimmed } }));
  postProviderRequest({ type: 'renameAccount', accountId, label: trimmed });
}

export function setAccountDefaultModel(accountId: string, modelId: string): void {
  setOverrides(current => ({ ...current, defaults: { ...current.defaults, [accountId]: modelId } }));
  postProviderRequest({ type: 'setAccountDefaultModel', accountId, modelId });
}

export function signIn(account: AccountView): void {
  if (account.isCursor) post({ type: 'cursorLogin' });
  else post({ type: 'reauthAccount', accountId: account.id });
}

export function signOut(account: AccountView): void {
  if (account.isCursor) post({ type: 'cursorLogout' });
  else if (account.authType === 'oauth') postProviderRequest({ type: 'signOutAccount', accountId: account.id });
  else post({ type: 'removeAccount', accountId: account.id });
}

export function removeAccount(account: AccountView): void {
  if (account.isCursor) post({ type: 'cursorLogout' });
  else post({ type: 'removeAccount', accountId: account.id });
}

export function refreshUsage(accountId?: string): void {
  post({ type: 'refreshUsage', ...(accountId ? { accountId } : {}) });
}

/** "Max", "Team", or what billing the account is on when the provider reports no plan. */
export function planName(account: AccountView): string {
  if (account.usage?.plan) return account.usage.plan.name;
  return account.authType === 'oauth' ? 'Subscription' : 'API key';
}

/** The plan's price ("$100/mo"), shown muted after planName ("Max"). */
export function planDetail(account: AccountView): string {
  const plan = account.usage?.plan;
  if (!plan) return account.authType === 'oauth' ? 'Reported by the provider' : 'Billed by the provider';
  if (!plan.monthlyUsd) return 'Free';
  const price = Number.isInteger(plan.monthlyUsd) ? String(plan.monthlyUsd) : plan.monthlyUsd.toFixed(2);
  return `$${price}/mo`;
}

/** "Connected", "Signed out", "Needs attention", "Checkingâ€¦". */
export function accountStateLabel(account: AccountView): string {
  switch (account.status) {
    case 'signedOut':
      return 'Signed out';
    case 'error':
      return 'Needs attention';
    case 'loading':
      return 'Checkingâ€¦';
    default:
      return 'Connected';
  }
}

/** "just now", "1m ago", "3h 20m ago", "2d 4h ago"; '' when there is no timestamp. */
export function usageUpdatedAgo(at: number | undefined): string {
  if (!at) return '';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h ago`;
}

/**
 * Accounts that should report usage but have none. CLI accounts report through their CLI and self-hosted
 * servers usually do not meter at all, so the Usage footer leaves them out (Figma counts only Mistral).
 */
const usageExempt = new Set(['claude-cli', 'codex-cli', 'self-hosted']);

export function accountsWithoutUsage(): AccountView[] {
  return allAccounts().filter(
    account =>
      !usageExempt.has(account.provider) &&
      !(account.usage?.metrics || []).some(metric => typeof metric.usedPercent === 'number'),
  );
}

/** How a new account authenticates. */
export type ProviderMethod = 'oauth' | 'api-key' | 'self-hosted';

export interface AddProviderOption {
  id: string;
  provider: string;
  /** Company name, as the dialog lists it. */
  title: string;
  /** What the row promises on the right. */
  hint: string;
  method: ProviderMethod;
}

/** Figma "24b Â· Providers Â· Add provider", plus Cursor and every API provider the engine's addAccount accepts. */
export const addProviderOptions: AddProviderOption[] = [
  { id: 'anthropic', provider: 'claude-cli', title: 'Anthropic', hint: 'Sign in with Claude', method: 'oauth' },
  { id: 'openai', provider: 'codex-cli', title: 'OpenAI', hint: 'Sign in with ChatGPT', method: 'oauth' },
  { id: 'opencode-go', provider: 'opencode-go', title: 'OpenCode Go', hint: 'API key', method: 'api-key' },
  { id: 'mistral', provider: 'mistral', title: 'Mistral', hint: 'API key', method: 'api-key' },
  { id: 'deepseek', provider: 'deepseek-official', title: 'DeepSeek', hint: 'API key', method: 'api-key' },
  { id: 'openrouter', provider: 'openrouter', title: 'OpenRouter', hint: 'API key', method: 'api-key' },
  { id: 'gemini', provider: 'google-gemini', title: 'Google Gemini', hint: 'API key', method: 'api-key' },
  { id: 'cursor', provider: 'cursor-acp', title: 'Cursor', hint: 'Sign in with Cursor', method: 'oauth' },
  { id: 'self-hosted', provider: 'self-hosted', title: 'Self-hosted', hint: 'Any OpenAI-compatible server', method: 'self-hosted' },
];

export function connectOAuth(option: AddProviderOption): void {
  if (option.provider === 'cursor-acp') {
    post({ type: 'cursorLogin' });
    return;
  }
  post({
    type: 'addOAuthAccount',
    provider: option.provider === 'codex-cli' ? 'codex-cli' : 'claude-cli',
    label: option.provider === 'codex-cli' ? 'ChatGPT account' : 'Claude account',
  });
}

export interface AddProviderFields {
  /** What the account is called in the list; defaults to the provider name. */
  label: string;
  secret?: string;
  baseURL?: string;
}

export function connectWithKey(option: AddProviderOption, fields: AddProviderFields): void {
  const label = fields.label.trim() || providerTitle(option.provider);
  post({ type: 'addAccount', provider: option.provider, label, secret: fields.secret ?? '' });
}

export function connectSelfHosted(option: AddProviderOption, fields: AddProviderFields): void {
  const baseURL = (fields.baseURL ?? '').trim();
  if (!baseURL) return;
  const label = fields.label.trim() || 'Self-hosted';
  post({ type: 'addAccount', provider: option.provider, label, secret: fields.secret ?? '', baseURL });
}

/** Shows the Usage overview and asks the engine to refresh that account's numbers. */
export function openProviderUsage(account?: AccountView): void {
  if (account) postProviderRequest({ type: 'openProviderUsage', accountId: account.id });
  select({ kind: 'usage' });
}
