// Strict calendar dates (`YYYY-MM-DD`, years 1900–2100) and ISO-8601 UTC timestamps with seconds, computed from day
// numbers. No Date.parse on caller text, no wall clock: "now" is always `context.clock.nowUs()`.
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/;
export const DAY_MS = 86400000;

export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const monthLength = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Days since 1970-01-01 for a civil date (Hinnant). */
export function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** Day number of a valid `YYYY-MM-DD`, or null. Never throws. */
export function parseDate(value) {
  const m = typeof value === "string" && value.length === 10 ? DATE.exec(value) : null;
  if (m === null) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > monthLength(y, mo)) return null;
  return daysFromCivil(y, mo, d);
}

export function formatDate(days) {
  const { year, month, day } = civilFromDays(days);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (days) => (((days + 4) % 7) + 7) % 7;

export function formatStamp(ms) {
  const days = Math.floor(ms / DAY_MS);
  const rest = ms - days * DAY_MS;
  const h = Math.floor(rest / 3600000);
  const mi = Math.floor((rest % 3600000) / 60000);
  const s = Math.floor((rest % 60000) / 1000);
  return `${formatDate(days)}T${pad(h)}:${pad(mi)}:${pad(s)}Z`;
}

/** Milliseconds for an ISO-8601 UTC timestamp (`Z` required), or null. Never throws. */
export function parseStamp(value) {
  const m = typeof value === "string" && value.length <= 40 ? STAMP.exec(value) : null;
  if (m === null) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > monthLength(y, mo) || h > 23 || mi > 59 || s > 59) return null;
  return daysFromCivil(y, mo, d) * DAY_MS + h * 3600000 + mi * 60000 + s * 1000;
}

export const nowMs = (context) => Math.floor(context.clock.nowUs() / 1000);
export const nowStamp = (context) => formatStamp(nowMs(context));
export const today = (context) => Math.floor(nowMs(context) / DAY_MS);

/** Adds calendar months keeping the day of month, clamped to the month's end. */
export function addMonths(days, months, dayOfMonth) {
  const { year, month, day } = civilFromDays(days);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const mo = (index % 12) + 1;
  return daysFromCivil(y, mo, Math.min(dayOfMonth ?? day, monthLength(y, mo)));
}

/** ISO-8601 UTC with milliseconds (used for preview start instants, which must be distinguishable). */
export function formatStampMs(ms) {
  return `${formatStamp(ms).slice(0, 19)}.${String(((ms % 1000) + 1000) % 1000).padStart(3, "0")}Z`;
}
