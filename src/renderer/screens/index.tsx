/**
 * Route → screen. The chats route is special (Home + PaneGrid, drawn by the Shell); every other route
 * renders one screen inside the content area. Setup is drawn by the Shell too (full window over Home), so
 * its entry is empty. To add or replace a screen, see screens/README.md.
 */
import type { JSX } from 'solid-js';
import type { RouteId } from '../router';
import { FilesScreen } from './files/FilesScreen';
import { HubScreen } from './hub/HubScreen';
import { KnowledgeScreen } from './knowledge/KnowledgeScreen';
import { ProvidersScreen } from './providers/ProvidersScreen';
import { SettingsScreen } from './settings/SettingsScreen';
import { ToolpacksScreen } from './toolpacks/ToolpacksScreen';

type ScreenRoute = Exclude<RouteId, 'chats'>;

const screens: Record<ScreenRoute, () => JSX.Element> = {
  files: () => <FilesScreen />,
  knowledge: () => <KnowledgeScreen />,
  toolpacks: () => <ToolpacksScreen />,
  hub: () => <HubScreen />,
  providers: () => <ProvidersScreen />,
  settings: () => <SettingsScreen />,
  setup: () => null,
};

/** Routes the Shell draws itself, so they get no content card. */
export function routeHasScreen(route: RouteId): boolean {
  return route !== 'chats' && route !== 'setup';
}

export function screenFor(route: RouteId): JSX.Element {
  if (!routeHasScreen(route)) return null;
  return screens[route as ScreenRoute]();
}
