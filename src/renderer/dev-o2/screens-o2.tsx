/**
 * DEV ONLY preview of the Knowledge, Toolpacks and Hub screens.
 *
 *   /dev-o2/screens-o2.html?screen=knowledge|toolpacks|hub&theme=walnutDark|walnutLight&github=in|out
 *
 * Every app module is imported *after* the mock bridge is installed: the store reads the persisted state
 * at module scope, so a static import would touch `window.unify` before it exists and blank the page.
 * viewState.github has no host message yet, so it is seeded through #boot-state before the store loads.
 */
import type { SidebarHostMessage, SidebarViewState } from '../protocol';
import type { ThemeId } from '../theme';

type PreviewPack = SidebarViewState['toolpacks'][number] & {
  name?: string;
  version?: string;
  source?: 'hub' | 'local';
  syncedDevices?: number;
};

const tool = (name: string, description: string) => ({ name, description });

const packs: PreviewPack[] = [
  {
    id: 'roblox-studio',
    name: 'Roblox Studio',
    description: 'Read and edit the open Roblox Studio place: instances, scripts, properties and playtests.',
    enabled: true,
    state: 'running',
    status: 'Connected to Studio',
    version: '1.4.0',
    source: 'hub',
    syncedDevices: 2,
    logs: ['Listening on 127.0.0.1:44755', 'Studio plugin connected'],
    tools: [
      tool('studio_tree', 'List the instance tree under a path.'),
      tool('studio_properties', 'Read the properties of an instance.'),
      tool('studio_set_property', 'Set a property on an instance.'),
      tool('studio_create_instance', 'Create an instance under a parent.'),
      tool('studio_execute', 'Run Luau in the edit place.'),
      tool('studio_play', 'Start or stop a playtest.'),
      tool('studio_output_log', 'Read the Output window.'),
    ],
  },
  {
    id: 'figma-bridge',
    name: 'Figma',
    description: 'Inspect frames, export images and run plugin code in the open Figma file.',
    enabled: true,
    state: 'running',
    status: 'Connected',
    version: '0.9.2',
    source: 'hub',
    syncedDevices: 1,
    logs: [],
    tools: [
      tool('figma_pages', 'List the pages in the file.'),
      tool('figma_tree', 'Read the node tree of a frame.'),
      tool('figma_export', 'Export a node as PNG or SVG.'),
      tool('figma_execute', 'Run plugin code in the file.'),
    ],
  },
  {
    id: 'imaging',
    name: 'Imaging',
    description: 'Generate and edit images from a prompt.',
    enabled: false,
    state: 'stopped',
    status: 'Off',
    source: 'local',
    logs: [],
    tools: [tool('generate_image', 'Generate an image from a prompt.'), tool('send_media', 'Send an image to the chat.')],
  },
  {
    id: 'blender',
    name: 'Blender',
    description: 'Drive a running Blender session: scenes, objects and renders.',
    enabled: true,
    state: 'error',
    status: 'Not connected',
    error: 'Blender is not running.',
    version: '0.3.1',
    source: 'hub',
    logs: ['Connection refused on 127.0.0.1:9876'],
    tools: [tool('blender_scene', 'Read the current scene.'), tool('blender_render', 'Render the active camera.')],
  },
];

function writeBootState(state: Partial<SidebarViewState>): void {
  const element = document.createElement('script');
  element.id = 'boot-state';
  element.type = 'application/json';
  element.textContent = JSON.stringify(state);
  document.head.appendChild(element);
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const screen = params.get('screen') || 'knowledge';
  const github = params.get('github') || 'in';
  writeBootState({
    github: github === 'in' ? { signedIn: true, login: 'ada-lovelace', source: 'gh' } : { signedIn: false },
  });

  const { installMockBridge } = await import('../dev/mockBridge');
  await installMockBridge();

  const [{ render }, { TooltipHost }, { NavRail }, router, store, theme, knowledge, toolpacks, hub, selection] = await Promise.all([
    import('solid-js/web'),
    import('../components'),
    import('../shell/NavRail'),
    import('../router'),
    import('../store'),
    import('../theme'),
    import('../screens/knowledge/KnowledgeScreen'),
    import('../screens/toolpacks/ToolpacksScreen'),
    import('../screens/hub/HubScreen'),
    import('../screens/toolpacks/selection'),
  ]);
  await import('../shell/shell.css');
  await import('./preview.css');

  theme.installTheme();
  const themeName = params.get('theme');
  if (themeName) theme.setTheme(themeName as ThemeId);
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');

  if (screen === 'hub') {
    selection.setHubCategory('all');
    selection.setOpen('hub', true);
    router.navigate('hub');
  } else if (screen === 'toolpacks') {
    selection.setOpen('installed', true);
    selection.selectPack('roblox-studio');
    router.navigate('toolpacks');
  } else {
    router.navigate('knowledge');
  }

  const active = screen === 'knowledge' ? 'knowledge' : 'toolpacks';
  render(
    () => (
      <>
        <div class="o2-preview-frame">
          <NavRail
            items={router.railRoutes.map(info => ({ ...info, visible: () => true }))}
            active={active}
            onSelect={() => undefined}
            onSettings={() => undefined}
            showMeter
          />
          <div class="o2-preview-slot">
            {screen === 'knowledge' ? <knowledge.KnowledgePanel /> : <toolpacks.ToolpacksPanel />}
          </div>
          <main class="o2-preview-content">
            <section class="o2-preview-card">
              {screen === 'knowledge' ? (
                <knowledge.KnowledgeContent />
              ) : screen === 'hub' ? (
                <hub.HubContent />
              ) : (
                <toolpacks.ToolpacksContent />
              )}
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
    const mock = (window as unknown as { __unifyMock?: { emit: (message: SidebarHostMessage) => void } }).__unifyMock;
    mock?.emit({ type: 'toolpacksState', packs });
  }, 40);
}

void boot();
