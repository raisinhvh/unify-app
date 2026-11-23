/**
 * DEV ONLY preview of the ModelPicker: closed lines in a composer bar and settings rows, plus one picker to open.
 *
 *   /dev-o5/picker.html?scenario=default|long|many|nosmart|noeffort|search&theme=walnutLight
 *
 * App modules load after the mock bridge is installed (the store reads it at module scope). The preview answers
 * selectModel / selectEffort / selectSpeed itself, so picks update the lines like the engine would.
 */
import type { SidebarAccount, SidebarHostMessage, SidebarModel, SidebarWebviewMessage } from '../protocol';
import type { ThemeId } from '../theme';

interface Scenario {
  models: SidebarModel[];
  accounts: SidebarAccount[];
  selectedModelId: string;
  selectedEffort?: string;
  selectedSpeed?: string;
  smartAuto: boolean;
  recents: string[];
  query?: string;
}

const efforts = ['low', 'medium', 'high', 'xhigh'];
const speeds = [{ label: 'Standard', backend: 'standard' }, { label: 'Fast', backend: 'fast' }];

function model(id: string, name: string, provider: string, account: string, extra: Partial<SidebarModel> = {}): SidebarModel {
  return { id, name, provider, account, backend: id, enabled: true, ...extra };
}

function account(id: string, provider: string, label: string): SidebarAccount {
  return { id, provider, label, isDefault: true, authType: 'oauth' };
}

const baseAccounts = [
  account('anthropic-work', 'claude-cli', 'Work'),
  account('codex-team', 'codex-cli', 'Team'),
  account('codex-personal', 'codex-cli', 'Personal'),
  account('gemini-main', 'gemini', 'Main'),
];

const baseModels = [
  model('opus-5.5', 'Opus 5.5', 'claude-cli', 'anthropic-work', { effortOptions: efforts, speedOptions: speeds }),
  model('sonnet-5.5', 'Sonnet 5.5', 'claude-cli', 'anthropic-work', { effortOptions: ['low', 'medium', 'high'] }),
  model('haiku-5.5', 'Haiku 5.5', 'claude-cli', 'anthropic-work'),
  model('gpt-5.1-team', 'GPT-5.1', 'codex-cli', 'codex-team', { effortOptions: ['low', 'medium', 'high'] }),
  model('gpt-5.1-personal', 'GPT-5.1', 'codex-cli', 'codex-personal', { effortOptions: ['low', 'medium', 'high'] }),
  model('gpt-5.1-mini', 'GPT-5.1 mini', 'codex-cli', 'codex-team'),
  model('gemini-3-pro', 'Gemini 3 Pro', 'gemini', 'gemini-main'),
];

const manyProviders: [string, string][] = [
  ['claude-cli', 'Opus 5.5'],
  ['codex-cli', 'GPT-5.1'],
  ['gemini', 'Gemini 3 Pro'],
  ['mistral', 'Mistral Large 3'],
  ['cursor-acp', 'Cursor Composer'],
  ['opencode-go', 'OpenCode Go'],
  ['self-hosted', 'Qwen3 Coder 480B'],
  ['openrouter', 'DeepSeek V4'],
  ['groq', 'Llama 5 70B'],
  ['xai', 'Grok 5'],
  ['together', 'Kimi K3'],
];

