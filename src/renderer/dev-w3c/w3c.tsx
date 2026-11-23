/**
 * DEV ONLY: the real app (Shell) on the mock bridge, for the wave-3c Power previews.
 *
 *   /dev-w3c/w3c.html?fixture=home&theme=walnutLight&route=settings     Settings opens on Power
 *   /dev-w3c/w3c.html?fixture=home&route=settings&section=agents         Settings opens on Agents
 *   /dev-w3c/w3c.html?fixture=home&route=chats                          Home; capture.mjs opens the usage popover
 *
 * `__w3cMountArmRow()` appends <ShutdownArmRow /> to the open usage popover, standing in for the hook
 * UsageMeter's owner adds (the popover itself is the real one). `__w3cAgentModels()` turns Smart Auto on and
 * pushes sample ranks and subagent profiles so the Agents model pickers show. Shots drive the rest through
 * `__unifyMock.emit`.
 */
export {};

declare global {
  interface Window {
    __w3cMountArmRow?: () => void;
    __w3cAgentModels?: () => void;
  }
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const { installMockBridge } = await import('../dev/mockBridge');
  await installMockBridge();
  const persist = await import('../persist');
  persist.writePersisted('setupComplete', true);
  persist.writePersisted('route', params.get('route') ?? 'chats');
  persist.writePersisted('settingsSection', params.get('section') ?? 'power');
  const [{ startApp }, { render }, { ShutdownArmRow }, { viewState }] = await Promise.all([
    import('../App'),
    import('solid-js/web'),
    import('../shell/ShutdownArmRow'),
    import('../store'),
  ]);
  window.__w3cMountArmRow = () => {
    const popover = document.querySelector<HTMLElement>('.popover.usage-popover');
    if (!popover) throw new Error('The usage popover is not open');
    render(() => <ShutdownArmRow />, popover);
  };
  window.__w3cAgentModels = () => {
    const emit = (window as unknown as { __unifyMock: { emit(message: unknown): void } }).__unifyMock.emit;
    emit({
      type: 'customizeState',
      features: { ...viewState.features, smartAuto: true },
      deciderModel: { model: 'sonnet-5.5' },
      smartAutoRanks: [
        { model: 'opus-5.5', note: 'Hard refactors and reviews' },
        { model: 'gpt-5.1' },
      ],
    });
    emit({
      type: 'subagentProfilesState',
      profiles: [
        { name: 'explorer', description: 'Reads the codebase and reports back', mode: 'read-only', model: 'sonnet-5.5' },
        { name: 'implementer', mode: 'edit', model: 'opus-5.5' },
      ],
    });
  };
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');
  startApp(root);
}

void boot();
