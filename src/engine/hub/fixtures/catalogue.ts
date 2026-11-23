/**
 * Local Hub catalogue used by the dev app and by tests.
 *
 * It is a copy of `src/renderer/screens/hub/hubMock.ts` (14 packs, six categories, the same featured three),
 * so the screen looks identical against the real engine. Nothing here contacts the network.
 */
import { HubCategory, HubPack, HubState } from '../types';

const day = 86_400_000;
const now = Date.now();

export const catalogueCategories: HubCategory[] = [
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
    description,
    icon,
    installs,
    tools: Array.from({ length: toolCount }, (_, index) => `${prefix}_${verbs[index % verbs.length]}${index >= verbs.length ? `_${index}` : ''}`),
    version: `1.${(installs % 7) + 1}.${toolCount % 4}`,
    updatedAt: now - ((installs % 9) + 1) * day,
    publishedAt: now - ageDays * day,
    license: installs % 3 ? 'MIT' : 'Apache-2.0',
  };
}

export const cataloguePacks: HubPack[] = [
  pack('roblox-studio', 'Roblox Studio', 'unify', 'studio', 'roblox', 12400, 24, 'Read and edit the open place: explorer, properties, scripts and playtests.', 300),
  pack('figma-bridge', 'Figma bridge', 'unify', 'design', 'figma', 8100, 8, 'Run plugin code, inspect nodes and capture frames from the open file.', 280),
  pack('imaging', 'Imaging', 'unify', 'media', 'imaging', 6700, 17, 'Resize, trim, composite and remove backgrounds without leaving the chat.', 260),
  pack('blender', 'Blender', 'mira.tools', 'studio', 'blender', 4200, 11, 'Build and render scenes, apply modifiers and export assets.', 200),
  pack('unity-editor', 'Unity Editor', 'northbeam', 'studio', 'engine', 3900, 14, 'Inspect scenes, edit prefabs and components, and enter play mode from an agent. Works with Unity 2022.3 and later.', 40),
  pack('postgres', 'Postgres', 'dataloom', 'data', 'database', 3100, 9, 'Query a database, read-only by default.', 90),
  pack('playwright-browser', 'Playwright browser', 'webkitchen', 'web', 'browser', 2800, 12, 'Drive a headless browser: navigate, click, fill forms, take screenshots.', 120),
  pack('linear-issues', 'Linear issues', 'trackside', 'dev', 'issues', 1900, 10, 'Read, create and update issues and cycles in your workspace.', 60),
  pack('audio-tools', 'Audio tools', 'sonar', 'media', 'audio', 1200, 7, 'Trim, normalise and convert audio files; generate waveforms.', 30),
  pack('containers', 'Containers', 'dockyard', 'dev', 'containers', 5200, 16, 'Build, run and inspect containers and read their logs.', 14),
  pack('spreadsheets', 'Spreadsheets', 'gridworks', 'data', 'sheet', 2400, 12, 'Read and edit sheets, formulas and charts in xlsx and csv.', 10),
  pack('screen-recorder', 'Screen recorder', 'sonar', 'media', 'recorder', 1100, 5, 'Record a window or region and hand the clip to an agent.', 6),
  pack('git-helpers', 'Git helpers', 'unify', 'dev', 'git', 3300, 6, 'Blame, bisect and summarise history without leaving the chat.', 240),
  pack('web-search', 'Web search', 'unify', 'web', 'web', 7300, 3, 'Search the web and read pages as clean text.', 310),
];

export const catalogueFeatured = ['containers', 'spreadsheets', 'screen-recorder'];

/** The state the Hub screen shows when it browses the local registry. */
export function catalogueState(): HubState {
  return {
    packs: cataloguePacks,
    categories: catalogueCategories,
    featured: catalogueFeatured,
    authors: 74,
    devices: [
      { id: 'desktop', label: 'Desktop', current: true },
      { id: 'laptop', label: 'Laptop', current: false },
    ],
    fetchedAt: now,
  };
}

export function findCataloguePack(id: string): HubPack | undefined {
  return cataloguePacks.find(pack => pack.id === id);
}

/** A short fixture README for the detail view. */
export function catalogueReadme(pack: HubPack): string {
  return [
    `# ${pack.name}`,
    '',
    pack.description,
    '',
    `Published by ${pack.author} under the ${pack.license} license.`,
    `Version ${pack.version}. Tools: ${pack.tools.join(', ')}.`,
    '',
    'This is the local development catalogue; the real README comes from the Hub registry.',
  ].join('\n');
}
