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
 * Content is the pane workspace (PaneGrid, on the chats route) or the route's screen (screens/index.ts) otherwise.
 * The workspace stays mounted while another screen is up so chats keep their scroll and drafts.
 * The layout menu (LayoutMenu) sits in the title strip of the content area, on the chats route only.
 *
 * Rail: Chats, then Files, Terminal and Source Control, which are panes (openPane) rather than routes. An entry is
 * highlighted for the focused pane's kind on the chats route. Files hides with editor.enabled (and closes its pane
 * when turned off). A divider, then Knowledge, Toolpacks, Agents and Providers, which are routes with their own
 * screen; Hub with toolpacks.hub (hubEnabled); the rail usage meter with usage.railMeter. A persisted `files` route
 * opens the Files pane and moves to chats; Knowledge panes from older layouts are closed (it is a screen now).
 * When the route on screen turns unavailable, the Shell goes back to chats.
 * Pop-outs: chats shown in their own window (bridge onPopoutsChanged) close their pane here and never open as
 * panes; opening one focuses its window instead (shell/layout.ts). A pop-out closing changes nothing here.
 *
 * While setup shows, the rail, panel and content fade out on the Modal spring (the title bar stays).
 */
import { createEffect, createSignal, on, onCleanup, Show, type JSX } from 'solid-js';
import { bridge, post } from '../bridge';
import { TitleBar } from '../components';
import { EngineNotice } from '../components/Notice';
import { ShutdownOverlay } from '../components/ShutdownOverlay';
import { createSpring, Presence } from '../motion';
import { readPersisted, writePersisted } from '../persist';
import { navigate, railRoutes, route, type RouteId } from '../router';
import { ChatsPanel, placeChatFromList } from '../screens/chats/ChatsPanel';
import { Home } from '../screens/chats/Home';
import { hubEnabled } from '../screens/hub/hubAdapter';
import { SetupWizard, shouldShowSetup } from '../screens/setup/SetupWizard';
import { updatePending, updateSnapshot } from '../screens/updates/updateState';
import { routeHasScreen, screenFor } from '../screens';
import { setChatVisibilityCheck, viewState } from '../store';
import { feature } from '../store/features';
import { closePane, focusedChatId, focusedPane, isChatOnScreen, openChats, openPane, panes, setPoppedOutChats } from './layout';
import { LayoutMenu } from './LayoutMenu';
import { NavRail, type NavRailItem } from './NavRail';
import { PaneContent, EmptySlot } from './PaneContent';
import { PaneGrid } from './PaneGrid';
import './shell.css';

const panelWidth = 280;

type PaneEntry = 'files' | 'terminal' | 'git';

/** Whether a route may show right now (its feature toggle is on). */
function routeAvailable(id: RouteId): boolean {
  if (id === 'hub') return hubEnabled();
  return true;
}

const isPaneEntry = (id: string): id is PaneEntry => id === 'files' || id === 'terminal' || id === 'git';

const paneEntries: NavRailItem[] = [
  { id: 'files', icon: 'files', label: 'Files', visible: () => feature('editor.enabled') },
  { id: 'terminal', icon: 'terminal', label: 'Terminal', visible: () => true },
  { id: 'git', icon: 'branch', label: 'Source Control', visible: () => true },
];

const [chatsInfo, ...otherRoutes] = railRoutes;
const navItems: NavRailItem[] = [
  { ...chatsInfo, visible: () => routeAvailable(chatsInfo.id) },
  ...paneEntries,
  // The divider separates the pane entries above from the full screens below.
  ...otherRoutes.map((info, index) => ({ ...info, visible: () => routeAvailable(info.id), dividerBefore: index === 0 })),
];

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
  const isMac = () => bridge().platform === 'darwin';
  // Right inset of the layout menu: clear of the window controls and the title-bar indicators (power glyph while
  // shutdown is armed, the no-questions glyph while that feature is on), 32px each.
  const layoutMenuRight = () =>
    (isMac() ? 10 : 128) + (viewState.shutdown?.armed ? 32 : 0) + (feature('agents.noQuestions') ? 32 : 0);

  // A chat counts as seen only while it is in a pane on the chats route (drives unread "done").
  setChatVisibilityCheck(sessionId => onChats() && !showSetup() && isChatOnScreen(sessionId));

  // Focusing a pane makes its chat the engine's active session (composer defaults, model state...).
  createEffect(on(
    () => focusedChatId(),
    chatId => {
      if (chatId && chatId !== viewState.activeSessionId) post({ type: 'selectSession', sessionId: chatId });
    },
  ));

  // Chats in pop-out windows leave the grid; opening one again focuses its window (layout.openChat).
  const stopPopouts = bridge().onPopoutsChanged?.(chatIds => setPoppedOutChats(chatIds));
  if (stopPopouts) onCleanup(stopPopouts);

  // Files used to be a route: a persisted one opens its pane on the chats route instead.
  createEffect(() => {
    if (route() !== 'files') return;
    if (feature('editor.enabled')) openPane('files');
    navigate('chats');
  });

  // Knowledge is a screen now: a Knowledge pane from an older saved layout closes.
  createEffect(() => {
    for (const pane of panes()) {
      if (pane.kind === 'knowledge') closePane(pane.id);
    }
  });

  // Turning the editor off takes its Files pane with it.
  createEffect(() => {
    if (feature('editor.enabled')) return;
    for (const pane of panes()) {
      if (pane.kind === 'files') closePane(pane.id);
    }
  });

  // A toggle that hides the route on screen (or a persisted route that is off) sends the window back to chats.
  createEffect(() => {
    if (!routeAvailable(route())) navigate('chats');
  });

  // The rail entry that is lit: a focused pane's kind on the chats route, else the route itself.
  const activeEntry = (): string => {
    if (!onChats()) return route();
    const kind = focusedPane()?.kind;
    return kind && isPaneEntry(kind) ? kind : route();
  };

  const selectRoute = (id: string) => {
    if (id === 'chats') {
      if (onChats()) setPanelOpen(!panelOpen());
      else navigate('chats');
      return;
    }
    if (isPaneEntry(id)) {
      if (!onChats()) navigate('chats');
      openPane(id);
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
          active={activeEntry()}
          onSelect={selectRoute}
          settingsActive={route() === 'settings'}
          onSettings={() => navigate('settings')}
          showUpdates={updatePending()}
          updateReady={updateSnapshot().status.state === 'ready'}
          updatesActive={route() === 'updates'}
          onUpdates={() => navigate('updates')}
          showMeter={feature('usage.railMeter')}
          inert={showSetup()}
        />
        <div class="side-panel-slot shell-chrome" style={{ width: `${slotWidth()}px` }} inert={!showPanel()}>
          <ChatsPanel />
        </div>
        <main class="content" style={{ '--notice-progress': String(noticeProgress()) }}>
          <TitleBar />
          <Show when={onChats() && !showSetup()}>
            <div class="shell-layout-menu no-drag" style={{ right: `${layoutMenuRight()}px` }}>
              <LayoutMenu />
            </div>
          </Show>
          <EngineNotice onProgress={setNoticeProgress} />
          <div class="content-chats shell-chrome" classList={{ hidden: !onChats() }} inert={showSetup()}>
            <PaneGrid
              renderPane={context => <PaneContent context={context} />}
              renderEmpty={context => <EmptySlot context={context} />}
              onChatDropped={placeChatFromList}
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
