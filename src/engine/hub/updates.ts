/**
 * Finds installed Hub packs that have a newer version on the Hub.
 *
 * A pack has an update when the Hub's `updatedAt` is newer than the one recorded at install (older records only
 * have `installedAt`) or when the version differs. Packs whose folder was deleted by hand are skipped. The request
 * handler (`unify/requests/hub.ts`, `hubCheckUpdates`) posts the result as `toolpackUpdates` and, with the
 * `toolpacks.autoUpdate` feature on, installs the ones that need no consent.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { toolpackIdFor } from './ids';
import type { HubPack, ToolpackUpdate } from './types';
import type { InstalledHubPack } from '../unify/requests/toolpacks';

function folderFor(toolpacksDir: string, hubId: string): string | undefined {
  try {
    return path.join(toolpacksDir, toolpackIdFor(hubId));
  } catch {
    return undefined;
  }
}

/** Every installed Hub pack with a newer Hub version, sorted by name. */
export function findHubUpdates(
  hubPacks: HubPack[],
  installed: Record<string, InstalledHubPack>,
  toolpacksDir: string,
): ToolpackUpdate[] {
  const updates: ToolpackUpdate[] = [];
  for (const hubPack of hubPacks) {
    const record = installed[hubPack.id];
    if (!record) continue;
    const folder = folderFor(toolpacksDir, hubPack.id);
    if (!folder || !existsSync(folder)) continue;
    const installedUpdatedAt = record.updatedAt ?? record.installedAt;
    const newer = hubPack.updatedAt > installedUpdatedAt;
    if (!newer && hubPack.version === record.version) continue;
    const installedTools = new Set(record.tools ?? []);
    const hubTools = new Set(hubPack.tools ?? []);
    updates.push({
      id: hubPack.id,
      name: hubPack.name,
      ...(hubPack.icon ? { icon: hubPack.icon } : {}),
      fromVersion: record.version,
      toVersion: hubPack.version,
      installedUpdatedAt,
      updatedAt: hubPack.updatedAt,
      addedTools: [...hubTools].filter(tool => !installedTools.has(tool)),
      removedTools: [...installedTools].filter(tool => !hubTools.has(tool)),
    });
  }
  return updates.sort((first, second) => first.name.localeCompare(second.name));
}
