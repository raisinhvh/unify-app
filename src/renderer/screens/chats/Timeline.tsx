/**
 * A chat's timeline (Figma 12 Chat pane 306:3030). Port of DSH renderFeed (media/sidebar.js ~922-1153):
 *
 *   - consecutive tool entries form one batch (subagent tools are skipped, diff entries are not shown here);
 *     a batch shows its latest call with a count and expands into every call, nested batch children included
 *   - edit calls are their own row with the change streaming in as a small diff (EditPreview), in subagent chats
 *     too; a running subagent's row shows the line its current edit is writing. With `chats.liveEditPreview` off
 *     edit calls are plain tool rows in the batch
 *   - user messages: bubble with attached images; an edit button while idle; editing posts editMessage
 *   - assistant messages: markdown
 *   - approvals and questions are flat rows on a guide line, resolved ones collapse to a summary
 *   - media, DSH notes, subagents (open one to read its own feed)
 *   - images a tool call gave the agent show as prints under it; a subagent's row grows a strip of the images it
 *     sent the main agent, minus any already shown in this chat (MediaLines)
 *   - internal tool rows say what the call really did (`internal`), and expand to the raw call
 *   - explorer runs are an inline "Explored" row, not a subagent (ExplorerRow)
 *   - agent → agent messages are quiet rows (AgentMessageRow)
 *
 * Rows are keyed by timeline id, so streaming text and state changes update in place instead of remounting.
 */
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, type Accessor, type JSX } from 'solid-js';
import { Button, Icon, Loader, actionLoader, toolAction, tooltip, type IconName } from '../../components';
import { isImage, mediaKey, openMediaViewer, thumbSource, uniqueMedia, type MediaItem } from '../../components/media';
import { imageDragProps } from '../../shell/imageDrag';
import { Collapse, Presence } from '../../motion';
import { post } from '../../bridge';
import type {
  SidebarEditPreview,
  SidebarInternalTool,
  SidebarMedia,
  SidebarSubagent,
  SidebarTimelineItem,
  SidebarToolEvent,
} from '../../protocol';
import { isChatLoading, isRunning, requestChatHistory, userImages, viewState } from '../../store';
import { feature } from '../../store/features';
import { AgentMessageRow } from './AgentMessageRow';
import { ExplorerRow } from './ExplorerRow';
import { EditRow, LiveEditDetail } from './EditPreview';
import { InternalIcon, internalLoader } from './internalTools';
import { SubagentStrip, ToolMediaLine } from './MediaLines';
import { QuestionRow } from './QuestionRow';
import { handleMarkdownClick, handleMarkdownKeyDown, renderMarkdown } from './markdown';
import './timeline.css';

type ToolLike = Pick<SidebarToolEvent, 'title' | 'detail' | 'full' | 'kind'> & {
  state: SidebarToolEvent['state'];
  internal?: SidebarInternalTool;
  media?: SidebarMedia[];
};

const explorerProfile = 'explorer';
const noMediaIds: ReadonlySet<string> = new Set();

function isExplorer(chatId: string, agentId: string): boolean {
  return viewState.subagents[chatId]?.[agentId]?.profile === explorerProfile;
}

type FeedItem =
  | Exclude<SidebarTimelineItem, { kind: 'tool' } | { kind: 'diff' }>
  | { id: string; kind: 'toolbatch'; tools: SidebarToolEvent[] }
  | { id: string; kind: 'edit'; event: SidebarToolEvent };

/**
 * Attachments arrive as their own `mediaMessage` entry (`user-media:<turn>` or `history-media:<index>`), not on the
 * user message. Pair them by id so the bubble can show them inline, and hide the standalone media row.
 */
function pairUserMedia(timeline: SidebarTimelineItem[]): {
  media: Map<string, MediaItem[]>;
  hidden: Set<string>;
} {
  const userMessages = new Set(
    timeline.filter(entry => entry.kind === 'message' && entry.role === 'user').map(entry => entry.id),
  );
  const media = new Map<string, MediaItem[]>();
  const hidden = new Set<string>();
  for (const entry of timeline) {
    if (entry.kind !== 'media') continue;
    const match = /^(user|history)-media:(.+)$/.exec(entry.id);
    if (!match) continue;
    const messageId = `${match[1]}:${match[2]}`;
    // An image-only send has no user message, so leave its media row standing rather than hiding it.
    if (!userMessages.has(messageId)) continue;
    media.set(messageId, [...(media.get(messageId) || []), ...entry.items]);
    hidden.add(entry.id);
  }
  return { media, hidden };
}

