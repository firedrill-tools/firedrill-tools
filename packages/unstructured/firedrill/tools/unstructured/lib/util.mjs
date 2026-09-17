// Small deterministic helpers shared by every module. No Node built-ins, no wall clock, no randomness.

/** Clips caller text quoted in messages and outputs. */
export function clip(value, max = 200) {
  const text = typeof value === "string" ? value : String(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const isInt = (value) => typeof value === "number" && Number.isInteger(value);
export const isNonEmptyString = (value, max = Infinity) => typeof value === "string" && value.length > 0 && value.length <= max;

/** UTF-8 byte length computed from code points (never Buffer). */
export function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** UTF-8 bytes of a string as a plain array of 0..255 numbers. Lone surrogates become U+FFFD. */
export function utf8Bytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      } else code = 0xfffd;
    } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return out;
}

/** Strict UTF-8 decoder over a byte array; returns null on any invalid sequence. */
export function utf8Decode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i];
    let code;
    let need;
    if (b0 < 0x80) {
      code = b0;
      need = 0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      code = b0 & 0x1f;
      need = 1;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      code = b0 & 0x0f;
      need = 2;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      code = b0 & 0x07;
      need = 3;
    } else return null;
    for (let k = 1; k <= need; k += 1) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) return null;
      code = (code << 6) | (b & 0x3f);
    }
    if (need === 2 && code < 0x800) return null;
    if (need === 3 && (code < 0x10000 || code > 0x10ffff)) return null;
    if (code >= 0xd800 && code <= 0xdfff) return null;
    out += String.fromCodePoint(code);
    i += need + 1;
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}

/** Strict base64 decode (standard alphabet, correct padding, no whitespace); returns null when malformed. */
export function base64Decode(text) {
  if (typeof text !== "string" || text.length % 4 !== 0) return null;
  const out = [];
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.slice(i, i + 4);
    const pad = chunk.endsWith("==") ? 2 : chunk.endsWith("=") ? 1 : 0;
    if (pad > 0 && i + 4 !== text.length) return null;
    const values = [];
    for (let k = 0; k < 4 - pad; k += 1) {
      const idx = B64.indexOf(chunk[k]);
      if (idx < 0) return null;
      values.push(idx);
    }
    while (values.length < 4) values.push(0);
    const n = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
    out.push((n >> 16) & 255);
    if (pad < 2) out.push((n >> 8) & 255);
    if (pad < 1) out.push(n & 255);
  }
  return out;
}

/** Virtual microseconds -> ISO 8601 UTC string with milliseconds. */
export function isoFromUs(us) {
  return new Date(Math.floor(us / 1000)).toISOString();
}

/** ISO 8601 UTC string (must end with Z or an explicit offset) -> microseconds, or null. */
export function usFromIso(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms * 1000 : null;
}

/** ISO 8601 duration for a non-negative number of whole seconds (PT1M13S). */
export function isoDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  let out = "PT";
  if (h > 0) out += `${h}H`;
  if (m > 0) out += `${m}M`;
  if (r > 0 || out === "PT") out += `${r}S`;
  return out;
}

export const ordered = (object, keys) => {
  const out = {};
  for (const key of keys) if (Object.hasOwn(object, key)) out[key] = object[key];
  return out;
};
