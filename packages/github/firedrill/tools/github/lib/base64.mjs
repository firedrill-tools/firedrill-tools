// UTF-8 <-> base64 in plain JavaScript (no Buffer, atob, btoa or TextEncoder, which the restricted executor
// does not guarantee). Used by the REST codecs for the contents routes and the MCP cursor of issues.list.

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

function utf8Text(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index];
    let code;
    let width;
    if (first < 0x80) {
      code = first;
      width = 1;
    } else if ((first & 0xe0) === 0xc0) {
      code = first & 0x1f;
      width = 2;
    } else if ((first & 0xf0) === 0xe0) {
      code = first & 0x0f;
      width = 3;
    } else if ((first & 0xf8) === 0xf0) {
      code = first & 0x07;
      width = 4;
    } else throw new TypeError("invalid UTF-8");
    if (index + width > bytes.length) throw new TypeError("invalid UTF-8");
    for (let offset = 1; offset < width; offset += 1) {
      const next = bytes[index + offset];
      if ((next & 0xc0) !== 0x80) throw new TypeError("invalid UTF-8");
      code = (code << 6) | (next & 0x3f);
    }
    text += String.fromCodePoint(code);
    index += width;
  }
  return text;
}

/** UTF-8 byte length of a string (GitHub's `size` for text content). */
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
