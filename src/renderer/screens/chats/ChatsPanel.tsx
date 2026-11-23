/**
 * The Chats side panel (Figma 14 Chats panel 306:1433, and the left of 11 Shell 306:2201).
 *
 *   header      "Chats" + new chat
 *   search      filters every group by name; Ctrl K focuses it
 *   Active      chats that run, need you, or finished unread — DSH's activity rail ordering (store/activity.ts)
 *   projects    one folder per project, newest first; 5 chats, then "Show N more"
 *
 * Click opens the chat in the focused pane; Ctrl/⌘-click or middle-click opens it beside the others.
 *
 * Organic motion (motion.organic.*): a renamed chat backspaces and retypes its title, a chat that moves up in
 * Active lifts, travels and settles, and the counts roll like an odometer.
 */
import { createMemo, createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { ChatLoader, Icon, IconButton, tooltip, TreeFolder, TreeItem } from '../../components';
import { AnimatedList, Collapse } from '../../motion';
import { liftMoves, RetypeText, RollingNumber } from '../../motion/organic';
import { post } from '../../bridge';
import { readPersisted, writePersisted } from '../../persist';
import type { SidebarSession } from '../../protocol';
import { markRead, viewState } from '../../store';
import { activeChats, activityDetail, activityStatus, pendingInterrupt } from '../../store/activity';
import { isChatOnScreen, layout, openChat } from '../../shell/layout';
import { chatAction, actionLabel } from '../../components/loaders/actions';
import { chatTime, projectGroups, projectName, shortPath } from './projects';
import { feature } from '../../store/features';
import './chats-panel.css';

/** How many chats each project folder shows before "Show N more" (feature chats.maxPerProject, at least 1). */
function visibleLimit(): number {
  const value = feature<number>('chats.maxPerProject');
  return Number.isFinite(value) && value > 0 ? value : 5;
}

const [closedFolders, setClosedFolders] = createSignal<string[]>(readPersisted<string[]>('closedFolders', []));
const [expandedFolders, setExpandedFolders] = createSignal<string[]>([]);

function setFolderOpen(key: string, open: boolean): void {
  const next = closedFolders().filter(item => item !== key);
  if (!open) next.push(key);
  setClosedFolders(next);
  writePersisted('closedFolders', next);
}

function toggleShowAll(key: string): void {
  const current = expandedFolders();
  setExpandedFolders(current.includes(key) ? current.filter(item => item !== key) : [...current, key]);
}

/** Opens a chat in the focused pane (or beside the others) and tells the engine which chat is active. */
export function openChatFromList(sessionId: string, beside: boolean): void {
  openChat(sessionId, { beside });
  markRead(sessionId);
  post({ type: 'selectSession', sessionId });
}

function onRowClick(event: MouseEvent, sessionId: string): void {
  openChatFromList(sessionId, event.ctrlKey || event.metaKey);
}

function onRowAuxClick(event: MouseEvent, sessionId: string): void {
  if (event.button === 1) openChatFromList(sessionId, true);
}

function ChatTip(props: { session: SidebarSession }): JSX.Element {
  const status = () => activityStatus(props.session.id);
  const action = () => chatAction(props.session.id);
  const command = () => {
    const interrupt = pendingInterrupt(props.session.id);
    if (interrupt?.kind === 'approval') return interrupt.detail;
    const timeline = viewState.timeline[props.session.id] || [];
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const entry = timeline[index];
      if (entry.kind === 'tool' && entry.event.state === 'running') return [entry.event.title, entry.event.detail].filter(Boolean).join(' ');
    }
    return '';
  };
  const detail = () => {
    const current = status();
    if (current === 'running') {
      const run = viewState.runStates[props.session.id];
      return run?.label || (action() ? actionLabel[action()!] : 'Working');
    }
    return current ? activityDetail(props.session.id, current) : chatTime(props.session);
  };
  return (
    <div class="chat-tip">
      <div class="chat-tip-title">{props.session.name}</div>
      <div class="chat-tip-detail">{detail()}</div>
      <Show when={command()}>
        <div class="chat-tip-command type-mono">{command()}</div>
      </Show>
    </div>
  );
}

function ChatRow(props: { session: SidebarSession; trailing: string; trailingWarn?: boolean; warn?: boolean }): JSX.Element {
  return (
    <TreeItem
      ref={element => tooltip(element, () => <ChatTip session={props.session} />, { placement: 'right-start', delay: 600 })}
      leading={<ChatLoader sessionId={props.session.id} size={12} />}
      label={<RetypeText value={props.session.name || 'New chat'} data-motion="chat-title" />}
      trailing={props.trailing}
      trailingTone={props.trailingWarn ? 'warn' : undefined}
      tone={props.warn ? 'warn' : undefined}
      selected={isChatOnScreen(props.session.id) && layout().cells[layout().focused] === props.session.id}
      onClick={event => onRowClick(event, props.session.id)}
      onAuxClick={event => onRowAuxClick(event, props.session.id)}
    />
  );
}

