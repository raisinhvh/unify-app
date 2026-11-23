/**
 * The "Active" group: DSH's activity rail ordering, unchanged (media/sidebar.js renderRail, lines ~184-361).
 *
 * A chat is active when it is blocked (a pending approval or question), running, or done-but-unread.
 * Groups sort blocked, then done, then running; within a group the most recent state change comes first.
 */
import { createMemo, createRoot } from 'solid-js';
import type { SidebarSession } from '../protocol';
import { isRunning, unread, viewState } from './index';

export type ActivityStatus = 'blocked' | 'running' | 'done' | '';

const activityRank: Record<Exclude<ActivityStatus, ''>, number> = { blocked: 0, done: 1, running: 2 };

export function pendingInterrupt(sessionId: string) {
  return (viewState.timeline[sessionId] || []).find(
    item => (item.kind === 'approval' || item.kind === 'question') && item.status === 'pending',
  );
}

export function activityStatus(sessionId: string): ActivityStatus {
  if (pendingInterrupt(sessionId)) return 'blocked';
  if (isRunning(sessionId)) return 'running';
  return sessionId in unread() ? 'done' : '';
}

/** The hover text DSH showed on rail tabs. */
export function activityDetail(sessionId: string, status: ActivityStatus): string {
  if (status === 'blocked') {
    return pendingInterrupt(sessionId)?.kind === 'question' ? 'Waiting for your answer' : 'Waiting for your approval';
  }
  if (status === 'done') return 'Finished. Open to read';
  return viewState.runStates[sessionId]?.label || 'Running';
}

export interface ActiveChat {
  session: SidebarSession;
  status: Exclude<ActivityStatus, ''>;
}

// Tracks when each chat last changed state; kept across recomputes like DSH's railSince map.
const statusSince = new Map<string, { status: ActivityStatus; at: number }>();
let statusClock = 0;

/** Reactive, ordered list of active chats. */
export const activeChats = createRoot(() => createMemo<ActiveChat[]>(() => {
  const items: (ActiveChat & { at: number })[] = [];
  for (const session of viewState.sessions) {
    const status = activityStatus(session.id);
    const since = statusSince.get(session.id);
    if (!status) {
      statusSince.delete(session.id);
      continue;
    }
    if (since?.status !== status) statusSince.set(session.id, { status, at: ++statusClock });
    items.push({ session, status, at: statusSince.get(session.id)!.at });
  }
  items.sort((first, second) => activityRank[first.status] - activityRank[second.status] || second.at - first.at);
  return items.map(({ session, status }) => ({ session, status }));
}));
