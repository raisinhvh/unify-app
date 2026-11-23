/**
 * A chat's timeline (Figma 12 Chat pane 306:3030). Port of DSH renderFeed (media/sidebar.js ~922-1153):
 *
 *   - consecutive tool entries form one batch (edit and subagent tools are skipped, diffs are not shown here);
 *     a batch shows its latest call with a count and expands into every call, nested batch children included
 *   - user messages: bubble with attached images; an edit button while idle; editing posts editMessage
 *   - assistant messages: markdown
 *   - approvals and questions are flat rows on a guide line, resolved ones collapse to a summary
 *   - media, DSH notes, subagents (open one to read its own feed)
 *
 * Rows are keyed by timeline id, so streaming text and state changes update in place instead of remounting.
 */
import { createMemo, createSignal, For, Match, Show, Switch, type Accessor, type JSX } from 'solid-js';
import { Button, Icon, Loader, actionLoader, toolAction, tooltip, type IconName } from '../../components';
import { Collapse, Presence } from '../../motion';
import { post } from '../../bridge';
import type { SidebarSubagent, SidebarTimelineItem, SidebarToolEvent } from '../../protocol';
import { isRunning, userImages, viewState } from '../../store';
import { QuestionRow } from './QuestionRow';
import { handleMarkdownClick, renderMarkdown } from './markdown';
import './timeline.css';

type ToolLike = Pick<SidebarToolEvent, 'title' | 'detail' | 'full' | 'kind'> & { state: SidebarToolEvent['state'] };

type FeedItem =
  | Exclude<SidebarTimelineItem, { kind: 'tool' } | { kind: 'diff' }>
  | { id: string; kind: 'toolbatch'; tools: SidebarToolEvent[] };

function feedItems(timeline: SidebarTimelineItem[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const entry of timeline) {
    if (entry.kind === 'tool') {
      if (entry.event.kind === 'edit' || entry.event.kind === 'subagent') continue;
      const last = items[items.length - 1];
      if (last?.kind === 'toolbatch') last.tools.push(entry.event);
      else items.push({ id: `batch:${entry.id}`, kind: 'toolbatch', tools: [entry.event] });
    } else if (entry.kind !== 'diff') {
      items.push(entry);
    }
  }
  return items;
}

/* Tool rows */

function toolGlyph(tool: ToolLike & { children?: unknown[] }): IconName {
  if (tool.state === 'error') return 'close';
  if (tool.state === 'cancelled') return 'stop';
  if (tool.kind === 'search') return 'search';
  return 'check';
}

export function ToolRow(props: { tool: ToolLike & { children?: unknown[] }; class?: string }): JSX.Element {
  const full = () => props.tool.full || props.tool.title + (props.tool.detail ? ` ${props.tool.detail}` : '');
  return (
    <div
      class={props.class ? `tool-row ${props.class}` : 'tool-row'}
      classList={{ [`tool-${props.tool.state}`]: true }}
      ref={element => tooltip(element, () => <span class="type-mono tool-tip">{full()}</span>, { placement: 'top-start', delay: 600 })}
    >
      <span class="tool-glyph">
        <Show when={props.tool.state === 'running'} fallback={<Icon name={toolGlyph(props.tool)} size={12} />}>
          <Loader id={actionLoader[toolAction(props.tool)]} size={12} />
        </Show>
      </span>
      <span class="tool-row-title">{props.tool.title}</span>
      <Show when={props.tool.detail}>
        <span class="tool-row-detail">{props.tool.detail!.replace(/\s+/g, ' ')}</span>
      </Show>
    </div>
  );
}

function childKind(child: { title: string; kind?: SidebarToolEvent['kind'] }): SidebarToolEvent['kind'] {
  if (child.kind) return child.kind;
  if (/search/i.test(child.title)) return 'search';
  if (/read|list|summar|history/i.test(child.title)) return 'read';
  return 'other';
}