function feedItems(timeline: SidebarTimelineItem[], hiddenMedia: ReadonlySet<string>): FeedItem[] {
  const items: FeedItem[] = [];
  const editRows = feature('chats.liveEditPreview');
  for (const entry of timeline) {
    if (entry.kind === 'tool') {
      if (entry.event.kind === 'subagent') continue;
      if (entry.event.kind === 'edit' && editRows) {
        items.push({ id: entry.id, kind: 'edit', event: entry.event });
        continue;
      }
      const last = items[items.length - 1];
      if (last?.kind === 'toolbatch') last.tools.push(entry.event);
      else items.push({ id: `batch:${entry.id}`, kind: 'toolbatch', tools: [entry.event] });
    } else if (entry.kind !== 'diff' && !hiddenMedia.has(entry.id)) {
      items.push(entry);
    }
  }
  return items;
}

/**
 * The engine appends the names of non-image attachments to the echoed text as a final `[Files: …]` line. Split it
 * off so the bubble can show real attachment chips (and so image names the media already covers do not repeat).
 */
function splitFilesMarker(text: string): { text: string; files: string[] } {
  const match = /(?:^|\n\n)\[Files: ([\s\S]*)\]\s*$/.exec(text);
  if (!match) return { text, files: [] };
  const files = match[1].split(/,\s+/).map(name => name.trim()).filter(Boolean);
  if (!files.length) return { text, files: [] };
  return { text: text.slice(0, match.index).trimEnd(), files };
}

/* Tool rows */

function toolGlyph(tool: ToolLike): IconName {
  if (tool.state === 'error') return 'close';
  if (tool.state === 'cancelled') return 'stop';
  if (tool.kind === 'search') return 'search';
  return 'check';
}

/** The call as the agent made it (shown on hover, and when an internal row is opened). */
function rawCall(tool: ToolLike): string {
  return tool.full || tool.title + (tool.detail ? ` ${tool.detail}` : '');
}

function ToolGlyph(props: { tool: ToolLike }): JSX.Element {
  const internal = () => props.tool.internal;
  return (
    <span class="tool-glyph">
      <Switch fallback={<Icon name={toolGlyph(props.tool)} size={12} />}>
        <Match when={props.tool.state === 'running'}>
          <Loader
            id={internal() ? internalLoader[internal()!.kind] : actionLoader[toolAction(props.tool)]}
            size={12}
          />
        </Match>
        <Match when={props.tool.state === 'complete' && internal()}>
          {current => <InternalIcon kind={current().kind} />}
        </Match>
      </Switch>
    </span>
  );
}

/** One call on one line. An internal call shows what it really did; the raw call stays in the tooltip. */
export function ToolRow(props: { tool: ToolLike; class?: string; trailing?: JSX.Element }): JSX.Element {
  const title = () => props.tool.internal?.label ?? props.tool.title;
  const detail = () => (props.tool.internal ? props.tool.internal.detail : props.tool.detail);
  return (
    <div
      class={props.class ? `tool-row ${props.class}` : 'tool-row'}
      classList={{
        [`tool-${props.tool.state}`]: true,
        'tool-internal': !!props.tool.internal,
      }}
      ref={element => tooltip(element, () => <span class="type-mono tool-tip">{rawCall(props.tool)}</span>, { placement: 'top-start', delay: 600 })}
    >
      <ToolGlyph tool={props.tool} />
      <span class="tool-row-title">{title()}</span>
      <Show when={detail()}>
        {text => <span class="tool-row-detail">{text().replace(/\s+/g, ' ')}</span>}
      </Show>
      {props.trailing}
    </div>
  );
}

