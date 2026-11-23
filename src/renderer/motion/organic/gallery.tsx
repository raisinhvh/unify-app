/**
 * DEV ONLY. Entry of /organic-gallery.html: every organic primitive with trigger buttons.
 *
 * Installs a tiny in-page bridge first (the store reads through the bridge as soon as it loads), which answers
 * `setUnifyFeature` exactly like dev/mockBridge.ts: it keeps the values and echoes them as
 * `unifyFeaturesState`, so the gallery's toggles drive the real motion.organic.* features once the store
 * handles that message. Then loads the gallery app. Not imported by the app; vite only builds index.html.
 */
import { setBridge, type UnifyBridge } from '../../bridge';
import type { SidebarHostMessage, SidebarWebviewMessage } from '../../protocol';

function installGalleryBridge(): void {
  const listeners = new Set<(message: SidebarHostMessage) => void>();
  const features: Record<string, unknown> = {};
  let state: unknown;
  const emitFeatures = () => {
    const message = { type: 'customizeState', features: { ...features } } as unknown as SidebarHostMessage;
    for (const listener of listeners) listener(message);
  };
  const bridge: UnifyBridge = {
    post(message: SidebarWebviewMessage) {
      const raw = message as unknown as { type: string; id?: string; value?: unknown };
      if (raw.type === 'setFeature' && raw.id) {
        features[raw.id] = raw.value;
        queueMicrotask(emitFeatures);
      }
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: <T,>() => state as T | undefined,
    setState: value => {
      state = value;
    },
    platform: 'win32',
    window: { minimize: () => undefined, maximize: () => undefined, close: () => undefined, isMaximized: async () => false },
    pickFolder: async () => undefined,
    openExternal: () => undefined,
  };
  setBridge(bridge);
}

async function boot(): Promise<void> {
  installGalleryBridge();
  const { startGallery } = await import('./galleryApp');
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing from organic-gallery.html');
  startGallery(root);
}

void boot();