function ToolList(props: { tools: SidebarToolEvent[] }): JSX.Element {
  return (
    <div class="tool-list">
      <For each={props.tools}>
        {tool => (
          <>
            <ToolRow tool={tool} />
            <Show when={tool.children?.length}>
              <div class="tool-children">
                <For each={tool.children}>{child => <ToolRow tool={{ ...child, kind: childKind(child) }} class="tool-child" />}</For>
              </div>
            </Show>
          </>
        )}
      </For>
    </div>
  );
}

function ToolBatch(props: { item: Extract<FeedItem, { kind: 'toolbatch' }> }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const last = () => props.item.tools[props.item.tools.length - 1];
  const single = () => props.item.tools.length === 1 && !last().children?.length;
  return (
    <div class="feed-entry tool-batch">
      <Show when={!single()} fallback={<ToolRow tool={last()} />}>
        <button
          type="button"
          class="tool-batch-head"
          aria-expanded={expanded()}
          aria-label={expanded() ? 'Collapse tool calls' : 'Expand tool calls'}
          onClick={() => setExpanded(!expanded())}
        >
          <Show when={!expanded()} fallback={<span class="tool-row-title">{props.item.tools.length} tool calls</span>}>
            <ToolRow tool={last()} class="tool-ticker" />
          </Show>
          <span class="tool-count">{props.item.tools.length}</span>
          <Icon name="chevronRight" size={12} class="tool-batch-chevron" style={{ rotate: expanded() ? '90deg' : '0deg' }} />
        </button>
        <Collapse open={expanded()}>
          <ToolList tools={props.item.tools} />
        </Collapse>
      </Show>
    </div>
  );
}

/* Messages */

function UserMessage(props: { chatId: string; item: Extract<FeedItem, { kind: 'message' }> }): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  let editor: HTMLTextAreaElement | undefined;
  const images = () => userImages()[props.item.id] || [];
  const save = () => {
    const text = editor?.value.trim();
    if (text) post({ type: 'editMessage', sessionId: props.chatId, entryId: props.item.id, text, chatId: props.chatId });
    setEditing(false);
  };
  return (
    <div class="feed-entry bubble user" classList={{ editing: editing() }}>
      <Show
        when={!editing()}
        fallback={
          <div class="message-editor">
            <textarea
              ref={element => {
                editor = element;
                queueMicrotask(() => element.focus());
              }}
              aria-label="Edit message"
              value={props.item.text}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  save();
                }
                if (event.key === 'Escape') setEditing(false);
              }}
            />
            <div class="message-edit-actions">
              <Button variant="text" onClick={() => setEditing(false)}>Cancel</Button>
              <Button variant="primary" onClick={save}>Save</Button>
            </div>
          </div>
        }
      >
        <Show when={images().length}>
          <div class="bubble-images">
            <For each={images()}>{image => <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />}</For>
          </div>
        </Show>
        <div class="message-content">{props.item.text}</div>
        <Show when={!isRunning(props.chatId)}>
          <button type="button" class="message-edit" aria-label="Edit message" onClick={() => setEditing(true)}>
            <Icon name="edit" size={12} />
          </button>
        </Show>
      </Show>
    </div>
  );
}

function AssistantMessage(props: { text: string }): JSX.Element {
  return <div class="feed-entry assistant markdown" innerHTML={renderMarkdown(props.text)} onClick={handleMarkdownClick} />;
}

/* Approvals */

