import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Chat storage: a folder per chat inside the project, for the files agents make while working (screenshots, renders,
 * comparison sheets, scratch scripts, logs, downloaded samples). It lives under `.unify/`, which is gitignored and
 * excluded from review, and it is removed when the chat is deleted.
 */
const SAFE_CHAT_ID = /^[A-Za-z0-9_-]+$/;

/** The chat's storage folder, relative to the project root: `.unify/chats/<chatId>`. */
export function chatStorageRel(chatId: string): string {
  if (!SAFE_CHAT_ID.test(chatId)) throw new Error(`Unsafe chat ID for chat storage: ${JSON.stringify(chatId)}`);
  return `.unify/chats/${chatId}`;
}

/** The chat's storage folder under a working copy or project root. */
export function chatStoragePath(cwd: string, chatId: string): string {
  return join(cwd, ...chatStorageRel(chatId).split('/'));
}

/** The instruction paragraph telling agents where to keep temporary files for this chat. */
export function chatStorageInstructions(cwd: string, chatId: string): string {
  const path = chatStoragePath(cwd, chatId);
  return [
    `Chat storage: ${path} is this chat's folder for temporary and working files. Save there screenshots, renders, before/after comparison sheets, scratch scripts, logs and downloaded samples. Create the folder if it is missing. It is deleted when the chat is deleted, and nothing in it is reviewed.`,
    'Put a file in the project only when it is meant to stay there, such as an icon, an asset the task asked for, or source code. Never leave throwaway images or scratch files in the project tree.',
  ].join(' ');
}

/** Removes the chat's storage folder under a working copy or project root. Missing folders are not an error. */
export async function removeChatStorage(cwd: string, chatId: string): Promise<void> {
  await fs.rm(chatStoragePath(cwd, chatId), { recursive: true, force: true });
}
