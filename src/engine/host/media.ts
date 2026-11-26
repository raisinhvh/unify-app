/** Images and media: storing, sending, showing and generating them for chats and subagents. */
import type { Host as ExtensionHost } from '../extension';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import * as vscode from 'vscode';
import { DelegateResult } from '../delegate/host';
import { linkedImagePaths, MAX_MEDIA_BYTES, MAX_MEDIA_FILES } from '../runtime/media';
import { generateImage, imageFileName, inputImageProblem, MAX_INPUT_BYTES, parseImageRequest, pngSize } from '../runtime/imageGen';
import { MediaRecord } from '../unify/media';
import { SidebarImage } from '../sidebar/view';
import { getUnifyFeature } from '../unify/settings';
import type { MediaItem, IncomingImage, ChildRun, Chat } from './types';
import { MAX_IMAGES, MAX_IMAGE_BASE64 } from './constants';

/** A SidebarMedia item for a stored record; `file` is the protocol URL, so `<img src>` just works. */
export function mediaItem(this: ExtensionHost, record: MediaRecord, name: string): MediaItem {
  return {
    name,
    mimeType: record.mimeType,
    file: `unify-media://${record.hash}`,
    hash: record.hash,
    ...(record.width !== undefined ? { width: record.width } : {}),
    ...(record.height !== undefined ? { height: record.height } : {}),
  };
}

/** Image blocks on a finished tool call, whatever shape the runtime reported them in. */
export function incomingImages(this: ExtensionHost, content: unknown): IncomingImage[] {
  if (!Array.isArray(content)) return [];
  const images: IncomingImage[] = [];
  for (const raw of content as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    const nested = block.type === 'content' && block.content && typeof block.content === 'object'
      ? block.content as Record<string, unknown>
      : block;
    if (nested.type !== 'image') continue;
    const source = nested.source && typeof nested.source === 'object' ? nested.source as Record<string, unknown> : undefined;
    const data = typeof nested.data === 'string' ? nested.data : typeof source?.data === 'string' ? source.data : '';
    const mimeType = typeof nested.mimeType === 'string' ? nested.mimeType
      : typeof nested.media_type === 'string' ? nested.media_type
      : typeof source?.media_type === 'string' ? source.media_type : '';
    if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || !mimeType.startsWith('image/')) continue;
    images.push({ data, mimeType });
  }
  return images;
}

