/**
 * Toolpack Hub requests. The local fixture registry is the default source; the GitHub registry is opt-in via
 * `createHubRegistry('github')` and never called by tests or by the app unless a caller asks for it.
 *
 * `hubPublish` has no engine-side implementation yet: publishing needs authentication, review and an upload
 * path the spec deliberately leaves to the app. It answers with a `hubState` carrying an explanatory `error`.
 */
import { createHubRegistry, HubInstallTarget, HubRegistry, installHubPack } from '../../hub';
import { recordHubInstall } from './toolpacks';
import { RequestPaths } from './state';

const PUBLISH_UNAVAILABLE = 'Publishing is not available yet.';

export interface HubRequestMessage {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

/** Handles `hubBrowse`, `hubInstall` and `hubPublish`; returns false for anything else. */
export async function handleHubRequest(
  message: HubRequestMessage,
  reply: (message: unknown) => void,
  paths: RequestPaths,
  registry: HubRegistry = createHubRegistry(),
): Promise<boolean> {
  const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
  const send = (payload: unknown): void => {
    if (requestId && payload && typeof payload === 'object') reply({ ...(payload as object), requestId });
    else reply(payload);
  };

  if (message.type === 'hubBrowse') {
    const hub = await registry.state();
    send({ type: 'hubState', hub });
    return true;
  }

  if (message.type === 'hubInstall') {
    const id = typeof message.id === 'string' ? message.id : '';
    const target: HubInstallTarget = message.target === 'this' ? 'this' : 'all';
    if (!id) {
      send({ type: 'hubInstallProgress', id, percent: 100, state: 'error', error: 'Choose a pack first.' });
      return true;
    }
    await installHubPack({
      registry,
      id,
      toolpacksDir: paths.toolpacksDir,
      target,
      reply: send,
      onInstalled: pack => recordHubInstall(paths, pack, target),
    });
    return true;
  }

  if (message.type === 'hubPublish') {
    const hub = await registry.state();
    send({ type: 'hubState', hub: { ...hub, error: PUBLISH_UNAVAILABLE } });
    return true;
  }

  return false;
}
