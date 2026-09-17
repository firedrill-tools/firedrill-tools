// Little text format helpers and UTF-8 byte accounting (no Buffer in behavior modules).

const WORD = /[\p{L}\p{N}_]/u;
const MAX_TAG = 100;

/**
 * Converts `#word` hashtags into LinkedIn's `{hashtag|\#|word}` template in one linear pass. A `#` preceded by a word
 * character or a backslash (already templated text) is left alone, as are hashtags longer than 100 characters.
 */
export function templateHashtags(text) {
  const chars = Array.from(text);
  let out = "";
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    const prev = i > 0 ? chars[i - 1] : "";
    if (ch === "#" && prev !== "\\" && !(prev !== "" && WORD.test(prev))) {
      let j = i + 1;
      while (j < chars.length && j - i - 1 <= MAX_TAG && WORD.test(chars[j])) j += 1;
      const length = j - i - 1;
      if (length >= 1 && length <= MAX_TAG) {
        out += `{hashtag|\\#|${chars.slice(i + 1, j).join("")}}`;
        i = j;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** UTF-8 byte length of a string, computed from code points (lone surrogates count as the 3-byte replacement). */
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

/** Encoded JSON size in UTF-8 bytes. */
export const jsonBytes = (value) => utf8Length(JSON.stringify(value));

/** Case-insensitive fold used by connection search (locale-independent). */
export const fold = (text) => text.toLowerCase();
