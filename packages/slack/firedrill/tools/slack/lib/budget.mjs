// Response byte budget. The HTTP layer refuses route responses over 1 MiB, so every list and read sizes its page by the
// UTF-8 bytes of the encoded JSON body as well as by count. Bytes are computed from code points (no Buffer), because
// String#length counts UTF-16 code units and undercounts CJK and emoji text by up to three times.

/** Body bytes a list or read may produce unless the workspace row lowers it (workspace.limits.response_bytes). */
export const RESPONSE_BYTES = 900000;

/** UTF-8 byte length of a string, computed from its code points (lone surrogates count as U+FFFD, 3 bytes). */
export function utf8Bytes(text) {
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

/** UTF-8 bytes of the compact JSON encoding of a value (the shape the route sends). */
export function jsonBytes(value) {
  return utf8Bytes(JSON.stringify(value));
}

/**
 * How many leading `items` fit in a body whose envelope (with an empty list) is `envelopeBytes`, given at most `limit`
 * items. Each admitted item adds its own bytes plus one comma after the first. Returns 0 when the first item alone does
 * not fit; the caller answers its declared error instead of an empty or oversized page.
 */
export function fitCount(items, limit, envelopeBytes, budget, sizeOf) {
  let used = envelopeBytes;
  let count = 0;
  const cap = Math.min(limit, items.length);
  while (count < cap) {
    const next = sizeOf(items[count]) + (count === 0 ? 0 : 1);
    if (used + next > budget) break;
    used += next;
    count += 1;
  }
  return count;
}

/**
 * Largest page size k ≤ `perPage` for which every page of k consecutive items (search's page arithmetic) fits the
 * budget. Sizes are measured once; each candidate is checked with a prefix sum, so the cost is items × candidates.
 * Returns 0 when a single item alone exceeds the budget.
 */
export function uniformPageSize(sizes, perPage, envelopeBytes, budget) {
  if (sizes.length === 0) return perPage;
  const prefix = [0];
  for (const size of sizes) prefix.push(prefix[prefix.length - 1] + size);
  for (let size = perPage; size >= 1; size -= 1) {
    let fits = true;
    for (let start = 0; start < sizes.length && fits; start += size) {
      const end = Math.min(start + size, sizes.length);
      fits = envelopeBytes + prefix[end] - prefix[start] + (end - start - 1) <= budget;
    }
    if (fits) return size;
  }
  return 0;
}
