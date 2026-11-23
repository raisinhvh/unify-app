/**
 * DEV ONLY preview of the Providers screen.
 *
 *   /screens/providers/preview.html?state=usage|account|add|empty&theme=walnutDark|walnutLight
 *
 * Every app module is imported *after* the mock bridge is installed: the store reads the persisted state
 * at module scope, so a static import would touch `window.unify` before it exists and blank the page.
 */
import type { SidebarAccount, SidebarHostMessage, SidebarModel, SidebarWebviewMessage } from '../../protocol';
import type { ThemeId } from '../../theme';

const minute = 60_000;
const at = (minutes: number): number => Date.now() + minutes * minute;
const seen = (minutes: number): number => Date.now() - minutes * minute;

type Model = SidebarModel;

const model = (
  id: string,
  name: string,
  provider: string,
  account: string,
  contextWindow: number,
  enabled = true,
): Model => ({ id, name, provider, account, backend: id, enabled, contextWindow });

const accounts: SidebarAccount[] = [
  { id: 'anthropic-work', provider: 'claude-cli', label: 'Work', email: 'ada@unify.dev', isDefault: true, authType: 'oauth' },
  { id: 'anthropic-personal', provider: 'claude-cli', label: 'Personal', email: 'ada@personal.dev', isDefault: false, authType: 'oauth' },
  { id: 'codex-team', provider: 'codex-cli', label: 'Team', email: 'team@unify.dev', isDefault: true, authType: 'oauth' },
  { id: 'codex-personal', provider: 'codex-cli', label: 'Personal', email: 'ada@personal.dev', isDefault: false, authType: 'oauth' },
  { id: 'opencode-go', provider: 'opencode-go', label: 'Go', isDefault: true, authType: 'api-key' },
  { id: 'mistral-api', provider: 'mistral', label: 'API key', isDefault: true, authType: 'api-key' },
  { id: 'self-hosted-homelab', provider: 'self-hosted', label: 'homelab', isDefault: true, authType: 'api-key', baseURL: 'http://homelab.local:11434/v1' },
];

const initialModels: Model[] = [
  model('opus-5.5', 'Opus 5.5', 'claude-cli', 'anthropic-work', 1_000_000),
  model('sonnet-5.5', 'Sonnet 5.5', 'claude-cli', 'anthropic-work', 1_000_000),
  model('haiku-5.5', 'Haiku 5.5', 'claude-cli', 'anthropic-work', 200_000),
  model('fable-5.2', 'Fable 5.2', 'claude-cli', 'anthropic-work', 1_000_000, false),
  model('opus-4.6', 'Opus 4.6', 'claude-cli', 'anthropic-work', 1_000_000, false),
  model('sonnet-4.6', 'Sonnet 4.6', 'claude-cli', 'anthropic-work', 1_000_000, false),
  model('gpt-5.1', 'GPT-5.1', 'codex-cli', 'codex-team', 400_000),
  model('gpt-5.1-mini', 'GPT-5.1 mini', 'codex-cli', 'codex-team', 128_000, false),
  model('cursor-composer', 'Composer', 'cursor-acp', 'cursor-login', 200_000),
  model('opencode-air', 'OpenCode Air', 'opencode-go', 'opencode-go', 128_000),
  model('codestral', 'Codestral', 'mistral', 'mistral-api', 256_000),
  model('llama-3.3', 'Llama 3.3 70B', 'self-hosted', 'self-hosted-homelab', 128_000),
  model('qwen2.5-coder:32b', 'Qwen 2.5 Coder 32B', 'self-hosted', 'self-hosted-homelab', 128_000),
];

const cursorBackends = [
  { value: 'auto', name: 'Auto' },
  { value: 'claude-4.5-sonnet', name: 'Claude 4.5 Sonnet' },
  { value: 'gpt-5.5', name: 'GPT-5.5' },
];

function messages(state: string): SidebarHostMessage[] {
  if (state === 'empty') {
    return [
      { type: 'accountsState', accounts: [], cursor: { connected: false, label: 'Not connected' } },
      { type: 'usageState', usage: {} },
      { type: 'modelState', models: [], selectedModelId: undefined },
    ];
  }
  return [
    {
      type: 'accountsState',
      cursor: { connected: true, label: 'Ada Lovelace' },
      accounts,
    },
    {
      type: 'usageState',
      usage: {
        'anthropic-work': {
          status: 'ready',
          fetchedAt: seen(1),
          plan: { name: 'Team', monthlyUsd: 30 },
          metrics: [
            { label: '5-hour', value: '34%', usedPercent: 34, resetsAt: at(185) },
            { label: 'Weekly', value: '21%', usedPercent: 21, resetsAt: at(2880) },
            { label: 'Weekly limit for Opus', value: '12%', usedPercent: 12, resetsAt: at(10080) },
          ],
        },
        'anthropic-personal': {
          status: 'ready',
          fetchedAt: seen(2),
          plan: { name: 'Max 5x', monthlyUsd: 100 },
          metrics: [
            { label: '5-hour', value: '42%', usedPercent: 42, resetsAt: at(95) },
            { label: 'Weekly', value: '26%', usedPercent: 26, resetsAt: at(5000) },
          ],
        },
        'codex-team': {
          status: 'ready',
          fetchedAt: seen(4),
          plan: { name: 'Business', monthlyUsd: 30 },
          metrics: [
            { label: '5-hour', value: '22%', usedPercent: 22, resetsAt: at(140) },
            { label: 'Weekly', value: '11%', usedPercent: 11, resetsAt: at(6000) },
          ],
        },
        'codex-personal': {
          status: 'error',
          fix: 'signin',
          fetchedAt: seen(3),
          metrics: [],
        },
        'cursor-login': {
          status: 'ready',
          fetchedAt: seen(1),
          plan: { name: 'Pro', monthlyUsd: 20 },
          metrics: [{ label: '5-hour', value: '9%', usedPercent: 9, resetsAt: at(45) }],
        },
        'opencode-go': {
          status: 'ready',
          fetchedAt: seen(6),
          plan: { name: 'Go', monthlyUsd: 10 },
          metrics: [{ label: '5-hour', value: '30%', usedPercent: 30, resetsAt: at(240) }],
        },
      },
    },
    {
      type: 'modelState',
      selectedModelId: 'opus-5.5',
      selectedEffort: 'high',
      cursorBackends,
      models: initialModels,
    },
  ];
}

