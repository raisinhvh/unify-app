/**
 * Scheduled prompts waiting to be sent (`/schedule <when> <prompt>`), as a compact bar by the composer.
 *
 *   <ScheduleBar chatId={id} />     that chat's pending prompts
 *   <ScheduleBar />                 prompts scheduled from Home (no chatId)
 *
 * Each row: clock glyph, the prompt on one ellipsised line, the due time (local HH:MM, plus a weekday or date
 * when it isn't today), a live countdown ("in 1h 20m"), then "Send now" and a cancel button. Nothing (and no
 * gap) while there are none.
 *
 * Motion: the bar opens and closes with Collapse (Reveal spring); rows come and go through AnimatedList.
 * The countdown re-renders every 30 s, or every second once a prompt is under a minute away.
 */
import { createMemo, createSignal, onCleanup, Show, type JSX } from 'solid-js';
import { Button, Icon, IconButton } from '../../components';
import { AnimatedList, Collapse } from '../../motion';
import { post } from '../../bridge';
import type { SidebarScheduledPrompt } from '../../protocol';
import { scheduledPrompts } from '../../store';
import './schedule-bar.css';

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

export interface ScheduleBarProps {
  /** The chat whose prompts to list; omit for Home (prompts with no chatId). */
  chatId?: string;
}

function sameDay(first: Date, second: Date): boolean {
  return first.getFullYear() === second.getFullYear() && first.getMonth() === second.getMonth() && first.getDate() === second.getDate();
}

function clockTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** "15:30" today, "Tue 09:00" within the coming week, "2 Dec 09:00" further out. */
export function formatDueTime(dueAt: number, now: number): string {
  const due = new Date(dueAt);
  const today = new Date(now);
  if (sameDay(due, today)) return clockTime(due);
  if (dueAt - now < 6 * dayMs) return `${due.toLocaleDateString(undefined, { weekday: 'short' })} ${clockTime(due)}`;
  return `${due.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${clockTime(due)}`;
}

/** "in 42s", "in 20m", "in 1h 20m", "in 2d 3h"; "due now" once it has passed. */
export function formatCountdown(dueAt: number, now: number): string {
  const remaining = dueAt - now;
  if (remaining <= 0) return 'due now';
  if (remaining < minuteMs) return `in ${Math.ceil(remaining / 1000)}s`;
  if (remaining < hourMs) return `in ${Math.ceil(remaining / minuteMs)}m`;
  if (remaining < dayMs) {
    const hours = Math.floor(remaining / hourMs);
    const minutes = Math.round((remaining - hours * hourMs) / minuteMs);
    return minutes ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
  }
  const days = Math.floor(remaining / dayMs);
  const hours = Math.round((remaining - days * dayMs) / hourMs);
  return hours ? `in ${days}d ${hours}h` : `in ${days}d`;
}

/**
 * A clock that ticks for the given due times: each second while one is under a minute away, else every 30 s.
 */
function createCountdownClock(dueTimes: () => number[]): () => number {
  const [now, setNow] = createSignal(Date.now());
  let timer: number | undefined;
  const schedule = () => {
    const current = Date.now();
    const urgent = dueTimes().some(dueAt => dueAt - current < minuteMs + 1000 && dueAt - current > -1000);
    timer = window.setTimeout(() => {
      setNow(Date.now());
      schedule();
    }, urgent ? 1000 : 30_000);
  };
  schedule();
  onCleanup(() => window.clearTimeout(timer));
  return now;
}

function ScheduleRow(props: { prompt: SidebarScheduledPrompt; now: number }): JSX.Element {
  return (
    <div class="schedule-row">
      <Icon name="clock" size={12} class="schedule-row-glyph" />
      <span class="schedule-row-prompt" title={props.prompt.prompt}>{props.prompt.prompt}</span>
      <Show when={props.prompt.imageCount}>
        {count => <span class="schedule-row-images type-caption">+{count()} image{count() === 1 ? '' : 's'}</span>}
      </Show>
      <span class="schedule-row-due" title={new Date(props.prompt.dueAt).toLocaleString()}>
        {formatDueTime(props.prompt.dueAt, props.now)}
      </span>
      <span class="schedule-row-countdown">{formatCountdown(props.prompt.dueAt, props.now)}</span>
      <Button
        class="schedule-row-send"
        onClick={() => post({ type: 'sendScheduledPromptNow', id: props.prompt.id })}
      >
        Send now
      </Button>
      <IconButton
        icon="close"
        label="Cancel scheduled prompt"
        size="small"
        tooltipPlacement="top-end"
        onClick={() => post({ type: 'cancelScheduledPrompt', id: props.prompt.id })}
      />
    </div>
  );
}

export function ScheduleBar(props: ScheduleBarProps): JSX.Element {
  const prompts = createMemo(() =>
    scheduledPrompts()
      .filter(prompt => (prompt.chatId || undefined) === (props.chatId || undefined))
      .sort((first, second) => first.dueAt - second.dueAt),
  );
  const now = createCountdownClock(() => prompts().map(prompt => prompt.dueAt));

  return (
    <Collapse open={prompts().length > 0} class="schedule-bar-slot">
      <div class="schedule-bar-frame">
        <div class="schedule-bar" role="list" aria-label="Scheduled prompts">
          <AnimatedList each={prompts()} key={prompt => prompt.id} itemClass="schedule-row-slot">
            {prompt => <ScheduleRow prompt={prompt()} now={now()} />}
          </AnimatedList>
        </div>
      </div>
    </Collapse>
  );
}
