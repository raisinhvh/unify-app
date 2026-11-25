/**
 * Top-level routes. One signal, persisted per window.
 *
 *   chats      Home underneath + the tiled workspace (chats, Files, Terminal, Source Control and image panes;
 *              the Shell draws the rail entries for the panes, see shell/Shell.tsx)
 *   knowledge, toolpacks, agents, providers   rail items with their own screen
 *   files      no longer a route: kept in the union so a persisted route can be read; the Shell opens
 *              the Files pane and moves to chats (shell/Shell.tsx)
 *   hub        reached from Toolpacks (no rail item, as in Figma)
 *   settings   the gear at the bottom of the rail
 *   updates    app updates: the rail's Updates button (shown while an update is downloading or ready),
 *              Settings > About, and the "update ready" notification
 *   setup      first-run flow (full window, no rail)
 *
 * Add a screen: see screens/README.md.
 */
import { createSignal } from 'solid-js';
import type { IconName } from './components';
import { readPersisted, writePersisted } from './persist';

export type RouteId = 'chats' | 'files' | 'knowledge' | 'toolpacks' | 'hub' | 'agents' | 'providers' | 'settings' | 'updates' | 'setup';

const routeIds: RouteId[] = ['chats', 'files', 'knowledge', 'toolpacks', 'hub', 'agents', 'providers', 'settings', 'updates', 'setup'];

export interface RouteInfo {
  id: RouteId;
  label: string;
  icon: IconName;
}

/**
 * Rail order matches Figma Rail 306:785. Files, Terminal and Source Control are pane entries built in the Shell
 * (they sit between Chats and Knowledge there, with a divider before the screens).
 */
export const railRoutes: RouteInfo[] = [
  { id: 'chats', label: 'Chats', icon: 'chats' },
  { id: 'knowledge', label: 'Knowledge', icon: 'knowledge' },
  { id: 'toolpacks', label: 'Toolpacks', icon: 'toolpacks' },
  { id: 'agents', label: 'Agents', icon: 'bot' },
  { id: 'providers', label: 'Providers', icon: 'providers' },
];

function validRoute(value: unknown): RouteId {
  return routeIds.includes(value as RouteId) ? (value as RouteId) : 'chats';
}

const [route, setRouteSignal] = createSignal<RouteId>(validRoute(readPersisted('route', 'chats')));

export { route };

export function navigate(next: RouteId): void {
  setRouteSignal(next);
  writePersisted('route', next);
}
