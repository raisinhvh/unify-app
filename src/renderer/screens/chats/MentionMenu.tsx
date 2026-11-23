/**
 * "@" file mentions for the composer, modelled on SlashMenu.
 *
 *   <MentionMenu anchor={form} text={text()} caret={caret()} idPrefix="composer-1" disabled={slashOpen}
 *                onReplace={(start, end, value) => …} ref={api => (mentionMenu = api)} />
 *
 * The menu is derived from the composer text: an "@" at the start of a word, with the caret after it, opens it,
 * and the text between the "@" and the caret is the query. Each query change posts `searchWorkspaceFiles`
 * (debounced 80 ms, fresh requestId); a reply counts when it answers the newest request, or when its `query`
 * equals the current one (a reply nobody asked for under that id, e.g. a dev fixture; it is still current).
 * Arrow keys move the highlight, Enter or Tab picks, Escape closes until the text changes. Picking replaces
 * "@query" with "@<path> " (folders keep their "/"). Mentions stay plain text: agents read the files themselves.
 *
 * Motion: the surface pops in and out (Popover); the highlight glides between rows on the Indicator spring.
 */
import { createEffect, createMemo, createSignal, Index, on, onCleanup, Show, type JSX } from 'solid-js';
import { Icon, Popover } from '../../components';
import { driveSpring, useSpring } from '../../motion';
import { post } from '../../bridge';
import { onHostMessage } from '../../store';
import './mention-menu.css';

/** Widest the menu gets over a wide composer. */
const maxMenuWidth = 440;
const searchDelayMs = 80;
const resultLimit = 12;

let requestCount = 0;

interface WorkspaceMatch {
  path: string;
  kind: 'file' | 'folder';
}

interface MentionQuery {
  /** Index of the "@" in the text. */
  start: number;
  /** What follows the "@", up to the caret. */
  query: string;
}

export interface MentionMenuApi {
  /** Handles a keydown from the composer input; true when the menu used the key. */
  handleKey(event: KeyboardEvent): boolean;
  open(): boolean;
  /** Id of the highlighted option, for aria-activedescendant. */
  activeId(): string | undefined;
}

export interface MentionMenuProps {
  /** The composer frame; the menu sits above it. */
  anchor: HTMLElement | undefined;
  text: string;
  caret: number;
  /** Prefix for option ids, unique per composer. */
  idPrefix: string;
  /** Another composer menu is open: stay closed. */
  disabled?: boolean;
  /** Replaces text[start, end) with value and puts the caret after it. */
  onReplace: (start: number, end: number, value: string) => void;
  ref?: (api: MentionMenuApi) => void;
}

/** The "@query" the caret sits in, if any: "@" at the start of the text or after whitespace. */
function mentionQuery(text: string, caret: number): MentionQuery | undefined {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match) return undefined;
  return { start: match.index + match[1].length, query: match[2] };
}

/** "src/app/main.ts" → name "main.ts", directory "src/app"; folders keep their trailing "/" in the name. */
function splitPath(match: WorkspaceMatch): { name: string; directory: string } {
  const trimmed = match.kind === 'folder' ? match.path.replace(/\/+$/, '') : match.path;
  const slash = trimmed.lastIndexOf('/');
  const name = slash < 0 ? trimmed : trimmed.slice(slash + 1);
  return {
    name: match.kind === 'folder' ? `${name}/` : name,
    directory: slash < 0 ? '' : trimmed.slice(0, slash),
  };
}

