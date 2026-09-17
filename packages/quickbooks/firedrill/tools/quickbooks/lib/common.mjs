// Shared pure helpers: QuickBooks fault codes, company-local time, ids, money in integer cents and bounded scans.
// No module state, no wall clock: every time value derives from context.clock.nowUs().

const FAULTS = new Map([
  ["OBJECT_NOT_FOUND", ["610", "Object Not Found", "ValidationFault"]],
  ["REQUIRED_PARAM_MISSING", ["2020", "Required param missing, need to supply the required value for the API", "ValidationFault"]],
  ["INVALID_REFERENCE", ["2500", "Invalid Reference Id", "ValidationFault"]],
  ["QUERY_PARSE_ERROR", ["4000", "Error parsing query", "ValidationFault"]],
  ["QUERY_VALIDATION_ERROR", ["4001", "Invalid query", "ValidationFault"]],
  ["STALE_OBJECT", ["5010", "Stale Object Error", "ValidationFault"]],
  ["BUSINESS_VALIDATION", ["6000", "A business validation error has occurred while processing your request", "ValidationFault"]],
  ["DUPLICATE_DOC_NUMBER", ["6140", "Duplicate Document Number Error", "ValidationFault"]],
  ["DUPLICATE_NAME", ["6240", "Duplicate Name Exists Error", "ValidationFault"]],
  ["AUTHENTICATION_FAILED", ["3200", "message=AuthenticationFailed; errorCode=003200; statusCode=401", "AuthenticationFault"]],
  ["AUTHORIZATION_FAILED", ["3100", "message=ApplicationAuthorizationFailed; errorCode=003100; statusCode=403", "AuthorizationFault"]],
  ["STATE_BOUND_EXCEEDED", ["10000", "An application error has occurred while processing your request", "SystemFault"]],
  ["THROTTLE_EXCEEDED", ["3001", "message=ThrottleExceeded; errorCode=003001; statusCode=429", "SERVICE"]],
  ["SERVICE_UNAVAILABLE", ["10000", "An application error has occurred while processing your request", "SystemFault"]],
]);

export function faultInfo(code) {
  return FAULTS.get(code);
}

export const DEFAULT_OFFSET_MINUTES = -420;
export const MAX_DETAIL = 2000;
export const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function clip(text, max = 200) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** UTF-8 length of a string, counted per code point (1, 2, 3 or 4 bytes; lone surrogates count as 3). */
export function utf8Bytes(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) { const next = text.charCodeAt(i + 1); if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i += 1; } else bytes += 3; }
    else bytes += 3;
  }
  return bytes;
}

const pad2 = (n) => String(n).padStart(2, "0");

function offsetText(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Company-local parts of an epoch-millisecond instant (fixed offset, host-independent). */
function localParts(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60000);
  return {
    date: `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    clock: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`,
    millis: String(d.getUTCMilliseconds()).padStart(3, "0"),
  };
}

export function clockOf(context, offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  const ms = Math.floor(context.clock.nowUs() / 1000);
  const parts = localParts(ms, offsetMinutes);
  const zone = offsetText(offsetMinutes);
  return {
    ms,
    date: parts.date,
    meta: `${parts.date}T${parts.clock}${zone}`,
    time: `${parts.date}T${parts.clock}.${parts.millis}${zone}`,
  };
}

/** Raise a declared error with the QuickBooks fault fields the wire encoder copies. */
export function fail(context, code, detail, element = "", clock = clockOf(context)) {
  const info = FAULTS.get(code);
  return context.fail({
    code,
    message: info[1],
    details: { qboCode: info[0], faultType: info[2], detail: clip(detail, MAX_DETAIL), element: clip(element, 200), time: clock.time },
  });
}

export const ID_PATTERN = /^(0|[1-9][0-9]{0,9})$/;

export function isId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function padId(id) {
  return String(id).padStart(10, "0");
}

const DATE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** Day number (days since 1970-01-01) of a strict YYYY-MM-DD calendar date, or null. */
export function dayNumber(text) {
  if (typeof text !== "string") return null;
  const match = DATE_PATTERN.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || month < 1 || month > 12 || day < 1) return null;
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) return null;
  return Math.round(ms / 86400000);
}

export function dateFromDay(dayNum) {
  const d = new Date(dayNum * 86400000);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

const DATETIME_PATTERN = /^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,6}))?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$/;

/** Epoch milliseconds of a date or ISO date-time; zone-less values use the company offset. Null when invalid. */
export function instantOf(text, offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  if (typeof text !== "string" || text.length > 40) return null;
  const match = DATETIME_PATTERN.exec(text);
  if (match === null) return null;
  const day = dayNumber(match[1]);
  if (day === null) return null;
  const hours = match[2] === undefined ? 0 : Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  const seconds = match[4] === undefined ? 0 : Number(match[4]);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const millis = match[5] === undefined ? 0 : Math.floor(Number(`0.${match[5]}`) * 1000);
  let zone = offsetMinutes;
  if (match[6] === "Z") zone = 0;
  else if (match[6] !== undefined) {
    const zh = Number(match[6].slice(1, 3));
    const zm = Number(match[6].slice(4, 6));
    if (zh > 14 || zm > 59) return null;
    zone = (match[6][0] === "-" ? -1 : 1) * (zh * 60 + zm);
  }
  return day * 86400000 + ((hours * 60 + minutes - zone) * 60 + seconds) * 1000 + millis;
}

/** Integer cents of a non-negative-or-any number with at most two decimals, or null. */
export function toCents(value, { allowNegative = false, max = 99_999_999_999 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (Math.abs(scaled - cents) > 1e-6) return null;
  if (!allowNegative && cents < 0) return null;
  if (Math.abs(cents) > max) return null;
  return cents;
}

export function fromCents(cents) {
  return cents / 100;
}

/** Value scaled by 10^4 when it has at most four decimals and lies within [0, max]; otherwise null. */
export function toScaled4(value, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) return null;
  const scaled = value * 10000;
  const rounded = Math.round(scaled);
  return Math.abs(scaled - rounded) > 1e-4 ? null : rounded;
}

/** Cents of qty x unitPrice (both scaled by 10^4), rounded half up, without floating error. */
export function lineCents(qtyScaled, priceScaled) {
  const product = BigInt(qtyScaled) * BigInt(priceScaled);
  return Number((product + 500_000n) / 1_000_000n);
}

export const DEFAULT_SCAN_BOUND = 5000;

export function scanBound(context) {
  const limits = context.state.get("meta", "limits");
  const value = limits === null ? undefined : limits.maxScanRows;
  return Number.isInteger(value) && value >= 1 && value <= 10000 ? value : DEFAULT_SCAN_BOUND;
}

/** Every row of a namespace in row-id order; fails STATE_BOUND_EXCEEDED instead of truncating. */
export function scanAll(context, namespace, bound, clock) {
  const rows = [];
  let after;
  for (;;) {
    const page = context.state.scan(namespace, after === undefined ? { limit: 1000 } : { afterRowId: after, limit: 1000 });
    for (const record of page) {
      rows.push(record.value);
      if (rows.length > bound) {
        return fail(context, "STATE_BOUND_EXCEEDED", `State exceeds the supported bound of ${bound} rows for ${namespace}.`, "", clock);
      }
    }
    if (page.length < 1000) return rows;
    after = page[page.length - 1].rowId;
  }
}

export const TERMS = new Map([
  ["1", { name: "Due on receipt", days: 0 }],
  ["2", { name: "Net 15", days: 15 }],
  ["3", { name: "Net 30", days: 30 }],
]);

export const USD = Object.freeze({ value: "USD", name: "United States Dollar" });
