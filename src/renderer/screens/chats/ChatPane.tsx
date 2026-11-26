/**
 * One chat in a tiled pane (Figma 12 Chat pane 306:3030, 11 Shell 306:2201).
 *
 *   header    grip (hold-drag to rearrange, see shell/PaneGrid) · title · working folder · model picker · pop out ·
 *             more · close
 *   job       JobBar.tsx: the chat's /job run (round, phase, criteria), only while it has one
 *   timeline  Timeline.tsx
 *   status    what the agent is doing right now (loader + label) while it runs
 *   changes   files this chat edited, with review / keep / undo (DSH renderChanges); every pane shows its own chat's.
 *             No card: a hairline above it, and it opens upward into a list like a tool batch
 *   composer  Composer.tsx, bound to this chat; `autoHide`: the box shows while the pointer is over the pane and
 *             otherwise tucks into a faint bottom line with the running subagent / background counts
 *   quote     QuoteSelection.tsx: selecting text in an agent reply offers "Quote", which adds it to the composer
 *
 * Everything under the header follows the pane text-size rule (shell/paneScale.tsx): narrower than full size it
 * scales down instead of wrapping, to 0.8× at most.
 *
 * Pop out (only where the bridge has `popOut`) moves the chat into its own window and closes this pane.
 * A standalone context (the pop-out window, Popout.tsx) hides the grip and the pop-out button.
 */
import { createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Button, Icon, IconButton, Loader, Menu, actionLabel, actionLoader, chatAction, type MenuEntry } from '../../components';
import { Collapse } from '../../motion';
import { bridge, post } from '../../bridge';
import type { PaneContext } from '../../shell/PaneGrid';
import { agentName, markRead, viewState } from '../../store';
import { tooltip } from '../../components/Tooltip';
import { ModelPicker } from '../../components/ModelPicker';
import type { SidebarProject } from '../../protocol';
import { openProjectInFiles } from '../../shell/fileLinks';
import { paneFullWidth, ScaleToWidth } from '../../shell/paneScale';
import { feature } from '../../store/features';
import { shortPath } from './projects';
import { Composer, type ComposerApi } from './Composer';
import { JobBar } from './JobBar';
import { ScheduleBar } from './ScheduleBar';
import { QuoteSelection } from './QuoteSelection';
import { Timeline } from './Timeline';
import { openedSubagent } from './subagentView';
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
      {/* No card: a hairline separates it from the feed, and it opens upward like a tool batch. */}
      <div class="changes">
        <div class="changes-head">
          <button type="button" class="changes-toggle" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>
            <Show
              when={pending().length <= 2}
              fallback={
                <span class="changes-file">
                  <span class="changes-name">{pending().length} files changed</span>
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
            <Icon name="chevronRight" size={12} style={{ rotate: expanded() ? '90deg' : '0deg' }} class="changes-chevron" />
          </button>
          <Button variant="text" onClick={() => send({ type: 'reviewAll' })}>Review</Button>
          <Button variant="text" onClick={() => send({ type: 'rejectAll' })}>{allApplied() ? 'Undo all' : 'Reject all'}</Button>
          <Button variant="text" onClick={() => send({ type: 'applyAll' })}>{allApplied() ? 'Keep all' : 'Apply all'}</Button>
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
 * A small paper icon beside the title; hovering it shows the messaging name ("Name: Kernel") of the agent the pane
 * shows: the chat's own agent, or the subagent whose feed is open, plus that subagent's profile ("Opus (High)").
 * It is the only place a subagent's name and profile appear; its row and feed bar show just the model.
 * Hidden until a name is known.
 */
function AgentNameTag(props: { chatId: string }): JSX.Element {
  const opened = () => {
    const openedId = openedSubagent(props.chatId);
    return openedId ? viewState.subagents[props.chatId]?.[openedId] : undefined;
  };
  const name = () => {
    const openedId = openedSubagent(props.chatId);
    if (!openedId) return agentName(props.chatId);
    return opened()?.name || agentName(openedId);
  };
  const profile = () => opened()?.title;
  return (
    <Show when={name()}>
      <span
        class="chat-pane-agent"
        aria-label={profile() ? `Name: ${name()}, profile: ${profile()}` : `Name: ${name()}`}
        ref={element => tooltip(element, () => (
          <span>
            Name: <strong>{name()}</strong>
            <Show when={profile()}>
              {' · '}Profile: <strong>{profile()}</strong>
            </Show>
          </span>
        ), { rich: false, delay: 200 })}
      >
        <Icon name="file" size={12} />
      </span>
    </Show>
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
  const [paneElement, setPaneElement] = createSignal<HTMLDivElement>();
  let composer: ComposerApi | undefined;

  // The composer shows while the pointer is over this pane. Popovers and menus are portaled out of the pane, so
  // moving onto one (the composer's model menu) keeps the current state; leaving the window hides it.
  const [hovered, setHovered] = createSignal(false);
  onMount(() => {
    const onPointerOver = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || target.closest?.('.popover')) return;
      setHovered(!!paneElement()?.contains(target));
    };
    const onPointerOut = (event: PointerEvent) => {
      if (!event.relatedTarget) setHovered(false);
    };
    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', onPointerOut);
    onCleanup(() => {
      document.removeEventListener('pointerover', onPointerOver);
      document.removeEventListener('pointerout', onPointerOut);
    });
  });

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
    <div
      ref={setPaneElement}
      class="chat-pane"
      onPointerDown={() => markRead(chatId())}
      onDragEnter={() => setHovered(true)}
    >
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
        <AgentNameTag chatId={chatId()} />
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
      {/* Narrower than full size, everything under the header shrinks instead of wrapping (shell/paneScale). */}
      <ScaleToWidth fullWidth={paneFullWidth.chat} class="chat-pane-scale">
        <JobBar chatId={chatId()} />
        <Timeline chatId={chatId()} />
        <div class="chat-pane-bottom">
          <StatusLine chatId={chatId()} />
          <ChangesBar chatId={chatId()} />
          <ScheduleBar chatId={chatId()} />
          <Composer
            chatId={chatId()}
            placeholder="Reply, @ to mention a file"
            autoHide
            hovered={hovered()}
            ref={api => {
              composer = api;
            }}
          />
        </div>
      </ScaleToWidth>
      <QuoteSelection root={paneElement()} onQuote={text => composer?.quote(text)} />
      <Menu anchor={moreAnchor()} open={moreOpen()} onClose={() => setMoreOpen(false)} placement="bottom-end" items={moreItems()} onSelect={onMore} />
    </div>
  );
}
