// Xero date handling: calendar dates stored as YYYY-MM-DD, instants as ISO-8601 UTC, rendered as /Date(ms+0000)/.
// The organisation's local date uses a fixed +12:00 offset. Every parse is explicit and host-independent.

export const ORG_OFFSET_MINUTES = 720;
const DAY_MS = 86400000;

const pad = (n, width = 2) => String(n).padStart(width, "0");

function digitsAt(text, start, count) {
  let value = 0;
  for (let i = start; i < start + count; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) return null;
    value = value * 10 + (code - 48);
  }
  return value;
}

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function validDate(year, month, day) {
  return year >= 1900 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** Epoch milliseconds of midnight UTC of a YYYY-MM-DD string. */
export function dateMs(date) {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

/** YYYY-MM-DD of an epoch-millisecond instant shifted by offsetMinutes. */
export function dateOf(ms, offsetMinutes = 0) {
  const d = new Date(ms + offsetMinutes * 60000);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export const isoOf = (ms) => new Date(ms).toISOString();

export const addDays = (date, days) => dateOf(dateMs(date) + days * DAY_MS);

/** Clock facts for one operation call. */
export function clockOf(context) {
  const ms = Math.floor(context.clock.nowUs() / 1000);
  return { ms, iso: isoOf(ms), wire: wireMs(ms), today: dateOf(ms, ORG_OFFSET_MINUTES) };
}

export const wireMs = (ms) => `/Date(${ms}+0000)/`;
export const wireDate = (date) => (date === null ? null : wireMs(dateMs(date)));
export const wireDateString = (date) => (date === null ? null : `${date}T00:00:00`);
export const wireInstant = (iso) => wireMs(Date.parse(iso));

/**
 * Parse a caller date: "YYYY-MM-DD", "YYYY-MM-DDTHH:MM:SS[.fff]" (date part taken) or "/Date(ms[+hhmm])/".
 * Returns YYYY-MM-DD or null when the value is not a real calendar date.
 */
export function parseDate(value) {
  if (typeof value !== "string" || value.length < 10 || value.length > 40) return null;
  if (value.startsWith("/Date(")) {
    let i = 6;
    let negative = false;
    if (value[i] === "-") {
      negative = true;
      i += 1;
    }
    let digits = "";
    while (i < value.length && value.charCodeAt(i) >= 48 && value.charCodeAt(i) <= 57 && digits.length < 16) digits += value[i++];
    if (digits.length === 0) return null;
    const rest = value.slice(i);
    if (rest !== ")/" && !(rest.length === 7 && (rest[0] === "+" || rest[0] === "-") && digitsAt(rest, 1, 4) !== null && rest.endsWith(")/"))) return null;
    const ms = (negative ? -1 : 1) * Number(digits);
    if (!Number.isSafeInteger(ms) || ms < -2208988800000 || ms > 253402214400000) return null;
    return dateOf(ms);
  }
  const year = digitsAt(value, 0, 4);
  const month = digitsAt(value, 5, 2);
  const day = digitsAt(value, 8, 2);
  if (year === null || month === null || day === null || value[4] !== "-" || value[7] !== "-") return null;
  if (!validDate(year, month, day)) return null;
  if (value.length === 10) return value.slice(0, 10);
  if (value[10] !== "T") return null;
  const tail = value.slice(11);
  const h = digitsAt(tail, 0, 2);
  const m = digitsAt(tail, 3, 2);
  const s = digitsAt(tail, 6, 2);
  if (tail.length < 8 || h === null || m === null || s === null || tail[2] !== ":" || tail[5] !== ":" || h > 23 || m > 59 || s > 59) return null;
  const frac = tail.slice(8);
  if (frac.length > 0) {
    if (frac[0] !== "." || frac.length > 8 || digitsAt(frac, 1, frac.length - 1) === null || frac.length === 1) return null;
  }
  return value.slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Parse If-Modified-Since: RFC 1123 ("Tue, 15 Sep 2026 08:00:00 GMT") or ISO-8601 "YYYY-MM-DDTHH:MM:SS[.fff][Z]"
 * (zone-less is UTC). Returns epoch ms or null.
 */
export function parseInstant(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  if (value.length === 29 && value[3] === "," && value.endsWith(" GMT")) {
    const day = digitsAt(value, 5, 2);
    const month = MONTHS.indexOf(value.slice(8, 11)) + 1;
    const year = digitsAt(value, 12, 4);
    const h = digitsAt(value, 17, 2);
    const m = digitsAt(value, 20, 2);
    const s = digitsAt(value, 23, 2);
    if (day === null || year === null || h === null || m === null || s === null || month === 0) return null;
    if (!validDate(year, month, day) || h > 23 || m > 59 || s > 59) return null;
    return Date.UTC(year, month - 1, day, h, m, s);
  }
  let text = value;
  if (text.endsWith("Z")) text = text.slice(0, -1);
  if (text.length < 19) return null;
  const date = parseDate(text);
  if (date === null || text[10] !== "T") return null;
  const h = digitsAt(text, 11, 2);
  const m = digitsAt(text, 14, 2);
  const s = digitsAt(text, 17, 2);
  let ms = 0;
  if (text.length > 20) ms = Math.floor(digitsAt(text, 20, Math.min(3, text.length - 20)) * 10 ** (3 - Math.min(3, text.length - 20)));
  return dateMs(date) + h * 3600000 + m * 60000 + s * 1000 + ms;
}
