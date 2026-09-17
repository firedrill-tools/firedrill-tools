// Deterministic helpers shared by handlers and codecs: UTF-8 byte counting, RFC 3339 rendering and parsing,
// diacritic folding, linear substring search and base64url codecs. Nothing here touches wall-clock time.

export const pad = (value, width) => String(value).padStart(width, "0");

/** Clips caller text quoted back in an error message or output field. */
export function clip(value, max = 200) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** UTF-8 byte length computed from code points; no allocation, no Buffer. */
export function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export const jsonBytes = (value) => utf8Length(JSON.stringify(value));

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
export const daysInMonth = (year, month) => (month === 2 && isLeap(year) ? 29 : DAYS[month - 1] ?? 31);

/**
 * Google renders API timestamps as RFC 3339 UTC with fractional seconds, e.g. `2026-09-16T09:00:00.000000Z`.
 * `us` is an integer microsecond instant from virtual time.
 */
export function rfc3339(us, fractionDigits = 6) {
  if (typeof us !== "number" || !Number.isFinite(us)) return null;
  const ms = Math.floor(us / 1000);
  const micros = us - ms * 1000;
  const iso = new Date(ms).toISOString();
  if (fractionDigits === 0) return `${iso.slice(0, 19)}Z`;
  const fraction = `${iso.slice(20, 23)}${pad(micros, 3)}`.slice(0, fractionDigits).padEnd(fractionDigits, "0");
  return `${iso.slice(0, 19)}.${fraction}Z`;
}

const TS_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt ]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|z|[+-][0-9]{2}:[0-9]{2})$/;

/**
 * Parses an RFC 3339 timestamp that carries an explicit offset and returns microseconds.
 * A zone-less or impossible value returns null — it is never assumed to be local time.
 */
export function parseRfc3339(text) {
  if (typeof text !== "string" || text.length > 48) return null;
  const m = TS_RE.exec(text);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const fraction = m[7] === undefined ? 0 : Number(`0.${m[7]}`);
  let us = Date.UTC(year, month - 1, day, hour, minute, second) * 1000 + Math.round(fraction * 1e6);
  const zone = m[8];
  if (zone !== "Z" && zone !== "z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const offsetMinutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6));
    if (!Number.isFinite(offsetMinutes) || offsetMinutes > 14 * 60) return null;
    us -= sign * offsetMinutes * 60 * 1000 * 1000;
  }
  return Number.isFinite(us) ? us : null;
}

/** Renders a duration the way the Apps Script API does: `12.5s`. */
export function durationString(us) {
  const seconds = Math.max(0, Math.round(us / 1000) / 1000);
  return `${Number(seconds.toFixed(3))}s`;
}

const FOLD_FROM = "àáâãäåāăąçćĉċčďđèéêëēĕėęěĝğġģĥħìíîïĩīĭįıĵķĺļľłñńņňòóôõöøōŏőŕŗřśŝşšţťŧùúûüũūŭůűųŵýÿŷźżžæœßð";
const FOLD_TO = ["a", "a", "a", "a", "a", "a", "a", "a", "a", "c", "c", "c", "c", "d", "d", "e", "e", "e", "e", "e", "e", "e", "e", "e",
  "g", "g", "g", "g", "h", "h", "i", "i", "i", "i", "i", "i", "i", "i", "i", "j", "k", "l", "l", "l", "l", "n", "n", "n", "n",
  "o", "o", "o", "o", "o", "o", "o", "o", "o", "r", "r", "r", "s", "s", "s", "s", "t", "t", "t", "u", "u", "u", "u", "u", "u",
  "u", "u", "u", "u", "w", "y", "y", "y", "z", "z", "z", "ae", "oe", "ss", "d"];
const FOLD = new Map();
for (let i = 0; i < FOLD_FROM.length; i += 1) FOLD.set(FOLD_FROM[i], FOLD_TO[i] ?? FOLD_FROM[i]);

/** Lowercases and folds the diacritics this Tool understands. Linear in the input length. */
export function fold(text) {
  if (typeof text !== "string") return "";
  const lower = text.toLowerCase();
  let out = "";
  for (const ch of lower) out += FOLD.get(ch) ?? ch;
  return out;
}

/** Splits folded text into search tokens (letters, digits and `+` runs). */
export function tokenize(text, maxTokens = 64) {
  const out = [];
  let current = "";
  for (const ch of fold(text)) {
    if (/[a-z0-9+@._-]/.test(ch)) current += ch;
    else if (current.length > 0) {
      out.push(current);
      current = "";
      if (out.length >= maxTokens) return out;
    }
  }
  if (current.length > 0 && out.length < maxTokens) out.push(current);
  return out;
}

/** The U+FFFD replacement character means the framework decoded a mangled percent-escape. */
export const isMangled = (value) => typeof value === "string" && value.includes("�");

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INDEX = new Map();
for (let i = 0; i < B64_ALPHABET.length; i += 1) B64_INDEX.set(B64_ALPHABET[i], i);

/** base64url encoding of a JS string's UTF-8 bytes, without padding. */
export function base64urlEncode(text) {
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += B64_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += B64_ALPHABET[b2 & 63];
  }
  return out;
}

/**
 * Strict base64url decode to a JS string. Returns null for any invalid alphabet character, impossible length,
 * overlong UTF-8 form, surrogate code point or value above U+10FFFF — cursors are hostile caller input.
 */
export function base64urlDecode(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 4096) return null;
  const chars = text.endsWith("=") || text.endsWith("==") ? text.replace(/=+$/, "") : text;
  if (chars.length % 4 === 1) return null;
  const bytes = [];
  let bits = 0;
  let acc = 0;
  for (const ch of chars) {
    const value = B64_INDEX.get(ch);
    if (value === undefined) return null;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return utf8Decode(bytes);
}

/** Strict UTF-8 decoder: rejects overlong forms, surrogates, truncated sequences and code points above U+10FFFF. */
export function utf8Decode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i];
    let code;
    let width;
    if (b0 < 0x80) {
      code = b0;
      width = 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      code = b0 & 0x1f;
      width = 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      code = b0 & 0x0f;
      width = 3;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      code = b0 & 0x07;
      width = 4;
    } else return null;
    if (i + width > bytes.length) return null;
    for (let k = 1; k < width; k += 1) {
      const bk = bytes[i + k];
      if (bk < 0x80 || bk > 0xbf) return null;
      code = (code << 6) | (bk & 0x3f);
    }
    if (width === 2 && code < 0x80) return null;
    if (width === 3 && code < 0x800) return null;
    if (width === 4 && code < 0x10000) return null;
    if (code > 0x10ffff) return null;
    if (code >= 0xd800 && code <= 0xdfff) return null;
    out += String.fromCodePoint(code);
    i += width;
  }
  return out;
}

/** Case-insensitive equality on ASCII, used for e-mail matching. */
export const sameEmail = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
