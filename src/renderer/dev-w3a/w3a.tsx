/**
 * DEV ONLY: the real app (Shell) on the mock bridge, for the wave-3a shell wiring previews.
 *
 *   /dev-w3a/w3a.html?fixture=home&theme=walnutLight            setup marked complete, so the Shell shows
 *   /dev-w3a/w3a.html?fixture=home&setup=open                   setup left incomplete: the wizard covers Home
 *
 * Shots drive the rest through `__unifyMock.emit({...})` (feature toggles, shutdown messages); see capture.mjs.
 */
export {};

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const { installMockBridge } = await import('../dev/mockBridge');
  await installMockBridge();
  const persist = await import('../persist');
  persist.writePersisted('setupComplete', params.get('setup') !== 'open');
  const { startApp } = await import('../App');
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');
  startApp(root);
}

void boot();