const scenarios: Record<string, () => Scenario> = {
  default: () => ({
    models: baseModels,
    accounts: baseAccounts,
    selectedModelId: 'opus-5.5',
    selectedEffort: 'high',
    selectedSpeed: 'Fast',
    smartAuto: true,
    recents: ['sonnet-5.5', 'gpt-5.1-team', 'gemini-3-pro'],
  }),
  long: () => ({
    models: [
      model('opus-long', 'Claude Opus 5.5 Extended Thinking 1M Context Research Preview', 'claude-cli', 'anthropic-work', {
        effortOptions: efforts,
        speedOptions: speeds,
      }),
      model('gpt-long', 'GPT-5.1 Codex Max High Reasoning Long Horizon Agentic Build', 'codex-cli', 'codex-team'),
      model('gpt-long-personal', 'GPT-5.1 Codex Max High Reasoning Long Horizon Agentic Build', 'codex-cli', 'codex-personal'),
      model('self-long', 'qwen3-coder-480b-a35b-instruct-awq-int4-gguf-q8_0-local', 'self-hosted', 'self-main'),
    ],
    accounts: [...baseAccounts, account('self-main', 'self-hosted', 'Home server with a very long account label')],
    selectedModelId: 'opus-long',
    selectedEffort: 'xhigh',
    selectedSpeed: 'Standard',
    smartAuto: true,
    recents: ['self-long', 'gpt-long'],
  }),
  many: () => ({
    models: manyProviders.flatMap(([provider, name], index) => [
      model(`${provider}-a`, name, provider, `${provider}-account`, index === 0 ? { effortOptions: efforts } : {}),
      model(`${provider}-b`, `${name} Lite`, provider, `${provider}-account`),
    ]),
    accounts: manyProviders.map(([provider]) => account(`${provider}-account`, provider, 'Main')),
    selectedModelId: 'claude-cli-a',
    selectedEffort: 'medium',
    smartAuto: true,
    recents: ['xai-a', 'mistral-a', 'self-hosted-a', 'groq-b', 'gemini-a'],
  }),
  nosmart: () => ({
    models: baseModels,
    accounts: baseAccounts,
    selectedModelId: 'sonnet-5.5',
    selectedEffort: 'medium',
    smartAuto: false,
    recents: [],
  }),
  noeffort: () => ({
    models: baseModels,
    accounts: baseAccounts,
    selectedModelId: 'haiku-5.5',
    smartAuto: true,
    recents: ['opus-5.5'],
  }),
  search: () => ({
    models: baseModels,
    accounts: baseAccounts,
    selectedModelId: 'opus-5.5',
    selectedEffort: 'high',
    smartAuto: true,
    recents: ['sonnet-5.5'],
    query: 'gpt',
  }),
};

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const scenarioName = params.get('scenario') ?? 'default';
  const makeScenario = scenarios[scenarioName];
  if (!makeScenario) throw new Error(`Unknown scenario "${scenarioName}"`);
  const scenario = makeScenario();

  const { installMockBridge } = await import('../dev/mockBridge');
  await installMockBridge();
  const bridgeModule = await import('../bridge');
  // Seed recents before the recents store reads them at module scope.
  bridgeModule.bridge().setState({ ...(bridgeModule.bridge().getState<Record<string, unknown>>() ?? {}), recentModels: scenario.recents });

  const [{ render }, { createSignal }, { TooltipHost, Icon, IconButton, Button }, picker, store, theme] = await Promise.all([
    import('solid-js/web'),
    import('solid-js'),
    import('../components'),
    import('../components/ModelPicker'),
    import('../store'),
    import('../theme'),
  ]);
  await import('./preview.css');

  theme.installTheme();
  const themeName = params.get('theme');
  if (themeName) theme.setTheme(themeName as ThemeId);

  let selected = { modelId: scenario.selectedModelId, effort: scenario.selectedEffort, speed: scenario.selectedSpeed };
  const modelState = (): SidebarHostMessage => ({
    type: 'modelState',
    models: scenario.models,
    selectedModelId: selected.modelId,
    selectedEffort: selected.effort,
    selectedSpeed: selected.speed,
  });

  // Answer the picker's posts like the engine would.
  const base = bridgeModule.bridge();
  bridgeModule.setBridge({
    ...base,
    post: (message: SidebarWebviewMessage) => {
      if (message.type === 'selectModel') selected = { modelId: message.modelId, effort: undefined, speed: undefined };
      else if (message.type === 'selectEffort') selected = { ...selected, effort: message.value };
      else if (message.type === 'selectSpeed') selected = { ...selected, speed: message.value };
      else {
        base.post(message);
        return;
      }
      queueMicrotask(() => store.applyHostMessage(modelState()));
    },
  });

  store.applyHostMessage({ type: 'accountsState', accounts: scenario.accounts, cursor: { connected: false, label: 'Not connected' } });
  store.applyHostMessage(modelState());
  const firstModel = scenario.models[0]?.id;
  store.applyHostMessage({
    type: 'customizeState',
    features: { ...store.viewState.features, smartAuto: scenario.smartAuto },
    deciderModel: { model: firstModel },
    smartAutoRanks: [{ model: firstModel }],
  } as unknown as SidebarHostMessage);

  const [deciderModel, setDeciderModel] = createSignal<string | undefined>(scenario.models[1]?.id);
  const [defaultModel, setDefaultModel] = createSignal<string>('');

  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');
  render(
    () => (
      <>
        <div class="o5-stage">
          <section class="o5-lines">
            <div class="o5-caption type-caption">Composer footer, 380px</div>
            <div class="o5-composer-bar">
              <IconButton icon="paperclip" label="Attach" />
              <picker.ModelPicker chatId="preview" variant="compact" placement="top-start" title="Model" />
              <span class="o5-spacer" />
              <Button variant="primary" icon="arrowUp" aria-label="Send" class="o5-send" />
            </div>
            <div class="o5-caption type-caption">Composer footer, 240px</div>
            <div class="o5-composer-bar o5-narrow">
              <IconButton icon="paperclip" label="Attach" />
              <picker.ModelPicker chatId="preview" variant="compact" placement="top-start" title="Model" />
              <span class="o5-spacer" />
              <Button variant="primary" icon="arrowUp" aria-label="Send" class="o5-send" />
            </div>
            <div class="o5-caption type-caption">Settings row, no Smart Auto, no effort or speed</div>
            <div class="o5-setting-row">
              <span class="o5-setting-label">Decider model</span>
              <picker.ModelPicker
                variant="regular"
                value={deciderModel()}
                onChange={setDeciderModel}
                smartAuto={false}
                placeholder="Choose a model"
                placement="bottom-end"
              />
            </div>
            <div class="o5-caption type-caption">Account default, with a None row</div>
            <div class="o5-setting-row">
              <span class="o5-setting-label">Default model</span>
              <picker.ModelPicker
                variant="regular"
                value={defaultModel()}
                onChange={setDefaultModel}
                smartAuto={false}
                noneLabel="None"
                modelIds={scenario.models.filter(item => item.provider === scenario.models[0]?.provider).map(item => item.id)}
                placement="bottom-end"
              />
            </div>
          </section>
          <section class="o5-open">
            <div class="o5-caption type-caption">
              <Icon name="chevronRight" size={12} />
              Open
            </div>
            <div class="o5-open-anchor">
              <picker.ModelPicker chatId="preview" variant="compact" placement="bottom-start" title="Model" />
            </div>
          </section>
        </div>
        <TooltipHost />
      </>
    ),
    root,
  );

  if (params.get('open') !== '0') {
    window.setTimeout(() => {
      const trigger = document.querySelector<HTMLButtonElement>('.o5-open-anchor .model-picker');
      trigger?.click();
      if (scenario.query) {
        window.setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>('.model-picker-search-input');
          if (!input) return;
          input.value = scenario.query!;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, 120);
      }
    }, 300);
  }
}

void boot();
