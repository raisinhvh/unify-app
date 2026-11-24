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
import { createHubRegistry, findHubUpdates, HubRegistry, installHubPack } from '../../hub';
import type { ToolpackAutoUpdated, ToolpackUpdate, ToolpackUpdatesMessage } from '../../hub';
import type { HubInstallResult } from '../../hub/install';
import { toolpackIdFor } from '../../hub/ids';
import type { GithubAuth } from '../github';
import { getUnifyFeature } from '../settings';
import { clearInstallError, setInstallError } from '../../toolpacks/sync-state';
import { installedHubPacks, recordHubInstall } from './toolpacks';
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
    const result = await installAndLoad(registry, paths, context, send, {
      id,
      allowScript: message.allowScript === true,
      ...(Array.isArray(message.packages)
        ? { packages: message.packages.filter((item: unknown): item is string => typeof item === 'string') }
        : {}),
    });
    send({ type: 'hubInstallResult', ...result });
    // The notice row drops the pack once its update is installed.
    if (result.ok) reply(await checkToolpackUpdates(registry, paths, context, reply, { autoUpdate: false }));
    return true;
  }

  if (message.type === 'hubCheckUpdates') {
    send(await checkToolpackUpdates(registry, paths, context, reply, { autoUpdate: message.auto === true }));
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

/** Installs one Hub pack, records it and loads it, as the Hub's Install button does. */
async function installAndLoad(
  registry: HubRegistry,
  paths: RequestPaths,
  context: UnifyRequestContext,
  send: (message: unknown) => void,
  request: { id: string; allowScript?: boolean; packages?: string[]; unattended?: boolean },
): Promise<HubInstallResult> {
  const installed = await installHubPack({
    registry,
    ...request,
    toolpacksDir: paths.toolpacksDir,
    unifyHome: paths.unifyHome,
    consentedScriptHash: installedHubPacks(paths)[request.id]?.scriptHash,
    reply: send,
    onInstalled: pack => recordHubInstall(paths, pack),
  });
  if (!installed.ok) return installed;
  const toolpackId = toolpackIdFor(installed.id);
  let result = installed;
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
  return result;
}

let checkRunning: Promise<ToolpackUpdatesMessage> | undefined;

/**
 * Compares installed Hub packs with the Hub. With `autoUpdate` and the `toolpacks.autoUpdate` feature on, installs
 * every update that needs no consent; the others stay in `updates` with `needsConsent`. Never throws: a Hub that
 * cannot be reached answers with `error` and no updates. Two checks never run at once.
 */
export function checkToolpackUpdates(
  registry: HubRegistry,
  paths: RequestPaths,
  context: UnifyRequestContext,
  reply: (message: unknown) => void,
  options: { autoUpdate: boolean },
): Promise<ToolpackUpdatesMessage> {
  if (checkRunning) return checkRunning;
  checkRunning = (async (): Promise<ToolpackUpdatesMessage> => {
    try {
      const hub = await registry.state();
      if (hub.error && !hub.packs.length) throw new Error(hub.error);
      const found = findHubUpdates(hub.packs, installedHubPacks(paths), paths.toolpacksDir);
      if (!options.autoUpdate || !getUnifyFeature('toolpacks.autoUpdate')) {
        return { type: 'toolpackUpdates', updates: found, checkedAt: Date.now() };
      }
      const updates: ToolpackUpdate[] = [];
      const autoUpdated: ToolpackAutoUpdated[] = [];
      for (const update of found) {
        const result = await installAndLoad(registry, paths, context, reply, { id: update.id, unattended: true });
        if (result.ok) {
          autoUpdated.push({ id: update.id, name: update.name, version: update.toVersion });
        } else if (result.needsScriptConsent) {
          updates.push({ ...update, needsConsent: true, consentReason: 'script' });
        } else if (result.needsDependencyConsent) {
          updates.push({ ...update, needsConsent: true, consentReason: 'programs' });
        } else {
          updates.push(update);
        }
      }
      return {
        type: 'toolpackUpdates',
        updates,
        ...(autoUpdated.length ? { autoUpdated } : {}),
        checkedAt: Date.now(),
      };
    } catch (error) {
      return {
        type: 'toolpackUpdates',
        updates: [],
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();
  const running = checkRunning;
  void running.finally(() => {
    if (checkRunning === running) checkRunning = undefined;
  });
  return running;
}
