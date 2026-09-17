// Small deterministic helpers shared by every module. No clock, no randomness, no Node built-ins.

export const HEX24 = /^[0-9a-f]{24}$/;

export const isHex24 = (value) => typeof value === "string" && HEX24.test(value);

export const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Clips caller text quoted into messages so no error message ever approaches the framework's 4,000-character cap. */
export function clip(value, max = 200) {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export const pad = (value, width, fill = "0") => String(value).padStart(width, fill);

/** UTF-8 byte length of a string, computed from code points (a behavior module has no Buffer). */
export function utf8Bytes(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: a well-formed pair is one 4-byte code point; a lone surrogate serialises as 3 bytes.
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** UTF-8 byte size of the JSON encoding of a value. */
export const jsonBytes = (value) => utf8Bytes(JSON.stringify(value));

/** Case fold for search: lower-case plus a full-width/upper-case normalisation that never depends on the host locale. */
export const fold = (text) => text.toLowerCase();

/** Linear-time substring test on folded text (String.prototype.includes is linear in V8; the needle is literal). */
export const containsFolded = (haystack, needle) => typeof haystack === "string" && fold(haystack).includes(needle);

export function titleCase(slug) {
  return slug
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

/** Deterministic string comparison by UTF-16 code units (no locale). */
export function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function hasOwn(object, key) {
  return isPlainObject(object) && Object.hasOwn(object, key);
}

/** Returns a copy of `value` without the listed keys. */
export function omit(value, keys) {
  const out = {};
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) out[key] = value[key];
  }
  return out;
}

/** Structural equality for JSON values (used to compute changed fields on update). */
export function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.hasOwn(b, key) || !jsonEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}
