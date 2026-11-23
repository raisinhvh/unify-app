/**
 * One chat in a tiled pane (Figma 12 Chat pane 306:3030, 11 Shell 306:2201).
 *
 *   header    grip (hold-drag to rearrange, see shell/PaneGrid) · title · model picker · pop out · more · close
 *   timeline  Timeline.tsx
 *   status    what the agent is doing right now (loader + label) while it runs
 *   changes   files this turn edited, with review / apply / reject (DSH renderChanges)
 *   composer  Composer.tsx, bound to this chat
 *
 * Pop out is a stub until the backend has a window API for it.
 */
import { createSignal, For, Show, type JSX } from 'solid-js';
import { Button, Icon, IconButton, Loader, Menu, Select, actionLabel, actionLoader, chatAction, type MenuEntry } from '../../components';
import { Collapse } from '../../motion';
import { post } from '../../bridge';
import type { PaneContext } from '../../shell/PaneGrid';
import { markRead, viewState } from '../../store';
import { Composer } from './Composer';
import { modelOptions, selectedModelLabel, selectedModelValue, selectModel } from './models';
import { Timeline } from './Timeline';
import './chat-pane.css';

function StatusLine(props: { chatId: string }): JSX.Element {
  const run = () => viewState.runStates[props.chatId];
  const action = () => chatAction(props.chatId);
  const running = () => (run()?.state || 'idle') !== 'idle';
  return (
    <Collapse open={running()}>
      <div class="chat-status">
        <Loader id={action() ? actionLoader[action()!] : undefined} size={12} />
        <span class="chat-status-label">{action() ? actionLabel[action()!] : 'Working'}</span>
        <Show when={run()?.label}>
          <span class="chat-status-detail">{run()!.label}</span>
        </Show>
      </div>
    </Collapse>
  );
}

/** Pending edits from the engine (DSH renderChanges). Diffs are global in the protocol, so only the focused pane shows them. */
function ChangesBar(props: { visible: boolean }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const pending = () => viewState.diffs.filter(diff => (diff.state || 'pending') === 'pending');
  const additions = () => pending().reduce((sum, diff) => sum + (diff.additions || 0), 0);
  const deletions = () => pending().reduce((sum, diff) => sum + (diff.deletions || 0), 0);
  return (
    <Collapse open={props.visible && pending().length > 0}>
      <div class="changes">
        <div class="changes-head">
          <button type="button" class="changes-toggle" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>
            <Icon name="chevronRight" size={12} style={{ rotate: expanded() ? '90deg' : '0deg' }} class="changes-chevron" />
            <span>{pending().length === 1 ? '1 file changed' : `${pending().length} files changed`}</span>
            <span class="diff-add">+{additions()}</span>
            <span class="diff-del">−{deletions()}</span>
          </button>
          <Button variant="text" onClick={() => post({ type: 'reviewAll' })}>Review</Button>
          <Button variant="text" onClick={() => post({ type: 'rejectAll' })}>Reject all</Button>
          <Button variant="secondary" onClick={() => post({ type: 'applyAll' })}>Apply all</Button>
        </div>
        <Collapse open={expanded()}>
          <div class="changes-list">
            <For each={pending()}>
              {diff => (
                <div class="changes-row">
                  <button type="button" class="changes-path" title={diff.summary} onClick={() => post({ type: 'openDiff', diffId: diff.id })}>
                    {diff.path}
                  </button>
                  <span class="diff-add">+{diff.additions || 0}</span>
                  <span class="diff-del">−{diff.deletions || 0}</span>
                  <IconButton icon="close" label="Reject" size="small" onClick={() => post({ type: 'rejectDiff', diffId: diff.id })} />
                  <IconButton icon="check" label="Apply" size="small" onClick={() => post({ type: 'applyDiff', diffId: diff.id })} />
                </div>
              )}
            </For>
          </div>
        </Collapse>
      </div>
    </Collapse>
  );
}

export function ChatPane(props: { context: PaneContext }): JSX.Element {
  const chatId = () => props.context.chatId;
  const session = () => viewState.sessions.find(item => item.id === chatId());
  const [moreOpen, setMoreOpen] = createSignal(false);
  const [moreAnchor, setMoreAnchor] = createSignal<HTMLButtonElement>();
  const [renaming, setRenaming] = createSignal(false);

  const moreItems = (): MenuEntry[] => [
    { id: 'rename', label: 'Rename' },
    { kind: 'separator' },
    { id: 'delete', label: 'Delete chat', danger: true },
  ];

  const onMore = (id: string) => {
    setMoreOpen(false);
    if (id === 'rename') setRenaming(true);
    if (id === 'delete') post({ type: 'deleteSession', sessionId: chatId() });
  };

  const commitRename = (value: string) => {
    const name = value.trim();
    setRenaming(false);
    if (name && name !== session()?.name) post({ type: 'renameSession', sessionId: chatId(), name });
  };

  return (
    <div class="chat-pane" onPointerDown={() => markRead(chatId())}>
      <header class="chat-pane-header">
        <span
          class="chat-pane-grip"
          data-drag-handle
          aria-label="Drag to rearrange"
          onPointerDown={event => props.context.startDrag(event)}
        >
          <Icon name="grip" size={14} />
        </span>
        <Show
          when={!renaming()}
          fallback={
            <input
              class="chat-pane-rename type-heading"
              value={session()?.name || ''}
              ref={element => queueMicrotask(() => element.select())}
              onBlur={event => commitRename(event.currentTarget.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') commitRename(event.currentTarget.value);
                if (event.key === 'Escape') setRenaming(false);
              }}
            />
          }
        >
          <h3
            class="chat-pane-title type-heading"
            onPointerDown={event => props.context.startDrag(event)}
            onDblClick={() => setRenaming(true)}
          >
            {session()?.name || 'New chat'}
          </h3>
        </Show>
        <span class="chat-pane-spacer" onPointerDown={event => props.context.startDrag(event)} />
        <Select
          class="chat-pane-model"
          value={selectedModelValue()}
          display={selectedModelLabel()}
          options={modelOptions()}
          onChange={value => selectModel(value, chatId())}
          placement="bottom-end"
          title="Choose model"
        />
        <IconButton icon="pop" label="Pop out (coming soon)" size="small" disabled />
        <IconButton ref={setMoreAnchor} icon="more" label="More" size="small" active={moreOpen()} onClick={() => setMoreOpen(!moreOpen())} />
        <IconButton icon="close" label="Close pane" size="small" onClick={() => props.context.close()} />
      </header>
      <Timeline chatId={chatId()} />
      <div class="chat-pane-bottom">
        <StatusLine chatId={chatId()} />
        <ChangesBar visible={props.context.focused()} />
        <Composer chatId={chatId()} placeholder="Reply, @ to mention a file" />
      </div>
      <Menu anchor={moreAnchor()} open={moreOpen()} onClose={() => setMoreOpen(false)} placement="bottom-end" items={moreItems()} onSelect={onMore} />
    </div>
  );
}
