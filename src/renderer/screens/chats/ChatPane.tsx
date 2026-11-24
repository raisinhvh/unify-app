/**
 * One chat in a tiled pane (Figma 12 Chat pane 306:3030, 11 Shell 306:2201).
 *
 *   header    grip (hold-drag to rearrange, see shell/PaneGrid) · title · working folder · model picker · pop out ·
 *             more · close
 *   job       JobBar.tsx: the chat's /job run (round, phase, criteria), only while it has one
 *   timeline  Timeline.tsx
 *   status    what the agent is doing right now (loader + label) while it runs
 *   changes   files this chat edited, with review / keep / undo (DSH renderChanges); every pane shows its own chat's
 *   composer  Composer.tsx, bound to this chat
 *
 * Pop out (only where the bridge has `popOut`) moves the chat into its own window and closes this pane.
 * A standalone context (the pop-out window, Popout.tsx) hides the grip and the pop-out button.
 */
import { createSignal, For, Show, type JSX } from 'solid-js';
import { Button, Icon, IconButton, Loader, Menu, actionLabel, actionLoader, chatAction, type MenuEntry } from '../../components';
import { Collapse } from '../../motion';
import { bridge, post } from '../../bridge';
import type { PaneContext } from '../../shell/PaneGrid';
import { markRead, viewState } from '../../store';
import { ModelPicker } from '../../components/ModelPicker';
import type { SidebarProject } from '../../protocol';
import { openProjectInFiles } from '../../shell/fileLinks';
import { feature } from '../../store/features';
import { shortPath } from './projects';
import { Composer } from './Composer';
import { JobBar } from './JobBar';
import { ScheduleBar } from './ScheduleBar';
import { ShutdownBar } from './ShutdownBar';
import { NoQuestionsBar } from './NoQuestionsBar';
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

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/**
 * This chat's edits (DSH renderChanges), from the engine's per-chat `chatDiffState`. Edits are applied as the agent
 * makes them, so most rows are "applied": Keep settles one, Undo reverts it. Rows not applied yet offer Apply / Reject.
 */
function ChangesBar(props: { chatId: string }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const pending = () => (viewState.chatDiffs?.[props.chatId] ?? []).filter(diff => diff.state !== 'rejected');
  const allApplied = () => pending().every(diff => diff.state === 'applied');
  const send = (message: { type: 'reviewAll' | 'rejectAll' | 'applyAll' } | { type: 'openDiff' | 'applyDiff' | 'rejectDiff'; diffId: string }) =>
    post({ ...message, chatId: props.chatId });
  const additions = () => pending().reduce((sum, diff) => sum + (diff.additions || 0), 0);
  const deletions = () => pending().reduce((sum, diff) => sum + (diff.deletions || 0), 0);
  return (
    <Collapse open={pending().length > 0}>
      <div class="changes">
        <div class="changes-head">
          <button type="button" class="changes-toggle" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>
            <Icon name="chevronRight" size={12} style={{ rotate: expanded() ? '90deg' : '0deg' }} class="changes-chevron" />
            <Show
              when={pending().length <= 2}
              fallback={
                <span class="changes-file">
                  <span class="changes-name">Multiple files</span>
                  <span class="diff-add">+{additions()}</span>
                  <span class="diff-del">−{deletions()}</span>
                </span>
              }
            >
              <For each={pending()}>
                {diff => (
                  <span class="changes-file" title={diff.path}>
                    <span class="changes-name">{fileName(diff.path)}</span>
                    <span class="diff-add">+{diff.additions || 0}</span>
                    <span class="diff-del">−{diff.deletions || 0}</span>
                  </span>
                )}
              </For>
            </Show>
          </button>
          <Button variant="text" onClick={() => send({ type: 'reviewAll' })}>Review</Button>
          <Button variant="text" onClick={() => send({ type: 'rejectAll' })}>{allApplied() ? 'Undo all' : 'Reject all'}</Button>
          <Button variant="secondary" onClick={() => send({ type: 'applyAll' })}>{allApplied() ? 'Keep all' : 'Apply all'}</Button>
        </div>
        <Collapse open={expanded()}>
          <div class="changes-list">
            <For each={pending()}>
              {diff => {
                const applied = () => diff.state === 'applied';
                return (
                  <div class="changes-row">
                    <button type="button" class="changes-path" title={diff.summary} onClick={() => send({ type: 'openDiff', diffId: diff.id })}>
                      {diff.path}
                    </button>
                    <span class="diff-add">+{diff.additions || 0}</span>
                    <span class="diff-del">−{diff.deletions || 0}</span>
                    <IconButton icon="close" label={applied() ? 'Undo' : 'Reject'} size="small" onClick={() => send({ type: 'rejectDiff', diffId: diff.id })} />
                    <IconButton icon="check" label={applied() ? 'Keep' : 'Apply'} size="small" onClick={() => send({ type: 'applyDiff', diffId: diff.id })} />
                  </div>
                );
              }}
            </For>
          </div>
        </Collapse>
      </div>
    </Collapse>
  );
}

