/**
 * DEV ONLY entry for preview.html. Installs the mock bridge, then mounts the Files screen in a stand-in frame:
 *
 *   default         rail | FilesPanel in the side-panel slot | FilesEditor in a card  (the recommended Shell wiring)
 *   ?composite=1    rail | FilesScreen inside a .content-screen card                  (what the Shell does today)
 */
async function boot(): Promise<void> {
  const { installMockBridge } = await import('../../dev/mockBridge');
  await installMockBridge();
  const [{ mountPreview }, files] = await Promise.all([import('./previewFrame'), import('./FilesScreen')]);
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');
  mountPreview(root, {
    route: 'files',
    panel: () => <files.FilesPanel />,
    content: () => <files.FilesEditor />,
    composite: () => <files.FilesScreen />,
  });
}

void boot();
