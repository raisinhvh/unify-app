/**
 * Dragging a chat from the chats list into the workspace (HTML5 drag and drop).
 *
 *   makeChatDraggable(row, () => chatId)   on a chats-list row
 *   isChatDrag(event)                       true during dragenter/dragover of such a drag
 *   readChatDrag(event)                     the chat id on drop
 *
 * PaneGrid shows the same snap zones as an image drag and calls layout.placeChat(chatId, target).
 */
import { onCleanup } from 'solid-js';

export const chatDragType = 'application/x-unify-chat';

export function makeChatDraggable(element: HTMLElement, chatId: () => string | undefined): void {
  element.draggable = true;
  const start = (event: DragEvent) => {
    const id = chatId();
    if (!id || !event.dataTransfer) return;
    event.dataTransfer.setData(chatDragType, id);
    event.dataTransfer.effectAllowed = 'move';
  };
  element.addEventListener('dragstart', start);
  onCleanup(() => element.removeEventListener('dragstart', start));
}

export function isChatDrag(event: DragEvent): boolean {
  return !!event.dataTransfer && [...event.dataTransfer.types].includes(chatDragType);
}

export function readChatDrag(event: DragEvent): string | undefined {
  return event.dataTransfer?.getData(chatDragType) || undefined;
}
