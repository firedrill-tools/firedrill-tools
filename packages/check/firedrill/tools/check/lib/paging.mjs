// Check cursor pages `{ next, previous, results }`. Cursors are base64url JSON `{v,r,f,k,d}` resuming after the full sort
// key; they are validated completely (alphabet, strict UTF-8, JSON shape, resource, filter digest, key types).
import { jsonBytes } from "./store.mjs";
import { bad } from "./validate.mjs";

const BYTE_BUDGET = 900000;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function limitArg(context, input, max) {
  const limit = Object.hasOwn(input, "limit") ? input.limit : 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) bad(context, "limit", `Ensure this value is between 1 and ${max}.`);
  return limit;
}

function utf8Bytes(text) {
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function strictUtf8(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let need = 0;
    let cp = 0;
    let min = 0;
    if (b < 0x80) { out += String.fromCharCode(b); i++; continue; }
    if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 31; min = 0x80; }
    else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 15; min = 0x800; }
    else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 7; min = 0x10000; }
    else return null;
    for (let j = 1; j <= need; j++) {
      const next = bytes[i + j];
      if (next === undefined || (next & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (next & 63);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

function encodeB64(text) {
  const bytes = utf8Bytes(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let j = 0; j < chars; j++) out += B64[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}

function decodeB64(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 2048 || text.length % 4 === 1) return null;
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    buffer = ((buffer << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return strictUtf8(bytes);
}

/** FNV-1a digest of the normalized filters (limit excluded). */
function digest(filters) {
  let hash = 0x811c9dc5;
  for (const ch of JSON.stringify(filters)) {
    hash ^= ch.codePointAt(0) & 0xffff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function readCursor(context, raw, resource, filters, keyTypes) {
  const invalid = () => bad(context, "cursor", "Invalid cursor.");
  const json = decodeB64(raw);
  if (json === null) invalid();
  let value;
  try { value = JSON.parse(json); } catch { invalid(); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "d,f,k,r,v" || value.v !== 1 || value.r !== resource || value.f !== digest(filters) || (value.d !== "n" && value.d !== "p")) invalid();
  if (!Array.isArray(value.k) || value.k.length !== keyTypes.length) invalid();
  keyTypes.forEach((type, i) => {
    const part = value.k[i];
    if (type === "s" ? typeof part !== "string" || part.length > 512 : !Number.isSafeInteger(part)) invalid();
  });
  return value;
}

function url(path, filters, limit, cursor) {
  const params = [];
  for (const [name, value] of Object.entries(filters)) {
    for (const item of Array.isArray(value) ? value : [value]) params.push(`${name}=${encodeURIComponent(String(item))}`);
  }
  params.push(`limit=${limit}`, `cursor=${cursor}`);
  return `${path}?${params.join("&")}`;
}

/**
 * One page. `rows` must already be sorted by `compare(keyOf(a), keyOf(b))`; `filters` are the normalized filters echoed
 * into `next`/`previous`; `map` renders a row for output; `extra` adds top-level fields.
 */
export function pageOf(context, { resource, path, rows, filters, limit, cursor, keyOf, keyTypes, compare, map, extra = {} }) {
  const token = cursor === undefined ? null : readCursor(context, cursor, resource, filters, keyTypes);
  const make = (row, d) => encodeB64(JSON.stringify({ v: 1, r: resource, f: digest(filters), k: keyOf(row), d }));
  let budget = BYTE_BUDGET - jsonBytes({ ...extra, next: null, previous: null, results: [] }) - 2 * (path.length + 3000);
  const take = (row) => {
    const rendered = map(row);
    const size = jsonBytes(rendered) + 1;
    if (size > budget) return null;
    budget -= size;
    return rendered;
  };
  const results = [];
  let first;
  let last;
  if (token !== null && token.d === "p") {
    let end = rows.findIndex((row) => compare(keyOf(row), token.k) >= 0);
    if (end < 0) end = rows.length;
    let i = end - 1;
    while (i >= 0 && results.length < limit) {
      const rendered = take(rows[i]);
      if (rendered === null) break;
      results.unshift(rendered);
      i--;
    }
    first = i + 1;
    last = end - 1;
  } else {
    let start = token === null ? 0 : rows.findIndex((row) => compare(keyOf(row), token.k) > 0);
    if (start < 0) start = rows.length;
    let i = start;
    while (i < rows.length && results.length < limit) {
      const rendered = take(rows[i]);
      if (rendered === null) break;
      results.push(rendered);
      i++;
    }
    first = start;
    last = i - 1;
  }
  const available = token !== null && token.d === "p" ? last + 1 : rows.length - first;
  if (results.length === 0 && available > 0) bad(context, "limit", "Response too large.");
  const next = results.length > 0 && last + 1 < rows.length ? url(path, filters, limit, make(rows[last], "n")) : null;
  const previous = results.length > 0 && first > 0 ? url(path, filters, limit, make(rows[first], "p")) : null;
  return { next, previous, results, ...extra };
}

/** Compares key arrays; `desc` lists the positions sorted descending. Strings compare by code unit. */
export function keyComparator(desc = []) {
  return (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      const order = a[i] < b[i] ? -1 : 1;
      return desc.includes(i) ? -order : order;
    }
    return 0;
  };
}
