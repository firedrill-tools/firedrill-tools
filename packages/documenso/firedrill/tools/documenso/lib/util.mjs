// Deterministic helpers: ids, virtual-time formatting, UTF-8 byte counting and seeded random strings.

export const pad10 = (n) => String(n).padStart(10, "0");

/** ISO-8601 in UTC with milliseconds, from integer microseconds. */
export const iso = (us) => new Date(Math.floor(us / 1000)).toISOString();
export const isoOrNull = (us) => (typeof us === "number" ? iso(us) : null);
export const monthOf = (us) => iso(us).slice(0, 7);

/** UTF-8 byte length computed from UTF-16 code units (lone surrogates count as the 3-byte replacement). */
export function utf8Bytes(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Bytes of the JSON response body the HTTP binding would write (JSON text plus a newline). */
export const jsonBytes = (value) => utf8Bytes(JSON.stringify(value)) + 1;

export const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
export const ENVELOPE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `length` characters drawn from `alphabet` using seeded 64-bit draws (several characters per draw). */
export function randomChars(context, alphabet, length) {
  const size = BigInt(alphabet.length);
  let out = "";
  while (out.length < length) {
    let value = context.random.nextU64();
    for (let k = 0; k < 8 && out.length < length; k += 1) {
      out += alphabet[Number(value % size)];
      value /= size;
    }
  }
  return out;
}

/** An integer id or page number from a JSON number or a decimal string; null when it is not one. */
export function toInt(value, min = 1, max = 9999999999) {
  let n = null;
  if (typeof value === "number" && Number.isSafeInteger(value)) n = value;
  else if (typeof value === "string" && /^[0-9]{1,16}$/.test(value)) n = Number(value);
  return n !== null && Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

/** A finite number from a JSON number or a plain decimal string. */
export function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?[0-9]{1,6}(\.[0-9]{1,6})?$/.test(value)) return Number(value);
  return null;
}

export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const hasOwn = (value, key) => isObject(value) && Object.hasOwn(value, key);
export const lower = (text) => String(text).toLowerCase();