/** A tool row in a feed or list. An internal call opens to the raw call underneath, on a guide line. */
function ToolEntry(props: { tool: ToolLike; class?: string }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <Show
      when={props.tool.internal}
      fallback={
        <ToolRow
          tool={props.tool}
          class={props.class}
        />
      }
    >
      <div class="tool-entry">
        <button
          type="button"
          class="tool-row-button"
          aria-expanded={open()}
          aria-label={open() ? 'Hide the raw call' : 'Show the raw call'}
          onClick={() => setOpen(!open())}
        >
          <ToolRow
            tool={props.tool}
            class={props.class}
            trailing={
              <Icon
                name="chevronRight"
                size={12}
                class="tool-batch-chevron"
                style={{ rotate: open() ? '90deg' : '0deg' }}
              />
            }
          />
        </button>
        <Collapse open={open()}>
          <div class="tool-raw-slot">
            <pre class="tool-raw type-mono">{rawCall(props.tool)}</pre>
          </div>
        </Collapse>
      </div>
    </Show>
  );
}

/** Images the calls gave the agent, once per image, when `chats.toolImages` is on. */
function toolMedia(tools: ToolLike[]): MediaItem[] {
  if (!feature('chats.toolImages')) {
    return [];
  }
  return uniqueMedia(tools.flatMap(tool => tool.media ?? []));
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
            <ToolEntry tool={tool} />
            <Show when={tool.children?.length}>
              <div class="tool-children">
                <For each={tool.children}>
                  {child => (
                    <ToolEntry
                      tool={{ ...child, kind: childKind(child) }}
                      class="tool-child"
                    />
                  )}
                </For>
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
  // The prints sit under the batch (not under each call), so they stay put when the batch opens or closes.
  const media = createMemo(() => toolMedia(props.item.tools));
  // A batch call counts as its children, so "Batch · 2 calls" never shows a count of 1.
  const callCount = () => props.item.tools.reduce((total, tool) => total + (tool.children?.length || 1), 0);
  return (
    <div class="feed-entry tool-batch">
      <Show when={!single()} fallback={<ToolEntry tool={last()} />}>
        <button
          type="button"
          class="tool-batch-head"
          aria-expanded={expanded()}
          aria-label={expanded() ? 'Collapse tool calls' : 'Expand tool calls'}
          onClick={() => setExpanded(!expanded())}
        >
          <Show when={!expanded()} fallback={<span class="tool-row-title">{callCount()} tool calls</span>}>
            <ToolRow tool={last()} class="tool-ticker" />
          </Show>
          <span class="tool-count">{callCount()}</span>
          <Icon name="chevronRight" size={12} class="tool-batch-chevron" style={{ rotate: expanded() ? '90deg' : '0deg' }} />
        </button>
        <Collapse open={expanded()}>
          <ToolList tools={props.item.tools} />
        </Collapse>
      </Show>
      <Show when={media().length}>
        <ToolMediaLine media={media()} />
      </Show>
    </div>
  );
}

/* Messages */

