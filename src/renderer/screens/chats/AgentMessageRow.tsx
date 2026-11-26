/**
 * A message one agent sent another, as a quiet row: `from → to` muted, then the text clamped to 2 lines.
 * A click springs it open to the whole text (Reveal) and back; the clamp's ellipsis only shows at rest.
 * Hidden when `agents.messaging.showInChat` is off (Timeline decides).
 */
import { createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { driveSpring, prefersReducedMotion, Spring } from '../../motion';
import type { SidebarTimelineItem } from '../../protocol';
import { agentName } from '../../store';

export type AgentMessageItem = Extract<SidebarTimelineItem, { kind: 'agentMessage' }>;

export function AgentMessageRow(props: { item: AgentMessageItem }): JSX.Element {
  let clip!: HTMLDivElement;
  let text!: HTMLDivElement;
  const [expanded, setExpanded] = createSignal(false);
  const [clamped, setClamped] = createSignal(true);
  const [truncated, setTruncated] = createSignal(false);
  const height = new Spring(0, 'reveal', 100);

  const collapsedHeight = () => {
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight) || 18;
    return Math.round(lineHeight * 2);
  };

  height.onChange(value => {
    clip.style.height = `${Math.max(0, value)}px`;
  });
  height.onRest(() => {
    if (!expanded()) {
      setClamped(true);
      clip.style.height = '';
    } else {
      clip.style.height = '';
    }
  });
  onCleanup(() => height.stop());

  onMount(() => {
    const measure = () => setTruncated(text.scrollHeight > text.clientHeight + 1 || expanded());
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    onCleanup(() => observer.disconnect());
  });

  const toggle = () => {
    if (!truncated()) {
      return;
    }
    const opening = !expanded();
    const from = clip.offsetHeight;
    setExpanded(opening);
    setClamped(false);
    const to = opening ? text.scrollHeight : collapsedHeight();
    if (prefersReducedMotion()) {
      height.jump(to);
      setClamped(!opening);
      clip.style.height = '';
      return;
    }
    if (!height.moving) {
      height.jump(from);
    }
    driveSpring(height, to, 'reveal');
  };

  const message = () => props.item.message;
  const fromName = () => message().fromName || agentName(message().fromId) || message().fromId;
  const toName = () => message().toName || agentName(message().toId) || message().toId;
  return (
    <button
      type="button"
      class="feed-entry agent-message"
      classList={{ 'agent-message-truncated': truncated() }}
      aria-expanded={truncated() ? expanded() : undefined}
      onClick={toggle}
    >
      <span class="agent-message-route">
        <span class="agent-name">{fromName()}</span>
        <span class="agent-message-arrow">→</span>
        <span class="agent-name">{toName()}</span>
      </span>
      <div
        class="agent-message-clip"
        ref={clip}
      >
        <div
          class="agent-message-text"
          classList={{ 'agent-message-clamped': clamped() }}
          ref={text}
        >
          {message().text}
        </div>
      </div>
    </button>
  );
}
