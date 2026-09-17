// Opaque keyset cursors (MCP `after`): canonical base64url of `{"k":kind,"p":projectId,"o":key}`. Cursors are
// caller input: anything that is not the exact canonical encoding of a cursor for this list scope is rejected.
import { base64UrlDecode, base64UrlEncode } from "./base64.mjs";

const MAX_CURSOR = 1_024;

export function encodeCursor(kind, projectId, key) {
  return base64UrlEncode(JSON.stringify({ k: kind, p: projectId, o: key }));
}

/** The key inside a valid cursor for (`kind`, `projectId`), or undefined for a forged, mis-scoped or malformed one. */
export function decodeCursor(text, kind, projectId) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  const json = base64UrlDecode(text);
  if (json === undefined) return undefined;
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("k") || !keys.includes("p") || !keys.includes("o")) return undefined;
  if (value.k !== kind || value.p !== projectId) return undefined;
  if (typeof value.o !== "string" && !(typeof value.o === "number" && Number.isSafeInteger(value.o))) return undefined;
  if (encodeCursor(kind, projectId, value.o) !== text) return undefined;
  return value.o;
}