function UserMessage(props: {
  chatId: string;
  item: Extract<FeedItem, { kind: 'message' }>;
  media: MediaItem[];
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  let editor: HTMLTextAreaElement | undefined;
  const thumbs = new Map<string, HTMLElement>();
  const legacyImages = (): MediaItem[] =>
    (userImages()[props.item.id] || [])
      .filter(image => image.mimeType.startsWith('image/'))
      .map(image => ({ name: image.name, mimeType: image.mimeType, file: `data:${image.mimeType};base64,${image.data}` }));
  // Backend media wins when it is there; the store's sent-image copy keeps older engines working before it arrives.
  const images = createMemo((): MediaItem[] => {
    const received = props.media.filter(isImage);
    return uniqueMedia(received.length ? received : legacyImages());
  });
  const parts = createMemo(() => {
    const parsed = splitFilesMarker(props.item.text);
    const imageNames = new Set(images().map(image => image.name));
    return { text: parsed.text, files: parsed.files.filter(name => !imageNames.has(name)) };
  });
  const openImage = (image: MediaItem) => {
    const items = images();
    const index = items.findIndex(item => mediaKey(item) === mediaKey(image));
    openMediaViewer({ items, index: Math.max(0, index), origin: at => thumbs.get(mediaKey(items[at])) });
  };
  const save = () => {
    const text = editor?.value.trim();
    if (text) {
      // Keep non-image attachment names when editing; the engine only re-adds them on a fresh send.
      const files = parts().files;
      post({
        type: 'editMessage',
        sessionId: props.chatId,
        entryId: props.item.id,
        text: files.length ? `${text}\n\n[Files: ${files.join(', ')}]` : text,
        chatId: props.chatId,
      });
    }
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
              value={parts().text}
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
        <Show when={feature('chats.imagesInBubble') && images().length}>
          <div class="bubble-images">
            <For each={images()}>
              {image => (
                <button
                  type="button"
                  class="bubble-image"
                  title={image.name}
                  aria-label={`View ${image.name}`}
                  ref={element => thumbs.set(mediaKey(image), element)}
                  onClick={() => openImage(image)}
                >
                  <img src={thumbSource(image)} alt="" {...imageDragProps(() => image.file, () => image.name)} />
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={parts().text}>
          <div class="message-content">{parts().text}</div>
        </Show>
        <Show when={parts().files.length}>
          <div class="bubble-files">
            <For each={parts().files}>
              {name => (
                <span class="bubble-file" title={name}>
                  <Icon name="file" size={12} />
                  <span class="bubble-file-name">{name}</span>
                </span>
              )}
            </For>
          </div>
        </Show>
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
  return (
    <div
      class="feed-entry assistant markdown"
      innerHTML={renderMarkdown(props.text)}
      onClick={handleMarkdownClick}
      onKeyDown={handleMarkdownKeyDown}
    />
  );
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
          <Show when={props.item.canAlwaysAllow}>
            <Button
              variant="text"
              onClick={() => post({ type: 'approvalResponse', id: id(), allow: true, always: true })}
            >
              Always allow
            </Button>
          </Show>
          <Button variant="secondary" onClick={() => post({ type: 'approvalResponse', id: id(), allow: false })}>Deny</Button>
        </div>
      </Collapse>
    </div>
  );
}

/* Media, notes, subagents */

/** Images open the full viewer from where they sit; other files open with the OS. */
function MediaEntry(props: { item: Extract<FeedItem, { kind: 'media' }>; sender?: string }): JSX.Element {
  const thumbs = new Map<string, HTMLElement>();
  const open = (media: MediaItem) => {
    if (!isImage(media)) {
      post({ type: 'openMedia', file: media.file });
      return;
    }
    const images = props.item.items.filter(isImage);
    openMediaViewer({
      items: images,
      index: images.indexOf(media),
      sender: props.sender,
      origin: index => thumbs.get(mediaKey(images[index])),
    });
  };
  return (
    <div class="feed-entry assistant media-entry" classList={{ generated: !!props.item.generated }}>
      <Show when={props.item.caption}>
        <div
          class="markdown"
          innerHTML={renderMarkdown(props.item.caption!)}
          onClick={handleMarkdownClick}
          onKeyDown={handleMarkdownKeyDown}
        />
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
                <button
                  type="button"
                  class="media-thumb"
                  title={media.name}
                  ref={element => thumbs.set(mediaKey(media), element)}
                  onClick={() => open(media)}
                >
                  <Show when={isImage(media)} fallback={<span class="media-file"><Icon name="file" size={14} />{media.name}</span>}>
                    <img
                      src={props.item.generated ? thumbSource(media) : media.file}
                      alt={media.name}
                      {...imageDragProps(() => media.file, () => media.name)}
                    />
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

function SubagentEntry(props: {
  chatId: string;
  agentId: string;
  parentMedia: Accessor<ReadonlySet<string>>;
  onOpen: (agentId: string) => void;
}): JSX.Element {
  const agent = () => viewState.subagents[props.chatId]?.[props.agentId];
  return (
    <Show when={agent()}>
      {current => (
        <Show
          when={current().profile !== explorerProfile}
          fallback={<ExplorerRow agent={current()} />}
        >
          <SubagentRow
            agent={current()}
            parentMedia={props.parentMedia}
            onOpen={() => props.onOpen(props.agentId)}
          />
        </Show>
      )}
    </Show>
  );
}

/**
 * A subagent in the parent chat. With `chats.subagentImageStrip` on, it grows a strip of the images it sent the
 * main agent (as they arrive), leaving out any this chat already shows inline.
 */
function SubagentRow(props: {
  agent: SidebarSubagent;
  parentMedia: Accessor<ReadonlySet<string>>;
  onOpen: () => void;
}): JSX.Element {
  const strip = createMemo(() => {
    if (!feature('chats.subagentImageStrip')) {
      return [];
    }
    return uniqueMedia(props.agent.sentToParent ?? [], props.parentMedia());
  });
  const liveEdit = createMemo(() => (feature('chats.liveEditPreview') ? subagentLiveEdit(props.agent) : undefined));
  return (
    <div class="feed-entry subagent-entry">
      <button type="button" class="subagent-row" onClick={() => props.onOpen()}>
        <span class="tool-glyph">
          <Switch fallback={<Icon name="check" size={12} />}>
            <Match when={props.agent.state === 'running'}>
              <Loader id={actionLoader[props.agent.delegated ? 'delegating' : 'spawning']} size={12} />
            </Match>
            <Match when={props.agent.state === 'error'}>
              <Icon name="close" size={12} />
            </Match>
            <Match when={props.agent.state === 'cancelled'}>
              <Icon name="stop" size={12} />
            </Match>
          </Switch>
        </span>
        <span class="subagent-title">{props.agent.title}</span>
        <Show when={props.agent.model}>
          <span class="subagent-model">{props.agent.model}</span>
        </Show>
        <LiveEditDetail
          edit={liveEdit()}
          text={subagentDetail(props.agent)}
        />
        <Icon name="chevronRight" size={12} />
      </button>
      <Collapse open={strip().length > 0}>
        <SubagentStrip
          media={strip()}
          sender={props.agent.title}
        />
      </Collapse>
    </div>
  );
}

type SubagentMessage = SidebarSubagent['messages'][number];

/** The edit a running subagent is making right now: its latest tool call, while that call is an edit still running. */
function subagentLiveEdit(agent: SidebarSubagent): SidebarEditPreview | undefined {
  if (agent.state !== 'running') return undefined;
  for (let index = agent.messages.length - 1; index >= 0; index -= 1) {
    const message = agent.messages[index];
    if (message.role !== 'tool' || !message.tool) continue;
    const edit = message.tool.edit;
    if (!edit) return undefined;
    return message.tool.state === 'running' || (message.tool.state === undefined && edit.streaming) ? edit : undefined;
  }
  return undefined;
}

/** A subagent tool call's state: only edit calls send one; a call still "running" when the agent stopped did not finish. */
function subagentToolState(agent: SidebarSubagent, tool: NonNullable<SubagentMessage['tool']>): SidebarToolEvent['state'] {
  const state = tool.state ?? (tool.edit?.streaming ? 'running' : 'complete');
  if (state !== 'running' || agent.state === 'running') return state;
  return agent.state === 'cancelled' || agent.state === 'error' ? 'cancelled' : 'complete';
}

/** Edit calls get the live edit row when `chats.liveEditPreview` is on. */
function isEditRow(tool: NonNullable<SubagentMessage['tool']>): boolean {
  return tool.kind === 'edit' && feature('chats.liveEditPreview');
}

/** A message's images as an inline media entry (send_media and the like), captioned by its text. */
function messageMedia(message: SubagentMessage, caption: boolean): Extract<FeedItem, { kind: 'media' }> {
  return {
    id: `media:${message.id}`,
    kind: 'media',
    caption: caption && message.text ? message.text : undefined,
    items: message.media ?? [],
  };
}

function SubagentToolEntry(props: { tool: ToolLike }): JSX.Element {
  const media = createMemo(() => toolMedia([props.tool]));
  return (
    <div class="feed-entry tool-batch">
      <ToolEntry tool={props.tool} />
      <Show when={media().length}>
        <ToolMediaLine media={media()} />
      </Show>
    </div>
  );
}

/** The static bar above the timeline scroller while a subagent's feed is open. Lives outside the scroller so it never scrolls. */
function SubagentBar(props: { agent: SidebarSubagent; onBack: () => void }): JSX.Element {
  return (
    <div class="subagent-bar">
      <button type="button" class="subagent-back" onClick={() => props.onBack()}>
        <Icon name="chevronRight" size={12} style={{ rotate: '180deg' }} />
        <span class="type-label">{props.agent.title}</span>
        <Show when={props.agent.model}>
          <span class="subagent-model">{props.agent.model}</span>
        </Show>
      </button>
    </div>
  );
}

/** A subagent's own feed, shown in place of the chat until "Back". */
function SubagentFeed(props: { agent: SidebarSubagent }): JSX.Element {
  return (
    <div class="feed">
      <Show when={props.agent.prompt}>
        <div class="feed-entry bubble user">
          <div class="message-content">{props.agent.prompt}</div>
        </div>
      </Show>
      <For each={props.agent.messages}>
        {message => (
          <Switch fallback={<AssistantMessage text={message.text} />}>
            <Match when={message.role === 'user'}>
              <div class="feed-entry bubble user">
                <Show when={message.from}>
                  <div class="bubble-from type-caption">From {message.from}</div>
                </Show>
                <div class="message-content">{message.text}</div>
              </div>
            </Match>
            <Match when={message.role === 'tool' && message.tool}>
              {tool => (
                <>
                  <Show
                    when={isEditRow(tool())}
                    fallback={<SubagentToolEntry tool={{ ...tool(), state: subagentToolState(props.agent, tool()) }} />}
                  >
                    <EditRow
                      id={`${props.agent.id}:${message.id}`}
                      tool={{ ...tool(), state: subagentToolState(props.agent, tool()) }}
                    />
                  </Show>
                  <Show when={message.media?.length}>
                    <MediaEntry
                      item={messageMedia(message, false)}
                      sender={props.agent.title}
                    />
                  </Show>
                </>
              )}
            </Match>
            <Match when={message.media?.length}>
              <MediaEntry
                item={messageMedia(message, true)}
                sender={props.agent.title}
              />
            </Match>
          </Switch>
        )}
      </For>
    </div>
  );
}

/* Feed */

type AgentMessageEntry = Extract<FeedItem, { kind: 'agentMessage' }>;

/** Agent messages are hidden when the setting is off, and never shown for explorer runs (they are lookups). */
function showAgentMessage(chatId: string, entry: AgentMessageEntry): boolean {
  if (!feature('agents.messaging.showInChat')) {
    return false;
  }
  return !isExplorer(chatId, entry.message.fromId) && !isExplorer(chatId, entry.message.toId);
}

function FeedRow(props: {
  chatId: string;
  item: Accessor<FeedItem | undefined>;
  userMedia: Accessor<ReadonlyMap<string, MediaItem[]>>;
  parentMedia: Accessor<ReadonlySet<string>>;
  onOpenSubagent: (id: string) => void;
}): JSX.Element {
  return (
    <Show when={props.item()}>
      {item => (
        <Switch>
          <Match when={item().kind === 'message' && (item() as Extract<FeedItem, { kind: 'message' }>)}>
            {message => (
              <Show when={message().role === 'user'} fallback={<AssistantMessage text={message().text} />}>
                <UserMessage
                  chatId={props.chatId}
                  item={message()}
                  media={props.userMedia().get(message().id) || []}
                />
              </Show>
            )}
          </Match>
          <Match when={item().kind === 'toolbatch' && (item() as Extract<FeedItem, { kind: 'toolbatch' }>)}>
            {batch => <ToolBatch item={batch()} />}
          </Match>
          <Match when={item().kind === 'edit' && (item() as Extract<FeedItem, { kind: 'edit' }>)}>
            {edit => (
              <EditRow
                id={edit().event.id}
                tool={edit().event}
              />
            )}
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
            {subagent => (
              <SubagentEntry
                chatId={props.chatId}
                agentId={subagent().agentId}
                parentMedia={props.parentMedia}
                onOpen={props.onOpenSubagent}
              />
            )}
          </Match>
          <Match when={item().kind === 'agentMessage' && (item() as AgentMessageEntry)}>
            {entry => (
              <Show when={showAgentMessage(props.chatId, entry())}>
                <AgentMessageRow item={entry()} />
              </Show>
            )}
          </Match>
        </Switch>
      )}
    </Show>
  );
}

/** True when the event target is a text field, so Escape belongs to the field rather than the subagent view. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

/** Keys of every image this chat already shows inline: media entries, and tool prints when those are on. */
function inlineMediaKeys(timeline: SidebarTimelineItem[]): ReadonlySet<string> {
  const keys = new Set<string>();
  const toolImages = feature('chats.toolImages');
  for (const entry of timeline) {
    if (entry.kind === 'media') {
      for (const media of entry.items) {
        keys.add(mediaKey(media));
      }
    } else if (toolImages && entry.kind === 'tool' && entry.event.kind !== 'edit' && entry.event.kind !== 'subagent') {
      for (const media of entry.event.media ?? []) {
        keys.add(mediaKey(media));
      }
    }
  }
  return keys;
}

export function Timeline(props: { chatId: string }): JSX.Element {
  const [openedSubagent, setOpenedSubagent] = createSignal('');
  // DEV: `?subagent=<agentId>` opens that subagent's feed so tools/shot.mjs can capture it.
  if (import.meta.env.DEV) {
    const subagent = new URLSearchParams(window.location.search).get('subagent');
    if (subagent) window.setTimeout(() => setOpenedSubagent(subagent), 300);
  }
  let scroller: HTMLDivElement | undefined;
  let stickToBottom = true;

  const feed = createMemo(() => {
    const timeline = viewState.timeline[props.chatId] || [];
    const paired = pairUserMedia(timeline);
    // With the feature off the engine's media row stays where it was; only turn it inline when the bubble shows it.
    const items = feedItems(timeline, feature('chats.imagesInBubble') ? paired.hidden : noMediaIds);
    const byId = new Map(items.map(item => [item.id, item]));
    return { order: items.map(item => item.id), byId, userMedia: paired.media };
  });

  const parentMedia = createMemo(() => inlineMediaKeys(viewState.timeline[props.chatId] || []));

  // A chat restored on screen (app start, pop-out) asks the engine for its history.
  createEffect(() => requestChatHistory(props.chatId));
  const loading = () => isChatLoading(props.chatId) && !feed().order.length;
  // The loader waits a beat so a history that arrives at once does not flash it.
  const [showLoader, setShowLoader] = createSignal(false);
  createEffect(() => {
    if (!loading()) {
      setShowLoader(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoader(true), 150);
    onCleanup(() => window.clearTimeout(timer));
  });

  const openedAgent = () => (openedSubagent() ? viewState.subagents[props.chatId]?.[openedSubagent()] : undefined);
  const subagentOpen = createMemo(() => !!openedAgent());

  // If the open subagent leaves the store (history reloaded, chat changed), fall back to the chat.
  // Only clears once the subagent has been seen, so a feed opened before its data arrives is kept.
  let openedSeen = '';
  createEffect(() => {
    const id = openedSubagent();
    if (!id) return;
    if (viewState.subagents[props.chatId]?.[id]) {
      openedSeen = id;
    } else if (openedSeen === id) {
      setOpenedSubagent('');
    }
  });

  // Opening or leaving a subagent's feed starts the reader at the bottom, like a new chat.
  createEffect(on(openedSubagent, () => {
    stickToBottom = true;
    queueMicrotask(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  }, { defer: true }));

  // Escape goes back while a subagent's feed is open, unless the key is handled elsewhere or typed into a field.
  createEffect(() => {
    if (!subagentOpen()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTypingTarget(event.target)) return;
      setOpenedSubagent('');
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  // Follow new output while the reader is at the bottom (DSH: within 60px).
  createMemo(() => {
    feed();
    JSON.stringify(viewState.timeline[props.chatId]?.at(-1));
    queueMicrotask(() => {
      if (scroller && stickToBottom) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  return (
    <div class="timeline-pane">
      <Show when={openedAgent()}>
        {agent => <SubagentBar agent={agent()} onBack={() => setOpenedSubagent('')} />}
      </Show>
      <div
        class="timeline"
        data-chat-id={props.chatId}
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
              <Show when={!feed().order.length && !loading()}>
                <div class="feed-empty type-caption">Ask about your workspace or request an edit.</div>
              </Show>
              <Presence when={showLoader()} from={0.96}>
                <div class="feed-loading type-caption" role="status">
                  <Loader id={actionLoader.loading} size={16} />
                  <span>Loading history</span>
                </div>
              </Presence>
              <For each={feed().order}>
                {id => (
                  <FeedRow
                    chatId={props.chatId}
                    item={() => feed().byId.get(id)}
                    userMedia={() => feed().userMedia}
                    parentMedia={parentMedia}
                    onOpenSubagent={setOpenedSubagent}
                  />
                )}
              </For>
            </div>
          }
        >
          {agent => <SubagentFeed agent={agent()} />}
        </Show>
      </div>
    </div>
  );
}
