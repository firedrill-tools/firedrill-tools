// Virtual-time helpers. All arithmetic is UTC and integer microseconds; nothing reads a wall clock.

const US_PER_MS = 1000;
export const US_PER_SECOND = 1_000_000;
export const US_PER_DAY = 86_400 * US_PER_SECOND;

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function isoParts(us) {
  const ms = Math.floor(us / US_PER_MS);
  const micros = us - ms * US_PER_MS;
  const iso = new Date(ms).toISOString(); // always UTC: YYYY-MM-DDTHH:MM:SS.mmmZ
  return { date: iso.slice(0, 10), time: iso.slice(11, 19), fraction: iso.slice(20, 23) + pad(micros, 3) };
}

/** Resend's timestamp rendering: `2026-09-15 14:00:00.000000+00`. */
export function wireTime(us) {
  if (us === null || us === undefined) return null;
  const parts = isoParts(us);
  return `${parts.date} ${parts.time}.${parts.fraction}+00`;
}

/** ISO-8601 with microseconds and `Z`: `2026-09-15T14:00:00.000000Z`. */
export function isoTime(us) {
  const parts = isoParts(us);
  return `${parts.date}T${parts.time}.${parts.fraction}Z`;
}

export function utcDay(us) {
  return isoParts(us).date;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse an ISO-8601 timestamp that carries `Z` or a numeric offset into microseconds. Zone-less input, impossible
 * calendar values (2026-02-31) and anything else return `null`; the caller raises the declared validation error.
 */
export function parseTimestamp(text) {
  if (typeof text !== "string" || text.length > 40) return null;
  const match = ISO.exec(text);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = match;
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(s);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  let offsetMinutes = 0;
  if (zone !== "Z" && zone !== "z") {
    const digits = zone.replace(":", "");
    const oh = Number(digits.slice(1, 3)), om = Number(digits.slice(3, 5));
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (oh * 60 + om) * (digits[0] === "-" ? -1 : 1);
  }
  const micros = frac === undefined ? 0 : Number(frac.padEnd(6, "0"));
  return (ms - offsetMinutes * 60_000) * US_PER_MS + micros;
}
