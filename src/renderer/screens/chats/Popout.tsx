/**
 * The whole UI of a pop-out window (`?popout=<chatId>`, see bridge.ts `popoutChatId`).
 *
 *   title bar   the chat's name on a drag strip; the shared TitleBar draws min / max / close (Windows, Linux)
 *               and leaves macOS its traffic lights
 *   card        one ChatPane filling the rest of the window, drawn like a pane on the app background
 *
 * The pane's context is standalone: close() closes this window, it is always focused, and it never drags.
 * When the chat is deleted (`sessionDeleted`, or gone from the session list once that has loaded) the window
 * closes itself.
 *
 * Boot stays inert: `startPopout` posts only `ready` (connectStore). The pop-out never posts selectSession,
 * pageChanged or newSession, which would move the main window's state. The main process sends this window
 * every engine message and ignores its setState.
 */
import { createEffect, onCleanup, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { bridge } from '../../bridge';
import { TitleBar, TooltipHost } from '../../components';
import { setAppReducedMotion } from '../../motion';
import type { PaneContext } from '../../shell/PaneGrid';
import { connectStore, viewState } from '../../store';
import { installTheme } from '../../theme';
import { ChatPane } from './ChatPane';
import './popout.css';

/** The pop-out window frame for one chat. */
export function Popout(props: { chatId: string }): JSX.Element {
  const session = () => viewState.sessions.find(item => item.id === props.chatId);
  const closeWindow = () => bridge().window.close();

  // The engine's "Reduce motion" feature joins the OS setting, as in the main window.
  createEffect(() => setAppReducedMotion(!!viewState.features.reduceMotion));

  // A deleted chat takes its window with it. The list check waits for the first session list to arrive.
  let sessionsSeen = false;
  createEffect(() => {
    const sessions = viewState.sessions;
    if (!sessionsSeen && sessions.length === 0) return;
    sessionsSeen = true;
    if (!sessions.some(item => item.id === props.chatId)) closeWindow();
  });
  const stopListening = bridge().onMessage(message => {
    if (message.type === 'sessionDeleted' && message.sessionId === props.chatId) closeWindow();
  });
  onCleanup(stopListening);

  // A pop-out is not a leaf of the workspace: no leaf key, always focused, never dragged.
  const context: PaneContext = {
    paneId: `popout:${props.chatId}`,
    pane: () => ({ id: `popout:${props.chatId}`, kind: 'chat', chatId: props.chatId }),
    chatId: props.chatId,
    leafKey: () => '',
    focused: () => true,
    dragging: () => false,
    startDrag: () => undefined,
    close: closeWindow,
    standalone: true,
  };

  return (
    <div
      class="popout"
      classList={{ mac: bridge().platform === 'darwin' }}
    >
      {/* A bare drag strip: the pane header right below already names the chat. */}
      <div
        class="popout-titlebar"
        title={session()?.name || 'New chat'}
      />
      <TitleBar />
      <div class="popout-card">
        <ChatPane context={context} />
      </div>
    </div>
  );
}

/** Mounts the pop-out UI for `chatId`. Call after the bridge exists (main.tsx), like App's startApp. */
export function startPopout(root: HTMLElement, chatId: string): void {
  installTheme();
  const disconnect = render(
    () => (
      <>
        <Popout chatId={chatId} />
        <TooltipHost />
      </>
    ),
    root,
  );
  // The chat's pane asks for its history (store requestChatHistory), so the chat is not selected in the engine.
  const stopListening = connectStore();
  import.meta.hot?.dispose(() => {
    stopListening();
    disconnect();
  });
}
