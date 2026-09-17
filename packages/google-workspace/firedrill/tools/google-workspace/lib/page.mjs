// Opaque page and sync tokens, page-size validation and byte-budgeted paging.
// Tokens come back from callers and can be forged, so every field is validated before it is trusted.
import { PAGE_BYTE_BUDGET, invalid, invalidPageToken, outOfRange } from "./errors.mjs";
import { base64urlDecode, base64urlEncode, jsonBytes } from "./util.mjs";

const TOKEN_VERSION = 1;

/** Mints a page token bound to the scope it was created for. */
export function mintPageToken(scope, cursor) {
  return base64urlEncode(JSON.stringify({ v: TOKEN_VERSION, s: scope, c: cursor }));
}

/** Parses a page token, or fails INVALID_ARGUMENT. Returns null when the caller sent none. */
export function readPageToken(context, token, scope) {
  if (token === undefined || token === null) return null;
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) invalidPageToken(context);
  const text = base64urlDecode(token);
  if (text === null) invalidPageToken(context);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalidPageToken(context);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) invalidPageToken(context);
  if (parsed.v !== TOKEN_VERSION || parsed.s !== scope) invalidPageToken(context);
  if (typeof parsed.c !== "string" || parsed.c.length > 700) invalidPageToken(context);
  return parsed.c;
}

/** Mints a connections sync token: the virtual-time watermark plus the owner it belongs to. */
export const mintSyncToken = (ownerUserId, atUs) => base64urlEncode(JSON.stringify({ v: TOKEN_VERSION, s: "sync", o: ownerUserId, t: atUs }));

export function readSyncToken(context, token, ownerUserId) {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) invalid(context, "Invalid sync token.", "INVALID_SYNC_TOKEN");
  const text = base64urlDecode(token);
  if (text === null) invalid(context, "Invalid sync token.", "INVALID_SYNC_TOKEN");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid(context, "Invalid sync token.", "INVALID_SYNC_TOKEN");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) invalid(context, "Invalid sync token.", "INVALID_SYNC_TOKEN");
  if (parsed.v !== TOKEN_VERSION || parsed.s !== "sync" || parsed.o !== ownerUserId) {
    invalid(context, "Invalid sync token.", "INVALID_SYNC_TOKEN");
  }
  if (typeof parsed.t !== "number" || !Number.isFinite(parsed.t) || parsed.t < 0) invalid(context, "Invalid sync token.", "INVALID_SYNC_TOKEN");
  return parsed.t;
}

/** Validates a page size against the provider's own bounds. */
export function pageSize(context, value, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalid(context, `Page size must be an integer between ${min} and ${max}.`);
  }
  if (value === 0) return fallback;
  if (value < min || value > max) outOfRange(context, `Page size must be between ${min} and ${max}, got ${value}.`);
  return value;
}

/**
 * Fills a page from `items` starting at `startIndex`, stopping on the count limit or once the encoded page would
 * pass the byte budget. Returns the rendered entries and the index of the first entry NOT included.
 * `onOversize` is called when a single entry alone exceeds the budget.
 */
export function fillPage(items, startIndex, limit, render, onOversize, overheadBytes = 512) {
  const out = [];
  let bytes = overheadBytes;
  let index = startIndex;
  while (index < items.length && out.length < limit) {
    const rendered = render(items[index]);
    const size = jsonBytes(rendered) + 2;
    if (size + overheadBytes > PAGE_BYTE_BUDGET) {
      onOversize(items[index]);
      return { entries: out, nextIndex: index };
    }
    if (out.length > 0 && bytes + size > PAGE_BYTE_BUDGET) return { entries: out, nextIndex: index };
    out.push(rendered);
    bytes += size;
    index += 1;
  }
  return { entries: out, nextIndex: index };
}

// ---- Keyed cursors -------------------------------------------------------------------------------------------
// A cursor carries the anchor row's id AND its sort key. When the anchor row still exists the page resumes on it;
// when it has been deleted between pages the page resumes at the first surviving row that sorts at or after the
// anchor's key, so the remaining rows are never skipped and nothing is repeated.

const KEY_STRING_MAX = 300;
const normKey = (value) => (typeof value === "string" && value.length > KEY_STRING_MAX ? value.slice(0, KEY_STRING_MAX) : value);

/** Compares two sort keys element-wise; `dirs[i]` is 1 for ascending (default) or -1 for descending. */
export function compareKeys(a, b, dirs = []) {
  for (let i = 0; i < a.length; i += 1) {
    const x = normKey(a[i]);
    const y = normKey(b[i]);
    const dir = dirs[i] === -1 ? -1 : 1;
    if (x < y) return -dir;
    if (x > y) return dir;
  }
  return 0;
}

/** Mints a page token anchored on `row`: its identity plus the sort key the list was ordered by. */
export function mintKeyedToken(scope, id, key) {
  return mintPageToken(scope, JSON.stringify({ i: id, k: key.map(normKey) }));
}

/**
 * Resolves the start index for a keyed cursor over `rows` (already sorted). `idOf(row)` and `keyOf(row)` must match
 * the values the token was minted with; `dirs` mirrors the comparator. Fails INVALID_ARGUMENT on a forged token.
 */
export function resumeIndex(context, token, scope, rows, idOf, keyOf, dirs = []) {
  const cursor = readPageToken(context, token, scope);
  if (cursor === null) return 0;
  let parsed;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    invalidPageToken(context);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) invalidPageToken(context);
  if (typeof parsed.i !== "string" || !Array.isArray(parsed.k) || parsed.k.length > 6) invalidPageToken(context);
  for (const part of parsed.k) {
    if (typeof part !== "string" && (typeof part !== "number" || !Number.isFinite(part))) invalidPageToken(context);
  }
  if (rows.length === 0) return 0;
  const shape = keyOf(rows[0]);
  if (parsed.k.length !== shape.length || parsed.k.some((part, i) => typeof part !== typeof shape[i])) invalidPageToken(context);

  const exact = rows.findIndex((row) => idOf(row) === parsed.i);
  if (exact >= 0) return exact;
  for (let index = 0; index < rows.length; index += 1) {
    if (compareKeys(keyOf(rows[index]), parsed.k, dirs) >= 0) return index;
  }
  return rows.length;
}
