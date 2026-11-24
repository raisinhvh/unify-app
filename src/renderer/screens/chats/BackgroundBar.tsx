/**
 * Background processes of a chat (a dev server, a watcher, a background shell command, a background subagent), shown
 * under the job bar while the chat has any (`backgroundProcesses` from the engine, see store/index.ts).
 *
 *   <BackgroundBar chatId={id} />   nothing (and no gap) while the chat has no background process
 *
 *   head   running glyph, "2 running in background" (or "Finished in background" once none runs), chevron
 *   list   expand: one row per process: status glyph, kind icon, title (monospace for shell commands), elapsed
 *          time ticking every second, and Stop while the engine can stop it
 *
 * Ended processes stay in the list (dimmed, with a check, cross or stop) until the engine drops them.
 *
 * Motion: the bar reveals and collapses with the Reveal spring (Collapse), rows join, leave and reorder through
 * AnimatedList, the chevron turns on the Indicator spring and ended rows dim on the Control spring.
 */
import { createMemo, createSignal, Match, onCleanup, onMount, Show, Switch, type Accessor, type JSX } from 'solid-js';
import { Button, Icon, Loader, actionLoader } from '../../components';
import { post } from '../../bridge';
import { AnimatedList, Collapse, createSpring } from '../../motion';
import type { SidebarBackgroundProcess } from '../../protocol';
import { backgroundProcesses } from '../../store';
import './background-bar.css';

type ProcessState = SidebarBackgroundProcess['state'];

/** "42s", "3m 12s", "1h 5m": the whole seconds a process has run, in the two largest units. */
function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The status cell: the running loader, or the mark an ended process left (check, cross, stop). */
function StatusGlyph(props: { state: ProcessState }): JSX.Element {
  return (
    <span class="background-status">
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

/** Shell commands get a terminal prompt (drawn in the Figma stroke style); subagents the bot, a provider's task the clock. */
function KindIcon(props: { kind: SidebarBackgroundProcess['kind'] }): JSX.Element {
  return (
    <span class="background-kind">
      <Switch>
        <Match when={props.kind === 'shell'}>
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
        </Match>
        <Match when={props.kind === 'subagent'}>
          <Icon name="bot" size={12} />
        </Match>
        <Match when={props.kind === 'task'}>
          <Icon name="clock" size={12} />
        </Match>
      </Switch>
    </span>
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
      class={`background-row background-row-${props.process().state}`}
      style={{ opacity: String(Math.max(0, Math.min(1, dim()))) }}
    >
      <StatusGlyph state={props.process().state} />
      <KindIcon kind={props.process().kind} />
      <span
        class="background-row-title"
        classList={{ 'background-row-command': props.process().kind === 'shell' }}
        title={tooltip()}
      >
        {props.process().title}
      </span>
      <span class="background-row-elapsed">{elapsed()}</span>
      <Show when={running() && props.process().stoppable}>
        <Button
          variant="text"
          class="background-row-stop"
          aria-label={`Stop ${props.process().title}`}
          onClick={() => post({ type: 'stopBackgroundProcess', sessionId: props.chatId, id: props.process().id })}
        >
          Stop
        </Button>
      </Show>
    </div>
  );
}

export function BackgroundBar(props: { chatId: string }): JSX.Element {
  const live = () => backgroundProcesses(props.chatId);
  // Keeps the last list while the bar collapses away after the engine drops the last process.
  const shown = createMemo<SidebarBackgroundProcess[]>(previous => (live().length ? live() : previous ?? []));
  const [expanded, setExpanded] = createSignal(false);
  const chevron = createSpring(() => (expanded() ? 90 : 0), 'indicator', { precision: 100 });
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });

  const runningCount = () => shown().filter(process => process.state === 'running').length;

  return (
    <Collapse open={live().length > 0} class="background-bar-slot">
      <div class="background-bar-frame">
        <div class="background-bar">
          <button
            type="button"
            class="background-bar-head"
            aria-expanded={expanded()}
            aria-label={expanded() ? 'Collapse background processes' : 'Expand background processes'}
            onClick={() => setExpanded(!expanded())}
          >
            <span class="background-glyph">
              <Show when={runningCount() > 0} fallback={<Icon name="check" size={12} />}>
                <Loader id={actionLoader.other} size={12} />
              </Show>
            </span>
            <span class="background-bar-title">
              {runningCount() > 0 ? `${runningCount()} running in background` : 'Finished in background'}
            </span>
            <span class="background-bar-spacer" />
            <Icon name="chevronRight" size={12} class="background-bar-chevron" style={{ rotate: `${chevron()}deg` }} />
          </button>
          <Collapse open={expanded()}>
            <div class="background-list">
              <AnimatedList each={shown()} key={process => process.id}>
                {process => <ProcessRow chatId={props.chatId} process={process} now={now} />}
              </AnimatedList>
            </div>
          </Collapse>
        </div>
      </div>
    </Collapse>
  );
}
