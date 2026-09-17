// Identifier, row-id, link, token and hashing helpers. Pure and deterministic: every value derives from a counter or
// its input. No Node built-ins, no wall clock, no randomness.

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const SPREADSHEET_ID = /^[A-Za-z0-9_-]{44}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const DOMAIN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const MAX_SHEET_ID = 2_147_483_647;

export function base32hex(value, width) {
  let n = value;
  let text = "";
  do {
    text = BASE32HEX[n % 32] + text;
    n = Math.floor(n / 32);
  } while (n > 0);
  return text.padStart(width, "0");
}

/** 44-character Sheets-shaped spreadsheet id: prefix `1fs` + 41 base32hex digits of the counter. */
export function spreadsheetIdFor(counter) {
  return `1fs${base32hex(counter, 41)}`;
}

/**
 * Sheet ids after the first: a linear congruential step over the per-world sheet counter, so new ids look like the
 * large integers Google assigns while staying deterministic. The caller skips collisions within the spreadsheet.
 */
export function sheetIdFor(counter) {
  return Number((BigInt(counter) * 1103515245n + 12345n) % 2147483648n);
}

/** 12-character named range id. */
export function namedRangeIdFor(counter) {
  return `nr${base32hex(counter, 10)}`;
}

/** 20-digit permission id for a grantee without a `users` row (`07` prefix; user rows carry their own id). */
export function permissionIdFor(counter) {
  return `07${String(counter).padStart(18, "0")}`;
}

export function pad10(value) {
  return String(value).padStart(10, "0");
}

export function pad7(value) {
  return String(value).padStart(7, "0");
}

export function sheetRowId(spreadsheetId, sheetId) {
  return `${spreadsheetId}:${pad10(sheetId)}`;
}

export function cellRowId(spreadsheetId, sheetId, rowIndex) {
  return `${spreadsheetId}:${pad10(sheetId)}:${pad7(rowIndex)}`;
}

export function cellRowPrefix(spreadsheetId, sheetId) {
  return `${spreadsheetId}:${pad10(sheetId)}:`;
}

export function namedRangeRowId(spreadsheetId, namedRangeId) {
  return `${spreadsheetId}:${namedRangeId}`;
}

export function permissionRowId(spreadsheetId, permissionId) {
  return `${spreadsheetId}:${permissionId}`;
}

export function userFileRowId(email, spreadsheetId) {
  return `${email}:${spreadsheetId}`;
}

export function spreadsheetUrlFor(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

export function webViewLinkFor(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?usp=drivesdk`;
}

export function iconLinkFor() {
  return `https://drive-thirdparty.googleusercontent.com/16/type/${SPREADSHEET_MIME}`;
}

function utf8Bytes(text) {
  const bytes = [];
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
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
    } else throw new TypeError("malformed UTF-8");
    if (index + width > bytes.length) throw new TypeError("malformed UTF-8");
    for (let offset = 1; offset < width; offset += 1) {
      const next = bytes[index + offset];
      if ((next & 0xc0) !== 0x80) throw new TypeError("malformed UTF-8");
      code = (code << 6) | (next & 0x3f);
    }
    text += String.fromCodePoint(code);
    index += width;
  }
  return text;
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

/** Inverse of encodeBase64Url; throws on malformed input. */
export function decodeBase64Url(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new TypeError("malformed base64url");
  }
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

/** Stable JSON (sorted keys, undefined dropped) for hashing argument scopes and comparing rows. */
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

export function domainOf(email) {
  return email.slice(email.indexOf("@") + 1);
}

/** Self-contained page token: base64url JSON of `{s: scope hash, o: offset}`. */
export function encodePageToken(scope, offset) {
  return encodeBase64Url(JSON.stringify({ s: hashText(scope), o: offset }));
}

/** Decodes a page token; returns null when it is malformed or belongs to another argument scope. */
export function decodePageToken(token, scope) {
  let parsed;
  try {
    parsed = JSON.parse(decodeBase64Url(token));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || parsed.s !== hashText(scope)) return null;
  if (!Number.isInteger(parsed.o) || parsed.o < 0) return null;
  return parsed.o;
}

export function compareText(left, right) {
  const a = String(left).toLowerCase();
  const b = String(right).toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}
