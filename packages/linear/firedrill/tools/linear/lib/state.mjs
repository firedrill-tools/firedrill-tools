// Row scans, counters, ids, timestamps and small pure helpers. Every function is pure or reads
// context.state; nothing keeps module-level state and nothing touches a wall clock.

const SCAN_STEP = 1000;

/** Documented bounds; a scan that exceeds one fails with FAILED_PRECONDITION (never a truncated result). */
export const LIMITS = Object.freeze({
  users: 1000,
  teams: 1000,
  "workflow-states": 1000,
  labels: 1000,
  projects: 1000,
  cycles: 1000,
  issues: 10000,
  comments: 10000,
  commentsPerIssue: 500,
  childrenPerIssue: 1000,
});

export const DEFAULT_ORGANIZATION = Object.freeze({
  id: "00000001-0000-4000-8000-000000000001",
  name: "Firedrill",
  urlKey: "firedrill",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  restrictLabelManagementToAdmins: false,
  gitBranchFormat: "{username}/{issueIdentifier}-{issueTitle}",
});

const DEFAULT_COUNTERS = Object.freeze({ nextId: 1, lastSyncId: 1 });

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Every row of a namespace in row-id order, failing through `onBound` when the bound is exceeded. */
export function allRows(context, namespace, bound, onBound) {
  const rows = [];
  let after;
  for (;;) {
    const batch = context.state.scan(namespace, { ...(after === undefined ? {} : { afterRowId: after }), limit: SCAN_STEP });
    if (batch.length === 0) return rows;
    for (const record of batch) {
      after = record.rowId;
      rows.push(record.value);
      if (rows.length > bound) return onBound(namespace, bound);
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

/** Every row whose id starts with `prefix` (row-id order), failing through `onBound` beyond `bound` rows. */
export function prefixRows(context, namespace, prefix, bound, onBound) {
  const rows = [];
  let after = prefix;
  for (;;) {
    const batch = context.state.scan(namespace, { afterRowId: after, limit: SCAN_STEP });
    if (batch.length === 0) return rows;
    for (const record of batch) {
      if (!record.rowId.startsWith(prefix)) return rows;
      after = record.rowId;
      rows.push(record.value);
      if (rows.length > bound) return onBound(namespace, bound);
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

export function organizationOf(context) {
  const stored = context.state.get("organization", "organization");
  return stored === null ? { ...DEFAULT_ORGANIZATION } : { ...DEFAULT_ORGANIZATION, ...stored };
}

export function counters(context) {
  const stored = context.state.get("meta", "counters");
  return stored === null ? { ...DEFAULT_COUNTERS } : { ...DEFAULT_COUNTERS, ...stored };
}

/** A fresh UUID-formatted id from the counter row (version nibble 4, variant 8; no randomness). */
export function nextId(context) {
  const meta = counters(context);
  const ordinal = meta.nextId;
  context.state.put("meta", "counters", { ...meta, nextId: ordinal + 1 });
  return `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, "0")}`;
}

/** Advances the workspace sync counter (one bump per successful mutation) and returns the new value. */
export function bumpSyncId(context) {
  const meta = counters(context);
  const lastSyncId = meta.lastSyncId + 1;
  context.state.put("meta", "counters", { ...meta, lastSyncId });
  return lastSyncId;
}

export function currentSyncId(context) {
  return counters(context).lastSyncId;
}

export function nowMs(context) {
  return Math.floor(context.clock.nowUs() / 1000);
}

/** Linear renders DateTime as ISO-8601 UTC with millisecond precision. */
export function isoNow(context) {
  return new Date(nowMs(context)).toISOString();
}

const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/i;

/**
 * ISO-8601 dates and date-times only. A date-time without a zone is read as UTC (never host-local); a bare date is
 * midnight UTC. Anything else (e.g. "Sep 12 2026", whose meaning depends on the host) is NaN.
 */
export function parseTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return Number.NaN;
  const match = ISO_INSTANT.exec(value);
  if (match === null) return Number.NaN;
  const [, date, hoursMinutes, seconds, fraction, zone] = match;
  // Reject impossible calendar dates and clock values instead of letting Date.parse roll them over (2026-02-30 → March 2).
  if (!isValidDate(date)) return Number.NaN;
  if (hoursMinutes !== undefined && (Number(hoursMinutes.slice(0, 2)) > 23 || Number(hoursMinutes.slice(3, 5)) > 59 || Number(seconds ?? "0") > 59)) return Number.NaN;
  if (zone !== undefined && zone.toUpperCase() !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return Number.NaN;
  if (hoursMinutes === undefined) return zone === undefined ? Date.parse(`${date}T00:00:00.000Z`) : Number.NaN;
  const millis = (fraction ?? "").padEnd(3, "0").slice(0, 3);
  const zoneText = zone === undefined || zone.toUpperCase() === "Z" ? "Z" : zone;
  return Date.parse(`${date}T${hoursMinutes}:${seconds ?? "00"}.${millis}${zoneText}`);
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Team key (1-5 characters) and issue number (at most 9 digits), e.g. `ENG-12`; bounds keep a caller's text short of the row-id limit. */
export const IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]{0,4}-[1-9][0-9]{0,8}$/;

/** The framework's row-id bound: `context.state.get/put/scan` throw for ids outside 1..512 characters. */
export const MAX_ROW_ID_LENGTH = 512;

/** True when `value` can be used as a row id: a string of 1..MAX_ROW_ID_LENGTH characters. Every caller-derived lookup checks this first. */
export function isRowId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ROW_ID_LENGTH;
}

/** Own-property lookup on a static table; never resolves inherited names such as `constructor` or `__proto__`. */
export function ownEntry(table, name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
}

/**
 * A caller-supplied JSON object whose prototype was replaced (a `__proto__` key assigned by a parser that does not
 * create it as an own property) has a prototype that is itself not a root prototype. Realm-independent.
 */
export function hasForgedPrototype(value) {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto !== null && Object.getPrototypeOf(proto) !== null;
}
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isValidDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function slugify(text) {
  const slug = String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "untitled" : slug;
}

/** FNV-1a 32-bit hash as 8 lower-case hex characters (deterministic, no randomness). */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function utf8Bytes(text) {
  const bytes = [];
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point < 0x10000) bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    else bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
  }
  return bytes;
}

/**
 * Strict UTF-8 decoder for caller-supplied bytes (opaque cursors). Returns null for any sequence a conforming decoder
 * rejects: stray continuation bytes, lead bytes C0/C1/F5-FF, truncated sequences, invalid continuation bytes, overlong
 * forms, UTF-16 surrogates (U+D800-U+DFFF) and code points above U+10FFFF. Nothing reaches String.fromCodePoint unless
 * it is a valid Unicode scalar value, so a forged token can never throw.
 */
function utf8Text(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; ) {
    const byte = bytes[index];
    let point;
    let width;
    let minimum;
    if (byte < 0x80) {
      point = byte;
      width = 1;
      minimum = 0;
    } else if (byte >= 0xc2 && byte <= 0xdf) {
      point = byte & 0x1f;
      width = 2;
      minimum = 0x80;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      point = byte & 0x0f;
      width = 3;
      minimum = 0x800;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      point = byte & 0x07;
      width = 4;
      minimum = 0x10000;
    } else return null;
    if (index + width > bytes.length) return null;
    for (let offset = 1; offset < width; offset += 1) {
      const next = bytes[index + offset];
      if ((next & 0xc0) !== 0x80) return null;
      point = (point << 6) | (next & 0x3f);
    }
    if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
    text += String.fromCodePoint(point);
    index += width;
  }
  return text;
}

/** Self-contained base64url (the behavior module may not use Buffer or the browser globals). */
export function base64urlEncode(text) {
  const bytes = utf8Bytes(text);
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += BASE64URL[a >> 2];
    output += BASE64URL[((a & 3) << 4) | ((b ?? 0) >> 4)];
    output += b === undefined ? "" : BASE64URL[((b & 15) << 2) | ((c ?? 0) >> 6)];
    output += c === undefined ? "" : BASE64URL[c & 63];
  }
  return output;
}

/** Longest opaque token the decoder accepts; every cursor this Tool issues is far shorter. */
export const MAX_TOKEN_LENGTH = 1024;

/**
 * Decodes canonical, unpadded base64url text as strict UTF-8; returns null for malformed input: a non-string, empty or
 * over-long token, any character outside the base64url alphabet (including `=`, `+`, `/` and whitespace), an impossible
 * length (4n+1), non-zero trailing bits (a non-canonical encoding) or bytes that are not valid UTF-8.
 */
export function base64urlDecode(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_TOKEN_LENGTH || text.length % 4 === 1) return null;
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < text.length; index += 1) {
    const value = BASE64URL.indexOf(text[index]);
    if (value < 0) return null;
    buffer = ((buffer << 6) | value) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) return null;
  return utf8Text(bytes);
}
