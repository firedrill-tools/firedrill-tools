// Response byte budgets. The framework refuses any HTTP route response over 1 MiB, so every body whose
// size depends on stored rows (query pages, search results, collection retrieves, composite responses)
// is measured in encoded UTF-8 bytes of the JSON actually sent, entry by entry, before it is admitted.

/** Budget for one response body: comfortably below the framework's 1 MiB (1,048,576-byte) cap. */
export const RESPONSE_BYTE_BUDGET = 900000;

/**
 * UTF-8 byte length of a string: 1 byte below U+0080, 2 below U+0800, 4 for a surrogate pair (2 per
 * code unit) and 3 otherwise. JSON.stringify escapes lone surrogates, so pairs are always well formed.
 */
export function utf8Length(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

/** Encoded size of `value` as the JSON body the route sends. */
export function jsonBytes(value) {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : utf8Length(text);
}

/** Tracks the bytes admitted to one array inside a body; `admit` refuses an entry that would pass the limit. */
export function byteBudget(limit, overhead) {
  let used = overhead;
  let count = 0;
  return {
    get used() {
      return used;
    },
    /** Size an entry (plus its separating comma) without admitting it. */
    measure(entry) {
      return jsonBytes(entry) + (count > 0 ? 1 : 0);
    },
    fits(size) {
      return used + size <= limit;
    },
    add(size) {
      used += size;
      count += 1;
    },
    admit(entry) {
      const size = this.measure(entry);
      if (!this.fits(size)) return false;
      this.add(size);
      return true;
    },
  };
}
