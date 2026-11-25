/**
 * The app root. `startApp` runs after the bridge exists (main.tsx), because persisted state and the store
 * read through the bridge as soon as their modules load.
 */
import { createEffect, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { TooltipHost } from './components';
import { ImageContextMenuHost } from './components/media';
import { setAppReducedMotion } from './motion';
import { Shell } from './shell';
import { post } from './bridge';
import { openChats, poppedOutChats, pruneChats } from './shell/layout';
import { connectStore, viewState } from './store';
import { startNotifySound } from './store/notifySound';
import { installTheme } from './theme';

function App(): JSX.Element {
  // The engine's "Reduce motion" feature joins the OS setting.
  createEffect(() => setAppReducedMotion(!!viewState.features.reduceMotion));

  // Panes whose chat was deleted close themselves. Skipped until the first session list arrives.
  let sessionsSeen = false;
  createEffect(() => {
    const ids = new Set(viewState.sessions.map(session => session.id));
    if (!sessionsSeen && ids.size === 0) return;
    sessionsSeen = true;
    pruneChats(chatId => ids.has(chatId));
  });

  // The engine never auto-prunes chats that are open here (panes or pop-outs). Sent once the engine has
  // answered with its session list, then whenever the open set changes.
  let sentOpenChats = '';
  createEffect(() => {
    if (!viewState.sessions.length) return;
    const chatIds = [...new Set([...openChats(), ...poppedOutChats()])].sort();
    const key = chatIds.join(',');
    if (key === sentOpenChats) return;
    sentOpenChats = key;
    post({ type: 'openChats', chatIds });
  });

  return (
    <>
      <Shell />
      <TooltipHost />
      <ImageContextMenuHost />
    </>
  );
}

export function startApp(root: HTMLElement): void {
  installTheme();
  const disconnect = render(() => <App />, root);
  const stopListening = connectStore();
  const stopNotifySound = startNotifySound();
  import.meta.hot?.dispose(() => {
    stopListening();
    stopNotifySound();
    disconnect();
  });
}
