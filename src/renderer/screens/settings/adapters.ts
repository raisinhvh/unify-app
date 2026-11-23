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

/* App info and updates (About). */

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current'; checkedAt: number }
  | { state: 'available'; version: string; notesUrl?: string }
  | { state: 'downloading'; version: string; progress: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

export interface AppInfo {
  version: string;
  channel: 'stable' | 'beta' | 'dev';
  /** Where settings, rules and memory live (shared with DSH), e.g. C:/Users/me/.dsh */
  dataFolder: string;
  update: UpdateStatus;
}

interface AppInfoMessage {
  type: 'appInfo';
  info: AppInfo;
}

const [appInfo, setAppInfo] = createSignal<AppInfo | undefined>();
export { appInfo };

let appInfoRequested = false;

/** Asks the engine for version and update state once; later `appInfo` messages keep it current. */
export function requestAppInfo(): void {
  if (appInfoRequested) return;
  appInfoRequested = true;
  onRequestReply<AppInfoMessage>('appInfo', message => setAppInfo(message.info));
  postRequest({ type: 'getAppInfo' });
}

export function checkForUpdates(): void {
  const current = appInfo();
  if (current) setAppInfo({ ...current, update: { state: 'checking' } });
  postRequest({ type: 'checkForUpdates' });
}

export function installUpdate(): void {
  postRequest({ type: 'installUpdate' });
}
