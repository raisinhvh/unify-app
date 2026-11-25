/**
 * Find in the open document (Ctrl+F), like an editor's find widget: docked top-right over the document.
 *
 *   const find = createFindController({ surface: () => domFindSurface(article), content: () => body() });
 *   <FindBar controller={find} />
 *   onFindShortcuts({ element: () => root, screen: '.knowledge-screen', onFind: () => find.show({ query: selectedText() }) });
 *
 *   FindBar               input · "3 of 12" · previous / next · Aa (match case) · close. Enter = next,
 *                         Shift+Enter = previous, Escape = close and give focus back. Pops in on the Pop spring.
 *   createFindController  the query, the matches and the current one; re-runs when `content` changes and keeps
 *                         the current match nearest where it was
 *   domFindSurface        rendered text (read views): CSS Custom Highlight API tints (`::highlight(find-match)`,
 *                         `::highlight(find-current)`), the current match scrolled smoothly into view
 *   textareaFindSurface   a textarea: a mirror behind it takes the tints, the current match is selected without
 *                         taking focus from the find input
 *   onFindShortcuts       Ctrl/⌘ F and Ctrl/⌘ Shift F, only for the screen or pane the user is in
 *
 * Shared by the side panels' contents searches (Ctrl/⌘ Shift F): MatchCaseToggle (Aa), MatchSnippet (a result
 * row's line with the match marked) and createContentSearch (debounced, stale replies dropped).
 */
import { createEffect, createSignal, on, onCleanup, untrack, type Accessor, type JSX } from 'solid-js';
import { Presence, pressable, prefersReducedMotion } from '../motion';
import { IconButton } from './Button';
import './findBar.css';

// ---------------------------------------------------------------------------------------------------------------
// Surfaces

/** A match as offsets into the surface's text: [start, end). */
export interface FindRange {
  start: number;
  end: number;
}

/** What the find bar searches and paints. */
export interface FindSurface {
  /** The searchable text (rendered views put a newline between blocks). */
  text(): string;
  /** Tints every match and the current one more strongly; current -1 = none. */
  paint(matches: FindRange[], current: number): void;
  /** Brings the match into view (and selects it, for editable text). */
  reveal(match: FindRange): void;
  clear(): void;
  /** Where focus goes when the bar closes; false when the surface has no focus of its own. */
  focus?(): boolean;
}

/** Every literal occurrence of `query` in `text`. */
export function findAll(text: string, query: string, caseSensitive: boolean): FindRange[] {
  if (!query) return [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: FindRange[] = [];
  let index = haystack.indexOf(needle);
  while (index >= 0 && matches.length < findMatchLimit) {
    matches.push({ start: index, end: index + needle.length });
    index = haystack.indexOf(needle, index + needle.length);
  }
  return matches;
}

/** Past this many matches the count stops (a one-letter query in a long file). */
const findMatchLimit = 5000;

/** Room kept clear above a revealed match, so the bar docked at the top does not cover it (px). */
const revealMargin = 56;

/** Highlights from every open find bar, merged into the two global CSS highlights. */
const highlightOwners = new Map<object, { all: Range[]; current: Range[] }>();

function syncHighlights(): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  const all = new Highlight();
  const current = new Highlight();
  current.priority = 1;
  for (const owner of highlightOwners.values()) {
    for (const range of owner.all) all.add(range);
    for (const range of owner.current) current.add(range);
  }
  CSS.highlights.set('find-match', all);
  CSS.highlights.set('find-current', current);
}

function setHighlights(owner: object, all: Range[], current: Range[]): void {
  if (all.length || current.length) highlightOwners.set(owner, { all, current });
  else highlightOwners.delete(owner);
  syncHighlights();
}

/** The nearest ancestor that scrolls on `axis`. */
function scrollParent(element: Element | null, axis: 'x' | 'y'): HTMLElement | undefined {
  for (let node = element; node; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const style = getComputedStyle(node);
    const overflow = axis === 'y' ? style.overflowY : style.overflowX;
    const scrolls = axis === 'y' ? node.scrollHeight > node.clientHeight : node.scrollWidth > node.clientWidth;
    if (scrolls && (overflow === 'auto' || overflow === 'scroll')) return node;
  }
  return undefined;
}