function ApprovalRow(props: { item: Extract<FeedItem, { kind: 'approval' }> }): JSX.Element {
  const id = () => props.item.id.slice('approval:'.length);
  const pending = () => props.item.status === 'pending';
  return (
    <div class="feed-entry interrupt-row approval-row" classList={{ [`approval-${props.item.status}`]: true }}>
      <div class="interrupt-title">
        <Switch>
          <Match when={pending()}>
            <Loader id="knock" size={12} />
          </Match>
          <Match when={props.item.status === 'allowed'}>
            <Icon name="check" size={12} />
          </Match>
          <Match when={props.item.status === 'rejected'}>
            <Icon name="close" size={12} />
          </Match>
        </Switch>
        <span>{pending() ? props.item.title : props.item.status === 'allowed' ? 'Allowed' : 'Rejected'}</span>
      </div>
      <pre class="approval-detail type-mono">{props.item.detail}</pre>
      <Collapse open={pending()}>
        <div class="interrupt-actions">
          <Button variant="primary" onClick={() => post({ type: 'approvalResponse', id: id(), allow: true })}>Allow</Button>
          <Button variant="secondary" onClick={() => post({ type: 'approvalResponse', id: id(), allow: false })}>Deny</Button>
        </div>
      </Collapse>
    </div>
  );
}

/* Media, notes, subagents */

