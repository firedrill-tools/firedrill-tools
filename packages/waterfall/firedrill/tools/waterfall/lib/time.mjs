// Hand-rolled proleptic Gregorian calendar (UTC only). Virtual time is an integer count of microseconds since the Unix
// epoch; nothing here parses zone-less strings with `Date`, so the same world renders identically on every host.

const US_PER_DAY = 86_400_000_000;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export function daysInMonth(year, month) {
  return month === 2 && isLeap(year) ? 29 : DAYS_IN_MONTH[month - 1];
}

/** Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm). */
export function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Civil date for a day count since 1970-01-01. */
export function civilFromDays(days) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

const pad = (value, width) => String(value).padStart(width, "0");

export function formatDate(days) {
  const { year, month, day } = civilFromDays(days);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** `YYYY-MM-DD` (UTC) of a microsecond instant. */
export function dateOfUs(us) {
  return formatDate(Math.floor(us / US_PER_DAY));
}

/** `YYYY-MM-DDTHH:MM:SS.ffffff+00:00` of a microsecond instant. */
export function isoOfUs(us) {
  const days = Math.floor(us / US_PER_DAY);
  let rest = us - days * US_PER_DAY;
  const hours = Math.floor(rest / 3_600_000_000);
  rest -= hours * 3_600_000_000;
  const minutes = Math.floor(rest / 60_000_000);
  rest -= minutes * 60_000_000;
  const seconds = Math.floor(rest / 1_000_000);
  const micros = rest - seconds * 1_000_000;
  return `${formatDate(days)}T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(micros, 6)}+00:00`;
}

export function usOfDays(days) {
  return days * US_PER_DAY;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** Strict `YYYY-MM-DD` → day count, or `null` when malformed or not a real calendar date. */
export function parseDate(text) {
  if (typeof text !== "string" || text.length !== 10) return null;
  const match = DATE_RE.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return daysFromCivil(year, month, day);
}

/** Strict `YYYY-MM` → `{ year, month }`, or `null`. */
export function parseMonth(text) {
  if (typeof text !== "string" || text.length !== 7) return null;
  const match = MONTH_RE.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12) return null;
  return { year, month };
}

/** `{ year, month }` shifted by `count` months (negative allowed). */
export function addMonths({ year, month }, count) {
  const index = year * 12 + (month - 1) + count;
  return { year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 };
}

/** First day (day count) of a month. */
export function monthStartDays({ year, month }) {
  return daysFromCivil(year, month, 1);
}

/** Day count of the first day of the month that contains `days`. */
export function monthOfDays(days) {
  const { year, month } = civilFromDays(days);
  return { year, month };
}
