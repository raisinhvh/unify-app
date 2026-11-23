/**
 * Top-level routes. One signal, persisted per window.
 *
 *   chats      Home underneath + the tiled chat panes (the Chats side panel is open)
 *   files, knowledge, toolpacks, agents, providers   rail items with their own screen
 *   hub        reached from Toolpacks (no rail item, as in Figma)
 *   settings   the gear at the bottom of the rail
 *   setup      first-run flow (full window, no rail)
 *
 * Add a screen: see screens/README.md.
 */
import { createSignal } from 'solid-js';
import type { IconName } from './components';
import { readPersisted, writePersisted } from './persist';

export type RouteId = 'chats' | 'files' | 'knowledge' | 'toolpacks' | 'hub' | 'agents' | 'providers' | 'settings' | 'setup';

const routeIds: RouteId[] = ['chats', 'files', 'knowledge', 'toolpacks', 'hub', 'agents', 'providers', 'settings', 'setup'];

export interface RouteInfo {
  id: RouteId;
  label: string;
  icon: IconName;
}

/** Rail order matches Figma Rail 306:785. */
export const railRoutes: RouteInfo[] = [
  { id: 'chats', label: 'Chats', icon: 'chats' },
  { id: 'files', label: 'Files', icon: 'files' },
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
