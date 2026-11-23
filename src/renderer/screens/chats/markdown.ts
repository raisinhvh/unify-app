/**
 * Markdown for assistant messages. Raw HTML is off (model output is untrusted); links open through the
 * engine (openExternal / openFile) instead of navigating the window.
 */
import MarkdownIt from 'markdown-it';
import { bridge, post } from '../../bridge';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

const defaultLinkOpen = markdown.renderer.rules.link_open
  ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('rel', 'noreferrer');
  return defaultLinkOpen(tokens, index, options, env, self);
};

export function renderMarkdown(text: string): string {
  return markdown.render(text || '');
}

/** Attach to a markdown container: routes link clicks to the engine. */
export function handleMarkdownClick(event: MouseEvent): void {
  const link = (event.target as HTMLElement).closest('a');
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute('href') || '';
  if (/^https?:/i.test(href)) {
    bridge().openExternal(href);
    return;
  }
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(decodeURI(href));
  if (match && match[1]) post({ type: 'openFile', path: match[1], line: match[2] ? Number(match[2]) : undefined, column: match[3] ? Number(match[3]) : undefined });
}
