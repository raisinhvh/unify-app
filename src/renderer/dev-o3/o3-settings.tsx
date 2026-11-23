/**
 * DEV ONLY preview of Settings, framed like the Shell (rail | settings nav in the panel slot | content card).
 *
 *   /dev-o3/o3-settings.html?section=power&power=countdown|armed|failed|off&github=in|token|out|error&theme=walnutLight
 *
 * App modules load after the mock bridge and the boot state are in place (the store reads both at module scope).
 */
import type { SidebarViewState } from '../protocol';
import type { ThemeId } from '../theme';
import { accountMessages, mockEmit, previewModels, writeBootState } from './o3-fixtures';

type GitHubState = NonNullable<SidebarViewState['github']>;

const githubStates: Record<string, GitHubState> = {
  in: { signedIn: true, login: 'ada-lovelace', source: 'gh' },
  token: { signedIn: true, login: 'ada-lovelace', source: 'token' },
  out: { signedIn: false },
  error: { signedIn: false, error: 'That token was not accepted. Check it has the repo and read:user scopes.' },
};

const shutdownStates: Record<string, SidebarViewState['shutdown']> = {
  countdown: { armed: true, phase: 'countdown', secondsLeft: 42 },
  armed: { armed: true, phase: 'armed' },
  failed: { armed: false, phase: 'failed' },
  off: { armed: false, phase: 'idle' },
};

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const github = githubStates[params.get('github') ?? 'in'] ?? githubStates.in;
  const power = params.get('power') ?? 'countdown';

  const { defaultViewState } = await import('../store/defaults');
  writeBootState({
    features: { ...defaultViewState().features, smartAuto: true },
    github,
    shutdown: shutdownStates[power],
    models: previewModels,
    deciderModel: { model: 'haiku-5.5' },
    smartAutoRanks: [
      { model: 'opus-5.5', effort: 'high', note: 'Hard problems and reviews' },
      { model: 'sonnet-5.5', note: 'Everyday coding' },
      { model: 'haiku-5.5', note: 'Quick questions' },
    ],
    subagentProfiles: [
      { name: 'explorer', description: 'Finds code and returns exact ranges', model: 'haiku-5.5', mode: 'read-only' },
      { name: 'implementer', model: 'sonnet-5.5', mode: 'edit' },
    ],
    sync: { connected: true, auto: true, account: 'ada-lovelace', repo: 'ada-lovelace/unify-backup', lastSync: Date.now() - 12 * 60_000 },
  });

  const { installMockBridge } = await import('../dev/mockBridge');
  await installMockBridge();
  // The preload's updater: present so "Check for updates" shows.
  const unify = (window as unknown as { unify?: Record<string, unknown> }).unify;
  if (unify && params.get('updates') !== 'none') unify.checkForUpdates = () => undefined;

  const [{ render }, { TooltipHost }, { NavRail }, router, store, theme, settings, features] = await Promise.all([
    import('solid-js/web'),
    import('../components'),
    import('../shell/NavRail'),
    import('../router'),
    import('../store'),
    import('../theme'),
    import('../screens/settings/SettingsScreen'),
    import('../store/features'),
  ]);
  await import('../shell/shell.css');
  await import('./o3-preview.css');

  theme.installTheme();
  const themeName = params.get('theme');
  if (themeName) theme.setTheme(themeName as ThemeId);
  const section = params.get('section');
  if (section) settings.openSettingsSection(section as Parameters<typeof settings.openSettingsSection>[0]);

  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');
  render(
    () => (
      <>
        <div class="o3-frame">
          <NavRail
            items={router.railRoutes.map(info => ({ ...info, visible: () => true }))}
            active="settings"
            settingsActive
            onSelect={() => undefined}
            onSettings={() => undefined}
            showMeter
          />
          <div class="o3-slot">
            <settings.SettingsPanel />
          </div>
          <main class="o3-content">
            <section class="o3-card">
              <settings.SettingsScreen nav={false} />
            </section>
          </main>
        </div>
        <TooltipHost />
      </>
    ),
    root,
  );
  store.connectStore();

  window.setTimeout(() => {
    const emit = mockEmit();
    for (const message of accountMessages()) emit(message);
    features.setFeature('power.shutdownWhenIdle', power !== 'off' && power !== 'failed');
    emit({
      type: 'appInfo',
      info: {
        version: '0.9.0',
        channel: 'beta',
        dataFolder: 'C:/Users/ada/.unify',
        update: { state: 'current', checkedAt: Date.now() - 3 * 60 * 60_000 },
      },
    });
  }, 40);
}

void boot();
