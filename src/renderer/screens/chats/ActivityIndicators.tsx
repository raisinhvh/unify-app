/**
 * The composer's activity indicators, right of the effort picker: what the chat has running besides its own turn.
 * They replace the background card the chat feed used to end with.
 *
 *   <SubagentIndicator chatId={id} />     bot icon + count while any subagent of the chat runs (explorers excluded)
 *   <BackgroundIndicator chatId={id} />   terminal icon + running count while the chat has a background shell or task
 *
 * Closed: a compact line like ModelPicker's (icon, count, chevron), no words; hover title and aria-label say it in
 * full. Open: a Popover with the same anchor, placement and motion as the model menu, one row per item:
 *
 *   subagent    loader, title, model, chevron; click opens its feed in the timeline (subagentView.ts)
 *   background  status glyph, kind icon, title (monospace for shell commands), elapsed time ticking every second,
 *               and Stop while the engine can stop it. Ended ones stay (dimmed) until the engine drops them.
 *
 * Background subagents are listed with the subagents, not twice. Each line pops in and out with Presence; rows join,
 * leave and reorder through AnimatedList, and ended background rows dim on the Control spring.
 */
import { createEffect, createMemo, createSignal, Match, onCleanup, onMount, Show, Switch, type Accessor, type JSX } from 'solid-js';
import { Button, Icon, Loader, Popover, actionLoader, type IconName } from '../../components';
import { post } from '../../bridge';
import { AnimatedList, Presence, createSpring } from '../../motion';
import type { SidebarBackgroundProcess, SidebarSubagent } from '../../protocol';
import { backgroundProcesses, viewState } from '../../store';
import { explorerProfile, openSubagent } from './subagentView';
import '../../components/modelPicker.css';
import './activity-indicators.css';

type ProcessState = SidebarBackgroundProcess['state'];

/** "42s", "3m 12s", "1h 5m": the whole seconds a process has run, in the two largest units. */
function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The shared closed line and popover: an icon and the running count, no words (the title says it in full).
 * `visible` false pops the line away and closes the popover; a count of 0 shows the icon alone.
 */