/** Scrolls the range's scroll containers so it sits clear of the edges (centred when it was out of view). */
function scrollRangeIntoView(range: Range): void {
  const rect = range.getBoundingClientRect();
  const anchor = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
  const vertical = scrollParent(anchor, 'y');
  if (vertical) {
    const box = vertical.getBoundingClientRect();
    if (rect.top < box.top + revealMargin || rect.bottom > box.bottom - 16) {
      vertical.scrollBy({ top: rect.top - box.top - box.height / 2 + rect.height / 2, behavior });
    }
  }
  const horizontal = scrollParent(anchor, 'x');
  if (horizontal) {
    const box = horizontal.getBoundingClientRect();
    if (rect.left < box.left + 16 || rect.right > box.right - 16) {
      horizontal.scrollBy({ left: rect.left - box.left - box.width / 2 + rect.width / 2, behavior });
    }
  }
}

/** Blocks that start a new line in the searchable text, so a match never joins the end of one to the next. */
const blockSelector = 'p, li, h1, h2, h3, h4, h5, h6, pre, div, td, th, dt, dd, blockquote, section, article, header';

interface TextSegment {
  node: Text;
  /** Offset of the node's first character in the surface text. */
  start: number;
}

/**
 * Rendered text under `root`. `textSelector` limits it to text inside matching elements (the plain code view's
 * line text, not its line numbers). Elements with `data-find-skip` and the find bar itself are left out.
 */
export function domFindSurface(root: HTMLElement, options: { textSelector?: string } = {}): FindSurface {
  const owner = {};
  let segments: TextSegment[] = [];

  const collect = (): string => {
    segments = [];
    const parts: string[] = [];
    let length = 0;
    let lastBlock: Element | null = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[data-find-skip], .find-bar, script, style')) return NodeFilter.FILTER_REJECT;
        if (options.textSelector && !parent.closest(options.textSelector)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const block = node.parentElement!.closest(blockSelector);
      if (lastBlock && block !== lastBlock && length) {
        parts.push('\n');
        length += 1;
      }
      lastBlock = block;
      segments.push({ node, start: length });
      parts.push(node.nodeValue!);
      length += node.nodeValue!.length;
    }
    return parts.join('');
  };

  /** The text node and offset for a surface offset (a virtual newline maps to the end of the node before it). */
  const locate = (offset: number, isEnd: boolean): { node: Text; offset: number } | undefined => {
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (segments[middle].start <= offset - (isEnd ? 1 : 0)) low = middle;
      else high = middle - 1;
    }
    const segment = segments[low];
    if (!segment) return undefined;
    return { node: segment.node, offset: Math.min(Math.max(0, offset - segment.start), segment.node.length) };
  };

  const toRange = (match: FindRange): Range | undefined => {
    const start = locate(match.start, false);
    const end = locate(match.end, true);
    if (!start || !end || !start.node.isConnected || !end.node.isConnected) return undefined;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  };

  return {
    text: collect,
    paint(matches, current) {
      const all = matches.map(toRange).filter((range): range is Range => !!range);
      const active = current >= 0 && matches[current] ? toRange(matches[current]) : undefined;
      setHighlights(owner, all, active ? [active] : []);
    },
    reveal(match) {
      const range = toRange(match);
      if (range) scrollRangeIntoView(range);
    },
    clear() {
      setHighlights(owner, [], []);
    },
  };
}

/**
 * A textarea. `mirror` sits exactly behind it with the same metrics and transparent text (findBar.css
 * `.find-mirror`); the tints are painted on the mirror and show through the transparent textarea.
 */
