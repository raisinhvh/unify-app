/**
 * Entry point. Sets up the bridge first (the Electron preload's `window.unify`, a VS Code webview API, or the
 * dev mock in a plain browser), then loads and starts the app. The app is imported dynamically because its
 * modules read persisted state through the bridge as soon as they load.
 */
import { hasHostBridge } from './bridge';

async function boot(): Promise<void> {
  if (!hasHostBridge()) {
    const { installMockBridge } = await import('./dev/mockBridge');
    await installMockBridge();
  }
  const { startApp } = await import('./App');
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing from index.html');
  startApp(root);
}

void boot();
