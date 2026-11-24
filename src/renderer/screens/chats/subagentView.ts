/**
 * Which subagent's feed a chat shows in place of its own (Timeline.tsx), per chat. Shared so the composer's
 * subagent indicator (ActivityIndicators.tsx) can open one too.
 *
 *   openedSubagent(chatId)          the open subagent's id, or '' while the chat's own feed shows
 *   openSubagent(chatId, agentId)   show that subagent's feed ('' goes back to the chat)
 */
import { createStore } from 'solid-js/store';

const [openedByChat, setOpenedByChat] = createStore<Record<string, string>>({});

export function openedSubagent(chatId: string): string {
  return openedByChat[chatId] ?? '';
}

export function openSubagent(chatId: string, agentId: string): void {
  setOpenedByChat(chatId, agentId);
}

/** The delegate profile that renders as an inline "Explored" row: never counted or listed as a subagent. */
export const explorerProfile = 'explorer';
