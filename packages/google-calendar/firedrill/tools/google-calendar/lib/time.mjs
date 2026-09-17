// Deterministic date/time helpers with a fixed IANA table (2026 daylight-saving rules).
// Only `new Date(number)`, `Date.UTC` and UTC getters are used: no wall clock, no Intl.

const MINUTE = 60_000;
export const DAY_MS = 86_400_000;

// [standardOffsetMinutes, daylightOffsetMinutes, rule]
const ZONES = {
  UTC: [0, 0, "none"],
  "Etc/UTC": [0, 0, "none"],
  "Europe/London": [0, 60, "eu"],
  "Europe/Dublin": [0, 60, "eu"],
  "Europe/Lisbon": [0, 60, "eu"],
  "Europe/Berlin": [60, 120, "eu"],
  "Europe/Paris": [60, 120, "eu"],
  "Europe/Madrid": [60, 120, "eu"],
  "Europe/Rome": [60, 120, "eu"],
  "Europe/Amsterdam": [60, 120, "eu"],
  "Europe/Zurich": [60, 120, "eu"],
  "Europe/Stockholm": [60, 120, "eu"],
  "Europe/Warsaw": [60, 120, "eu"],
  "Europe/Athens": [120, 180, "eu"],
  "Europe/Helsinki": [120, 180, "eu"],
  "America/New_York": [-300, -240, "us"],
  "America/Toronto": [-300, -240, "us"],
  "America/Chicago": [-360, -300, "us"],
  "America/Denver": [-420, -360, "us"],
  "America/Phoenix": [-420, -420, "none"],
  "America/Los_Angeles": [-480, -420, "us"],
  "America/Vancouver": [-480, -420, "us"],
  "America/Sao_Paulo": [-180, -180, "none"],
  "America/Mexico_City": [-360, -360, "none"],
  "Asia/Kolkata": [330, 330, "none"],
  "Asia/Dubai": [240, 240, "none"],
  "Asia/Singapore": [480, 480, "none"],
  "Asia/Tokyo": [540, 540, "none"],
  "Asia/Shanghai": [480, 480, "none"],
  "Asia/Hong_Kong": [480, 480, "none"],
  "Australia/Sydney": [600, 660, "au"],
  "Australia/Melbourne": [600, 660, "au"],
  "Pacific/Auckland": [720, 780, "nz"],
  "Africa/Johannesburg": [120, 120, "none"],
  "Africa/Lagos": [60, 60, "none"],
  "Africa/Nairobi": [180, 180, "none"],
};

export const SUPPORTED_ZONES = Object.freeze(Object.keys(ZONES));

/**
 * `Date.UTC` maps years 0-99 to 1900-1999, so every instant computed from caller-supplied parts goes through this
 * helper instead: years 0-99 keep their literal value (year 50 is 0050-01-01, not 1950-01-01).
 */
export function utcMs(year, monthIndex, day, hour = 0, minute = 0, second = 0, millis = 0) {
  const ms = Date.UTC(year, monthIndex, day, hour, minute, second, millis);
  if (!Number.isFinite(ms) || !(year >= 0 && year <= 99)) return ms;
  const date = new Date(ms);
  date.setUTCFullYear(year);
  return date.getTime();
}

export function isZone(name) {
  return typeof name === "string" && Object.hasOwn(ZONES, name);
}

/** Day of month of the n-th (1-based) weekday of a month, or the last one when n is -1. month is 1-12, weekday 0=Sunday. */
export function nthWeekdayOfMonth(year, month, weekday, n) {
  if (n > 0) {
    const first = new Date(utcMs(year, month - 1, 1)).getUTCDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return day <= daysInMonth(year, month) ? day : null;
  }
  const last = daysInMonth(year, month);
  const lastWeekday = new Date(utcMs(year, month - 1, last)).getUTCDay();
  const day = last - ((lastWeekday - weekday + 7) % 7) + (n + 1) * 7;
  return day > 0 ? day : null;
}

export function daysInMonth(year, month) {
  return new Date(utcMs(year, month, 0)).getUTCDate();
}

function daylightWindow(zone, year) {
  const [standard, daylight, rule] = ZONES[zone];
  if (rule === "eu") {
    return {
      start: utcMs(year, 2, nthWeekdayOfMonth(year, 3, 0, -1), 1),
      end: utcMs(year, 9, nthWeekdayOfMonth(year, 10, 0, -1), 1),
      southern: false,
    };
  }
  if (rule === "us") {
    return {
      start: utcMs(year, 2, nthWeekdayOfMonth(year, 3, 0, 2), 2) - standard * MINUTE,
      end: utcMs(year, 10, nthWeekdayOfMonth(year, 11, 0, 1), 2) - daylight * MINUTE,
      southern: false,
    };
  }
  if (rule === "au") {
    return {
      start: utcMs(year, 9, nthWeekdayOfMonth(year, 10, 0, 1), 2) - standard * MINUTE,
      end: utcMs(year, 3, nthWeekdayOfMonth(year, 4, 0, 1), 3) - daylight * MINUTE,
      southern: true,
    };
  }
  if (rule === "nz") {
    return {
      start: utcMs(year, 8, nthWeekdayOfMonth(year, 9, 0, -1), 2) - standard * MINUTE,
      end: utcMs(year, 3, nthWeekdayOfMonth(year, 4, 0, 1), 3) - daylight * MINUTE,
      southern: true,
    };
  }
  return null;
}