async function boot(): Promise<void> {
  const { installMockBridge } = await import('../../dev/mockBridge');
  await installMockBridge();

  const [{ bridge, setBridge }, { render }, { TooltipHost }, { NavRail }, router, store, theme, screens, dialog, selection] = await Promise.all([
    import('../../bridge'),
    import('solid-js/web'),
    import('../../components'),
    import('../../shell/NavRail'),
    import('../../router'),
    import('../../store'),
    import('../../theme'),
    import('./ProvidersScreen'),
    import('./AddProviderDialog'),
    import('./selection'),
  ]);
  await import('../../shell/shell.css');
  await import('./preview.css');

  const baseBridge = bridge();
  let previewModels = [...initialModels];
  const emit = (message: SidebarHostMessage) => {
    const mock = (window as unknown as { __unifyMock?: { emit: (msg: SidebarHostMessage) => void } }).__unifyMock;
    mock?.emit(message);
  };
  setBridge({
    ...baseBridge,
    post: (message: SidebarWebviewMessage) => {
      if (message.type === 'saveModel') {
        window.setTimeout(() => {
          const entry: Model = {
            id: message.name,
            name: message.name,
            provider: message.provider,
            backend: message.backend,
            account: message.account,
            enabled: true,
          };
          previewModels = previewModels.filter(item => item.name !== (message.originalName || message.name)).concat(entry);
          emit({ type: 'modelState', selectedModelId: previewModels[0]?.id, cursorBackends, models: previewModels });
          emit({ type: 'modelSaved' });
        }, 120);
        return;
      }
      if (message.type === 'removeModel') {
        previewModels = previewModels.filter(item => item.name !== message.name && item.id !== message.name);
        emit({ type: 'modelState', selectedModelId: previewModels[0]?.id, cursorBackends, models: previewModels });
        return;
      }
      if (message.type === 'listProviderModels') {
        window.setTimeout(() => {
          emit({
            type: 'providerModels',
            accountId: message.accountId,
            models: ['llama3.3:70b', 'qwen2.5-coder:32b', 'deepseek-r1:32b'],
          });
        }, 150);
        return;
      }
      baseBridge.post(message);
    },
  });

  theme.installTheme();
  const params = new URLSearchParams(location.search);
  const themeName = params.get('theme');
  if (themeName) theme.setTheme(themeName as ThemeId);
  const state = params.get('state') || 'usage';
  const accountId = params.get('account') || 'anthropic-work';
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');

  render(
    () => (
      <>
        <div class="pv-preview-frame">
          <NavRail
            items={router.railRoutes.map(info => ({ ...info, visible: () => true }))}
            active="providers"
            onSelect={() => undefined}
            onSettings={() => undefined}
            showMeter
          />
          <div class="pv-preview-slot">
            <screens.ProvidersPanel />
          </div>
          <main class="pv-preview-content">
            <section class="pv-preview-card">
              <screens.ProvidersContent />
            </section>
          </main>
        </div>
        <dialog.AddProviderDialog />
        <TooltipHost />
      </>
    ),
    root,
  );
  store.connectStore();

  window.setTimeout(() => {
    for (const message of messages(state)) emit(message);
    selection.select(state === 'account' ? { kind: 'account', id: accountId } : { kind: 'usage' });
    selection.setAddProviderOpen(state === 'add');
    const expand = params.get('add');
    if (expand) {
      window.setTimeout(() => {
        const rows = [...document.querySelectorAll<HTMLButtonElement>('.provider-add-row, .pv-add-row')];
        rows.find(row => row.textContent?.includes(expand))?.click();
      }, 300);
    }
    if (params.get('addModel') === '1') {
      window.setTimeout(() => {
        document.querySelector<HTMLButtonElement>('.pv-add-model-trigger, .pv-models-empty-action')?.click();
      }, 240);
    }
  }, 40);
}

void boot();
