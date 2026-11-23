/**
 * Which media has already been shown in a chat (TODO 2e, "no duplicate visuals").
 *
 * Tracking is always on, whatever the `chats.showYourWork` toggle says: a chat's own `send_media`,
 * images on its tool rows, and its subagents' `send_media` and tool images all count. `send_media`
 * consults this before showing anything, so the same sha256 never appears twice in one chat.
 *
 * Pure and in memory: the set only needs to live as long as the chats it describes, and the media
 * store's refs already make the bytes durable.
 */
export interface ShownMediaTracker {
  /** Whether this chat already showed the image. */
  has(chatId: string, hash: string): boolean;
  /** Records that `shownBy` showed the image in this chat; the first name wins. */
  add(chatId: string, hash: string, shownBy: string): void;
  /** Who first showed the image in this chat, or undefined when it was not shown. */
  shownBy(chatId: string, hash: string): string | undefined;
  /** Drops everything for a deleted chat. */
  forget(chatId: string): void;
}

export function createShownMediaTracker(): ShownMediaTracker {
  const chats = new Map<string, Map<string, string>>();

  const hashes = (chatId: string): Map<string, string> => {
    let known = chats.get(chatId);
    if (!known) {
      known = new Map<string, string>();
      chats.set(chatId, known);
    }
    return known;
  };

  return {
    has(chatId: string, hash: string): boolean {
      return !!hash && chats.get(chatId)?.has(hash) === true;
    },
    add(chatId: string, hash: string, shownBy: string): void {
      if (!chatId || !hash) return;
      const known = hashes(chatId);
      if (!known.has(hash)) known.set(hash, shownBy || 'the main agent');
    },
    shownBy(chatId: string, hash: string): string | undefined {
      return hash ? chats.get(chatId)?.get(hash) : undefined;
    },
    forget(chatId: string): void {
      chats.delete(chatId);
    },
  };
}
