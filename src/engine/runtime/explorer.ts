import type { SidebarExplorerRange } from '../sidebar/view';
import { getUnifyFeature } from '../unify/settings';

/** Adds the built-in explorer without replacing a user profile of the same name. */
export function withExplorer<T extends { name: string }>(profiles: T[], choice: { model?: string; effort?: string; speed?: string }): (T | { name: string; description: string; model: string; effort?: string; speed?: string; mode: 'read-only' })[] {
  if (!choice.model || profiles.some(profile => profile.name === 'explorer')) return profiles;
  return [...profiles, { name: 'explorer', description: 'Searches and reads files and returns a concise answer.', model: choice.model, effort: choice.effort, speed: choice.speed, mode: 'read-only' }];
}

/** The explorer's opening task note; with agents.explorerRanges it also asks for the ranges block. */
export function explorerPromptNote(): string {
  const answer = 'Answer in at most about 300 words. Include file paths with line numbers for every claim.';
  if (!getUnifyFeature('agents.explorerRanges')) return `${answer}\n\n`;
  return `${answer} End your answer with one fenced block named ranges, one line per range:\n`
    + '```ranges\npath:startLine-endLine why\n```\n'
    + 'Give the exact ranges the requester needs to read or edit, not whole files.\n\n';
}

const MAX_EXPLORER_RANGES = 12;
const RANGES_BLOCK = /```ranges[ \t]*\r?\n([\s\S]*?)```/gi;
const RANGE_LINE = /^\s*(.+?):(\d+)\s*-\s*(\d+)(?:\s+(.*))?\s*$/;

/**
 * Splits an explorer answer into its prose and the ranges block.
 * Overlapping or touching ranges in one file are merged, the first "why" is kept, malformed lines are
 * dropped and the list is capped at 12. Without a block the answer is returned unchanged.
 */
export function parseExplorerRanges(answer: string): { text: string; ranges: SidebarExplorerRange[] } {
  const ranges: SidebarExplorerRange[] = [];
  let sawBlock = false;
  const text = answer.replace(RANGES_BLOCK, (_block, body: string) => {
    sawBlock = true;
    for (const line of body.split(/\r?\n/)) {
      const match = line.match(RANGE_LINE);
      if (!match) continue;
      const path = match[1].trim();
      const startLine = Number(match[2]);
      const endLine = Number(match[3]);
      if (!path || !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) continue;
      ranges.push({ path, startLine, endLine, ...(match[4]?.trim() ? { why: match[4].trim() } : {}) });
    }
    return '';
  });
  if (!sawBlock) return { text: answer, ranges: [] };
  const merged = mergeRanges(ranges).slice(0, MAX_EXPLORER_RANGES);
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), ranges: merged };
}

/** Merges ranges per file, keeping the first reason, in the order the files first appeared. */
function mergeRanges(ranges: SidebarExplorerRange[]): SidebarExplorerRange[] {
  const byPath = new Map<string, SidebarExplorerRange[]>();
  for (const range of ranges) {
    const list = byPath.get(range.path);
    if (list) list.push(range);
    else byPath.set(range.path, [range]);
  }
  const merged: SidebarExplorerRange[] = [];
  for (const list of byPath.values()) {
    list.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
    for (const range of list) {
      const last = merged[merged.length - 1];
      if (last && last.path === range.path && range.startLine <= last.endLine + 1) {
        last.endLine = Math.max(last.endLine, range.endLine);
        continue;
      }
      merged.push({ ...range });
    }
  }
  return merged;
}

/** The compact block appended to the explorer's delegate_task result so the main agent can read those ranges. */
export function formatExplorerRanges(ranges: SidebarExplorerRange[]): string {
  if (!ranges.length) return '';
  const lines = ranges.slice(0, MAX_EXPLORER_RANGES).map(range => `${range.path}:${range.startLine}-${range.endLine}${range.why ? ` ${range.why}` : ''}`);
  return `Ranges the explorer found (read them with read_file ranges; edit with edit_range):\n${lines.join('\n')}`;
}
