// Deterministic quickAdd grammar: `<title> [<date>] [<time>[-<time>|for N min|hours]] [at|in <location>]`.
import { addDays, dateToMs, daysInMonth, zonedParts, zonedToMs } from "./time.mjs";

export class QuickAddError extends Error {}

// Null-prototype tables looked up only through `lookup` (Object.hasOwn): words such as "constructor" stay title words.
const table = (entries) => Object.freeze(Object.assign(Object.create(null), entries));
const lookup = (tableValue, key) => (typeof key === "string" && Object.hasOwn(tableValue, key) ? tableValue[key] : undefined);
const WEEKDAYS = table({ sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 });
const MONTHS = table({
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
});
const DURATION_UNITS = table({ min: 1, mins: 1, minute: 1, minutes: 1, hour: 60, hours: 60, hr: 60, hrs: 60, h: 60 });

function parseTimeToken(token, meridiemToken) {
  const lower = token.toLowerCase();
  if (lower === "noon") return { minutes: 12 * 60, explicit: true, consumedMeridiem: false };
  if (lower === "midnight") return { minutes: 0, explicit: true, consumedMeridiem: false };
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm|a\.m\.|p\.m\.)?$/.exec(lower);
  if (match === null) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  let meridiem = match[3]?.replace(/\./g, "");
  let consumedMeridiem = false;
  if (meridiem === undefined && meridiemToken !== undefined && /^(am|pm|a\.m\.|p\.m\.)$/.test(meridiemToken.toLowerCase())) {
    meridiem = meridiemToken.toLowerCase().replace(/\./g, "");
    consumedMeridiem = true;
  }
  if (hour > 23 || minute > 59) return null;
  if (meridiem !== undefined) {
    if (hour > 12 || hour === 0) return null;
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  }
  return { minutes: hour * 60 + minute, explicit: match[2] !== undefined || meridiem !== undefined, consumedMeridiem };
}

/**
 * Parse quickAdd text. Returns { summary, location?, allDay, start, end } where start/end are
 * { year, month, day } for all-day results and epoch milliseconds for timed results.
 */
