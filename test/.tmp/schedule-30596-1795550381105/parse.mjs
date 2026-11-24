// src/engine/slash/registry.ts
var SCHEDULE_USAGE = "/schedule <in 2h | at 15:30 | 9am tomorrow> <prompt>";

// src/engine/schedule/parse.ts
var MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1e3;
var DURATION_PART = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d)(?![a-z])/iy;
var EXAMPLES = "Examples: /schedule in 2h run the tests, /schedule at 15:30 check the build, /schedule 9am tomorrow summarize the diff.";
function failure(detail) {
  const parts = [detail, SCHEDULE_USAGE, EXAMPLES].filter((part) => !!part);
  return { error: parts.join(" ") };
}
function unitMilliseconds(unit) {
  switch (unit[0].toLowerCase()) {
    case "s":
      return 1e3;
    case "m":
      return 6e4;
    case "h":
      return 36e5;
    default:
      return 864e5;
  }
}
function parseDuration(text) {
  let index = 0;
  let total = 0;
  let matched = false;
  while (true) {
    DURATION_PART.lastIndex = index;
    const part = DURATION_PART.exec(text);
    if (!part) break;
    const value = Number(part[1]);
    if (!Number.isFinite(value) || value < 0) return void 0;
    total += value * unitMilliseconds(part[2]);
    matched = true;
    index = DURATION_PART.lastIndex;
    const spaces = /^\s*/.exec(text.slice(index))?.[0].length ?? 0;
    const next = index + spaces;
    DURATION_PART.lastIndex = next;
    if (!DURATION_PART.test(text)) break;
    index = next;
  }
  if (!matched) return void 0;
  return { ms: total, length: index };
}
function parseIso(text, now) {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[Tt ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!match) return void 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  const due = new Date(year, month - 1, day, hour, minute, second, 0);
  if (due.getFullYear() !== year || due.getMonth() !== month - 1 || due.getDate() !== day || due.getHours() !== hour || due.getMinutes() !== minute || due.getSeconds() !== second) {
    return failure("That date and time does not exist.");
  }
  if (due.getTime() <= now.getTime()) return failure("That time has already passed.");
  return { dueAt: due.getTime(), length: match[0].length };
}
function parseClock(text, now) {
  let index = 0;
  let day;
  const leading = /^(today|tomorrow)\b[,\s]*/i.exec(text);
  if (leading) {
    day = leading[1].toLowerCase();
    index = leading[0].length;
  }
  const at = /^at\s+/i.exec(text.slice(index));
  if (at) index += at[0].length;
  const core = text.slice(index);
  let hour;
  let minute;
  let second = 0;
  let length;
  const word = /^(noon|midnight)\b/i.exec(core);
  if (word) {
    hour = word[1].toLowerCase() === "noon" ? 12 : 0;
    minute = 0;
    length = word[0].length;
  } else {
    const twelveHour = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(core);
    if (twelveHour) {
      hour = Number(twelveHour[1]);
      minute = Number(twelveHour[2] || 0);
      const meridiem = twelveHour[3].toLowerCase();
      if (hour < 1 || hour > 12 || minute > 59) return failure("That time does not exist.");
      if (meridiem === "am") hour = hour === 12 ? 0 : hour;
      else hour = hour === 12 ? 12 : hour + 12;
      length = twelveHour[0].length;
    } else {
      const twentyFourHour = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(core);
      if (!twentyFourHour) return void 0;
      hour = Number(twentyFourHour[1]);
      minute = Number(twentyFourHour[2]);
      second = Number(twentyFourHour[3] || 0);
      if (hour > 23 || minute > 59 || second > 59) return failure("That time does not exist.");
      length = twentyFourHour[0].length;
    }
  }
  index += length;
  const trailing = /^\s*(today|tomorrow)\b/i.exec(text.slice(index));
  if (trailing) {
    const trailingDay = trailing[1].toLowerCase();
    if (day && day !== trailingDay) return failure("Choose either today or tomorrow, not both.");
    day = trailingDay;
    index += trailing[0].length;
  }
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (day === "tomorrow") base.setDate(base.getDate() + 1);
  const due = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, second, 0);
  if (!day && due.getTime() < now.getTime()) due.setDate(due.getDate() + 1);
  if (day === "today" && due.getTime() < now.getTime()) return failure("That time has already passed today.");
  return { dueAt: due.getTime(), length: index };
}
function promptAfter(rest) {
  return rest.replace(/^\s*[:,\-\u2013\u2014]\s*/, "").trim();
}
function finishDelay(text, length, ms, now) {
  if (ms > MAX_DELAY_MS) return failure("Delays can be at most 30 days.");
  const prompt = promptAfter(text.slice(length));
  if (!prompt) return failure("Add a prompt to send after the delay.");
  return { dueAt: now.getTime() + Math.round(ms), prompt };
}
function finishTime(text, result) {
  if ("error" in result) return result;
  const prompt = promptAfter(text.slice(result.length));
  if (!prompt) return failure("Add a prompt to send at that time.");
  return { dueAt: result.dueAt, prompt };
}
function parseScheduleArgs(args, now) {
  const text = (args || "").trim();
  if (!text) return failure("Add a time and a prompt.");
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
export {
  parseScheduleArgs
};
