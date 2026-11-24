/**
 * Markdown for assistant messages. Raw HTML is off (model output is untrusted); links open through the
 * engine (openExternal) instead of navigating the window.
 *
 * File references open in the workspace's Files pane (shell/fileLinks.ts), in the chat's project: inline code that
 * reads as a path (`src/main/index.ts:42`) renders as a clickable chip, and links whose target is a path do the same.
 * The chat is found from the nearest `[data-chat-id]` (the Timeline root).
 */
import MarkdownIt from 'markdown-it';
import { bridge } from '../../bridge';
import { chatProject, openFileReference, parseFileReference } from '../../shell/fileLinks';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

const defaultLinkOpen = markdown.renderer.rules.link_open
  ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('rel', 'noreferrer');
  return defaultLinkOpen(tokens, index, options, env, self);
};

markdown.renderer.rules.code_inline = (tokens, index) => {
  const content = tokens[index].content;
  const escaped = markdown.utils.escapeHtml(content);
  if (!parseFileReference(content)) return `<code>${escaped}</code>`;
  return `<code class="file-ref" role="link" tabindex="0" title="Open in Files" data-file-ref="${escaped}">${escaped}</code>`;
};

export function renderMarkdown(text: string): string {
  return markdown.render(text || '');
}

function openReference(element: Element, text: string): boolean {
  const reference = parseFileReference(text);
  if (!reference) return false;
  const chatId = element.closest<HTMLElement>('[data-chat-id]')?.dataset.chatId;
  openFileReference(reference, chatProject(chatId));
  return true;
}

/** Attach to a markdown container: routes link and file-reference clicks. */
export function handleMarkdownClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  const chip = target.closest<HTMLElement>('code.file-ref');
  if (chip) {
    event.preventDefault();
    openReference(chip, chip.dataset.fileRef ?? chip.textContent ?? '');
    return;
  }
  const link = target.closest('a');
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute('href') || '';
  if (/^https?:/i.test(href)) {
    bridge().openExternal(href);
    return;
  }
  let decoded = href;
  try {
    decoded = decodeURI(href);
  } catch {
    // Malformed escapes: use the target as written.
  }
  openReference(link, decoded.replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1'));
}

/** Enter / Space on a focused file chip opens it, like a link. */
export function handleMarkdownKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const chip = (event.target as HTMLElement).closest<HTMLElement>('code.file-ref');
  if (!chip) return;
  event.preventDefault();
  openReference(chip, chip.dataset.fileRef ?? chip.textContent ?? '');
}
