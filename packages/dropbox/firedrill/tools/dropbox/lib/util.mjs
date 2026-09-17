// Pure helpers: UTF-8 and base64 codecs, byte budgets, Dropbox timestamps and a small FNV-1a digest.
// No Node built-ins, no TextEncoder/Buffer, no wall clock.

/** UTF-8 byte length of a string computed from code points (a lone surrogate counts as the 3-byte replacement). */
export function utf8Size(text) {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) length += 1;
    else if (unit < 0x800) length += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        length += 4;
        index += 1;
      } else length += 3;
    } else length += 3;
  }
  return length;
}

/** UTF-8 bytes of a string; lone surrogates become U+FFFD. */
export function utf8Encode(text) {
  const out = new Uint8Array(utf8Size(text));
  let at = 0;
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      } else code = 0xfffd;
    } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out[at++] = code;
    else if (code < 0x800) {
      out[at++] = 0xc0 | (code >> 6);
      out[at++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[at++] = 0xe0 | (code >> 12);
      out[at++] = 0x80 | ((code >> 6) & 0x3f);
      out[at++] = 0x80 | (code & 0x3f);
    } else {
      out[at++] = 0xf0 | (code >> 18);
      out[at++] = 0x80 | ((code >> 12) & 0x3f);
      out[at++] = 0x80 | ((code >> 6) & 0x3f);
      out[at++] = 0x80 | (code & 0x3f);
    }
  }
  return out;
}

/** UTF-8 size of the JSON encoding of a value. */
export function jsonSize(value) {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : utf8Size(text);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function reverse(alphabet) {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i += 1) table[alphabet.charCodeAt(i)] = i;
  return table;
}
const B64_REV = reverse(B64);
const B64URL_REV = reverse(B64URL);

/** Standard base64 (with padding) → bytes; null when the text is not canonical base64. */
export function base64Decode(text, url = false) {
  const table = url ? B64URL_REV : B64_REV;
  let body = text;
  if (!url) {
    if (text.length % 4 !== 0) return null;
    if (body.endsWith("==")) body = body.slice(0, -2);
    else if (body.endsWith("=")) body = body.slice(0, -1);
  }
  if (body.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let at = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < body.length; i += 1) {
    const code = body.charCodeAt(i);
    const value = code < 128 ? table[code] : -1;
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 0xff;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

/** Bytes → base64 (standard with padding, or url-safe without). */
export function base64Encode(bytes, url = false) {
  const alphabet = url ? B64URL : B64;
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + (url ? "" : "==");
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + (url ? "" : "=");
  }
  return out;
}

const BACKSLASH = String.fromCharCode(92);
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** Dropbox timestamp `%Y-%m-%dT%H:%M:%SZ` (UTC, second precision) from virtual microseconds. */
export function timestamp(us) {
  const date = new Date(Math.floor(us / 1_000_000) * 1000);
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Parses a Dropbox timestamp strictly (explicit UTC, real calendar date); returns epoch seconds or null. */
export function parseTimestamp(text) {
  if (typeof text !== "string") return null;
  const match = TIMESTAMP.exec(text);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (hour > 23 || minute > 59 || second > 59 || year < 1970) return null;
  return ms / 1000;
}

/** 32-bit FNV-1a of a string's UTF-16 units, as 8 lowercase hex digits. */
export function fnv32(text, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Escapes every non-ASCII UTF-16 unit of a JSON text as \uXXXX (HTTP-header and cursor safe). */
export function asciiJson(value) {
  const text = JSON.stringify(value);
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out += code >= 0x7f ? `${BACKSLASH}u${code.toString(16).padStart(4, "0")}` : text[i];
  }
  return out;
}

/** A Dropbox void union member sent as "value" or {".tag": "value"}. */
export function tagOf(value) {
  if (typeof value === "string") return value;
  return value !== null && typeof value === "object" && typeof value[".tag"] === "string" ? value[".tag"] : undefined;
}
