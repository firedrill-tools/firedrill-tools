// Shared pure helpers: own-key lookups, GUIDs, text clipping and UTF-8 sizes. No module state, no wall clock.

export const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const hasOwn = (object, key) => object !== null && typeof object === "object" && Object.hasOwn(object, key);

export const own = (object, key) => (hasOwn(object, key) ? object[key] : undefined);

export const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function clip(text, max = 200) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const HEX = "0123456789abcdef";

function isHex(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

/** True for a 36-character GUID (8-4-4-4-12 hex digits, any case). Linear, no regular expression. */
export function isGuid(value) {
  if (typeof value !== "string" || value.length !== 36) return false;
  for (let i = 0; i < 36; i += 1) {
    const code = value.charCodeAt(i);
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (code !== 45) return false;
    } else if (!isHex(code)) return false;
  }
  return true;
}

/** Lower-case GUID, or null when the value is not one. */
export const normalGuid = (value) => (isGuid(value) ? value.toLowerCase() : null);

/** A version-4 GUID drawn from the seeded world random source. */
export function drawGuid(context) {
  let digits = "";
  for (let i = 0; i < 2; i += 1) {
    let word = context.random.nextU64();
    for (let j = 0; j < 16; j += 1) {
      digits += HEX[Number(word & 15n)];
      word >>= 4n;
    }
  }
  const chars = digits.split("");
  chars[12] = "4";
  chars[16] = HEX[(HEX.indexOf(chars[16]) & 3) | 8];
  const s = chars.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** UTF-8 byte length of a string computed from code points (lone surrogates count as U+FFFD, 3 bytes). */
export function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export const jsonBytes = (value) => utf8Length(JSON.stringify(value));

/** Case-insensitive folding used by search and where-expression string comparisons. */
export const fold = (text) => String(text).toLowerCase();

export const containsReplacement = (text) => typeof text === "string" && text.includes("�");

/** Stable comparison of two strings by UTF-16 code units (host-independent, no locale). */
export function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Iterative JSON depth and hazard check: returns an error message or null. */
export function inspectJson(value, { maxDepth = 512, maxArray = 10000 } = {}) {
  const stack = [[value, 1]];
  let visited = 0;
  while (stack.length > 0) {
    const [current, depth] = stack.pop();
    if (current === null || typeof current !== "object") continue;
    visited += 1;
    if (visited > 200000) return "Request body is too large to process.";
    if (depth > maxDepth) return `Request body nesting exceeds ${maxDepth} levels.`;
    if (Array.isArray(current)) {
      if (current.length > maxArray) return `Request body array exceeds ${maxArray} elements.`;
      for (const inner of current) if (inner !== null && typeof inner === "object") stack.push([inner, depth + 1]);
      continue;
    }
    for (const key of Object.keys(current)) {
      if (RESERVED_KEYS.has(key)) return `Request body contains the reserved key "${key}".`;
      const inner = current[key];
      if (inner !== null && typeof inner === "object") stack.push([inner, depth + 1]);
    }
  }
  return null;
}