/**
 * The folder the agent works in, beside the title: the project's last two segments ("Programs/Unify"), full path in
 * the tooltip. Clicking shows it in the Files pane (not in pop-outs, which have no panes). No project means the
 * chat runs in its own scratch folder.
 */
function ChatFolder(props: { project: SidebarProject | undefined; standalone: boolean }): JSX.Element {
  const path = () => props.project?.path || '';
  const clickable = () => !!path() && !props.standalone && feature('editor.enabled');
  return (
    <button
      type="button"
      class="chat-pane-dir"
      classList={{ static: !clickable() }}
      title={path() ? (clickable() ? `${path()}\nShow in Files` : path()) : 'No folder: this chat works in its own scratch folder'}
      tabIndex={clickable() ? 0 : -1}
      onClick={() => {
        if (clickable() && props.project) openProjectInFiles(props.project);
      }}
    >
      <Icon name="folder" size={12} />
      <span class="chat-pane-dir-path">{path() ? shortPath(path()) : 'No folder'}</span>
    </button>
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

  const canPopOut = () => !props.context.standalone && !!bridge().popOut;
  const popOut = () => {
    bridge().popOut!(chatId());
    props.context.close();
  };

  const commitRename = (value: string) => {
    const name = value.trim();
    setRenaming(false);
    if (name && name !== session()?.name) post({ type: 'renameSession', sessionId: chatId(), name });
  };

  return (
    <div class="chat-pane" onPointerDown={() => markRead(chatId())}>
      <header
        class="chat-pane-header"
        classList={{ standalone: !!props.context.standalone }}
      >
        <Show when={!props.context.standalone}>
          <span
            class="chat-pane-grip"
            data-drag-handle
            aria-label="Drag to rearrange"
            onPointerDown={event => props.context.startDrag(event)}
          >
            <Icon name="grip" size={14} />
          </span>
        </Show>
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
        <Show when={!renaming()}>
          <ChatFolder project={session()?.project} standalone={!!props.context.standalone} />
        </Show>
        <span class="chat-pane-spacer" onPointerDown={event => props.context.startDrag(event)} />
        <ModelPicker
          class="chat-pane-model"
          chatId={chatId()}
          variant="compact"
          placement="bottom-end"
          title="Model"
        />
        <div class="chat-pane-actions">
          <Show when={canPopOut()}>
            <IconButton
              class="chat-pane-popout"
              icon="pop"
              label="Pop out"
              size="small"
              onClick={popOut}
            />
          </Show>
          <IconButton ref={setMoreAnchor} icon="more" label="More" size="small" active={moreOpen()} onClick={() => setMoreOpen(!moreOpen())} />
          <IconButton icon="close" label="Close pane" size="small" onClick={() => props.context.close()} />
        </div>
      </header>
      <JobBar chatId={chatId()} />
      <Timeline chatId={chatId()} />
      <div class="chat-pane-bottom">
        <StatusLine chatId={chatId()} />
        <ChangesBar chatId={chatId()} />
        <ScheduleBar chatId={chatId()} />
        <ShutdownBar />
        <NoQuestionsBar />
        <Composer chatId={chatId()} placeholder="Reply, @ to mention a file" />
      </div>
      <Menu anchor={moreAnchor()} open={moreOpen()} onClose={() => setMoreOpen(false)} placement="bottom-end" items={moreItems()} onSelect={onMore} />
    </div>
  );
}
