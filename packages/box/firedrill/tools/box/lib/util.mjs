// Deterministic helpers shared by handlers and codecs: UTF-8 bytes, RFC 3339 rendering/parsing, id checks.

export const ID_RE = /^[0-9]{1,20}$/;
export const isId = (value) => typeof value === "string" && ID_RE.test(value);
export const pad = (value, width) => String(value).padStart(width, "0");

/** UTF-8 bytes of a well-formed JS string (lone surrogates become U+FFFD, as TextEncoder does). */
export function utf8Encode(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      } else code = 0xfffd;
    } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}

/** UTF-8 byte length computed from code points (no allocation). */
export function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export const jsonBytes = (value) => utf8Length(JSON.stringify(value));

/** Box renders times as RFC 3339 with a `-00:00` offset. */
export function rfc3339(us) {
  if (typeof us !== "number" || !Number.isFinite(us)) return null;
  const iso = new Date(Math.floor(us / 1000)).toISOString();
  return `${iso.slice(0, 19)}-00:00`;
}

const TS_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;

/** Parses an RFC 3339 timestamp that carries an offset; zone-less or impossible values return null. */
export function parseRfc3339(text) {
  if (typeof text !== "string" || text.length > 40) return null;
  const m = TS_RE.exec(text);
  if (m === null) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const daysIn = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysIn) return null;
  let offsetMin = 0;
  if (m[7] !== "Z") {
    const sign = m[7][0] === "-" ? -1 : 1;
    const oh = Number(m[7].slice(1, 3));
    const om = Number(m[7].slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMin = sign * (oh * 60 + om);
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMin * 60000;
  return ms * 1000;
}

export const hasReplacement = (text) => typeof text === "string" && text.includes("�");

export function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  const ext = name.slice(dot + 1);
  return ext.length <= 32 ? ext.toLowerCase() : "";
}

/** Base64url without padding for ASCII-only JSON text (markers). */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function b64urlEncode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

export function b64urlDecode(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 4096 || text.length % 4 === 1) return null;
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i += 1) {
    const v = B64.indexOf(text[i]);
    if (v < 0) return null;
    buffer = ((buffer << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 255);
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
}