function MediaEntry(props: { item: Extract<FeedItem, { kind: 'media' }> }): JSX.Element {
  return (
    <div class="feed-entry assistant media-entry" classList={{ generated: !!props.item.generated }}>
      <Show when={props.item.caption}>
        <div class="markdown" innerHTML={renderMarkdown(props.item.caption!)} onClick={handleMarkdownClick} />
      </Show>
      <div class="media-items">
        <Show
          when={!props.item.status}
          fallback={
            <div class="media-status" classList={{ failed: props.item.status === 'failed' }}>
              <Show when={props.item.status === 'pending'} fallback={<span class="type-caption">Could not make the image</span>}>
                <Loader id={actionLoader.imaging} size={16} />
              </Show>
            </div>
          }
        >
          <For each={props.item.items}>
            {media => (
              <Presence when>
                <button type="button" class="media-thumb" title={media.name} onClick={() => post({ type: 'openMedia', file: media.file })}>
                  <Show when={media.mimeType.startsWith('image/')} fallback={<span class="media-file"><Icon name="file" size={14} />{media.name}</span>}>
                    <img src={media.file} alt={media.name} />
                  </Show>
                </button>
              </Presence>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

function NoteEntry(props: { item: Extract<FeedItem, { kind: 'note' }> }): JSX.Element {
  return <div class="feed-entry feed-note type-caption">{props.item.text}</div>;
}

function subagentDetail(agent: SidebarSubagent): string {
  if (agent.state === 'running') return 'Working…';
  if (agent.state === 'error') return 'Failed';
  if (agent.state === 'cancelled') return 'Cancelled';
  return agent.messages.length ? 'View subagent chat' : 'Completed';
}

function SubagentEntry(props: { chatId: string; agentId: string; onOpen: (agentId: string) => void }): JSX.Element {
  const agent = () => viewState.subagents[props.chatId]?.[props.agentId];
  return (
    <Show when={agent()}>
      {current => (
        <button type="button" class="feed-entry subagent-row" onClick={() => props.onOpen(props.agentId)}>
          <span class="tool-glyph">
            <Switch fallback={<Icon name="check" size={12} />}>
              <Match when={current().state === 'running'}>
                <Loader id={actionLoader[current().delegated ? 'delegating' : 'spawning']} size={12} />
              </Match>
              <Match when={current().state === 'error'}>
                <Icon name="close" size={12} />
              </Match>
              <Match when={current().state === 'cancelled'}>
                <Icon name="stop" size={12} />
              </Match>
            </Switch>
          </span>
          <span class="subagent-title">{current().title}</span>
          <Show when={current().model}>
            <span class="subagent-model">{current().model}</span>
          </Show>
          <span class="subagent-detail">{subagentDetail(current())}</span>
          <Icon name="chevronRight" size={12} />
        </button>
      )}
    </Show>
  );
}

/** A subagent's own feed, shown in place of the chat until "Back". */
function SubagentFeed(props: { agent: SidebarSubagent; onBack: () => void }): JSX.Element {
  return (
    <div class="feed">
      <button type="button" class="subagent-back" onClick={() => props.onBack()}>
        <Icon name="chevronRight" size={12} style={{ rotate: '180deg' }} />
        <span class="type-label">{props.agent.title}</span>
        <Show when={props.agent.model}>
          <span class="subagent-model">{props.agent.model}</span>
        </Show>
      </button>
      <Show when={props.agent.prompt}>
        <div class="feed-entry bubble user">
          <div class="message-content">{props.agent.prompt}</div>
        </div>
      </Show>
      <For each={props.agent.messages}>
        {message => (
          <Show when={message.role === 'tool' && message.tool} fallback={<AssistantMessage text={message.text} />}>
            <ToolRow tool={{ ...message.tool!, state: 'complete' }} />
          </Show>
        )}
      </For>
    </div>
  );
}

/* Feed */

function FeedRow(props: { chatId: string; item: Accessor<FeedItem | undefined>; onOpenSubagent: (id: string) => void }): JSX.Element {
  return (
    <Show when={props.item()}>
      {item => (
        <Switch>
          <Match when={item().kind === 'message' && (item() as Extract<FeedItem, { kind: 'message' }>)}>
            {message => (
              <Show when={message().role === 'user'} fallback={<AssistantMessage text={message().text} />}>
                <UserMessage chatId={props.chatId} item={message()} />
              </Show>
            )}
          </Match>
          <Match when={item().kind === 'toolbatch' && (item() as Extract<FeedItem, { kind: 'toolbatch' }>)}>
            {batch => <ToolBatch item={batch()} />}
          </Match>
          <Match when={item().kind === 'approval' && (item() as Extract<FeedItem, { kind: 'approval' }>)}>
            {approval => <ApprovalRow item={approval()} />}
          </Match>
          <Match when={item().kind === 'question' && (item() as Extract<FeedItem, { kind: 'question' }>)}>
            {question => <QuestionRow chatId={props.chatId} item={question()} />}
          </Match>
          <Match when={item().kind === 'media' && (item() as Extract<FeedItem, { kind: 'media' }>)}>
            {media => <MediaEntry item={media()} />}
          </Match>
          <Match when={item().kind === 'note' && (item() as Extract<FeedItem, { kind: 'note' }>)}>
            {note => <NoteEntry item={note()} />}
          </Match>
          <Match when={item().kind === 'subagent' && (item() as Extract<FeedItem, { kind: 'subagent' }>)}>
            {subagent => <SubagentEntry chatId={props.chatId} agentId={subagent().agentId} onOpen={props.onOpenSubagent} />}
          </Match>
        </Switch>
      )}
    </Show>
  );
}

export function Timeline(props: { chatId: string }): JSX.Element {
  const [openedSubagent, setOpenedSubagent] = createSignal('');
  let scroller: HTMLDivElement | undefined;
  let stickToBottom = true;

  const feed = createMemo(() => {
    const items = feedItems(viewState.timeline[props.chatId] || []);
    const byId = new Map(items.map(item => [item.id, item]));
    return { order: items.map(item => item.id), byId };
  });

  const openedAgent = () => (openedSubagent() ? viewState.subagents[props.chatId]?.[openedSubagent()] : undefined);

  // Follow new output while the reader is at the bottom (DSH: within 60px).
  createMemo(() => {
    feed();
    JSON.stringify(viewState.timeline[props.chatId]?.at(-1));
    queueMicrotask(() => {
      if (scroller && stickToBottom) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  return (
    <div
      class="timeline"
      ref={scroller}
      onScroll={event => {
        const element = event.currentTarget;
        stickToBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
      }}
    >
      <Show
        when={openedAgent()}
        fallback={
          <div class="feed">
            <Show when={!feed().order.length}>
              <div class="feed-empty type-caption">Ask about your workspace or request an edit.</div>
            </Show>
            <For each={feed().order}>
              {id => <FeedRow chatId={props.chatId} item={() => feed().byId.get(id)} onOpenSubagent={setOpenedSubagent} />}
            </For>
          </div>
        }
      >
        {agent => <SubagentFeed agent={agent()} onBack={() => setOpenedSubagent('')} />}
      </Show>
    </div>
  );
}
