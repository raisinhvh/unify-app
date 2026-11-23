/**
 * DEV ONLY: shared fixtures for the O3 previews (Settings and Setup).
 *
 * `writeBootState` must run before the store module loads: the store reads #boot-state once at module scope,
 * which is the only way to seed fields no host message sets yet (viewState.github).
 */
import type { SidebarAccount, SidebarHostMessage, SidebarModel, SidebarViewState } from '../protocol';

const minute = 60_000;

export const previewAccounts: SidebarAccount[] = [
  { id: 'anthropic-work', provider: 'claude-cli', label: 'Work', email: 'ada@unify.dev', isDefault: true, authType: 'oauth' },
  { id: 'codex-team', provider: 'codex-cli', label: 'Team', email: 'team@unify.dev', isDefault: true, authType: 'oauth' },
  { id: 'codex-personal', provider: 'codex-cli', label: 'Personal', email: 'ada@personal.dev', isDefault: false, authType: 'oauth' },
];

const model = (id: string, name: string, provider: string, account: string, enabled = true): SidebarModel => ({
  id,
  name,
  provider,
  account,
  backend: id,
  enabled,
});

export const previewModels: SidebarModel[] = [
  model('opus-5.5', 'Opus 5.5', 'claude-cli', 'anthropic-work'),
  model('sonnet-5.5', 'Sonnet 5.5', 'claude-cli', 'anthropic-work'),
  model('haiku-5.5', 'Haiku 5.5', 'claude-cli', 'anthropic-work'),
  model('gpt-5.1', 'GPT-5.1', 'codex-cli', 'codex-team'),
];

export function writeBootState(state: Partial<SidebarViewState>): void {
  const element = document.createElement('script');
  element.id = 'boot-state';
  element.type = 'application/json';
  element.textContent = JSON.stringify(state);
  document.head.appendChild(element);
}

export function accountMessages(empty = false): SidebarHostMessage[] {
  if (empty) {
    return [
      { type: 'accountsState', accounts: [], cursor: { connected: false, label: 'Not connected' } },
      { type: 'usageState', usage: {} },
      { type: 'modelState', models: [], selectedModelId: undefined },
    ];
  }
  return [
    { type: 'accountsState', accounts: previewAccounts, cursor: { connected: false, label: 'Not connected' } },
    {
      type: 'usageState',
      usage: {
        'anthropic-work': { status: 'ready', fetchedAt: Date.now() - minute, metrics: [] },
        'codex-team': { status: 'ready', fetchedAt: Date.now() - minute, metrics: [] },
        'codex-personal': { status: 'error', fix: 'signin', fetchedAt: Date.now() - minute, metrics: [] },
      },
    },
    { type: 'modelState', models: previewModels, selectedModelId: 'opus-5.5' },
  ];
}

export type MockEmit = (message: SidebarHostMessage | { type: string; [key: string]: unknown }) => void;

export function mockEmit(): MockEmit {
  const mock = (window as unknown as { __unifyMock?: { emit: (message: SidebarHostMessage) => void } }).__unifyMock;
  return message => mock?.emit(message as SidebarHostMessage);
}
