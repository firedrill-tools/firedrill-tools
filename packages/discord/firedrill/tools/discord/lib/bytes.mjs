// Response byte budgets. The HTTP binding refuses bodies over 1 MiB, so pages are filled by the UTF-8 size of their JSON
// encoding (escapes included: JSON.stringify already turns control characters into six-byte \u00XX sequences and lone
// surrogates into escapes), counted from code units without Buffer. Pure.

/** UTF-8 byte length of `JSON.stringify(value)`. */
export function jsonBytes(value) {
  const text = JSON.stringify(value);
  if (typeof text !== "string") return 0;
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Admit rendered rows in the given order until `limit` rows or `budget` bytes (the size of the JSON array holding them).
 * Returns `{ items, oversized }`; `oversized` is true only when the very first row alone does not fit, so callers answer a
 * declared error instead of an empty page. Rows are rendered lazily, so nothing past the cap is built.
 */
export function fillByBytes(rows, render, limit, budget) {
  const items = [];
  let bytes = 2;
  for (const row of rows) {
    if (items.length >= limit) break;
    const item = render(row);
    const size = jsonBytes(item) + (items.length > 0 ? 1 : 0);
    if (bytes + size > budget) return { items, oversized: items.length === 0 };
    items.push(item);
    bytes += size;
  }
  return { items, oversized: false };
}
