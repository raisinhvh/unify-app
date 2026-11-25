/**
 * Typed adapters for engine messages Settings and Setup need but the protocol does not have yet.
 * The exact shapes are in protocol-requests.md. Until the engine implements them, nothing answers and the UI
 * shows its "unknown" state (the dev preview answers them through __unifyMock.emit).
 *
 * Once the engine adds these to SidebarHostMessage / SidebarWebviewMessage, the casts below can go.
 */
import { createSignal } from 'solid-js';
import { post } from '../../bridge';
import { onHostMessage } from '../../store';

/** Posts a message the protocol types do not know yet. */
export function postRequest(message: { type: string; [key: string]: unknown }): void {
  post(message as never);
}

/** Listens for one host message type the protocol types do not know yet. Returns the unsubscribe. */
export function onRequestReply<Message extends { type: string }>(type: Message['type'], handler: (message: Message) => void): () => void {
  return onHostMessage(message => {
    const loose = message as unknown as { type: string };
    if (loose.type === type) handler(loose as Message);
  });
}

/* App info (About). App updates come from the main process instead: screens/updates/updateState.ts. */

export interface AppInfo {
  version: string;
  channel: 'stable' | 'beta' | 'dev';
  /** Where settings, rules and memory live, e.g. C:/Users/me/.unify */
  dataFolder: string;
}

interface AppInfoMessage {
  type: 'appInfo';
  info: AppInfo;
}

const [appInfo, setAppInfo] = createSignal<AppInfo | undefined>();
export { appInfo };

let appInfoRequested = false;

/** Asks the engine for version and data folder once; later `appInfo` messages keep it current. */
export function requestAppInfo(): void {
  if (appInfoRequested) return;
  appInfoRequested = true;
  onRequestReply<AppInfoMessage>('appInfo', message => setAppInfo(message.info));
  postRequest({ type: 'getAppInfo' });
}
