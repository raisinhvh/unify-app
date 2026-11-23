/**
 * The app frame (Figma 11 Shell 306:2201).
 *
 *   Home (bottom layer, backdrop logo)       always mounted; `inert` while panes, a screen or setup cover it
 *   setup wizard                             over Home while setup is needed (or the setup route is open)
 *   rail | side panel | content              drawn on top, transparent wherever nothing covers Home
 *   shutdown countdown                       over everything but the title bar
 *
 * The side panel holds the Chats tree. Clicking Chats in the rail while already on chats folds it away
 * (width springs 280 → 0 with the Panel token); the choice is persisted.
 * Content is the tiled PaneGrid on the chats route, or the route's screen (screens/index.ts) otherwise.
 * The PaneGrid stays mounted while another screen is up so chats keep their scroll and drafts.
 *
 * Feature toggles: Files hides with editor.enabled, Hub with toolpacks.hub (hubEnabled), the rail usage meter
 * with usage.railMeter. When the route on screen turns unavailable, the Shell goes back to chats.
 * While setup shows, the rail, panel and content fade out on the Modal spring (the title bar stays).
 */
import { createEffect, createSignal, on, Show, type JSX } from 'solid-js';
import { post } from '../bridge';
import { TitleBar } from '../components';
import { EngineNotice } from '../components/Notice';
import { ShutdownOverlay } from '../components/ShutdownOverlay';
import { createSpring, Presence } from '../motion';
import { readPersisted, writePersisted } from '../persist';
import { navigate, railRoutes, route, type RouteId } from '../router';
import { ChatPane } from '../screens/chats/ChatPane';
import { ChatsPanel } from '../screens/chats/ChatsPanel';
import { Home } from '../screens/chats/Home';
import { hubEnabled } from '../screens/hub/hubAdapter';
import { SetupWizard, shouldShowSetup } from '../screens/setup/SetupWizard';
import { routeHasScreen, screenFor } from '../screens';
import { setChatVisibilityCheck, viewState } from '../store';
import { feature } from '../store/features';
import { isChatOnScreen, layout, openChats } from './layout';
import { NavRail, type NavRailItem } from './NavRail';
import { PaneGrid } from './PaneGrid';
import './shell.css';

const panelWidth = 280;

/** Whether a route may show right now (its feature toggle is on). */
function routeAvailable(id: RouteId): boolean {
  if (id === 'files') return feature('editor.enabled');
  if (id === 'hub') return hubEnabled();
  return true;
}

const navItems: NavRailItem[] = railRoutes.map(info => ({
  ...info,
  visible: () => routeAvailable(info.id),
}));

export function Shell(): JSX.Element {
  const [panelOpen, setPanelOpenSignal] = createSignal(readPersisted('panelOpen', true));
  const setPanelOpen = (open: boolean) => {
    setPanelOpenSignal(open);
    writePersisted('panelOpen', open);
  };

  const onChats = () => route() === 'chats';
  const showSetup = () => shouldShowSetup() || route() === 'setup';
  const showPanel = () => onChats() && panelOpen() && !showSetup();
  const slotWidth = createSpring(() => (showPanel() ? panelWidth : 0), 'panel');
  const homeCovered = () => showSetup() || !onChats() || openChats().length > 0;
  // The app chrome fades away under the setup wizard; the title bar (window controls) stays.
  const chromeOpacity = createSpring(() => (showSetup() ? 0 : 1), 'modal', { fadeOnly: true });
  // 0..1 while the notice row opens; the pane grid and screens move down with it.
  const [noticeProgress, setNoticeProgress] = createSignal(0);

  // A chat counts as seen only while it is in a pane on the chats route (drives unread "done").
  setChatVisibilityCheck(sessionId => onChats() && !showSetup() && isChatOnScreen(sessionId));

  // Focusing a pane makes its chat the engine's active session (composer defaults, model state...).
  createEffect(on(
    () => layout().cells[layout().focused],
    chatId => {
      if (chatId && chatId !== viewState.activeSessionId) post({ type: 'selectSession', sessionId: chatId });
    },
  ));

  // A toggle that hides the route on screen (or a persisted route that is off) sends the window back to chats.
  createEffect(() => {
    if (!routeAvailable(route())) navigate('chats');
  });

  const selectRoute = (id: string) => {
    if (id === 'chats' && onChats()) {
      setPanelOpen(!panelOpen());
      return;
    }
    navigate(id as RouteId);
  };

  return (
    <div class="app" style={{ '--shell-chrome': String(Math.max(0, Math.min(1, chromeOpacity()))) }}>
      <Home covered={homeCovered()} />
      <Presence when={showSetup()} from={1} enter="modal" exit="panel">
        <div class="shell-setup">
          <SetupWizard />
        </div>
      </Presence>
      <div class="app-layers">
        <NavRail
          items={navItems}
          active={route()}
          onSelect={selectRoute}
          settingsActive={route() === 'settings'}
          onSettings={() => navigate('settings')}
          showMeter={feature('usage.railMeter')}
          inert={showSetup()}
        />
        <div class="side-panel-slot shell-chrome" style={{ width: `${slotWidth()}px` }} inert={!showPanel()}>
          <ChatsPanel />
        </div>
        <main class="content" style={{ '--notice-progress': String(noticeProgress()) }}>
          <TitleBar />
          <EngineNotice onProgress={setNoticeProgress} />
          <div class="content-chats shell-chrome" classList={{ hidden: !onChats() }} inert={showSetup()}>
            <PaneGrid
              renderPane={context => <ChatPane context={context} />}
              renderEmpty={() => <div class="pane-empty type-label">Drop a chat here, or pick one from Chats</div>}
            />
          </div>
          <Show when={routeHasScreen(route())}>
            <section class="content-screen shell-chrome" inert={showSetup()}>{screenFor(route())}</section>
          </Show>
        </main>
      </div>
      <ShutdownOverlay />
    </div>
  );
}