export function textareaFindSurface(textarea: HTMLTextAreaElement, mirror: HTMLElement): FindSurface {
  const owner = {};
  const textNode = document.createTextNode('');
  mirror.replaceChildren(textNode);

  const toRange = (match: FindRange): Range | undefined => {
    if (!textNode.isConnected) return undefined;
    const range = document.createRange();
    range.setStart(textNode, Math.min(match.start, textNode.length));
    range.setEnd(textNode, Math.min(match.end, textNode.length));
    return range;
  };

  return {
    text() {
      // A trailing newline needs a character after it to take up its line, like the textarea does.
      textNode.nodeValue = `${textarea.value}​`;
      return textarea.value;
    },
    paint(matches, current) {
      const all = matches.map(toRange).filter((range): range is Range => !!range);
      const active = current >= 0 && matches[current] ? toRange(matches[current]) : undefined;
      setHighlights(owner, all, active ? [active] : []);
    },
    reveal(match) {
      // Selecting does not focus the textarea, so typing stays in the find input.
      textarea.setSelectionRange(match.start, match.end);
      const range = toRange(match);
      if (range) scrollRangeIntoView(range);
    },
    clear() {
      setHighlights(owner, [], []);
    },
    focus() {
      if (!textarea.isConnected) return false;
      textarea.focus({ preventScroll: true });
      return true;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Controller

export interface FindController {
  open: Accessor<boolean>;
  query: Accessor<string>;
  setQuery: (query: string) => void;
  caseSensitive: Accessor<boolean>;
  setCaseSensitive: (caseSensitive: boolean) => void;
  /** Number of matches. */
  total: Accessor<number>;
  /** Index of the current match, -1 when there is none. */
  current: Accessor<number>;
  /** Opens (or re-focuses) the bar. `query` replaces the text; `index` picks which match is current. */
  show: (options?: { query?: string; index?: number; caseSensitive?: boolean }) => void;
  /** Makes match `index` current on the next run (e.g. when the surface is about to be swapped for another). */
  pick: (index: number) => void;
  close: () => void;
  next: () => void;
  previous: () => void;
  /** Runs the search again (the surface changed in a way `content` does not track). */
  refresh: () => void;
  /** Set by FindBar: focuses and selects the input. */
  focusInput: () => void;
  /** FindBar registers its input here. */
  bindInput: (focus: () => void) => void;
}

export interface FindControllerOptions {
  surface: Accessor<FindSurface | undefined>;
  /** Read for tracking only: when it changes the search re-runs (the document text). */
  content?: Accessor<unknown>;
}

export function createFindController(options: FindControllerOptions): FindController {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [matches, setMatches] = createSignal<FindRange[]>([]);
  const [current, setCurrent] = createSignal(-1);
  let pendingIndex: number | undefined;
  /** Where the current match starts, so a re-run keeps the match nearest it. */
  let anchor = 0;
  let restoreFocus: HTMLElement | undefined;
  let focusInput = () => undefined as void;
  let painted: FindSurface | undefined;

  const clearPainted = () => {
    painted?.clear();
    painted = undefined;
  };

  /** `reveal` scrolls to (and selects) the current match; a text change only repaints, so typing is not moved. */
  const run = (reveal: boolean) => {
    const surface = options.surface();
    if (painted && painted !== surface) clearPainted();
    if (!open() || !surface) {
      clearPainted();
      setMatches([]);
      setCurrent(-1);
      return;
    }
    const found = findAll(surface.text(), query(), caseSensitive());
    let index = -1;
    // An asked-for match (show({ index })) is revealed even when it lands on a later re-run (the surface mounting).
    const revealNow = reveal || pendingIndex !== undefined;
    if (found.length) {
      if (pendingIndex !== undefined) {
        index = Math.min(Math.max(0, pendingIndex), found.length - 1);
      } else if (reveal) {
        // A new query: the first match at or after where the last one was.
        index = found.findIndex(match => match.start >= anchor);
        if (index < 0) index = 0;
      } else {
        // The text changed: the match nearest where the current one was.
        let best = Infinity;
        found.forEach((match, matchIndex) => {
          const distance = Math.abs(match.start - anchor);
          if (distance < best) {
            best = distance;
            index = matchIndex;
          }
        });
      }
    }
    // Kept until there is something to pick from (the document may still be loading).
    if (found.length) pendingIndex = undefined;
    setMatches(found);
    setCurrent(index);
    surface.paint(found, index);
    painted = surface;
    if (index >= 0) {
      anchor = found[index].start;
      if (revealNow) surface.reveal(found[index]);
    }
  };

  const step = (direction: 1 | -1) => {
    const list = matches();
    const surface = options.surface();
    if (!list.length || !surface) return;
    const index = (current() + direction + list.length) % list.length;
    setCurrent(index);
    anchor = list[index].start;
    surface.paint(list, index);
    surface.reveal(list[index]);
  };

  createEffect(on([open, query, caseSensitive], () => run(true), { defer: true }));
  createEffect(on([() => options.content?.(), options.surface], () => {
    if (untrack(open)) run(false);
  }, { defer: true }));
  onCleanup(clearPainted);

  return {
    open,
    query,
    setQuery(next) {
      pendingIndex = undefined;
      setQuery(next);
    },
    caseSensitive,
    setCaseSensitive(next) {
      pendingIndex = undefined;
      setCaseSensitive(next);
    },
    total: () => matches().length,
    current,
    show(showOptions = {}) {
      const wasOpen = untrack(open);
      const active = document.activeElement;
      if (!wasOpen) {
        anchor = 0;
        if (active instanceof HTMLElement && !active.closest('.find-bar')) restoreFocus = active;
      }
      pendingIndex = showOptions.index;
      const sameQuery =
        (showOptions.query === undefined || showOptions.query === untrack(query)) &&
        (showOptions.caseSensitive === undefined || showOptions.caseSensitive === untrack(caseSensitive));
      if (showOptions.query !== undefined) setQuery(showOptions.query);
      if (showOptions.caseSensitive !== undefined) setCaseSensitive(showOptions.caseSensitive);
      setOpen(true);
      // Already open with the same text: nothing re-runs by itself, so jump to the asked-for match here.
      if (wasOpen && sameQuery) run(true);
      queueMicrotask(() => focusInput());
    },
    pick(index) {
      pendingIndex = index;
    },
    close() {
      if (!untrack(open)) return;
      setOpen(false);
      const surface = options.surface();
      if (surface?.focus?.()) return;
      if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
      restoreFocus = undefined;
    },
    next: () => step(1),
    previous: () => step(-1),
    refresh: () => run(false),
    focusInput: () => focusInput(),
    bindInput(focus) {
      focusInput = focus;
    },
  };
}

/** The page's selected text when it is one short line, to prefill the find input with. */
export function selectedFindText(): string | undefined {
  const text = window.getSelection()?.toString() ?? '';
  return text && !text.includes('\n') && text.length <= 200 ? text : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Bar

export interface FindBarProps {
  controller: FindController;
  class?: string;
  placeholder?: string;
}

export function FindBar(props: FindBarProps): JSX.Element {
  const find = props.controller;
  const count = () => {
    if (!find.query()) return '';
    if (!find.total()) return 'No results';
    return `${find.current() + 1} of ${find.total()}`;
  };
  return (
    <Presence when={find.open()} from={0.96} origin="top right" offsetY={-4}>
      <div
        class={`find-bar${props.class ? ' ' + props.class : ''}`}
        role="search"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            find.close();
          }
        }}
      >
        <input
          ref={element => {
            find.bindInput(() => {
              element.focus();
              element.select();
            });
          }}
          class="find-bar-input"
          type="text"
          spellcheck={false}
          aria-label="Find"
          placeholder={props.placeholder ?? 'Find'}
          value={find.query()}
          onInput={event => find.setQuery(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (event.shiftKey) find.previous();
            else find.next();
          }}
        />
        <span class="find-bar-count type-caption" classList={{ empty: !!find.query() && !find.total() }} aria-live="polite">
          {count()}
        </span>
        <IconButton
          icon="chevronUp"
          label="Previous match (Shift+Enter)"
          size="small"
          disabled={!find.total()}
          onClick={() => find.previous()}
        />
        <IconButton
          icon="chevron"
          label="Next match (Enter)"
          size="small"
          disabled={!find.total()}
          onClick={() => find.next()}
        />
        <MatchCaseToggle
          active={find.caseSensitive()}
          onChange={find.setCaseSensitive}
        />
        <IconButton icon="close" label="Close (Escape)" size="small" onClick={() => find.close()} />
      </div>
    </Presence>
  );
}

/** The "Aa" match-case toggle (the find bar's, and the contents searches' in the side panels). */
export function MatchCaseToggle(props: { active: boolean; onChange: (active: boolean) => void }): JSX.Element {
  return (
    <button
      type="button"
      class="find-bar-case"
      classList={{ active: props.active }}
      aria-pressed={props.active}
      aria-label="Match case"
      title="Match case"
      ref={element => pressable(element)}
      // Keeps focus in the search input next to it.
      onPointerDown={event => event.preventDefault()}
      onClick={() => props.onChange(!props.active)}
    >
      Aa
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Contents search (Ctrl+Shift+F in the side panels)

/** Characters of context kept before a match in a result row; the rest of the line follows it. */
const snippetLead = 28;

/** One result row's text: the line trimmed to just before the match, the match marked. */
export function MatchSnippet(props: { text: string; column: number; length: number; class?: string }): JSX.Element {
  const parts = () => {
    const start = Math.max(0, props.column - 1);
    const end = start + props.length;
    let from = 0;
    while (from < start && /\s/.test(props.text[from])) from += 1;
    let before = props.text.slice(from, start);
    if (before.length > snippetLead) before = `…${before.slice(before.length - snippetLead).trimStart()}`;
    return { before, match: props.text.slice(start, end), after: props.text.slice(end) };
  };
  return (
    <span class={`find-snippet${props.class ? ' ' + props.class : ''}`}>
      {parts().before}
      <mark class="find-snippet-match">{parts().match}</mark>
      {parts().after}
    </span>
  );
}

export interface ContentSearchOptions<Result> {
  query: Accessor<string>;
  caseSensitive: Accessor<boolean>;
  /** Off: no requests, and the result is cleared. */
  enabled: Accessor<boolean>;
  run: (query: string, caseSensitive: boolean) => Promise<Result>;
  /** Other inputs `run` reads (e.g. the scope); a change re-runs the search. */
  deps?: Accessor<unknown>;
  /** Debounce (ms). */
  delay?: number;
}

/**
 * A debounced search: waits `delay` after the last keystroke, and drops replies to queries that were replaced
 * meanwhile. `searching` is true from the keystroke until the reply for the latest query lands.
 */
export function createContentSearch<Result>(options: ContentSearchOptions<Result>): {
  result: Accessor<Result | undefined>;
  searching: Accessor<boolean>;
} {
  const [result, setResult] = createSignal<Result | undefined>();
  const [searching, setSearching] = createSignal(false);
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const query = options.query().trim() ? options.query() : '';
    const caseSensitive = options.caseSensitive();
    const enabled = options.enabled();
    options.deps?.();
    generation += 1;
    clearTimeout(timer);
    if (!enabled || !query) {
      setResult(undefined);
      setSearching(false);
      return;
    }
    const mine = generation;
    setSearching(true);
    timer = setTimeout(() => {
      void options.run(query, caseSensitive).then(reply => {
        if (mine !== generation) return;
        setResult(() => reply);
        setSearching(false);
      });
    }, options.delay ?? 200);
  });
  onCleanup(() => {
    generation += 1;
    clearTimeout(timer);
  });
  return { result, searching };
}

// ---------------------------------------------------------------------------------------------------------------
// Shortcuts

export interface FindShortcutOptions {
  /** The element that owns the shortcut (a panel, the editor card); it must be on screen. */
  element: Accessor<HTMLElement | undefined>;
  /** The route composite it lives in when it is not in a workspace pane, e.g. '.knowledge-screen'. */
  screen?: string;
  /** Ctrl/⌘ F. */
  onFind?: (event: KeyboardEvent) => void;
  /** Ctrl/⌘ Shift F. */
  onFindAll?: (event: KeyboardEvent) => void;
}

function isEditable(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return element.isContentEditable || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT';
}

/**
 * Whether a find shortcut belongs to `element`'s screen. In a workspace pane (`.pane`) it does when focus is inside
 * that pane, or nothing in another pane has focus and this pane is the focused one. On a route it does unless focus
 * is in a pane or in a text field outside the screen.
 */
export function ownsFindShortcut(element: HTMLElement, screen?: string): boolean {
  if (!element.isConnected || !(element.checkVisibility?.() ?? element.offsetParent !== null)) return false;
  const pane = element.closest('.pane');
  const root = pane ?? (screen ? element.closest(screen) : null) ?? document.body;
  const active = document.activeElement;
  if (active && active !== document.body && root.contains(active)) return true;
  const activePane = active?.closest('.pane');
  if (activePane && activePane !== pane) return false;
  if (pane) return pane.classList.contains('focused');
  return !isEditable(active);
}

/**
 * Listens on the window in the bubble phase, so a focused Monaco (which handles its own Ctrl+F and stops the event)
 * wins inside the editor. Handled shortcuts call preventDefault.
 */
export function onFindShortcuts(options: FindShortcutOptions): void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return;
    const handler = event.shiftKey ? options.onFindAll : options.onFind;
    const element = options.element();
    if (!handler || !element || !ownsFindShortcut(element, options.screen)) return;
    event.preventDefault();
    handler(event);
  };
  window.addEventListener('keydown', onKeyDown);
  onCleanup(() => window.removeEventListener('keydown', onKeyDown));
}
