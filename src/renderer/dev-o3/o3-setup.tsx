/**
 * DEV ONLY preview of the Setup wizard over Home (covered), as the Shell will mount it.
 *
 *   /dev-o3/o3-setup.html?step=welcome|providers|project|tools|extras|done&accounts=none&theme=walnutLight
 *
 * App modules load after the mock bridge is installed (the store reads it at module scope).
 */
import type { ThemeId } from '../theme';
import { accountMessages, mockEmit } from './o3-fixtures';

const projects = [
  { name: 'Website', path: 'C:/Users/ada/Projects/Website' },
  { name: 'Notes', path: 'C:/Users/ada/Documents/Notes' },
  { name: 'Engine', path: 'C:/Users/ada/Projects/Engine' },
  { name: 'Unify', path: 'C:/Users/ada/Projects/Unify' },
];

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const { installMockBridge } = await import('../dev/mockBridge');
  await installMockBridge();

  const [{ render }, { TooltipHost }, store, theme, home, wizard, state, chatsProjects] = await Promise.all([
    import('solid-js/web'),
    import('../components'),
    import('../store'),
    import('../theme'),
    import('../screens/chats/Home'),
    import('../screens/setup/SetupWizard'),
    import('../screens/setup/setupState'),
    import('../screens/chats/projects'),
  ]);
  await import('../shell/shell.css');
  await import('./o3-preview.css');

  theme.installTheme();
  const themeName = params.get('theme');
  if (themeName) theme.setTheme(themeName as ThemeId);

  for (const project of projects) chatsProjects.selectProject(project);
  const step = (params.get('step') ?? 'welcome') as Parameters<typeof state.goToStep>[0];
  // Reach the last step first so every earlier step shows as done in the panel.
  state.goToStep('done');
  state.goToStep(step);

  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');
  render(
    () => (
      <>
        <div class="o3-setup-frame">
          <home.Home covered />
          <wizard.SetupWizard />
        </div>
        <TooltipHost />
      </>
    ),
    root,
  );
  store.connectStore();

  const sendTools = () => {
    const emit = mockEmit();
    emit({
      type: 'toolsState',
      tools: [
        { id: 'git', description: 'Checkpoints, diffs and branches', state: 'found', version: '2.47.1', required: true },
        { id: 'node', description: 'Runs toolpacks and MCP servers', state: 'found', version: '22.11.0', required: true },
        { id: 'claude', description: 'Claude Code CLI, the Anthropic agent runtime', state: 'found', version: '3.2.0', required: true },
        { id: 'codex', description: 'Codex CLI, the OpenAI agent runtime', state: params.get('tools') === 'ok' ? 'found' : 'missing', required: true },
      ],
    });
  };
  window.setTimeout(() => {
    for (const message of accountMessages(params.get('accounts') === 'none')) mockEmit()(message);
    sendTools();
  }, 40);
  // The Tools step asks again on mount; answer like the engine would.
  window.setTimeout(sendTools, 700);
}

void boot();
