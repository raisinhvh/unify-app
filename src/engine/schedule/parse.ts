/**
 * `/schedule` argument parsing: a delay, a clock time or an ISO date-time at the start of the
 * arguments, then the prompt. Pure, so the tests can pin "now" and check rollover behaviour.
 */
import { SCHEDULE_USAGE } from '../slash/registry';

export type ParsedSchedule = { dueAt: number; prompt: string } | { error: string };

/** The longest delay a single schedule may use. */
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

/** One `10m`, `2 hours` or `3 days` part of a delay; sticky so parts must be adjacent. */
const DURATION_PART = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d)(?![a-z])/iy;

const EXAMPLES = 'Examples: /schedule in 2h run the tests, /schedule at 15:30 check the build, /schedule 9am tomorrow summarize the diff.';

function failure(detail?: string): { error: string } {
  const parts = [detail, SCHEDULE_USAGE, EXAMPLES].filter((part): part is string => !!part);
  return { error: parts.join(' ') };
}

/** Milliseconds in one unit; all units start with a different letter. */
function unitMilliseconds(unit: string): number {
  switch (unit[0].toLowerCase()) {
    case 's': return 1_000;
    case 'm': return 60_000;
    case 'h': return 3_600_000;
    default: return 86_400_000;
  }
}

/** Reads one or more adjacent duration parts (`1h30m`, `2 hours`, `1 day`). */
function parseDuration(text: string): { ms: number; length: number } | undefined {
  let index = 0;
  let total = 0;
  let matched = false;
  while (true) {
    DURATION_PART.lastIndex = index;
    const part = DURATION_PART.exec(text);
    if (!part) break;
    const value = Number(part[1]);
    if (!Number.isFinite(value) || value < 0) return undefined;
    total += value * unitMilliseconds(part[2]);
    matched = true;
    index = DURATION_PART.lastIndex;
    // Only consume the gap between parts when another part really follows, so the prompt keeps its spacing.
    const spaces = /^\s*/.exec(text.slice(index))?.[0].length ?? 0;
    const next = index + spaces;
    DURATION_PART.lastIndex = next;
    if (!DURATION_PART.test(text)) break;
    index = next;
  }
  if (!matched) return undefined;
  return { ms: total, length: index };
}

type TimeResult = { dueAt: number; length: number } | { error: string } | undefined;

/** `2026-11-24 09:00` or `2026-11-24T09:00`; explicit dates in the past are rejected. */
function parseIso(text: string, now: Date): TimeResult {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[Tt ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  const due = new Date(year, month - 1, day, hour, minute, second, 0);
  // A rolled-over component (31 February, 24:00) means the text named a time that does not exist.
  if (due.getFullYear() !== year || due.getMonth() !== month - 1 || due.getDate() !== day ||
    due.getHours() !== hour || due.getMinutes() !== minute || due.getSeconds() !== second) {
    return failure('That date and time does not exist.');
  }
  if (due.getTime() <= now.getTime()) return failure('That time has already passed.');
  return { dueAt: due.getTime(), length: match[0].length };
}

/** A clock time with an optional `today`/`tomorrow` before or after it. */
function parseClock(text: string, now: Date): TimeResult {
  let index = 0;
  let day: 'today' | 'tomorrow' | undefined;
  const leading = /^(today|tomorrow)\b[,\s]*/i.exec(text);
  if (leading) {
    day = leading[1].toLowerCase() as 'today' | 'tomorrow';
    index = leading[0].length;
  }
  const at = /^at\s+/i.exec(text.slice(index));
  if (at) index += at[0].length;

  const core = text.slice(index);
  let hour: number;
  let minute: number;
  let second = 0;
  let length: number;
  const word = /^(noon|midnight)\b/i.exec(core);
  if (word) {
    hour = word[1].toLowerCase() === 'noon' ? 12 : 0;
    minute = 0;
    length = word[0].length;
  } else {
    const twelveHour = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(core);
    if (twelveHour) {
      hour = Number(twelveHour[1]);
      minute = Number(twelveHour[2] || 0);
      const meridiem = twelveHour[3].toLowerCase();
      if (hour < 1 || hour > 12 || minute > 59) return failure('That time does not exist.');
      if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
      else hour = hour === 12 ? 12 : hour + 12;
      length = twelveHour[0].length;
    } else {
      const twentyFourHour = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(core);
      if (!twentyFourHour) return undefined;
      hour = Number(twentyFourHour[1]);
      minute = Number(twentyFourHour[2]);
      second = Number(twentyFourHour[3] || 0);
      if (hour > 23 || minute > 59 || second > 59) return failure('That time does not exist.');
      length = twentyFourHour[0].length;
    }
  }
  index += length;
  const trailing = /^\s*(today|tomorrow)\b/i.exec(text.slice(index));
  if (trailing) {
    const trailingDay = trailing[1].toLowerCase() as 'today' | 'tomorrow';
    if (day && day !== trailingDay) return failure('Choose either today or tomorrow, not both.');
    day = trailingDay;
    index += trailing[0].length;
  }

  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (day === 'tomorrow') base.setDate(base.getDate() + 1);
  const due = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, second, 0);
  if (!day && due.getTime() < now.getTime()) due.setDate(due.getDate() + 1);
  if (day === 'today' && due.getTime() < now.getTime()) return failure('That time has already passed today.');
  return { dueAt: due.getTime(), length: index };
}

/** The prompt after the time expression, without a leading separator such as `:`, `,` or `-`. */
function promptAfter(rest: string): string {
  return rest.replace(/^\s*[:,\-\u2013\u2014]\s*/, '').trim();
}

function finishDelay(text: string, length: number, ms: number, now: Date): ParsedSchedule {
  if (ms > MAX_DELAY_MS) return failure('Delays can be at most 30 days.');
  const prompt = promptAfter(text.slice(length));
  if (!prompt) return failure('Add a prompt to send after the delay.');
  return { dueAt: now.getTime() + Math.round(ms), prompt };
}

function finishTime(text: string, result: { dueAt: number; length: number } | { error: string }): ParsedSchedule {
  if ('error' in result) return result;
  const prompt = promptAfter(text.slice(result.length));
  if (!prompt) return failure('Add a prompt to send at that time.');
  return { dueAt: result.dueAt, prompt };
}

/**
 * Parses `/schedule` arguments. Accepts, at the start and case-insensitively:
 * `in 10m`, `2h`, `1h30m`, `90 minutes`, `at 15:30`, `3:15pm`, `noon`, `tomorrow 9am`,
 * `9am tomorrow`, `2026-11-24 09:00` and `2026-11-24T09:00`; the rest is the prompt.
 */
export function parseScheduleArgs(args: string, now: Date): ParsedSchedule {
  const text = (args || '').trim();
  if (!text) return failure('Add a time and a prompt.');

  const inDelay = /^in\b\s*/i.exec(text);
  if (inDelay) {
    const duration = parseDuration(text.slice(inDelay[0].length));
    if (!duration) return failure(`Could not read a delay from "${text}".`);
    return finishDelay(text, inDelay[0].length + duration.length, duration.ms, now);
  }
  const bareDelay = parseDuration(text);
  if (bareDelay) return finishDelay(text, bareDelay.length, bareDelay.ms, now);

  const iso = parseIso(text, now);
  if (iso) return finishTime(text, iso);
  const clock = parseClock(text, now);
  if (clock) return finishTime(text, clock);
  return failure(`Could not read a time from "${text}".`);
}
