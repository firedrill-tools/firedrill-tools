// ISO-8601 UTC timestamps with milliseconds from virtual time (microseconds). No wall clock.
const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function isLeap(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Civil date from days since 1970-01-01 (Howard Hinnant's algorithm). */
function civil(days) {
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

const pad = (n, w = 2) => String(n).padStart(w, "0");

export function isoFromMs(ms) {
  const days = Math.floor(ms / 86400000);
  const rest = ms - days * 86400000;
  const { year, month, day } = civil(days);
  const h = Math.floor(rest / 3600000);
  const m = Math.floor((rest % 3600000) / 60000);
  const s = Math.floor((rest % 60000) / 1000);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(h)}:${pad(m)}:${pad(s)}.${pad(rest % 1000, 3)}Z`;
}

export function nowMs(context) {
  return Math.floor(context.clock.nowUs() / 1000);
}

export function nowIso(context) {
  return isoFromMs(nowMs(context));
}

/** Milliseconds since the epoch for a stored `YYYY-MM-DDTHH:MM:SS.mmmZ` string, or null. */
export function msFromIso(value) {
  const m = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(value) : null;
  if (m === null) return null;
  const [year, month, day, h, min, s, ms] = m.slice(1).map(Number);
  let days = (year - 1970) * 365;
  for (let y = 1970; y < year; y++) if (isLeap(y)) days++;
  days += DAYS_BEFORE_MONTH[month - 1] + (month > 2 && isLeap(year) ? 1 : 0) + day - 1;
  return days * 86400000 + h * 3600000 + min * 60000 + s * 1000 + ms;
}

/** A real calendar date `YYYY-MM-DD` between 1900 and 2100. */
export function isDate(value) {
  const m = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (m === null) return false;
  const [year, month, day] = m.slice(1).map(Number);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  const lengths = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}
