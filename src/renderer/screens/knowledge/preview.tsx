/**
 * DEV ONLY entry for preview.html. Installs the mock bridge, then mounts the Knowledge screen in the shared stand-in
 * frame (../files/previewFrame):
 *
 *   default         rail | KnowledgePanel in the side-panel slot | KnowledgeContent in a card
 *   ?composite=1    rail | KnowledgeScreen inside a .content-screen card
 */
async function boot(): Promise<void> {
  const { installMockBridge } = await import('../../dev/mockBridge');
  await installMockBridge();
  const [{ mountPreview }, knowledge] = await Promise.all([import('../files/previewFrame'), import('./KnowledgeScreen')]);
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');
  mountPreview(root, {
    route: 'knowledge',
    panel: () => <knowledge.KnowledgePanel />,
    content: () => <knowledge.KnowledgeContent />,
    composite: () => <knowledge.KnowledgeScreen />,
  });
}

void boot();

export {};
