/** Small pure helpers of the extension host. */
import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { OAuthCliProvider } from '../accounts/oauthCli';
import { JobState } from '../goal/types';
import { SidebarJob } from '../sidebar/view';
import type { SessionRecord } from './types';
import { RISKY_ACTION, EFFORT_LEVELS } from './constants';

/**
 * Whether a lock / subagent-files entry covers a path: the same path, or inside it when the entry is a folder
 * (trailing "/"). Absolute paths compare case-insensitively on Windows.
 */
export function pathCovers(entry: string, path: string): boolean {
  const fold = (value: string): string => process.platform === 'win32' && isAbsolute(value) ? value.toLowerCase() : value;
  const a = fold(entry);
  const b = fold(path);
  return a === b || (a.endsWith('/') && b.startsWith(a));
}

export const isRiskyAction = (description: string): boolean => RISKY_ACTION.test(description);

/** Providers whose accounts are subscription sign-ins kept in OAuthCliAccounts: ChatGPT (Codex) and Claude. */
export function isOAuthProvider(value: string): value is OAuthCliProvider { return value === 'codex-cli' || value === 'claude-cli'; }

/** Claude always uses its CLI; Codex uses its CLI only for chats created with the agent-runtime option off. */
export function isCliProvider(value: string): value is 'claude-cli' { return value === 'claude-cli'; }

export function isCodexCliChat(record: SessionRecord): boolean { return record.provider === 'codex-cli' && record.codexRuntime === false; }

export function usesCliChat(record: SessionRecord): boolean { return isCliProvider(record.provider) || isCodexCliChat(record); }

export function runtimeLabel(provider: string): string { return provider === 'cursor-acp' ? 'Cursor' : provider === 'codex-cli' ? 'ChatGPT' : provider === 'claude-cli' ? 'Claude' : 'Unify'; }

export function toSidebarJob(job: JobState): SidebarJob {
  const { phase, round, maxRounds, stopReason, criteria } = job;
  return { phase, round, maxRounds, stopReason, criteria };
}

export function lowestEffort(options: readonly string[] | undefined): string | undefined {
  if (!options?.length) return undefined;
  const rank = (level: string): number => {
    const index = EFFORT_LEVELS.indexOf(level);
    return index === -1 ? EFFORT_LEVELS.length : index;
  };
  return options.reduce((lowest, candidate) => rank(candidate) < rank(lowest) ? candidate : lowest);
}

/** Files under a folder, for the memory status and the warning before deleting it. */
export async function countFiles(folder: string): Promise<number> {
  let count = 0;
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(directory, entry.name));
      else if (entry.isFile()) count += 1;
    }
  };
  await walk(folder);
  return count;
}
