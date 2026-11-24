/**
 * Toolpack Hub requests, answered from the public GitHub registry (`raisinhvh/unify-hub`) unless the caller
 * passes another `HubRegistry` (tests do, through `context.hubRegistry`).
 *
 * Browsing and installing are open to everyone. `hubPublish` verifies the signed-in GitHub login against the
 * registry's `publishers.json` through `context.getGithubAuth`, lets the user pick and confirm an installed
 * pack through `context.pickOption` / `context.confirm`, and opens a pull request to the Hub. The final
 * toolpack list after an install comes from the extension (`context.refreshToolpacks`) so it matches the real
 * registry.
 */
import * as path from 'node:path';
import { createHubRegistry, HubRegistry, installHubPack } from '../../hub';
import { toolpackIdFor } from '../../hub/ids';
import type { GithubAuth } from '../github';
import { clearInstallError, setInstallError } from '../../toolpacks/sync-state';
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
    if (!id) {
      send({ type: 'hubInstallProgress', id, percent: 100, state: 'error', error: 'Choose a pack first.' });
      send({ type: 'hubInstallResult', ok: false, id, error: 'Choose a pack first.' });
      return true;
    }
    const installed = await installHubPack({
      registry,
      id,
      toolpacksDir: paths.toolpacksDir,
      unifyHome: paths.unifyHome,
      allowScript: message.allowScript === true,
      ...(Array.isArray(message.packages)
        ? { packages: message.packages.filter((item: unknown): item is string => typeof item === 'string') }
        : {}),
      reply: send,
      onInstalled: pack => recordHubInstall(paths, pack),
    });
    let result = installed;
    if (installed.ok) {
      const toolpackId = toolpackIdFor(installed.id);
      try {
        await context.installToolpack?.(path.join(paths.toolpacksDir, toolpackId, 'pack.ts'));
        clearInstallError(paths.toolpacksDir, toolpackId);
      } catch (error) {
        // The files are there but the pack does not load: it stays listed with Install again, and the error is kept.
        const text = error instanceof Error ? error.message : String(error);
        setInstallError(paths.toolpacksDir, toolpackId, text);
        result = { ...installed, ok: false, error: text };
      }
      context.refreshToolpacks?.();
    }
    send({ type: 'hubInstallResult', ...result });
    return true;
  }

  if (message.type === 'hubPublish') {
    let auth: GithubAuth | undefined;
    try {
      auth = context.getGithubAuth ? await context.getGithubAuth() : undefined;
    } catch {
      auth = undefined;
    }
    const result = await registry.publish(auth, {
      toolpacksDir: paths.toolpacksDir,
      pickOption: context.pickOption,
      confirm: context.confirm,
    });
    send({ type: 'hubPublishResult', ...result });
    return true;
  }

  return false;
}
