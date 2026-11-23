/**
 * The app frame (Figma 11 Shell 306:2201).
 *
 *   Home (bottom layer, backdrop logo)       always mounted; `inert` while panes or a screen cover it
 *   rail | side panel | content              drawn on top, transparent wherever nothing covers Home
 *
 * The side panel holds the Chats tree. Clicking Chats in the rail while already on chats folds it away
 * (width springs 280 → 0 with the Panel token); the choice is persisted.
 * Content is the tiled PaneGrid on the chats route, or the route's screen (screens/index.ts) otherwise.
 * The PaneGrid stays mounted while another screen is up so chats keep their scroll and drafts.
 */
import { createEffect, createSignal, on, Show, type JSX } from 'solid-js';
import { post } from '../bridge';
import { Rail, TitleBar } from '../components';
import { createSpring } from '../motion';
import { readPersisted, writePersisted } from '../persist';
import { navigate, railRoutes, route } from '../router';
import { ChatPane } from '../screens/chats/ChatPane';
import { ChatsPanel } from '../screens/chats/ChatsPanel';
import { Home } from '../screens/chats/Home';
import { screenFor } from '../screens';
import { setChatVisibilityCheck, viewState } from '../store';
import { isChatOnScreen, layout, openChats } from './layout';
import { PaneGrid } from './PaneGrid';
import './shell.css';

const panelWidth = 280;

export function Shell(): JSX.Element {
  const [panelOpen, setPanelOpenSignal] = createSignal(readPersisted('panelOpen', true));
  const setPanelOpen = (open: boolean) => {
    setPanelOpenSignal(open);
    writePersisted('panelOpen', open);
  };

  const onChats = () => route() === 'chats';
  const showPanel = () => onChats() && panelOpen();
  const slotWidth = createSpring(() => (showPanel() ? panelWidth : 0), 'panel');
  const homeCovered = () => !onChats() || openChats().length > 0;

  // A chat counts as seen only while it is in a pane on the chats route (drives unread "done").
  setChatVisibilityCheck(sessionId => onChats() && isChatOnScreen(sessionId));

  // Focusing a pane makes its chat the engine's active session (composer defaults, model state...).
  createEffect(on(
    () => layout().cells[layout().focused],
    chatId => {
      if (chatId && chatId !== viewState.activeSessionId) post({ type: 'selectSession', sessionId: chatId });
    },
  ));

  const selectRoute = (id: string) => {
    if (id === 'chats' && onChats()) {
      setPanelOpen(!panelOpen());
      return;
    }
    navigate(id as Parameters<typeof navigate>[0]);
  };

  return (
    <div class="app">
      <Home covered={homeCovered()} />
      <div class="app-layers">
        <Rail
          items={railRoutes}
          active={route()}
          onSelect={selectRoute}
          settingsActive={route() === 'settings'}
          onSettings={() => navigate('settings')}
        />
        <div class="side-panel-slot" style={{ width: `${slotWidth()}px` }} inert={!showPanel()}>
          <ChatsPanel />
        </div>
        <main class="content">
          <TitleBar />
          <div class="content-chats" classList={{ hidden: !onChats() }}>
            <PaneGrid
              renderPane={context => <ChatPane context={context} />}
              renderEmpty={() => <div class="pane-empty type-label">Drop a chat here, or pick one from Chats</div>}
            />
          </div>
          <Show when={!onChats()}>
            <section class="content-screen">{screenFor(route())}</section>
          </Show>
        </main>
      </div>
    </div>
  );
}
