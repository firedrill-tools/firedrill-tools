// Identifier, timestamp and cursor rendering shared by the behavior module, the HTTP codecs and the
// conformance data. Pure and deterministic: no Node built-ins, no wall clock, no randomness.

/** Bounded state scans: rows are read in steps and never beyond the cap. */
export const SCAN_STEP = 1000;
export const SCAN_CAP = 10000;

/** Slack message timestamps look like "1789376400.000301": epoch seconds, a dot, six digits. */
export const TS_PATTERN = /^[0-9]{10}\.[0-9]{6}$/;

export function pad6(value) {
  return String(value).padStart(6, "0");
}

/** The most message timestamps one virtual second can hold: the fraction is exactly six digits. */
export const MAX_TS_SEQUENCE = 999_999;

/** Render a `ts` from virtual epoch seconds and the per-workspace message sequence. */
export function renderTs(seconds, sequence) {
  return `${String(seconds).padStart(10, "0")}.${pad6(sequence)}`;
}

export function isTs(value) {
  return typeof value === "string" && TS_PATTERN.test(value);
}

/** `oldest`/`latest` arguments: a full ts or plain epoch seconds (optionally with a fraction). */
export function isTsLike(value) {
  return typeof value === "string" && /^[0-9]{1,10}(?:\.[0-9]{1,6})?$/.test(value);
}

export function tsNumber(value) {
  return Number(value);
}

export function tsSeconds(ts) {
  return Number(ts.slice(0, 10));
}

/** Two well-formed ts values compare as strings because seconds are fixed-width. */
export function compareTs(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Generated conversation ids: "C" or "D" followed by a zero-padded base-36 sequence (11 characters). */
export function conversationId(prefix, sequence) {
  return `${prefix}${sequence.toString(36).toUpperCase().padStart(10, "0")}`;
}

export function messageRowId(channel, ts) {
  return `${channel}:${ts}`;
}

export function membershipRowId(channel, user) {
  return `${channel}:${user}`;
}

export function pinRowId(channel, ts) {
  return `${channel}:${ts}`;
}

/** Slack-style permalink built from the workspace url stored in data; it resolves nowhere. */
export function permalink(workspaceUrl, channel, ts) {
  return `${workspaceUrl}archives/${channel}/p${ts.replace(".", "")}`;
}

/** Wire error strings are the lower-snake spelling of the declared code (CHANNEL_NOT_FOUND → channel_not_found). */
export function lowerSnake(code) {
  return String(code).toLowerCase();
}

/**
 * UTC calendar day (YYYY-MM-DD) of an epoch-seconds value, computed arithmetically (Howard Hinnant's
 * civil-from-days) so the search date modifiers never touch the host Date implementation.
 */
export function isoDay(seconds) {
  const days = Math.floor(seconds / 86400);
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding, ASCII input only (cursors contain ids, digits, dots and colons). */
export function base64url(text) {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const first = text.charCodeAt(index++);
    const second = index < text.length ? text.charCodeAt(index++) : undefined;
    const third = index < text.length ? text.charCodeAt(index++) : undefined;
    if (first > 127 || (second !== undefined && second > 127) || (third !== undefined && third > 127)) {
      throw new TypeError("cursor text must be ASCII");
    }
    output += ALPHABET[first >> 2];
    output += ALPHABET[((first & 3) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) output += ALPHABET[((second & 15) << 2) | ((third ?? 0) >> 6)];
    if (third !== undefined) output += ALPHABET[third & 63];
  }
  return output;
}

/** Inverse of base64url; returns null for anything that is not well-formed ASCII base64url. */
export function fromBase64url(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 === 1 || /[^A-Za-z0-9_-]/.test(value)) {
    return null;
  }
  let bits = 0;
  let buffer = 0;
  let output = "";
  for (const character of value) {
    buffer = (buffer << 6) | ALPHABET.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const code = (buffer >> bits) & 255;
      if (code > 127) return null;
      output += String.fromCharCode(code);
    }
  }
  return output;
}

/** Cursors mirror Slack's opaque-but-decodable shape: base64url("<kind>:<value>"). */
export function encodeCursor(kind, value) {
  return base64url(`${kind}:${value}`);
}

/** Decode a cursor of the expected kind; null when malformed or of another kind. */
export function decodeCursor(cursor, kind) {
  const text = fromBase64url(cursor);
  if (text === null) return null;
  const separator = text.indexOf(":");
  if (separator <= 0) return null;
  if (text.slice(0, separator) !== kind) return null;
  const value = text.slice(separator + 1);
  return value.length > 0 ? value : null;
}