export function parseQuickAdd(text, { nowMs, zone, defaultLengthMinutes }) {
  const words = String(text).trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) throw new QuickAddError("Text is required.");
  const consumed = new Array(words.length).fill(false);
  const lower = words.map((word) => word.toLowerCase().replace(/[,]+$/, ""));
  const today = zonedParts(nowMs, zone);
  let date = null;
  let startMinutes = null;
  let endMinutes = null;
  let durationMinutes = null;

  // Duration: for N minutes|hours, for an hour, for half an hour.
  for (let index = 0; index < words.length - 1; index += 1) {
    if (lower[index] !== "for") continue;
    if (lower[index + 1] === "an" && (lower[index + 2] === "hour" || lower[index + 2] === "hr")) {
      durationMinutes = 60;
      consumed.fill(true, index, index + 3);
      break;
    }
    if (lower[index + 1] === "half" && lower[index + 2] === "an" && lower[index + 3] === "hour") {
      durationMinutes = 30;
      consumed.fill(true, index, index + 4);
      break;
    }
    const inline = /^(\d{1,3})(min|mins|minutes|h|hr|hrs|hours?)$/.exec(lower[index + 1]);
    if (inline !== null) {
      durationMinutes = Number(inline[1]) * lookup(DURATION_UNITS, inline[2]);
      consumed.fill(true, index, index + 2);
      break;
    }
    if (/^\d{1,3}$/.test(lower[index + 1]) && lookup(DURATION_UNITS, lower[index + 2]) !== undefined) {
      durationMinutes = Number(lower[index + 1]) * lookup(DURATION_UNITS, lower[index + 2]);
      consumed.fill(true, index, index + 3);
      break;
    }
  }

  // Date.
  for (let index = 0; index < words.length && date === null; index += 1) {
    if (consumed[index]) continue;
    const word = lower[index];
    const prefixed = (word === "on" || word === "next" || word === "this") && index + 1 < words.length;
    const target = prefixed ? lower[index + 1] : word;
    const at = prefixed ? index + 1 : index;
    if (target === "today") {
      date = { year: today.year, month: today.month, day: today.day };
      consumed.fill(true, index, at + 1);
    } else if (target === "tomorrow") {
      date = addDays(today, 1);
      consumed.fill(true, index, at + 1);
    } else if (lookup(WEEKDAYS, target) !== undefined) {
      let ahead = (lookup(WEEKDAYS, target) - today.weekday + 7) % 7;
      if (word === "next" && ahead === 0) ahead = 7;
      date = addDays(today, ahead);
      consumed.fill(true, index, at + 1);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(target)) {
      const [year, month, day] = target.split("-").map(Number);
      if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new QuickAddError(`Invalid date: ${target}`);
      date = { year, month, day };
      consumed.fill(true, index, at + 1);
    } else if (lookup(MONTHS, target) !== undefined && at + 1 < words.length && /^\d{1,2}(st|nd|rd|th)?,?$/.test(lower[at + 1])) {
      const day = Number(lower[at + 1].replace(/\D/g, ""));
      let year = today.year;
      let end = at + 2;
      if (/^\d{4}$/.test(lower[at + 2] ?? "")) {
        year = Number(lower[at + 2]);
        end = at + 3;
      }
      if (day < 1 || day > daysInMonth(year, lookup(MONTHS, target))) throw new QuickAddError(`Invalid date: ${words[at]} ${words[at + 1]}`);
      date = { year, month: lookup(MONTHS, target), day };
      consumed.fill(true, index, end);
    } else if (/^\d{1,2}(st|nd|rd|th)?$/.test(target) && at + 1 < words.length && lookup(MONTHS, lower[at + 1]) !== undefined) {
      const day = Number(target.replace(/\D/g, ""));
      let year = today.year;
      let end = at + 2;
      if (/^\d{4}$/.test(lower[at + 2] ?? "")) {
        year = Number(lower[at + 2]);
        end = at + 3;
      }
      if (day < 1 || day > daysInMonth(year, lookup(MONTHS, lower[at + 1]))) throw new QuickAddError(`Invalid date: ${words[at]} ${words[at + 1]}`);
      date = { year, month: lookup(MONTHS, lower[at + 1]), day };
      consumed.fill(true, index, end);
    }
  }

  // Time or time range: "at 12:30", "3pm-4pm", "from 9 to 10:30", "at noon".
  for (let index = 0; index < words.length && startMinutes === null; index += 1) {
    if (consumed[index]) continue;
    const word = lower[index];
    const prefixed = (word === "at" || word === "from" || word === "@") && index + 1 < words.length && !consumed[index + 1];
    const at = prefixed ? index + 1 : index;
    const token = lower[at];
    const range = /^([^-–]+)[-–]([^-–]+)$/.exec(token);
    let first;
    let second = null;
    let end = at + 1;
    if (range !== null) {
      first = parseTimeToken(range[1]);
      second = parseTimeToken(range[2], lower[at + 1]);
      if (first === null || second === null) continue;
      if (second.consumedMeridiem) end = at + 2;
    } else {
      first = parseTimeToken(token, lower[at + 1]);
      if (first === null) continue;
      if (!prefixed && !first.explicit) continue; // a bare number is part of the title unless introduced by "at"/"from"
      if (first.consumedMeridiem) end = at + 2;
      const connector = lower[end];
      if ((connector === "-" || connector === "–" || connector === "to" || connector === "until") && end + 1 < words.length) {
        const candidate = parseTimeToken(lower[end + 1], lower[end + 2]);
        if (candidate !== null) {
          second = candidate;
          end += candidate.consumedMeridiem ? 3 : 2;
        }
      }
    }
    startMinutes = first.minutes;
    if (second !== null) {
      endMinutes = second.minutes;
      if (endMinutes <= startMinutes && endMinutes < 12 * 60) endMinutes += 12 * 60;
    }
    consumed.fill(true, index, end);
  }

  // Location: the last unconsumed "at"/"in" followed by free text.
  let location;
  for (let index = words.length - 2; index >= 0; index -= 1) {
    if (consumed[index] || (lower[index] !== "at" && lower[index] !== "in") || consumed[index + 1]) continue;
    let end = index + 1;
    while (end < words.length && !consumed[end]) end += 1;
    location = words.slice(index + 1, end).join(" ").replace(/[,.]+$/, "");
    consumed.fill(true, index, end);
    break;
  }

  const titleWords = words.filter((_, index) => !consumed[index]);
  while (titleWords.length > 0 && /^(on|at|in|from|for)$/i.test(titleWords[titleWords.length - 1])) titleWords.pop();
  while (titleWords.length > 0 && /^(on|at|in|from|for)$/i.test(titleWords[0])) titleWords.shift();
  const summary = titleWords.join(" ").replace(/\s+,/g, ",").trim();
  if (summary.length === 0) throw new QuickAddError("Could not find an event title in the text.");

  const day = date ?? { year: today.year, month: today.month, day: today.day };
  if (startMinutes === null) {
    return { summary, ...(location ? { location } : {}), allDay: true, start: day, end: addDays(day, 1) };
  }
  const startMs = zonedToMs(zone, { ...day, hour: Math.floor(startMinutes / 60), minute: startMinutes % 60, second: 0 });
  let endMs;
  if (endMinutes !== null) {
    const endDay = endMinutes >= 24 * 60 ? addDays(day, 1) : day;
    const minutes = endMinutes % (24 * 60);
    endMs = zonedToMs(zone, { ...endDay, hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0 });
  } else {
    endMs = startMs + (durationMinutes ?? defaultLengthMinutes) * 60_000;
  }
  if (endMs <= startMs) throw new QuickAddError("The end time must be after the start time.");
  return { summary, ...(location ? { location } : {}), allDay: false, start: startMs, end: endMs, dateMs: dateToMs(day) };
}