function rowTrailing(session: SidebarSession): { text: string; warn: boolean } {
  const interrupt = pendingInterrupt(session.id);
  if (interrupt) return { text: interrupt.kind === 'question' ? 'needs answer' : 'needs approval', warn: true };
  return { text: chatTime(session), warn: false };
}

export function ChatsPanel(): JSX.Element {
  const [query, setQuery] = createSignal('');
  let searchInput: HTMLInputElement | undefined;

  const matches = (session: SidebarSession) => {
    const text = query().trim().toLowerCase();
    return !text || (session.name || '').toLowerCase().includes(text);
  };

  const active = createMemo(() => activeChats().filter(item => matches(item.session)));
  const groups = createMemo(() =>
    projectGroups()
      .map(group => ({ ...group, sessions: group.sessions.filter(matches) }))
      .filter(group => group.sessions.length > 0 || !query()),
  );

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInput?.focus();
        searchInput?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  return (
    <aside class="side-panel chats-panel" aria-label="Chats">
      <header class="chats-header">
        <h2 class="type-heading">Chats</h2>
        <IconButton icon="plus" label="New chat" onClick={() => post({ type: 'newSession' })} />
      </header>
      <label class="chats-search">
        <Icon name="search" size={14} />
        <input
          ref={searchInput}
          type="search"
          placeholder="Search chats"
          value={query()}
          onInput={event => setQuery(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              setQuery('');
              event.currentTarget.blur();
            }
          }}
        />
        <kbd class="type-caption">Ctrl K</kbd>
      </label>
      <div class="chats-tree">
        <Show when={active().length > 0}>
          <TreeFolder
            label="Active"
            trailing={<RollingNumber value={active().length} data-motion="chats-active-count" />}
            open={!closedFolders().includes('__active__')}
            onToggle={open => setFolderOpen('__active__', open)}
          >
            {/* Re-ranked chats lift, travel and settle (liftMoves on the AnimatedList's own container). */}
            <div
              style={{ display: 'contents' }}
              ref={element => {
                onMount(() => {
                  const container = element.firstElementChild;
                  if (container instanceof HTMLElement) liftMoves(container);
                });
              }}
            >
              <AnimatedList each={active()} key={item => item.session.id}>
                {item => (
                  <ChatRow
                    session={item().session}
                    trailing={item().session.project ? projectName(item().session.project!.path) : ''}
                    warn={item().status === 'blocked'}
                  />
                )}
              </AnimatedList>
            </div>
          </TreeFolder>
          <div class="chats-rule" />
        </Show>
        <AnimatedList each={groups()} key={group => group.key}>
          {group => {
            const showAll = () => expandedFolders().includes(group().key) || !!query();
            const visible = () => (showAll() ? group().sessions : group().sessions.slice(0, visibleLimit()));
            const hidden = () => group().sessions.length - visible().length;
            const showToggle = () => hidden() > 0 || (expandedFolders().includes(group().key) && group().sessions.length > visibleLimit());
            // Memoised so the label is only rebuilt when it switches between "Show N more" and "Show less".
            const hasHidden = createMemo(() => hidden() > 0);
            return (
              <TreeFolder
                icon="folder"
                label={group().project ? group().project!.name : 'Chats'}
                trailing={group().project ? shortPath(group().project!.path) : ''}
                open={!closedFolders().includes(group().key)}
                onToggle={open => setFolderOpen(group().key, open)}
              >
                <AnimatedList each={visible()} key={session => session.id}>
                  {session => {
                    const trailing = () => rowTrailing(session());
                    return (
                      <ChatRow
                        session={session()}
                        trailing={trailing().text}
                        trailingWarn={trailing().warn}
                        warn={trailing().warn}
                      />
                    );
                  }}
                </AnimatedList>
                <Collapse open={showToggle()}>
                  <TreeItem
                    class="chats-more"
                    tone="muted"
                    label={
                      hasHidden() ? (
                        <>
                          Show <RollingNumber value={hidden()} /> more
                        </>
                      ) : (
                        'Show less'
                      )
                    }
                    onClick={() => toggleShowAll(group().key)}
                  />
                </Collapse>
              </TreeFolder>
            );
          }}
        </AnimatedList>
        <Show when={!viewState.sessions.length}>
          <p class="chats-empty type-caption">No chats yet. Start one from Home.</p>
        </Show>
      </div>
    </aside>
  );
}
