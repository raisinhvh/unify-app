/**
 * Route → screen. The chats route is special (Home + PaneGrid, drawn by the Shell); every other route
 * renders one screen inside the content area. To add or replace a screen, see screens/README.md.
 */
import type { JSX } from 'solid-js';
import type { RouteId } from '../router';
import { StubScreen } from './stubs';

type ScreenRoute = Exclude<RouteId, 'chats'>;

const screens: Record<ScreenRoute, () => JSX.Element> = {
  files: () => <StubScreen route="files" />,
  knowledge: () => <StubScreen route="knowledge" />,
  toolpacks: () => <StubScreen route="toolpacks" />,
  hub: () => <StubScreen route="hub" />,
  providers: () => <StubScreen route="providers" />,
  settings: () => <StubScreen route="settings" />,
  setup: () => <StubScreen route="setup" />,
};

export function screenFor(route: RouteId): JSX.Element {
  if (route === 'chats') return null;
  return screens[route]();
}
