// UTF-8 <-> base64 in plain JavaScript (no Buffer, atob, btoa or TextEncoder, which the restricted executor
// does not guarantee). Used for file contents and opaque list cursors.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Map([...ALPHABET].map((character, index) => [character, index]));
LOOKUP.set("-", 62);
LOOKUP.set("_", 63);

export function utf8Bytes(text) {
  const bytes = [];
  for (const character of text) {
    let code = character.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

/**
 * Strict UTF-8 decoding: invalid lead or continuation bytes, truncated sequences, overlong forms, UTF-16 surrogate
 * code points and code points above U+10FFFF all throw, so decoded text always re-encodes to the caller's bytes.
 */
function utf8Text(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index];
    let code;
    let width;
    let minimum;
    if (first < 0x80) {
      code = first;
      width = 1;
      minimum = 0;
    } else if ((first & 0xe0) === 0xc0) {
      code = first & 0x1f;
      width = 2;
      minimum = 0x80;
    } else if ((first & 0xf0) === 0xe0) {
      code = first & 0x0f;
      width = 3;
      minimum = 0x800;
    } else if ((first & 0xf8) === 0xf0) {
      code = first & 0x07;
      width = 4;
      minimum = 0x10000;
    } else throw new TypeError("invalid UTF-8");
    if (index + width > bytes.length) throw new TypeError("invalid UTF-8");
    for (let offset = 1; offset < width; offset += 1) {
      const next = bytes[index + offset];
      if ((next & 0xc0) !== 0x80) throw new TypeError("invalid UTF-8");
      code = (code << 6) | (next & 0x3f);
    }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new TypeError("invalid UTF-8");
    text += String.fromCodePoint(code);
    index += width;
  }
  return text;
}

/** True when a string contains an unpaired UTF-16 surrogate (it has no UTF-8 encoding). */
export function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/** UTF-8 byte length of a string (`size` of text content). */
export function byteLength(text) {
  return utf8Bytes(text).length;
}

function encodeBytes(bytes, url) {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(triple >> 18) & 63] + ALPHABET[(triple >> 12) & 63];
    out += b === undefined ? "=" : ALPHABET[(triple >> 6) & 63];
    out += c === undefined ? "=" : ALPHABET[triple & 63];
  }
  return url ? out.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") : out;
}

function decodeBytes(text) {
  const clean = text.replace(/[\s=]/g, "");
  if (!/^[A-Za-z0-9+/_-]*$/.test(clean) || clean.length % 4 === 1) return undefined;
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const character of clean) {
    value = (value << 6) | LOOKUP.get(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return bytes;
}

export function base64Encode(text) {
  return encodeBytes(utf8Bytes(text), false);
}

/** Returns undefined for input that is not base64 or not UTF-8 text. */
export function base64Decode(text) {
  const bytes = decodeBytes(text);
  if (bytes === undefined) return undefined;
  try {
    return utf8Text(bytes);
  } catch {
    return undefined;
  }
}

export function base64UrlEncode(text) {
  return encodeBytes(utf8Bytes(text), true);
}

export function base64UrlDecode(text) {
  if (typeof text !== "string" || text.length === 0) return undefined;
  return base64Decode(text);
}
