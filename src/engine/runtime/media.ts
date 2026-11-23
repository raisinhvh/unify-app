import { extname } from 'node:path';
import type { DelegateToolInfo } from '../delegate/host';

export const SEND_MEDIA = 'send_media';
export const MAX_MEDIA_FILES = 8;
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
};

export function mediaType(path: string): string { return MEDIA_TYPES[extname(path).toLowerCase()] || 'application/octet-stream'; }

export const SEND_MEDIA_TOOL: DelegateToolInfo = {
  name: SEND_MEDIA,
  description: 'Show files in the chat: images, video and audio inline, other files as a link. Files are copied when sent.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: { type: 'array', minItems: 1, maxItems: MAX_MEDIA_FILES, items: { type: 'string' }, description: 'Relative to the working copy, or absolute.' },
      caption: { type: 'string', description: 'Optional markdown shown above them.' },
    },
    required: ['paths'],
  },
};

export const MEDIA_INSTRUCTIONS = `Unify media: ${SEND_MEDIA} shows a file (screenshot, render, video, audio, other) in the chat.`;

/**
 * TODO 2e ("show your work, no duplicate visuals"), added to the agent prompt only while
 * `chats.showYourWork` is on. Duplicate tracking itself is always on (see
 * `src/engine/unify/media/shown.ts`); this text just tells the agent to use images well.
 */
export const SHOW_YOUR_WORK_INSTRUCTIONS = `Show your work visually when it helps: ${SEND_MEDIA} screenshots of UI changes, renders, before/after pairs, and images of assets you generated. Stay text-only only when there is nothing to look at. Never send an image the user has already seen in this chat; refer to it instead ("the screenshot above").`;
