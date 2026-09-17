// Row ids, counters, bounded scans and virtual-time formatting. Every function is pure or reads
// context.state; nothing keeps module-level state.

export const SCAN_STEP = 500;
export const SCAN_CAP = 10_000;
const ID_PATTERN = /^[1-9][0-9]{0,9}$/;
const DEFINED_AT = "2019-08-06T02:41:09.058Z";

/** The framework rejects state row ids longer than 512 characters (a lookup with one throws). */
export const MAX_ROW_ID = 512;

/** True when `namespacePrefix + value` is a row id the state store accepts (non-empty, no `/`, ≤ 512 chars). */
export function isRowKey(value, prefix = "") {
  return typeof value === "string" && value.length > 0 && !value.includes("/") && prefix.length + value.length <= MAX_ROW_ID;
}

/** The framework caps a Tool error message at 1000 characters (longer messages fail response mapping). */
export const MAX_MESSAGE = 1_000;
const CLIP = 100;

/**
 * A caller value shortened for echoing in an error message (`abc…` beyond 100 code points).
 * The cut is on code points, never on UTF-16 units, so an astral character (emoji, rare CJK) is
 * never split into a lone surrogate.
 */
export function clip(value, max = CLIP) {
  const text = typeof value === "string" ? value : String(value);
  if (text.length <= max) return text;
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max).join("")}…` : text;
}

/**
 * A caller value rendered as JSON for an error message: the value is clipped first and encoded
 * afterwards, so the quoting of a long string stays balanced (`"abc…"`, never `"abc…`).
 */
export function clipJson(value, max = CLIP) {
  if (typeof value === "string") return JSON.stringify(clip(value, max));
  if (value === null || typeof value === "number" || typeof value === "boolean") return clip(String(value), max);
  if (Array.isArray(value)) return `an array of ${value.length} values`;
  if (typeof value === "object") return "an object";
  return clip(String(value), max);
}

/**
 * A Tool error message bounded to the framework's cap. The framework validates the message with a
 * UTF-16 length check (`z.string().max(1000)`), so the bound is 1000 UTF-16 units, but the cut falls on
 * a code point boundary: an astral character that would straddle the cut is dropped whole, never split
 * into a lone surrogate. The result, ellipsis included, always fits the cap.
 */
export function clipMessage(message, max = MAX_MESSAGE) {
  const text = typeof message === "string" ? message : String(message);
  if (text.length <= max) return text;
  let end = 0;
  for (const point of text) {
    if (end + point.length > max - 1) break;
    end += point.length;
  }
  return `${text.slice(0, end)}…`;
}

export function fail(context, code, message, details) {
  const text = clipMessage(message);
  return context.fail(details === undefined ? { code, message: text } : { code, message: text, details });
}

export function notFound(context, message = "resource not found") {
  return fail(context, "NOT_FOUND", message);
}

/** HubSpot's validation envelope: one message plus one `errors[]` entry per offending field. */
export function validationError(context, message, errors) {
  return fail(context, "VALIDATION_ERROR", message, { errors: errors ?? [{ message }] });
}

export function tooLarge(context) {
  return fail(context, "VALIDATION_ERROR", "The result set is too large for this Tool (more than 10000 rows).");
}

export function isObjectId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function padId(id) {
  return String(id).padStart(10, "0");
}

export function associationRowId(fromTypeId, fromId, toTypeId, toId) {
  return `${fromTypeId}/${padId(fromId)}/${toTypeId}/${padId(toId)}`;
}

export function associationPrefix(fromTypeId, fromId, toTypeId) {
  return `${fromTypeId}/${padId(fromId)}/${toTypeId}/`;
}

