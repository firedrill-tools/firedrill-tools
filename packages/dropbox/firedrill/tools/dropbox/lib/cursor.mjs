// Opaque cursors: url-safe base64 of an ASCII-only JSON object plus a 16-hex FNV checksum. Cursors come back from
// callers, so decoding validates the alphabet, checksum, ASCII bytes, JSON shape, kind and account.
import { asciiJson, base64Decode, base64Encode, fnv32, utf8Encode } from "./util.mjs";

const MAX_CURSOR = 8192;

function checksum(body) {
  return fnv32(body) + fnv32(body, 0x2545f491);
}

export function encodeCursor(value) {
  const body = base64Encode(utf8Encode(asciiJson(value)), true);
  return `${body}${checksum(body)}`;
}

/** Returns the decoded object when valid for `kind` and `accountId`, otherwise null. */
export function decodeCursor(text, kind, accountId) {
  if (typeof text !== "string" || text.length < 20 || text.length > MAX_CURSOR) return null;
  const body = text.slice(0, -16);
  const sum = text.slice(-16);
  if (!/^[0-9a-f]{16}$/.test(sum) || checksum(body) !== sum) return null;
  const bytes = base64Decode(body, true);
  if (bytes === null) return null;
  let json = "";
  for (const byte of bytes) {
    if (byte >= 0x80 || byte < 0x20) return null;
    json += String.fromCharCode(byte);
  }
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.v !== 1 || value.k !== kind || value.a !== accountId) return null;
  return value;
}

export const isInt = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(value) && value >= min && value <= max;
export const isStr = (value, max = 4096) => typeof value === "string" && value.length <= max;
export const isBool = (value) => typeof value === "boolean";
