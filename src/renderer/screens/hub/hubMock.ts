/**
 * DEV ONLY. Answers Hub requests with a fake catalogue and a fake download until the engine implements them
 * (hubAdapter.ts imports this only under import.meta.env.DEV). Never contacts GitHub; publish only logs.
 */
import type { SidebarHostMessage } from '../../protocol';
import { viewState } from '../../store';
import type { HubCategory, HubInstallProgress, HubPack, HubReply, HubRequest, HubState } from './hubAdapter';

const day = 86_400_000;
const now = Date.now();

const categories: HubCategory[] = [
  { id: 'studio', label: 'Studio & 3D' },
  { id: 'design', label: 'Design' },
  { id: 'media', label: 'Media' },
  { id: 'dev', label: 'Dev tools' },
  { id: 'web', label: 'Web' },
  { id: 'data', label: 'Data' },
];

function pack(
  id: string,
  name: string,
  author: string,
  category: string,
  icon: string,
  installs: number,
  toolCount: number,
  description: string,
  ageDays: number,
): HubPack {
  const prefix = id.split('-')[0];
  const verbs = ['tree', 'inspect', 'set_property', 'prefab_edit', 'play', 'find', 'export', 'import', 'list', 'run', 'query', 'open', 'close', 'capture', 'search', 'select'];
  return {
    id,
    name,
    author,
    category,
    icon,
    installs,
    tools: Array.from({ length: toolCount }, (_, index) => `${prefix}_${verbs[index % verbs.length]}${index >= verbs.length ? `_${index}` : ''}`),
    version: `1.${(installs % 7) + 1}.${toolCount % 4}`,
    updatedAt: now - ((installs % 9) + 1) * day,
    publishedAt: now - ageDays * day,
    license: installs % 3 ? 'MIT' : 'Apache-2.0',
  };
}

const packs: HubPack[] = [
  pack('roblox-studio', 'Roblox Studio', 'dsh', 'studio', 'roblox', 12400, 24, 'Read and edit the open place: explorer, properties, scripts and playtests.', 300),
  pack('figma-bridge', 'Figma bridge', 'dsh', 'design', 'figma', 8100, 8, 'Run plugin code, inspect nodes and capture frames from the open file.', 280),
  pack('imaging', 'Imaging', 'dsh', 'media', 'imaging', 6700, 17, 'Resize, trim, composite and remove backgrounds without leaving the chat.', 260),
  pack('blender', 'Blender', 'mira.tools', 'studio', 'blender', 4200, 11, 'Build and render scenes, apply modifiers and export assets.', 200),
  pack('unity-editor', 'Unity Editor', 'northbeam', 'studio', 'engine', 3900, 14, 'Inspect scenes, edit prefabs and components, and enter play mode from an agent. Works with Unity 2022.3 and later.', 40),
  pack('postgres', 'Postgres', 'dataloom', 'data', 'database', 3100, 9, 'Query a database, read-only by default.', 90),
  pack('playwright-browser', 'Playwright browser', 'webkitchen', 'web', 'browser', 2800, 12, 'Drive a headless browser: navigate, click, fill forms, take screenshots.', 120),
  pack('linear-issues', 'Linear issues', 'trackside', 'dev', 'issues', 1900, 10, 'Read, create and update issues and cycles in your workspace.', 60),
  pack('audio-tools', 'Audio tools', 'sonar', 'media', 'audio', 1200, 7, 'Trim, normalise and convert audio files; generate waveforms.', 30),
  pack('containers', 'Containers', 'dockyard', 'dev', 'containers', 5200, 16, 'Build, run and inspect containers and read their logs.', 14),
  pack('spreadsheets', 'Spreadsheets', 'gridworks', 'data', 'sheet', 2400, 12, 'Read and edit sheets, formulas and charts in xlsx and csv.', 10),
  pack('screen-recorder', 'Screen recorder', 'sonar', 'media', 'recorder', 1100, 5, 'Record a window or region and hand the clip to an agent.', 6),
  pack('git-helpers', 'Git helpers', 'dsh', 'dev', 'git', 3300, 6, 'Blame, bisect and summarise history without leaving the chat.', 240),
  pack('web-search', 'Web search', 'dsh', 'web', 'web', 7300, 3, 'Search the web and read pages as clean text.', 310),
];

const state: HubState = {
  packs,
  categories,
  featured: ['containers', 'spreadsheets', 'screen-recorder'],
  authors: 74,
  devices: [
    { id: 'desktop', label: 'Desktop', current: true },
    { id: 'laptop', label: 'Laptop', current: false },
  ],
  fetchedAt: now,
};

const running = new Map<string, number>();

/** Tells the store the pack is installed, the way the engine's toolpacksState would. */
function announceInstalled(id: string): void {
  const hubPack = packs.find(item => item.id === id);
  const mock = (window as unknown as { __unifyMock?: { emit: (message: SidebarHostMessage) => void } }).__unifyMock;
  if (!hubPack || !mock) return;
  const installed = {
    id,
    name: hubPack.name,
    icon: hubPack.icon,
    version: hubPack.version,
    source: 'hub',
    syncedDevices: 2,
    description: hubPack.description,
    enabled: true,
    state: 'running',
    status: 'Running',
    tools: hubPack.tools.map(name => ({ name, description: '' })),
    logs: [],
  };
  mock.emit({ type: 'toolpacksState', packs: [...viewState.toolpacks, installed] } as unknown as SidebarHostMessage);
}

export function answer(request: HubRequest, reply: (message: HubReply) => void): void {
  switch (request.type) {
    case 'hubBrowse':
      window.setTimeout(() => reply({ type: 'hubState', hub: state }), 120);
      break;
    case 'hubInstall': {
      if (running.has(request.id)) return;
      let percent = 0;
      const timer = window.setInterval(() => {
        percent = Math.min(100, percent + 7 + Math.random() * 9);
        const progress: HubInstallProgress = {
          id: request.id,
          percent: Math.round(percent),
          state: percent >= 100 ? 'done' : percent > 80 ? 'installing' : 'downloading',
        };
        reply({ type: 'hubInstallProgress', ...progress });
        if (percent >= 100) {
          window.clearInterval(timer);
          running.delete(request.id);
          announceInstalled(request.id);
        }
      }, 400);
      running.set(request.id, timer);
      break;
    }
    case 'hubPublish':
      console.info('[hub mock] publish requested; nothing is uploaded in dev');
      break;
  }
}
