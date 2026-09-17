// Response byte budgets. The framework refuses HTTP responses above 1 MiB, so pages are filled by the UTF-8 size of
// their encoded JSON (counted from code points, never from UTF-16 string length) and single or batch responses that
// would not fit fail with a declared error before anything commits.

/** Pages stop filling before the encoded body would pass this many UTF-8 bytes (the framework cap is 1,048,576). */
export const RESPONSE_BYTE_BUDGET = 900_000;

/** Bytes reserved on a page for the envelope (`{"results":[…]}`, `total`, `paging.next` with its link). */
export const PAGE_ENVELOPE_BYTES = 512;

/** UTF-8 byte length of a string: 1–3 bytes per BMP code unit, 4 per surrogate pair, 3 for a lone surrogate. */
export function utf8Length(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** UTF-8 size of a value's JSON encoding (the shape the HTTP route sends). */
export function jsonBytes(value) {
  return utf8Length(JSON.stringify(value));
}
