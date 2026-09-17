// Response byte budget. The framework refuses any HTTP route response above 1 MiB (after the operation has
// committed), so every list is paged by bytes as well as by count and single reads are measured before they are
// returned. Sizes are UTF-8 bytes of the JSON encoding, counted from code points (no Buffer or TextEncoder).

/** Budget for the items of one response; leaves room under 1 MiB for the envelope and headers. */
export const RESPONSE_BUDGET = 900_000;

/** UTF-8 byte length of `JSON.stringify(value)`. Lone surrogates are escaped by JSON.stringify (ASCII). */
export function jsonBytes(value) {
  const text = JSON.stringify(value);
  if (typeof text !== "string") return 0;
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Page-number pagination sized by count and bytes. Pages are cut greedily from the start of the ordered list:
 * a page holds at most `perPage` items and at most `budget` bytes of encoded items (plus one separator each),
 * so page N is the same partition on every request and every item appears on exactly one page.
 * `viewOf(item)` builds the encoded item; only the requested page's views are kept.
 * Returns `{ items, total, page, perPage, pages }`, or `{ tooLarge: item }` when one item alone exceeds the budget.
 */
export function pageByBytes(items, page, perPage, viewOf, options = {}) {
  const size = perPage ?? 30;
  const current = page ?? 1;
  const budget = (options.budget ?? RESPONSE_BUDGET) - (options.reserved ?? 0);
  let pages = 0;
  let count = size;
  let bytes = 0;
  const selected = [];
  for (const item of items) {
    const view = viewOf(item);
    const itemBytes = jsonBytes(view) + 1;
    if (itemBytes > budget) return { tooLarge: item, view };
    if (count >= size || bytes + itemBytes > budget) {
      pages += 1;
      count = 0;
      bytes = 0;
    }
    count += 1;
    bytes += itemBytes;
    if (pages === current) selected.push(view);
  }
  return { items: selected, total: items.length, page: current, perPage: size, pages: Math.max(1, pages) };
}

/** A diff entry whose `patch` would overflow a response (after `reserved` bytes) loses `patch`, as GitHub omits it for large diffs. */
export function fitPatch(entry, reserved = 0) {
  if (entry.patch === undefined || jsonBytes(entry) + 1 <= RESPONSE_BUDGET - reserved) return entry;
  const { patch: _patch, ...rest } = entry;
  return rest;
}

/** Items after a cursor position, bounded by count and bytes (for cursor-style continuations). */
export function takeByBytes(items, limit, viewOf, options = {}) {
  const budget = (options.budget ?? RESPONSE_BUDGET) - (options.reserved ?? 0);
  const views = [];
  let bytes = 0;
  let taken = 0;
  for (const item of items) {
    if (taken >= limit) break;
    const view = viewOf(item);
    const itemBytes = jsonBytes(view) + 1;
    if (itemBytes > budget) return { tooLarge: item, view };
    if (bytes + itemBytes > budget) break;
    views.push(view);
    bytes += itemBytes;
    taken += 1;
  }
  return { items: views, taken };
}
