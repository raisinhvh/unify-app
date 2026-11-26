/**
 * Slash command menu for the composer (port of DSH media/sidebar.js slashMatches / renderSlashMenu).
 *
 *   <SlashMenu anchor={form} text={text()} caret={caret()} idPrefix="composer-1"
 *              onInsert={value => …} onApplied={() => clear()} ref={api => (slashMenu = api)} />
 *
 * The menu is derived from the composer text, it holds no text of its own:
 *   "/"  "/jo"            the command list, filtered by what is typed before the caret
 *   "/permissions " (+ a partial mode)   the approval-mode picker, with a check on the current mode
 *   "/schedule " (+ a partial pick)       quick "when" picks; a pick is inserted with the caret left for the prompt
 * Arrow keys move the highlight, Enter or Tab picks, Escape closes until the text changes. The composer
 * passes its keydown to `api.handleKey` first; focus never leaves the input (rows cancel mousedown).
 *
 * Picking a command inserts "/name " and keeps typing; picking /permissions shows the mode picker, and a mode
 * posts `setApproval` and clears the composer. Typing "/permissions auto" and sending also works: the engine
 * parses it.
 *
 * Motion: the surface pops in and out (Popover). The command list and the mode picker are two sections in
 * Collapses, so switching folds one away while the other opens and the surface height follows. The highlight is
 * one block that glides between rows on the Indicator spring and retargets when the keys move faster than it.
 */
import { createEffect, createMemo, createSignal, Index, on, onCleanup, Show, type JSX } from 'solid-js';
import { Icon, Popover } from '../../components';
import { Collapse, driveSpring, useSpring } from '../../motion';
import { post } from '../../bridge';
import type { ApprovalMode } from '../../protocol';
import { viewState } from '../../store';
import './slash-menu.css';

type SlashCommand = (typeof viewState)['slashCommands'][number];

/**
 * The engine's commands (src/engine/slash/registry.ts SLASH_COMMANDS), for when the view state arrives before
 * `slashCommandsState`, so the menu never opens empty.
 */
const builtInCommands: SlashCommand[] = [
  { name: 'clearcontext', aliases: ['mib'], description: "Clear this chat's agent context and feed, and start a fresh session", usage: '/clearcontext [prompt]' },
  { name: 'job', description: 'Plan a checklist from your spec, then work and review until it passes', usage: '/job <spec>' },
  { name: 'noquestions', description: 'Agents stop asking you questions and state their assumptions instead (toggle)', usage: '/noquestions [on | off]' },
  { name: 'permissions', description: 'Show or change the approval mode for this workspace', usage: '/permissions [ask | auto | most | full]' },
  { name: 'schedule', description: 'Send a prompt later, after a delay or at a time', usage: '/schedule <when> <prompt>' },
  { name: 'shutdown', description: 'Shut the PC down once every chat and subagent finishes', usage: '/shutdown' },
];

/** Quick "when" picks after "/schedule " (forms the engine's parser accepts), with the time each stands for. */
const schedulePicks: { when: string; dueAt: (now: Date) => Date }[] = [
  { when: 'in 30m', dueAt: now => new Date(now.getTime() + 30 * 60_000) },
  { when: 'in 1h', dueAt: now => new Date(now.getTime() + 60 * 60_000) },
  { when: 'in 3h', dueAt: now => new Date(now.getTime() + 180 * 60_000) },
  { when: 'tomorrow 9am', dueAt: now => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0) },
];