/** Stores tool-result images in the media store and marks them shown in the chat. */
export async function storeIncomingImages(this: ExtensionHost, chatId: string, images: IncomingImage[], shownBy: string): Promise<MediaItem[]> {
  const items: MediaItem[] = [];
  for (const image of images) {
    try {
      const bytes = Buffer.from(image.data, 'base64');
      const extension = image.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
      const record = await this.media.put(bytes, image.mimeType, chatId);
      this.shownMedia.add(chatId, record.hash, shownBy);
      items.push(this.mediaItem(record, `image.${extension}`));
    } catch (error) {
      this.output.appendLine(`Storing a tool image failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return items;
}

/** Image content blocks for the model, downscaled when over 1568 px on the long side, plus the hashes delivered. */
export async function agentImageBlocks(this: ExtensionHost, chatId: string, entries: { item: MediaItem; shownBy: string }[]): Promise<{ blocks: { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }[]; hashes: string[] }> {
  const blocks: { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }[] = [];
  const hashes: string[] = [];
  for (const entry of entries) {
    const hash = entry.item.hash;
    const image = await this.media.agentImage(hash);
    if (!image || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)) continue;
    this.shownMedia.add(chatId, hash, entry.shownBy);
    hashes.push(hash);
    blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' });
  }
  return { blocks, hashes };
}

/**
 * Adds images a background subagent sent to its parent to that chat's next tool result.
 * Images that go inline are remembered on the run so its sentToParent strip can omit them.
 */
export async function withPendingParentMedia(this: ExtensionHost, chat: Chat, result: DelegateResult): Promise<DelegateResult> {
  const chatId = chat.record.id;
  const pending = this.pendingParentMedia?.get(chatId);
  if (!pending?.length) return result;
  this.pendingParentMedia?.delete(chatId);
  const { blocks } = await this.agentImageBlocks(chatId, pending);
  if (!blocks.length) return result;
  return { ...result, content: [{ type: 'text', text: result.text }, ...blocks] };
}

/**
 * Hands a finished subagent's queued images to its parent run: background runs park them for the
 * parent's next tool result, foreground runs return them as blocks on this result. Returns the
 * blocks to attach (empty for background runs).
 */
export async function deliverRunMediaToParent(this: ExtensionHost, run: ChildRun): Promise<{ type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }[]> {
  if (!run.queuedForParent.length) return [];
  const chatId = run.parent.record.id;
  const queued = run.queuedForParent.splice(0);
  if (run.background) {
    const pending = this.pendingParentMedia?.get(chatId) || [];
    pending.push(...queued.map(entry => ({ item: entry.item, shownBy: entry.shownBy, run })));
    this.pendingParentMedia?.set(chatId, pending);
    return [];
  }
  const { blocks } = await this.agentImageBlocks(chatId, queued);
  return blocks;
}

export async function saveImages(this: ExtensionHost, images: SidebarImage[] | undefined, ref: string): Promise<{ name: string; mimeType: string; data: string; path: string }[]> {
  if (!images?.length) return [];
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} files.`);
  const saved: { name: string; mimeType: string; data: string; path: string }[] = [];
  let totalBytes = 0;
  for (const image of images) {
    if (typeof image?.data !== 'string' || image.data.length > MAX_IMAGE_BASE64 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
      throw new Error('Invalid attachment data. Files must be under 10 MB.');
    }
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.toString('base64') !== image.data) throw new Error('Invalid attachment data.');
    totalBytes += bytes.length;
    if (bytes.length > 10 * 1024 * 1024 || totalBytes > 20 * 1024 * 1024) throw new Error('Files must be under 10 MB each and 20 MB in total.');
    const mimeType = image.mimeType || 'application/octet-stream';
    const record = await this.media.put(bytes, mimeType, ref);
    const path = this.media.pathOf(record.hash);
    if (!path) throw new Error('The attachment could not be stored.');
    saved.push({ name: String(image.name || 'file').slice(0, 200), mimeType, data: image.data, path });
  }
  return saved;
}

/**
 * Stores files an agent sent in the media store and shows them in the chat.
 * A subagent's media appears in its own feed and, when agents.imagesToParent is on, reaches the
 * parent as image content blocks instead of a `**label:**` message.
 * into is the entry id of a generated image's box, already in the chat; the files fill it.
 */
export async function sendMedia(this: ExtensionHost, chat: Chat, args: Record<string, unknown>, from?: ChildRun, into?: string): Promise<DelegateResult> {
  const paths = (Array.isArray(args.paths) ? args.paths : typeof args.path === 'string' ? [args.path] : []).filter((item): item is string => typeof item === 'string' && !!item.trim());
  if (!paths.length) return { text: '"paths" must list at least one file.', isError: true };
  if (paths.length > MAX_MEDIA_FILES) return { text: `Send at most ${MAX_MEDIA_FILES} files at a time.`, isError: true };
  const chatId = chat.record.id;
  const by = from?.label || 'the main agent';
  const items: MediaItem[] = [];
  const candidates: { item: MediaItem; record: MediaRecord }[] = [];
  const duplicates: string[] = [];
  const problems: string[] = [];
  for (const raw of paths) {
    const source = isAbsolute(raw) ? raw : resolvePath(chat.mirror.cwd, raw);
    try {
      const info = await stat(source);
      if (!info.isFile()) { problems.push(`${raw}: not a file`); continue; }
      if (info.size > MAX_MEDIA_BYTES) { problems.push(`${raw}: larger than ${MAX_MEDIA_BYTES / 1024 / 1024} MB`); continue; }
      const record = await this.media.putFile(source, chatId);
      const item = this.mediaItem(record, basename(source));
      // A generated image's own box is already a new visual: fill it even if the bytes are familiar.
      const already = into ? undefined : this.shownMedia.shownBy(chatId, record.hash);
      // A subagent may pass on an image only it has shown (one it read); its parent has not seen it yet.
      if (from && from.sentToParent.some(sent => sent.hash === record.hash)) { duplicates.push(by); continue; }
      if (already && !(from && already === by)) { duplicates.push(already); continue; }
      items.push(item);
      candidates.push({ item, record });
    } catch (error) { problems.push(`${raw}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const duplicateNote = duplicates.length
    ? `Already shown in this chat by ${duplicates[0]}; refer to it instead of sending it again.`
    : '';
  if (!items.length) {
    if (duplicateNote) return { text: duplicateNote };
    return { text: `No files were sent. ${problems.join('; ')}`, isError: true };
  }
  for (const candidate of candidates) this.shownMedia.add(chatId, candidate.record.hash, by);
  const caption = typeof args.caption === 'string' && args.caption.trim() ? args.caption.trim().slice(0, 4000) : undefined;
  if (from) {
    // The subagent's own feed gets the media; its sentToParent strip is updated separately.
    this.sidebar.postMessage({
      type: 'subagentEvent', sessionId: chatId, agentId: from.agentId, messageId: `media:${randomUUID()}`,
      role: 'assistant', ...(caption ? { text: caption } : {}), media: items,
    });
    from.sentToParent.push(...items);
    this.publishSentToParent(from);
    if (getUnifyFeature('agents.imagesToParent')) {
      from.queuedForParent.push(...candidates.map(candidate => ({ item: candidate.item, shownBy: by })));
    }
  } else {
    // Media from the parent's own turn is placed between its text segments, like a tool call.
    if (!into && chat.running) chat.segment++;
    this.sidebar.postMessage({ type: 'mediaMessage', sessionId: chatId, entryId: into || `media:${randomUUID()}`, caption, items, ...(into ? { generated: true } : {}) });
  }
  const sent = `Shown to the user: ${items.map(item => item.name).join(', ')}.`;
  return { text: [sent, duplicateNote, problems.length ? `Not sent: ${problems.join('; ')}` : ''].filter(Boolean).join(' ') };
}

/**
 * Sends the subagent's sentToParent strip. Images handed to the parent agent as tool-result blocks
 * stay in it: the user never sees those blocks. The renderer leaves out images the chat already shows.
 */
export function publishSentToParent(this: ExtensionHost, run: ChildRun): void {
  this.sidebar.postMessage({ type: 'subagentEvent', sessionId: run.parent.record.id, agentId: run.agentId, sentToParent: [...run.sentToParent] });
}

/**
 * Agents sometimes answer with the path or a link to an image they saved instead of showing it.
 * Shows those images after the reply; ones this chat already shows are skipped by sendMedia.
 */
export async function showLinkedImages(this: ExtensionHost, chat: Chat, reply: string): Promise<void> {
  const paths = await this.linkedImageFiles(chat, reply);
  if (!paths.length) return;
  const result = await this.sendMedia(chat, { paths });
  if (result.isError) this.output.appendLine(`Linked images not shown: ${result.text}`);
}

/**
 * Images a subagent names in its report are handed to its parent, like a user attaching them: they show
 * under its row and reach the parent agent as image blocks. Ones already sent or shown are skipped.
 */
export async function attachReportImages(this: ExtensionHost, chat: Chat, run: ChildRun, report: string): Promise<void> {
  const paths = await this.linkedImageFiles(chat, report);
  if (!paths.length) return;
  const result = await this.sendMedia(chat, { paths }, run);
  if (result.isError) this.output.appendLine(`Report images not sent: ${result.text}`);
}

/** Existing image files a reply names by path or link, resolved in the agent's working copy, then the workspace. */
export async function linkedImageFiles(this: ExtensionHost, chat: Chat, text: string): Promise<string[]> {
  const found: string[] = [];
  for (const raw of linkedImagePaths(text)) {
    const candidates = isAbsolute(raw) ? [raw] : [resolvePath(chat.mirror.cwd, raw), resolvePath(this.projectRoot(chat.record).uri.fsPath, raw)];
    for (const candidate of candidates) {
      if ((await stat(candidate).catch(() => undefined))?.isFile()) { found.push(candidate); break; }
    }
  }
  return [...new Set(found)].slice(0, MAX_MEDIA_FILES);
}

/** Generates an image with the chat's ChatGPT (Codex) account, or the default one, saves it under .unify/images in the real workspace and shows it in the chat. */
async function generateImageMethod(this: ExtensionHost, chat: Chat, args: Record<string, unknown>, from?: ChildRun): Promise<DelegateResult> {
  const request = parseImageRequest(args);
  if (typeof request === 'string') return { text: request, isError: true };
  const own = this.oauthAccounts.get(chat.record.accountId);
  const account = own?.provider === 'codex-cli' ? own : this.oauthAccounts.getDefault('codex-cli');
  if (!account) return { text: 'Image generation needs a ChatGPT (Codex) account. Connect one in Accounts.', isError: true };
  // Relative input paths resolve in the agent's working copy first, then in the real workspace, where .unify/images is in mirror mode.
  const inputs: Buffer[] = [];
  const problems: string[] = [];
  for (const raw of request.images) {
    const candidates = isAbsolute(raw) ? [raw] : [resolvePath(chat.mirror.cwd, raw), resolvePath(this.projectRoot(chat.record).uri.fsPath, raw)];
    let found: string | undefined;
    for (const candidate of candidates) if (!found && (await stat(candidate).catch(() => undefined))?.isFile()) found = candidate;
    if (!found) { problems.push(`${raw}: file not found`); continue; }
    if ((await stat(found)).size > MAX_INPUT_BYTES) { problems.push(`${raw}: larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB`); continue; }
    const bytes = await readFile(found);
    const problem = inputImageProblem(bytes);
    if (problem) problems.push(`${raw}: ${problem}`); else inputs.push(bytes);
  }
  if (problems.length) return { text: `No image was generated. ${problems.join('; ')}.`, isError: true };
  // The image's box shows in the chat right away with a loading circle, and is filled or marked failed when generation ends.
  const entryId = `media:${randomUUID()}`;
  const box = (status: 'pending' | 'failed'): void => {
    this.sidebar.postMessage({ type: 'mediaMessage', sessionId: chat.record.id, entryId, caption: from ? `**${from.label}:**` : undefined, items: [], generated: true, status });
  };
  // A subagent's image belongs in its own feed, so it gets no box in the parent chat.
  if (!from) {
    if (chat.running) chat.segment++;
    box('pending');
  }
  try {
    const image = await generateImage({ home: account.directory }, request, inputs);
    // The real workspace, not the chat's private copy: .unify is outside the mirror's review scope.
    const dir = join(this.projectRoot(chat.record).uri.fsPath, '.unify', 'images');
    await mkdir(dir, { recursive: true });
    const path = join(dir, imageFileName(args.name, request.prompt, image.extension));
    await writeFile(path, image.bytes, { flag: 'wx' });
    const size = pngSize(image.bytes);
    const shown = await this.sendMedia(chat, { paths: [path] }, from, from ? undefined : entryId);
    if (shown.isError && !from) box('failed');
    return { text: `Image saved to ${path}${size ? ` (${size})` : ''}. ${shown.isError ? `It could not be shown in the chat: ${shown.text}` : 'It is already shown to the user in the chat.'}` };
  } catch (error) {
    if (!from) box('failed');
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

export async function openMedia(this: ExtensionHost, file: string): Promise<void> {
  // New media carries the store hash in its protocol URL. Older saved chats still carry a path
  // relative to the legacy media folder, which is kept for them.
  if (file.startsWith('unify-media://')) {
    const hash = new URL(file).hostname.toLowerCase();
    const path = this.media.pathOf(hash);
    if (!path) throw new Error('That media file is no longer in the media store.');
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path));
    return;
  }
  const root = join(this.context.globalStorageUri.fsPath, 'media');
  const path = resolvePath(root, file);
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('That file is not in the chat media folder.');
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path));
}

export { generateImageMethod as generateImage };