function ActivityIndicator(props: {
  visible: boolean;
  icon: IconName;
  count: number;
  title: string;
  listLabel: string;
  children: JSX.Element;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();

  createEffect(() => {
    if (!props.visible) setOpen(false);
  });

  return (
    <>
      <Presence when={props.visible} origin="left center">
        <Button
          ref={setAnchor}
          variant="text"
          trailingIcon="chevron"
          class={`model-picker model-picker-compact composer-choice activity-indicator${open() ? ' open' : ''}`}
          title={props.title}
          aria-label={props.title}
          aria-haspopup="dialog"
          aria-expanded={open()}
          onClick={() => setOpen(!open())}
        >
          <Icon name={props.icon} size={14} class="activity-indicator-icon" />
          <Show when={props.count > 0}>
            <span class="model-picker-name activity-indicator-count">{props.count}</span>
          </Show>
        </Button>
      </Presence>
      <Popover
        anchor={anchor()}
        open={open()}
        onClose={() => setOpen(false)}
        placement="top-start"
        class="model-picker-popover activity-popover"
      >
        {/* A row that navigates (a subagent) closes the popover; background rows stay open for Stop. */}
        <div
          class="activity-list"
          role="group"
          aria-label={props.listLabel}
          onClick={event => {
            if ((event.target as HTMLElement).closest('.activity-subagent-row')) setOpen(false);
          }}
        >
          {props.children}
        </div>
      </Popover>
    </>
  );
}

export function SubagentIndicator(props: { chatId: string }): JSX.Element {
  const running = createMemo(() =>
    Object.values(viewState.subagents[props.chatId] ?? {}).filter(
      (agent): agent is SidebarSubagent => !!agent && agent.state === 'running' && agent.profile !== explorerProfile,
    ),
  );
  // Keeps the last list while the line pops away after the last subagent finishes.
  const shown = createMemo<SidebarSubagent[]>(previous => (running().length ? running() : previous ?? []));

  return (
    <ActivityIndicator
      visible={running().length > 0}
      icon="bot"
      count={shown().length}
      title={`${plural(shown().length, 'subagent')} running`}
      listLabel="Running subagents"
    >
      <AnimatedList each={shown()} key={agent => agent.id}>
        {agent => (
          <button
            type="button"
            class="model-picker-row activity-row activity-subagent-row"
            onClick={() => openSubagent(props.chatId, agent().id)}
          >
            <span class="activity-status">
              <Loader id={actionLoader[agent().delegated ? 'delegating' : 'spawning']} size={12} />
            </span>
            <span class="model-picker-row-label">{agent().title}</span>
            <Show when={agent().model}>
              <span class="model-picker-row-hint">{agent().model}</span>
            </Show>
            <Icon name="chevronRight" size={12} class="activity-row-chevron" />
          </button>
        )}
      </AnimatedList>
    </ActivityIndicator>
  );
}

/** The status cell: the running loader, or the mark an ended process left (check, cross, stop). */
function StatusGlyph(props: { state: ProcessState }): JSX.Element {
  return (
    <span class="activity-status">
      <Switch fallback={<Loader id={actionLoader.other} size={12} />}>
        <Match when={props.state === 'done'}>
          <Icon name="check" size={12} />
        </Match>
        <Match when={props.state === 'error'}>
          <Icon name="close" size={12} />
        </Match>
        <Match when={props.state === 'stopped'}>
          <Icon name="stop" size={12} />
        </Match>
      </Switch>
    </span>
  );
}

/** A terminal prompt (drawn in the Figma stroke style) for shell commands, the clock for a provider's own task. */
function KindIcon(props: { kind: SidebarBackgroundProcess['kind'] }): JSX.Element {
  return (
    <Show when={props.kind === 'shell'} fallback={<Icon name="clock" size={12} />}>
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3.33333 4.66667L6.66667 8L3.33333 11.3333M8.66667 11.3333H12.6667"
          fill="none"
          stroke="currentColor"
          stroke-width="1.33333"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </Show>
  );
}

function ProcessRow(props: {
  chatId: string;
  process: Accessor<SidebarBackgroundProcess>;
  now: Accessor<number>;
}): JSX.Element {
  const running = () => props.process().state === 'running';
  // An ended process freezes at its end time; a running one ticks with the shared clock.
  const elapsed = () => {
    const current = props.process();
    const end = running() ? props.now() : (current.endedAt ?? props.now());
    return formatElapsed(end - current.startedAt);
  };
  const dim = createSpring(() => (running() ? 1 : 0.55), 'control', { fadeOnly: true });
  const tooltip = () => (props.process().detail ? `${props.process().title}\n${props.process().detail}` : props.process().title);
  return (
    <div
      class={`model-picker-row activity-row activity-process-row activity-process-${props.process().state}`}
      style={{ opacity: String(Math.max(0, Math.min(1, dim()))) }}
    >
      <StatusGlyph state={props.process().state} />
      <span class="activity-kind">
        <KindIcon kind={props.process().kind} />
      </span>
      <span
        class="model-picker-row-label"
        classList={{ 'activity-command': props.process().kind === 'shell' }}
        title={tooltip()}
      >
        {props.process().title}
      </span>
      <span class="activity-elapsed">{elapsed()}</span>
      <Show when={running() && props.process().stoppable}>
        <Button
          variant="text"
          class="activity-stop"
          aria-label={`Stop ${props.process().title}`}
          onClick={() => post({ type: 'stopBackgroundProcess', sessionId: props.chatId, id: props.process().id })}
        >
          Stop
        </Button>
      </Show>
    </div>
  );
}

/**
 * The faint line a hidden composer leaves at the bottom of the pane (Composer `autoHide`): a short handle while
 * nothing else runs, or the running subagent and background counts (icon + number, no words) in its place.
 */
export function ActivityPeek(props: { chatId: string }): JSX.Element {
  const subagents = () =>
    Object.values(viewState.subagents[props.chatId] ?? {}).filter(
      agent => !!agent && agent.state === 'running' && agent.profile !== explorerProfile,
    ).length;
  const background = () =>
    backgroundProcesses(props.chatId).filter(process => process.kind !== 'subagent' && process.state === 'running').length;
  const busy = () => subagents() > 0 || background() > 0;
  const label = () => {
    const parts: string[] = [];
    if (subagents()) parts.push(`${plural(subagents(), 'subagent')} running`);
    if (background()) parts.push(`${plural(background(), 'background task')} running`);
    return parts.join(', ') || 'Hover to reply';
  };
  return (
    <div class="activity-peek" aria-label={label()} title={label()}>
      <Show when={busy()} fallback={<span class="activity-peek-handle" />}>
        <Show when={subagents() > 0}>
          <span class="activity-peek-item">
            <Icon name="bot" size={12} />
            <span class="activity-indicator-count">{subagents()}</span>
          </span>
        </Show>
        <Show when={background() > 0}>
          <span class="activity-peek-item">
            <Icon name="terminal" size={12} />
            <span class="activity-indicator-count">{background()}</span>
          </span>
        </Show>
      </Show>
    </div>
  );
}

export function BackgroundIndicator(props: { chatId: string }): JSX.Element {
  const live = createMemo(() => backgroundProcesses(props.chatId).filter(process => process.kind !== 'subagent'));
  // Keeps the last list while the line pops away after the engine drops the last process.
  const shown = createMemo<SidebarBackgroundProcess[]>(previous => (live().length ? live() : previous ?? []));
  const runningCount = () => shown().filter(process => process.state === 'running').length;

  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });

  return (
    <ActivityIndicator
      visible={live().length > 0}
      icon="terminal"
      count={runningCount()}
      title={runningCount() > 0 ? `${plural(runningCount(), 'background task')} running` : 'Finished in background'}
      listLabel="Background tasks"
    >
      <AnimatedList each={shown()} key={process => process.id}>
        {process => <ProcessRow chatId={props.chatId} process={process} now={now} />}
      </AnimatedList>
    </ActivityIndicator>
  );
}
