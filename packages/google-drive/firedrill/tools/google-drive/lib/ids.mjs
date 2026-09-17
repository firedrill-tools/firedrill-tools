// Identifier, link, token and hashing helpers. Pure and deterministic: every value derives from a counter or its input.
// No Node built-ins, no wall clock, no randomness.

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const FILE_ID = /^[A-Za-z0-9_-]{33}$/;
export const PERMISSION_ID = /^([0-9]{20}|anyoneWithLink)$/;
export const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const DOMAIN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const RFC3339 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
export const FOLDER_COLOR = /^#[0-9a-fA-F]{6}$/;

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
export const DOCUMENT_MIME = "application/vnd.google-apps.document";
export const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const PRESENTATION_MIME = "application/vnd.google-apps.presentation";
export const GOOGLE_TEXT_TYPES = [DOCUMENT_MIME, SPREADSHEET_MIME, PRESENTATION_MIME];

export function base32hex(value, width) {
  let n = value;
  let text = "";
  do {
    text = BASE32HEX[n % 32] + text;
    n = Math.floor(n / 32);
  } while (n > 0);
  return text.padStart(width, "0");
}

/** 33-character Drive-shaped file id: fixed prefix `1fd` + 30 base32hex digits of the counter (starter rows use `1st`). */
export function fileIdFor(counter) {
  return `1fd${base32hex(counter, 30)}`;
}

/** 20-digit permission id with the prefix `07` (starter rows use `05…`, users' own ids `06…`, generated users `08…`). */
export function permissionIdFor(counter) {
  return `07${String(counter).padStart(18, "0")}`;
}

export function userPermissionIdFor(counter) {
  return `08${String(counter).padStart(18, "0")}`;
}

/** Zero-padded 12-digit change id: change rows sort by insertion order. */
export function changeIdFor(counter) {
  return String(counter).padStart(12, "0");
}

/** Head revision id `0B` + 20 base32hex digits, set on blob create and content replace. */
export function revisionIdFor(counter) {
  return `0B${base32hex(counter, 20)}`;
}

export function webViewLinkFor(id, mimeType) {
  if (mimeType === FOLDER_MIME) return `https://drive.google.com/drive/folders/${id}`;
  if (mimeType === DOCUMENT_MIME) return `https://docs.google.com/document/d/${id}/edit?usp=drivesdk`;
  if (mimeType === SPREADSHEET_MIME) return `https://docs.google.com/spreadsheets/d/${id}/edit?usp=drivesdk`;
  if (mimeType === PRESENTATION_MIME) return `https://docs.google.com/presentation/d/${id}/edit?usp=drivesdk`;
  return `https://drive.google.com/file/d/${id}/view?usp=drivesdk`;
}

export function webContentLinkFor(id) {
  return `https://drive.google.com/uc?id=${id}&export=download`;
}

export function iconLinkFor(mimeType) {
  return `https://drive-thirdparty.googleusercontent.com/16/type/${mimeType}`;
}

export function exportLinkFor(id, mimeType) {
  return `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(mimeType)}`;
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

/** Strict UTF-8 decoder: rejects truncated sequences, bad continuation bytes, overlong forms, surrogates and > U+10FFFF. */
function utf8Text(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index];
    let code;
    let width;
    let min;
    if (first < 0x80) {
      code = first;
      width = 1;
      min = 0;
    } else if (first >= 0xc2 && first <= 0xdf) {
      code = first & 0x1f;
      width = 2;
      min = 0x80;
    } else if ((first & 0xf0) === 0xe0) {
      code = first & 0x0f;
      width = 3;
      min = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      code = first & 0x07;
      width = 4;
      min = 0x10000;
    } else throw new TypeError("malformed UTF-8");
    if (index + width > bytes.length) throw new TypeError("malformed UTF-8");
    for (let offset = 1; offset < width; offset += 1) {
      const next = bytes[index + offset];
      if ((next & 0xc0) !== 0x80) throw new TypeError("malformed UTF-8");
      code = (code << 6) | (next & 0x3f);
    }
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new TypeError("malformed UTF-8");
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
  if (bits >= 6 || buffer !== 0) throw new TypeError("malformed base64url");
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

/** Stable JSON (sorted keys, undefined dropped) for hashing argument scopes. */
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

export function permissionRowId(fileId, permissionId) {
  return `${fileId}:${permissionId}`;
}

export function userFileRowId(email, fileId) {
  return `${email}:${fileId}`;
}

/** Longest page token this service issues or accepts (the `pageToken` schema bound). */
export const MAX_PAGE_TOKEN_LENGTH = 4096;

/**
 * Opaque page token: base64url(JSON `{ p: <bounded position payload>, c: <checksum of scope + payload> }`). The payload
 * never embeds caller-sized text unclipped, so the token stays far below MAX_PAGE_TOKEN_LENGTH; the checksum binds it to
 * the request scope (user, query, order) and detects tampering.
 */
export function encodePageToken(scope, payload) {
  const body = JSON.stringify(payload);
  const token = encodeBase64Url(JSON.stringify({ p: payload, c: hashText(`${scope}\u0000${body}`) }));
  if (token.length > MAX_PAGE_TOKEN_LENGTH) throw new RangeError("page token exceeds its bound");
  return token;
}

/** Decodes a page token with full validation; returns null when malformed, tampered or issued for another scope. */
export function decodePageToken(token, scope) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_PAGE_TOKEN_LENGTH) return null;
  let parsed;
  try {
    parsed = JSON.parse(decodeBase64Url(token));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !Object.hasOwn(parsed, "p") || !Object.hasOwn(parsed, "c") || typeof parsed.c !== "string") return null;
  if (parsed.c !== hashText(`${scope}\u0000${JSON.stringify(parsed.p)}`)) return null;
  if (encodeBase64Url(JSON.stringify({ p: parsed.p, c: parsed.c })) !== token) return null;
  return parsed.p;
}

/** Natural ("name_natural") comparison: digit runs compare numerically, the rest by lower-cased code units. */
export function compareNatural(left, right) {
  const a = String(left).toLowerCase();
  const b = String(right).toLowerCase();
  const pattern = /(\d+)|(\D+)/g;
  const chunksA = a.match(pattern) ?? [];
  const chunksB = b.match(pattern) ?? [];
  const length = Math.min(chunksA.length, chunksB.length);
  for (let index = 0; index < length; index += 1) {
    const x = chunksA[index];
    const y = chunksB[index];
    const numeric = /^\d/.test(x) && /^\d/.test(y);
    if (numeric) {
      const difference = Number.parseInt(x, 10) - Number.parseInt(y, 10);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      if (x.length !== y.length) return x.length < y.length ? -1 : 1;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  if (chunksA.length !== chunksB.length) return chunksA.length < chunksB.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

export function compareText(left, right) {
  const a = String(left).toLowerCase();
  const b = String(right).toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}
