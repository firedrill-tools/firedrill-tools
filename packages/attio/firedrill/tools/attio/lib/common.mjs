// Shared pure helpers: deterministic ids, virtual-time formatting, failures, bounded scans.
// Nothing here keeps module-level mutable state; every stateful helper reads or writes context.state.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SLUG = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_MESSAGE = 1_000;
export const DEFAULT_SCAN_BOUND = 5_000;
export const PAGE_BYTES = 900_000;
const SCAN_STEP = 500;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

export const KIND = Object.freeze({
  workspace: "00000001",
  object: "00000002",
  attribute: "00000003",
  record: "00000004",
  list: "00000005",
  entry: "00000006",
  note: "00000007",
  task: "00000008",
  member: "00000009",
});

export function isUuid(value) {
  return typeof value === "string" && value.length === 36 && UUID.test(value);
}

export function isSlug(value) {
  return typeof value === "string" && value.length <= 64 && SLUG.test(value) && !RESERVED.has(value);
}

export function isReserved(key) {
  return RESERVED.has(key);
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A caller value shortened for an error message. */
export function clip(value, max = 100) {
  let text;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function fail(context, code, message) {
  const text = message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message;
  return context.fail({ code, message: text });
}

export const notFound = (context, message) => fail(context, "NOT_FOUND", message);
export const validation = (context, message) => fail(context, "VALIDATION_TYPE", message);
export const valueNotFound = (context, message) => fail(context, "VALUE_NOT_FOUND", message);

/** Virtual microseconds → Attio's nanosecond ISO-8601 UTC string. */
export function isoFromUs(us) {
  const ms = Math.floor(us / 1_000);
  const micros = String(((us % 1_000_000) + 1_000_000) % 1_000_000).padStart(6, "0");
  return `${new Date(ms).toISOString().slice(0, 19)}.${micros}000Z`;
}

export function now(context) {
  return isoFromUs(context.clock.nowUs());
}

export function nextId(context, kind) {
  const stored = context.state.get("meta", "counters");
  const seq = stored !== null && Number.isSafeInteger(stored.nextSeq) && stored.nextSeq >= 1 ? stored.nextSeq : 1_000;
  context.state.put("meta", "counters", { nextSeq: seq + 1 });
  return `${kind}-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

export function scanBound(context) {
  const row = context.state.get("meta", "limits");
  return row !== null && Number.isSafeInteger(row.maxScanRows) && row.maxScanRows >= 1 ? row.maxScanRows : DEFAULT_SCAN_BOUND;
}

function boundExceeded(context, namespace, bound) {
  return fail(context, "FAILED_PRECONDITION", `state exceeds the supported bound of ${bound} rows for ${namespace}`);
}

/**
 * Every row (or every row under `prefix`) of a namespace in row-id order. With `bounded`, a result set larger
 * than the world's scan bound fails FAILED_PRECONDITION instead of being truncated. Unbounded scans page through
 * the whole namespace (used for internal lookups whose result is complete by construction).
 */
export function rows(context, namespace, { prefix, bounded = false } = {}) {
  const bound = bounded ? scanBound(context) : Number.POSITIVE_INFINITY;
  const out = [];
  let after = prefix;
  for (;;) {
    const batch = context.state.scan(namespace, after === undefined ? { limit: SCAN_STEP } : { afterRowId: after, limit: SCAN_STEP });
    for (const record of batch) {
      if (prefix !== undefined && !record.rowId.startsWith(prefix)) return out;
      after = record.rowId;
      out.push(record.value);
      if (out.length > bound) return boundExceeded(context, namespace, bound);
    }
    if (batch.length < SCAN_STEP) return out;
  }
}

/** The first row (row-id order) matching `predicate`, or null; pages through without a bound (single result). */
export function findRow(context, namespace, predicate, prefix) {
  let after = prefix;
  for (;;) {
    const batch = context.state.scan(namespace, after === undefined ? { limit: SCAN_STEP } : { afterRowId: after, limit: SCAN_STEP });
    for (const record of batch) {
      if (prefix !== undefined && !record.rowId.startsWith(prefix)) return null;
      after = record.rowId;
      if (predicate(record.value)) return record.value;
    }
    if (batch.length < SCAN_STEP) return null;
  }
}

/** Up to `max` rows matching `predicate`. */
export function findRows(context, namespace, predicate, max) {
  const out = [];
  let after;
  for (;;) {
    const batch = context.state.scan(namespace, after === undefined ? { limit: SCAN_STEP } : { afterRowId: after, limit: SCAN_STEP });
    for (const record of batch) {
      after = record.rowId;
      if (predicate(record.value)) {
        out.push(record.value);
        if (out.length >= max) return out;
      }
    }
    if (batch.length < SCAN_STEP) return out;
  }
}

export function workspace(context) {
  const row = context.state.get("workspace", "workspace");
  if (row === null) return fail(context, "AUTHENTICATION_FAILED", "The access token is invalid or has been revoked.");
  return row;
}

/** limit/offset validation shared by every paged operation (a raw string from a query string is accepted if integral). */
export function integerParam(context, value, name, { min, max, fallback }) {
  if (value === undefined || value === null) return fallback;
  let number = value;
  if (typeof value === "string") {
    if (!/^-?[0-9]{1,15}$/.test(value)) return validation(context, `Invalid value for "${name}": expected an integer, got ${clip(JSON.stringify(value))}.`);
    number = Number(value);
  }
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min || number > max) {
    return validation(context, `Invalid value for "${name}": expected an integer between ${min} and ${max}.`);
  }
  return number;
}

export function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Approximate encoded size used to keep pages under the framework's 1 MiB response limit. */
export function encodedSize(value) {
  const text = JSON.stringify(value);
  let bytes = text.length;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) > 0x7f) bytes += 2;
  return bytes;
}
