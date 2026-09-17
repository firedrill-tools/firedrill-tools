// Billing-period arithmetic on UTC calendar fields. Only `Date.UTC` and explicit epoch construction are used;
// nothing here reads the wall clock.

export const DAY = 86_400;

export const INTERVALS = Object.freeze(["day", "week", "month", "year"]);
export const MAX_INTERVAL_COUNT = Object.freeze({ day: 365, week: 52, month: 12, year: 1 });

function utcFields(seconds) {
  const date = new Date(seconds * 1_000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** `seconds` advanced by `count` intervals; month/year steps clamp to the last day of the target month. */
export function addInterval(seconds, interval, count) {
  if (interval === "day") return seconds + count * DAY;
  if (interval === "week") return seconds + count * 7 * DAY;
  const fields = utcFields(seconds);
  const months = interval === "year" ? count * 12 : count;
  const total = fields.year * 12 + fields.month + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const day = Math.min(fields.day, daysInMonth(year, month));
  return Math.floor(Date.UTC(year, month, day, fields.hour, fields.minute, fields.second) / 1_000);
}

/** ISO-8601 (`2026-09-14T09:00:00Z`) for logs and messages. */
export function isoSeconds(seconds) {
  return new Date(seconds * 1_000).toISOString().replace(/\.000Z$/, "Z");
}
