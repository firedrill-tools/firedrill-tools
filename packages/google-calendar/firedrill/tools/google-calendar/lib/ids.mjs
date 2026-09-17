// Identifier, etag, link and token helpers. Pure and deterministic: every value derives from a counter or its input.

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const EVENT_ID = /^[a-v0-9]{5,1024}$/;
export const GROUP_CALENDAR_ID = /^c_[a-v0-9]{20,26}@group\.calendar\.google\.com$/;
export const RESOURCE_CALENDAR_ID = /^[a-z0-9-]+@resource\.calendar\.google\.com$/;
export const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const MEET_URL = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** Framework state row ids are 1–512 characters; longer or empty ids make state reads and writes throw. */
export const MAX_ROW_ID = 512;
/** Longest calendar id (an e-mail address or a group/resource id). */
export const MAX_CALENDAR_ID = 254;
/**
 * Longest client-supplied event id. Google allows 1024; here an event row id is `<calendarId>:<eventId>` and an exception
 * row id `<calendarId>:<eventId>_<YYYYMMDDTHHMMSSZ>`, so 240 keeps both within the 512-character row-id bound for every
 * calendar id up to 254 characters.
 */
export const MAX_CLIENT_EVENT_ID = 240;
/** Longest id any stored event (including exception instances) can have. */
export const MAX_STORED_EVENT_ID = MAX_CLIENT_EVENT_ID + 17;

const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/;

/** True when `value` has no whitespace, no control characters and no unpaired UTF-16 surrogates. */
function isCleanIdentifier(value) {
  if (WHITESPACE_OR_CONTROL.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Lookup key of a caller-supplied calendar id, or null when no calendar can carry it: not a string, empty, longer than
 * 254 characters, or containing whitespace (leading, trailing or inner), control characters or unpaired surrogates.
 * Ids are compared case-insensitively (lower-cased), like Google's e-mail-shaped calendar ids. Never trims: Google treats
 * `" primary"` as an unknown calendar, not as `primary`.
 */
export function calendarIdKey(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CALENDAR_ID) return null;
  if (!isCleanIdentifier(value)) return null;
  return value.toLowerCase();
}

/**
 * Whether a caller-supplied event id could name a stored or derived event: a base32hex id (`^[a-v0-9]{5,1024}$`) or an
 * instance id `<masterId>_<stamp>`, no longer than the longest storable id. Anything else cannot exist.
 */
export function isEventIdShape(value) {
  if (typeof value !== "string" || value.length < 5 || value.length > MAX_STORED_EVENT_ID) return false;
  return EVENT_ID.test(value) || splitInstanceId(value) !== null;
}

/** A state row id the framework accepts (1–512 characters). */
export function isRowId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ROW_ID;
}

export function base32hex(value, width) {
  let n = value;
  let text = "";
  do {
    text = BASE32HEX[n % 32] + text;
    n = Math.floor(n / 32);
  } while (n > 0);
  return text.padStart(width, "0");
}

/** 26-character event id: fixed prefix + 24 base32hex digits of the counter. */
export function eventIdFor(counter) {
  return `fd${base32hex(counter, 24)}`;
}

/** Secondary calendar id in Google's group-calendar form. */
export function calendarIdFor(counter) {
  return `c_${base32hex(counter, 26)}@group.calendar.google.com`;
}

export function etagFor(sequence) {
  return `"${String(3_000_000_000_000_000 + sequence)}"`;
}

/** Deterministic Meet code xxx-xxxx-xxx (letters only). */
export function meetCodeFor(counter) {
  let n = counter;
  let letters = "";
  for (let index = 0; index < 10; index += 1) {
    letters = String.fromCharCode(97 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  }
  return `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7, 10)}`;
}

export function iCalUidFor(eventId) {
  return `${eventId}@google.com`;
}

export function htmlLinkFor(eventId, calendarId) {
  return `https://www.google.com/calendar/event?eid=${encodeBase64Url(`${eventId} ${calendarId}`)}`;
}

function utf8Bytes(text) {
  const bytes = [];
  const encoded = encodeURIComponent(text);
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index];
    if (character === "%") {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(character.charCodeAt(0));
    }
  }
  return bytes;
}

function utf8Text(bytes) {
  let encoded = "";
  for (const byte of bytes) encoded += `%${byte.toString(16).padStart(2, "0")}`;
  return decodeURIComponent(encoded);
}

export function encodeBase64Url(text) {
  const bytes = utf8Bytes(text);
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += BASE64URL[a >> 2];
    out += BASE64URL[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += BASE64URL[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += BASE64URL[c & 63];
  }
  return out;
}

/**
 * Inverse of encodeBase64Url; throws on malformed input: characters outside the unpadded base64url alphabet, a length
 * that no byte sequence encodes to (length % 4 === 1), non-zero trailing bits, or bytes that are not well-formed UTF-8
 * (decodeURIComponent rejects invalid continuation bytes, overlong forms, surrogates and code points above U+10FFFF).
 */
export function decodeBase64Url(text) {
  if (typeof text !== "string" || text.length === 0 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new TypeError("malformed base64url");
  if (text.length % 4 === 1) throw new TypeError("malformed base64url");
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const character of text) {
    buffer = (buffer << 6) | BASE64URL.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) throw new TypeError("malformed base64url");
  return utf8Text(bytes);
}

/** FNV-1a 32-bit hash of a string, as 8 hex digits. */
export function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Stable JSON (sorted keys) for hashing argument scopes. */
export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

export function normalizeEmail(value) {
  return String(value).trim().toLowerCase();
}

export function isEmail(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL.test(value);
}

export function eventRowId(calendarId, eventId) {
  return `${calendarId}:${eventId}`;
}

export function listRowId(userEmail, calendarId) {
  return `${userEmail}:${calendarId}`;
}

/** Split Google's instance id `<masterId>_<stamp>`; null when the id has no stamp suffix. */
export function splitInstanceId(eventId) {
  const index = eventId.lastIndexOf("_");
  if (index <= 0) return null;
  const masterId = eventId.slice(0, index);
  const stamp = eventId.slice(index + 1);
  if (!EVENT_ID.test(masterId) || !/^\d{8}(T\d{6}Z?)?$/.test(stamp)) return null;
  return { masterId, stamp };
}