export function MentionMenu(props: MentionMenuProps): JSX.Element {
  const [highlight, setHighlight] = createSignal(0);
  const [dismissedAt, setDismissedAt] = createSignal<string>();
  /** The newest reply that counts, with the query it answered. */
  const [reply, setReply] = createSignal<{ query: string; results: WorkspaceMatch[] }>();
  let latestRequestId: string | undefined;
  let searchTimer: number | undefined;

  const mention = createMemo(() => mentionQuery(props.text, props.caret));
  const query = () => mention()?.query;

  // One search per query, after a short pause in typing.
  createEffect(on(query, current => {
    window.clearTimeout(searchTimer);
    if (current === undefined) return;
    searchTimer = window.setTimeout(() => {
      requestCount += 1;
      latestRequestId = `${props.idPrefix}-mention-${requestCount}`;
      post({ type: 'searchWorkspaceFiles', requestId: latestRequestId, query: current, limit: resultLimit });
    }, searchDelayMs);
  }));

  const stopListening = onHostMessage(message => {
    if (message.type !== 'workspaceFileResults') return;
    const answersLatest = message.requestId === latestRequestId;
    if (!answersLatest && message.query !== query()) return;
    setReply({ query: message.query, results: message.results });
  });
  onCleanup(() => {
    stopListening();
    window.clearTimeout(searchTimer);
  });

  /** Results for the current query; while a new query is in flight the last results stay up. */
  const results = () => reply()?.results ?? [];
  const searched = () => reply() !== undefined;
  const open = () => !props.disabled && !!mention() && dismissedAt() !== props.text;

  createEffect(on(query, () => setHighlight(0)));
  createEffect(() => {
    const count = results().length;
    if (count && highlight() >= count) setHighlight(count - 1);
  });

  const optionId = (index: number) => `${props.idPrefix}-mention-${index}`;

  const pick = (match: WorkspaceMatch) => {
    const current = mention();
    if (!current) return;
    props.onReplace(current.start, props.caret, `@${match.path} `);
  };

  const dismiss = () => setDismissedAt(props.text);

  props.ref?.({
    handleKey(event) {
      if (!open() || event.isComposing) return false;
      const list = results();
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
        return true;
      }
      if (!list.length) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setHighlight(index => (index + step + list.length) % list.length);
        return true;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault();
        const match = list[highlight()];
        if (match) pick(match);
        return true;
      }
      return false;
    },
    open,
    activeId: () => (open() && results().length ? optionId(highlight()) : undefined),
  });

  // The gliding highlight block (as SlashMenu's sections).
  const rows: HTMLElement[] = [];
  const top = useSpring(0, 'indicator', 100);
  const height = useSpring(0, 'indicator', 100);
  const opacity = useSpring(0, 'control', 1);
  let block: HTMLDivElement | undefined;

  const paint = () => {
    if (!block) return;
    block.style.transform = `translateY(${top.value}px)`;
    block.style.height = `${Math.max(0, height.value)}px`;
    block.style.opacity = String(Math.max(0, Math.min(1, opacity.value)));
  };
  top.onChange(paint);
  height.onChange(paint);
  opacity.onChange(paint);

  createEffect(on(() => [highlight(), results(), open()] as const, ([index, , isOpen]) => {
    queueMicrotask(() => {
      const row = isOpen ? rows[index] : undefined;
      if (!row || !row.isConnected) {
        opacity.set(0, 'control');
        return;
      }
      if (opacity.value < 0.05) {
        top.jump(row.offsetTop);
        height.jump(row.offsetHeight);
      } else {
        driveSpring(top, row.offsetTop, 'indicator');
        driveSpring(height, row.offsetHeight, 'indicator');
      }
      opacity.set(1, 'control');
    });
  }));

  return (
    <Popover
      anchor={props.anchor}
      open={open()}
      onClose={dismiss}
      placement="top-start"
      class="mention-menu"
      ref={element => {
        if (props.anchor) element.style.width = `${Math.min(props.anchor.offsetWidth, maxMenuWidth)}px`;
        // Rows never take focus: the caret stays in the composer.
        element.addEventListener('mousedown', event => event.preventDefault());
      }}
    >
      <div class="mention-heading type-caption">Files</div>
      <div class="mention-list" role="listbox" aria-label="Files">
        <div
          ref={element => {
            block = element;
            paint();
          }}
          class="mention-highlight"
          aria-hidden="true"
        />
        <Index each={results()}>
          {(match, index) => (
            <div
              ref={element => {
                rows[index] = element;
              }}
              id={optionId(index)}
              role="option"
              aria-selected={highlight() === index}
              class="mention-item"
              title={match().path}
              onPointerMove={() => {
                if (highlight() !== index) setHighlight(index);
              }}
              onClick={() => pick(match())}
            >
              <Icon
                name={match().kind === 'folder' ? 'folder' : 'file'}
                size={14}
                class="mention-icon"
              />
              <span class="mention-name">{splitPath(match()).name}</span>
              <span class="mention-directory">{splitPath(match()).directory}</span>
            </div>
          )}
        </Index>
        <Show when={!results().length}>
          <div class="mention-empty type-caption">{searched() ? 'No matches' : 'Searching…'}</div>
        </Show>
      </div>
    </Popover>
  );
}
