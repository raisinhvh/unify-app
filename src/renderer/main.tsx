/**
 * Entry point. Sets up the bridge first (the Electron preload's `window.unify`, a VS Code webview API, or the
 * dev mock in a plain browser), then loads and starts the app. The app is imported dynamically because its
 * modules read persisted state through the bridge as soon as they load. A pop-out window (`?popout=<chatId>`)
 * mounts screens/chats/Popout instead of the Shell.
 */
import { hasHostBridge, popoutChatId } from './bridge';

async function boot(): Promise<void> {
  if (!hasHostBridge()) {
    const { installMockBridge } = await import('./dev/mockBridge');
    await installMockBridge();
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing from index.html');
  // Accessibility scales and flags go on <html> before anything renders, in the main window and pop-outs alike.
  const { applyAccessibility } = await import('./theme/accessibility');
  applyAccessibility();
  // A pop-out window (`?popout=<chatId>`) shows just that chat; it posts only `ready` and never moves main state.
  const chatId = popoutChatId();
  if (chatId) {
    const { startPopout } = await import('./screens/chats/Popout');
    startPopout(root, chatId);
    return;
  }
  const { startApp } = await import('./App');
  startApp(root);
}

void boot();