/** UTC offset in minutes of `zone` at the UTC instant `ms`. */
export function offsetAt(zone, ms) {
  const [standard, daylight] = ZONES[zone];
  const year = new Date(ms).getUTCFullYear();
  const window = daylightWindow(zone, year);
  if (window === null) return standard;
  const active = window.southern ? ms >= window.start || ms < window.end : ms >= window.start && ms < window.end;
  return active ? daylight : standard;
}

/** Wall-clock parts of the instant `ms` in `zone`. */
export function zonedParts(ms, zone) {
  const offsetMinutes = offsetAt(zone, ms);
  return { ...utcParts(ms + offsetMinutes * MINUTE), offsetMinutes };
}

export function utcParts(ms) {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    weekday: date.getUTCDay(),
  };
}

/** Instant of a wall-clock time in `zone` (gaps and overlaps resolve to the offset in force after the transition). */
export function zonedToMs(zone, parts) {
  const wall = utcMs(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  const [standard] = ZONES[zone];
  let ms = wall - standard * MINUTE;
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = offsetAt(zone, ms);
    const candidate = wall - offset * MINUTE;
    if (candidate === ms) break;
    ms = candidate;
  }
  return ms;
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** RFC 3339 → { ms, offsetMinutes } or null. */
export function parseDateTime(text) {
  if (typeof text !== "string") return null;
  const match = DATE_TIME.exec(text.trim());
  if (match === null) return null;
  const [, y, mo, d, h, mi, s, fraction, zulu, sign, oh, om] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 60) return null;
  const millis = fraction === undefined ? 0 : Math.floor(Number(`0${fraction}`) * 1000);
  let offsetMinutes = 0;
  if (zulu === undefined) {
    if (Number(oh) > 23 || Number(om) > 59) return null;
    offsetMinutes = (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om));
  }
  return { ms: utcMs(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * MINUTE, offsetMinutes };
}

/** YYYY-MM-DD → { year, month, day } or null. */
export function parseDate(text) {
  if (typeof text !== "string") return null;
  const match = DATE.exec(text.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

export function formatOffsetSuffix(offsetMinutes) {
  if (offsetMinutes === 0) return "Z";
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** RFC 3339 without fraction, rendered at the given fixed offset. */
export function formatWithOffset(ms, offsetMinutes) {
  const p = utcParts(ms + offsetMinutes * MINUTE);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${formatOffsetSuffix(offsetMinutes)}`;
}

/** RFC 3339 rendered in `zone`'s offset at that instant. */
export function formatInZone(ms, zone) {
  return formatWithOffset(ms, offsetAt(zone, ms));
}

/** RFC 3339 with milliseconds in UTC (the `created`/`updated` spelling). */
export function formatTimestamp(ms) {
  return new Date(ms).toISOString();
}

export function dateKey(parts) {
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function dateToMs(parts) {
  return utcMs(parts.year, parts.month - 1, parts.day);
}

export function msToDate(ms) {
  const p = utcParts(ms);
  return { year: p.year, month: p.month, day: p.day };
}

export function addDays(parts, days) {
  return msToDate(dateToMs(parts) + days * DAY_MS);
}

export function addMonths(parts, months) {
  const total = parts.year * 12 + (parts.month - 1) + months;
  return { year: Math.floor(total / 12), month: (total % 12) + 1, day: parts.day };
}

export function weekdayOf(parts) {
  return new Date(dateToMs(parts)).getUTCDay();
}

export function compareDates(left, right) {
  return dateToMs(left) - dateToMs(right);
}

/** Google's instance-id stamp of a UTC instant: YYYYMMDDTHHMMSSZ. */
export function instanceStamp(ms) {
  const p = utcParts(ms);
  return `${pad(p.year, 4)}${pad(p.month)}${pad(p.day)}T${pad(p.hour)}${pad(p.minute)}${pad(p.second)}Z`;
}

/** Google's all-day instance-id stamp: YYYYMMDD. */
export function dateStamp(parts) {
  return `${pad(parts.year, 4)}${pad(parts.month)}${pad(parts.day)}`;
}

/** Parse a basic-format stamp (YYYYMMDDTHHMMSSZ | YYYYMMDDTHHMMSS | YYYYMMDD). */
export function parseStamp(text) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (match[4] === undefined) return { kind: "date", year, month, day };
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 60) return null;
  return { kind: "dateTime", year, month, day, hour, minute, second, utc: match[7] === "Z" };
}

export function parseClock(text) {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) return null;
  return hour * 60 + minute;
}
