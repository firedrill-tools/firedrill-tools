// Host-independent time handling: ISO-8601 UTC strings from virtual microseconds and strict parsing of caller dates.
// Zone-less input is UTC (the provider's documented default); nothing here consults the host clock or time zone.
import { pad } from "./util.mjs";

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Formats virtual microseconds as `YYYY-MM-DDTHH:MM:SS.sssZ`. */
export function isoFromUs(us) {
  const ms = Math.floor(Number(us) / 1000);
  const date = new Date(ms);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}T${pad(
    date.getUTCHours(),
    2,
  )}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}.${pad(date.getUTCMilliseconds(), 3)}Z`;
}

export const nowIso = (context) => isoFromUs(context.clock.nowUs());

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parses an ISO-8601 date or date-time into microseconds since the epoch, or returns null when the text is not a
 * real instant. Time and zone are optional; a missing zone means UTC. A U+FFFD (mangled percent-encoding) is invalid.
 */
export function parseIsoUs(text) {
  if (typeof text !== "string" || text.length > 40 || text.includes("�")) return null;
  const match = ISO.exec(text.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const fraction = match[7] === undefined ? 0 : Number(match[7].padEnd(6, "0"));
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const maxDay = DAYS_IN_MONTH[month - 1] + (month === 2 && isLeap(year) ? 1 : 0);
  if (day > maxDay || hour > 23 || minute > 59 || second > 60) return null;
  let offsetMinutes = 0;
  if (match[8] !== undefined && match[8] !== "Z") {
    const sign = match[8][0] === "-" ? -1 : 1;
    const digits = match[8].slice(1).replace(":", "");
    const offsetHours = Number(digits.slice(0, 2));
    const offsetMins = Number(digits.slice(2, 4));
    if (offsetHours > 14 || offsetMins > 59) return null;
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, Math.min(second, 59)) - offsetMinutes * 60000;
  return ms * 1000 + fraction;
}

/** Normalises caller date text to the canonical ISO string, or null when invalid. */
export function normaliseIso(text) {
  const us = parseIsoUs(text);
  return us === null ? null : isoFromUs(us);
}