/** Every row whose id starts with `prefix` (in row-id order), through bounded scans. */
export function prefixRows(context, namespace, prefix) {
  const rows = [];
  let after = prefix;
  for (;;) {
    const batch = context.state.scan(namespace, { afterRowId: after, limit: SCAN_STEP });
    if (batch.length === 0) return rows;
    for (const record of batch) {
      if (!record.rowId.startsWith(prefix)) return rows;
      after = record.rowId;
      rows.push(record.value);
      if (rows.length >= SCAN_CAP) return tooLarge(context);
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

/** Every row of a namespace in row-id order (bounded). */
export function allRows(context, namespace) {
  const rows = [];
  let after;
  for (;;) {
    const batch = context.state.scan(namespace, { ...(after === undefined ? {} : { afterRowId: after }), limit: SCAN_STEP });
    if (batch.length === 0) return rows;
    for (const record of batch) {
      after = record.rowId;
      rows.push(record.value);
      if (rows.length >= SCAN_CAP) return tooLarge(context);
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

/** ISO-8601 with milliseconds, as HubSpot renders timestamps (`2026-09-14T09:00:00.000Z`). */
export function isoFromUs(us) {
  return new Date(Math.floor(us / 1_000)).toISOString();
}

export function isoNow(context) {
  return isoFromUs(context.clock.nowUs());
}

export function definedAt() {
  return DEFINED_AT;
}

// Strict, host-independent datetime parsing. HubSpot accepts epoch milliseconds or ISO 8601; `Date.parse`
// is never used because it reads zone-less strings in the host time zone and accepts engine-specific formats.
const EPOCH_MS = /^[0-9]{1,15}$/;
const ISO_8601 =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[Tt ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:[.,]([0-9]{1,9}))?)?(Z|z|[+-][0-9]{2}(?::?[0-9]{2})?)?)?$/;
// HubSpot renders datetimes as four-digit-year ISO strings: accept 0000-01-01T00:00:00.000Z … 9999-12-31T23:59:59.999Z.
const MIN_EPOCH_MS = -62_167_219_200_000;
const MAX_EPOCH_MS = 253_402_300_799_999;

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Epoch milliseconds for an epoch-ms digit string or an ISO-8601 date/datetime; undefined otherwise.
 * A date-only value is midnight UTC and a datetime without a zone designator is read as UTC, so the same
 * input yields the same instant on every host. Impossible calendar values (month 13, 31 April, 24:00) are rejected.
 */
export function parseMillis(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (EPOCH_MS.test(text)) {
    const epoch = Number(text);
    return epoch > MAX_EPOCH_MS ? undefined : epoch;
  }
  const match = ISO_8601.exec(text);
  if (match === null) return undefined;
  const [, y, mo, d, h = "00", mi = "00", s = "00", fraction = "", zone = "Z"] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) return undefined;
  let offsetMinutes = 0;
  if (zone !== "Z" && zone !== "z") {
    const digits = zone.slice(1).replace(":", "");
    const offsetHours = Number(digits.slice(0, 2));
    const offsetMins = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (offsetHours > 18 || offsetMins > 59) return undefined;
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  const millis = Number(fraction.padEnd(3, "0").slice(0, 3));
  const instant = Date.UTC(2000, 0, 1, 0, 0, 0, 0) + utcDayOffset(year, month, day) * 86_400_000 + ((hour * 60 + minute - offsetMinutes) * 60 + second) * 1_000 + millis;
  return instant < MIN_EPOCH_MS || instant > MAX_EPOCH_MS ? undefined : instant;
}

/** Whole days from 2000-01-01 to the given proleptic Gregorian date (pure arithmetic, no Date parsing). */
function utcDayOffset(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468 - 10_957;
}

/** Epoch-millisecond digit strings and ISO-8601 dates/datetimes → `YYYY-MM-DDTHH:MM:SS.sssZ`; undefined when invalid. */
export function normalizeDateTime(value) {
  const ms = parseMillis(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/**
 * The first row of a namespace (row-id order) matching `predicate`, or null. Pages through the whole
 * namespace in bounded scans; it never truncates, because it returns a single row rather than a result set.
 */
export function findRow(context, namespace, predicate) {
  let after;
  for (;;) {
    const batch = context.state.scan(namespace, { ...(after === undefined ? {} : { afterRowId: after }), limit: SCAN_STEP });
    for (const record of batch) {
      if (predicate(record.value)) return record.value;
      after = record.rowId;
    }
    if (batch.length < SCAN_STEP) return null;
  }
}

const DEFAULT_COUNTERS = { nextObjectId: 1 };

export function counters(context) {
  const stored = context.state.get("meta", "counters");
  return stored === null ? { ...DEFAULT_COUNTERS } : { ...stored };
}

/**
 * The next free object id. Starter data normally seeds `meta/counters`; when it is absent the counter
 * starts at 1 and skips ids that already exist in any object namespace (bounded probe).
 */
export function nextObjectId(context, namespaces) {
  const meta = counters(context);
  let id = meta.nextObjectId;
  for (let probe = 0; probe < 1_000; probe += 1) {
    const taken = namespaces.some((namespace) => context.state.get(namespace, padId(id)) !== null);
    if (!taken) break;
    id += 1;
  }
  context.state.put("meta", "counters", { ...meta, nextObjectId: id + 1 });
  return String(id);
}

export function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
