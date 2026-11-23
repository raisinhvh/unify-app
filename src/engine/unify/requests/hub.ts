/**
 * Toolpack Hub requests. The local fixture registry is the default source; the GitHub registry is opt-in via
 * `createHubRegistry('github')` and never called by tests or by the app unless a caller asks for it.
 *
 * Browsing and installing are open to everyone. `hubPublish` checks the signed-in GitHub login against the
 * registry's `publishers.json` through `context.getGithubAuth`; the final toolpack list after an install comes
 * from the extension (`context.refreshToolpacks`) so it matches the real registry.
 */
import * as path from 'node:path';
import { createHubRegistry, HubInstallTarget, HubRegistry, installHubPack } from '../../hub';
import { toolpackIdFor } from '../../hub/fixtures/packSource';
import type { GithubAuth } from '../github';
import { recordHubInstall } from './toolpacks';
import { RequestPaths } from './state';
import { UnifyRequestContext } from './types';

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
  context: UnifyRequestContext,
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
      send({ type: 'hubInstallResult', ok: false, id, error: 'Choose a pack first.' });
      return true;
    }
    const installed = await installHubPack({
      registry,
      id,
      toolpacksDir: paths.toolpacksDir,
      target,
      allowScript: message.allowScript === true,
      reply: send,
      onInstalled: pack => recordHubInstall(paths, pack, target),
    });
    send({ type: 'hubInstallResult', ...installed });
    if (installed.ok) {
      const sourcePath = path.join(paths.toolpacksDir, toolpackIdFor(installed.id), 'pack.ts');
      await context.installToolpack?.(sourcePath);
      context.refreshToolpacks?.();
    }
    return true;
  }

  if (message.type === 'hubPublish') {
    let auth: GithubAuth | undefined;
    try {
      auth = context.getGithubAuth ? await context.getGithubAuth() : undefined;
    } catch {
      auth = undefined;
    }
    const result = await registry.publish(auth);
    send({ type: 'hubPublishResult', ...result });
    return true;
  }

  return false;
}