/** "Today at 15:42" / "Tomorrow at 09:00", a quick pick's description. */
function describeDue(due: Date, now: Date): string {
  const time = `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (due.toDateString() === now.toDateString()) return `Today at ${time}`;
  if (due.toDateString() === tomorrow.toDateString()) return `Tomorrow at ${time}`;
  return `${due.toLocaleDateString(undefined, { weekday: 'short' })} at ${time}`;
}

/** Copied from src/engine/slash/registry.ts APPROVAL_MODES (engine runtime code stays out of the renderer). */
const approvalModes: { mode: ApprovalMode; label: string; description: string }[] = [
  { mode: 'ask', label: 'Ask approval', description: 'Ask before running tools' },
  { mode: 'auto', label: 'Approve for me', description: 'Routine actions run automatically; risky ones still ask' },
  { mode: 'most', label: 'Most access', description: 'No approval prompts, but reckless commands (wiping folders, force-push, publishing, disk or system changes) are blocked' },
  { mode: 'full', label: 'Full access', description: 'No approval prompts; unrestricted file and network access' },
];

/** Widest the menu gets over a wide composer. */
const maxMenuWidth = 440;

type SlashViewKind = 'commands' | 'modes' | 'schedule';

interface SlashView {
  kind: SlashViewKind;
  /** Lowercase text typed so far (command name, or approval mode). */
  query: string;
}

interface SlashEntry {
  id: string;
  label: string;
  /** Muted text after the label (a command's arguments, a mode's keyword). */
  hint?: string;
  description: string;
  /** undefined: no check column. */
  checked?: boolean;
}

export interface SlashMenuApi {
  /** Handles a keydown from the composer input; true when the menu used the key. */
  handleKey(event: KeyboardEvent): boolean;
  open(): boolean;
  /** Id of the highlighted option, for aria-activedescendant. */
  activeId(): string | undefined;
}

export interface SlashMenuProps {
  /** The composer frame; the menu sits above it. */
  anchor: HTMLElement | undefined;
  text: string;
  caret: number;
  /** Prefix for option ids, unique per composer. */
  idPrefix: string;
  /** Replaces the composer text (a picked command, caret at the end). */
  onInsert: (text: string) => void;
  /** An approval mode was set: the composer clears. */
  onApplied: () => void;
  ref?: (api: SlashMenuApi) => void;
}

/** What the menu shows for this text and caret, if anything. */
function slashView(text: string, caret: number): SlashView | undefined {
  if (!text.startsWith('/')) return undefined;
  const modeMatch = /^\/permissions\s+(\S*)$/i.exec(text);
  if (modeMatch && caret === text.length) return { kind: 'modes', query: modeMatch[1].toLowerCase() };
  // Open while what follows "/schedule " is still the start of a pick; a whole pick (plus the prompt) closes it.
  const scheduleMatch = /^\/schedule\s+(.*)$/i.exec(text);
  if (scheduleMatch) {
    const typed = scheduleMatch[1].toLowerCase();
    const partialPick = schedulePicks.some(pick => pick.when.startsWith(typed) && pick.when !== typed);
    return partialPick && caret === text.length ? { kind: 'schedule', query: typed } : undefined;
  }
  const whitespace = text.search(/\s/);
  const tokenEnd = whitespace < 0 ? text.length : whitespace;
  if (caret > tokenEnd) return undefined;
  return { kind: 'commands', query: text.slice(1, caret).toLowerCase() };
}

/** "/job <spec>" → "<spec>"; alternatives read as words ("[ask auto full]"), with no bar separators. */
function argumentsHint(command: SlashCommand): string {
  const usage = command.usage.trim();
  const prefix = `/${command.name}`;
  const rest = usage.toLowerCase().startsWith(prefix) ? usage.slice(prefix.length).trim() : usage;
  return rest.replace(/\s*\|\s*/g, ' ');
}

export function SlashMenu(props: SlashMenuProps): JSX.Element {
  const [highlight, setHighlight] = createSignal(0);
  /** The text the menu was dismissed at; it stays closed until the text changes. */
  const [dismissedAt, setDismissedAt] = createSignal<string>();

  const commands = () => (viewState.slashCommands.length ? viewState.slashCommands : builtInCommands);
  const view = createMemo(() => slashView(props.text, props.caret));

  const commandEntries = (query: string): SlashEntry[] =>
    commands()
      .filter(command => [command.name, ...(command.aliases || [])].some(name => name.toLowerCase().startsWith(query)))
      .map(command => ({
        id: command.name,
        label: `/${command.name}`,
        hint: argumentsHint(command) || undefined,
        description: command.description,
      }));

  const modeEntries = (query: string): SlashEntry[] =>
    approvalModes
      .filter(item => item.mode.startsWith(query) || item.label.toLowerCase().startsWith(query))
      .map(item => ({
        id: item.mode,
        label: item.label,
        hint: item.mode,
        description: item.description,
        checked: viewState.approvalMode === item.mode,
      }));

  const scheduleEntries = (query: string): SlashEntry[] => {
    const now = new Date();
    return schedulePicks
      .filter(pick => pick.when.startsWith(query) && pick.when !== query)
      .map(pick => ({
        id: pick.when,
        label: pick.when,
        description: describeDue(pick.dueAt(now), now),
      }));
  };

  const liveEntries = createMemo<SlashEntry[]>(() => {
    const current = view();
    if (!current) return [];
    if (current.kind === 'modes') return modeEntries(current.query);
    if (current.kind === 'schedule') return scheduleEntries(current.query);
    return commandEntries(current.query);
  });

  const open = () => !!view() && liveEntries().length > 0 && dismissedAt() !== props.text;

  // While the surface plays its exit (and while the other section folds away), each section keeps its last rows.
  const shownKind = createMemo<SlashViewKind>(previous => (open() ? view()!.kind : previous), 'commands');
  const shownCommands = createMemo<SlashEntry[]>(previous => (open() && view()!.kind === 'commands' ? liveEntries() : previous), []);
  const shownModes = createMemo<SlashEntry[]>(previous => (open() && view()!.kind === 'modes' ? liveEntries() : previous), []);
  const shownSchedule = createMemo<SlashEntry[]>(previous => (open() && view()!.kind === 'schedule' ? liveEntries() : previous), []);

  // A new list starts on its first row; the mode picker starts on the current mode.
  createEffect(on(() => [view()?.kind, view()?.query] as const, ([kind, query]) => {
    if (kind === 'modes' && !query) {
      const checkedIndex = liveEntries().findIndex(entry => entry.checked);
      setHighlight(Math.max(0, checkedIndex));
      return;
    }
    setHighlight(0);
  }));

  // The list may shrink under the highlight (more typed).
  createEffect(() => {
    const count = liveEntries().length;
    if (count && highlight() >= count) setHighlight(count - 1);
  });

  const optionId = (kind: SlashViewKind, index: number) => `${props.idPrefix}-slash-${kind}-${index}`;

  const pick = (entry: SlashEntry) => {
    const current = view();
    if (!current) return;
    if (current.kind === 'modes') {
      post({ type: 'setApproval', mode: entry.id as ApprovalMode });
      props.onApplied();
      return;
    }
    if (current.kind === 'schedule') {
      props.onInsert(`/schedule ${entry.id} `);
      return;
    }
    props.onInsert(`/${entry.id} `);
  };

  const dismiss = () => setDismissedAt(props.text);

  props.ref?.({
    handleKey(event) {
      if (!open() || event.isComposing) return false;
      const list = liveEntries();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setHighlight(index => (index + step + list.length) % list.length);
        return true;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault();
        const entry = list[highlight()];
        if (entry) pick(entry);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
        return true;
      }
      return false;
    },
    open,
    activeId: () => (open() ? optionId(view()!.kind, highlight()) : undefined),
  });

  const sectionHighlight = (kind: SlashViewKind) => (open() && shownKind() === kind ? highlight() : -1);

  return (
    <Popover
      anchor={props.anchor}
      open={open()}
      onClose={dismiss}
      placement="top-start"
      class="slash-menu"
      ref={element => {
        if (props.anchor) element.style.width = `${Math.min(props.anchor.offsetWidth, maxMenuWidth)}px`;
        // Rows never take focus: the caret stays in the composer while the menu is used with the mouse.
        element.addEventListener('mousedown', event => event.preventDefault());
      }}
    >
      <Collapse open={shownKind() === 'commands'}>
        <SlashSection
          heading="Commands"
          kind="commands"
          entries={shownCommands()}
          highlight={sectionHighlight('commands')}
          optionId={optionId}
          onHover={setHighlight}
          onPick={pick}
        />
      </Collapse>
      <Collapse open={shownKind() === 'modes'}>
        <SlashSection
          heading="Approval mode"
          kind="modes"
          entries={shownModes()}
          highlight={sectionHighlight('modes')}
          optionId={optionId}
          onHover={setHighlight}
          onPick={pick}
        />
      </Collapse>
      <Collapse open={shownKind() === 'schedule'}>
        <SlashSection
          heading="When"
          kind="schedule"
          entries={shownSchedule()}
          highlight={sectionHighlight('schedule')}
          optionId={optionId}
          onHover={setHighlight}
          onPick={pick}
        />
      </Collapse>
    </Popover>
  );
}

interface SlashSectionProps {
  heading: string;
  kind: SlashViewKind;
  entries: SlashEntry[];
  /** Highlighted row, or -1 (this section is folding away). */
  highlight: number;
  optionId: (kind: SlashViewKind, index: number) => string;
  onHover: (index: number) => void;
  onPick: (entry: SlashEntry) => void;
}

/** One list with its gliding highlight block. */
function SlashSection(props: SlashSectionProps): JSX.Element {
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

  createEffect(on(() => [props.highlight, props.entries] as const, ([index]) => {
    // Rows render in the same tick; measure them after.
    queueMicrotask(() => {
      const row = index >= 0 ? rows[index] : undefined;
      if (!row || !row.isConnected) {
        opacity.set(0, 'control');
        return;
      }
      // Hidden (first show): appear on the row; visible: glide to it.
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

  onCleanup(() => {
    rows.length = 0;
  });

  const hasChecks = () => props.entries.some(entry => entry.checked !== undefined);

  return (
    <div class="slash-section">
      <div class="slash-heading type-caption">{props.heading}</div>
      <div class="slash-list" role="listbox" aria-label={props.heading}>
        <div
          ref={element => {
            block = element;
            paint();
          }}
          class="slash-highlight"
          aria-hidden="true"
        />
        <Index each={props.entries}>
          {(entry, index) => (
            <div
              ref={element => {
                rows[index] = element;
              }}
              id={props.optionId(props.kind, index)}
              role="option"
              aria-selected={props.highlight === index}
              class="slash-item"
              classList={{ highlighted: props.highlight === index }}
              onPointerMove={() => {
                if (props.highlight !== index) props.onHover(index);
              }}
              onClick={() => props.onPick(entry())}
            >
              <Show when={hasChecks()}>
                <span class="slash-check">
                  <Show when={entry().checked}>
                    <Icon name="check" size={14} />
                  </Show>
                </span>
              </Show>
              <span class="slash-text">
                <span class="slash-line">
                  <span class="slash-label">{entry().label}</span>
                  <Show when={entry().hint}>
                    <span class="slash-hint">{entry().hint}</span>
                  </Show>
                </span>
                <span class="slash-description type-caption" title={entry().description}>{entry().description}</span>
              </span>
            </div>
          )}
        </Index>
      </div>
    </div>
  );
}
