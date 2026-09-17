// Response byte budgets. Drive-shaped HTTP routes may not answer more than 1 MiB, so every list page is filled by the
// UTF-8 size of the entries it will actually send, computed from code points (no Buffer or TextEncoder in behaviour).
// Pure functions only.

/** Byte budget of one encoded list page (entries plus envelope), well under the 1 MiB route limit. */
export const PAGE_BYTE_BUDGET = 900_000;

/**
 * Bytes reserved for the list envelope (`kind`, flags and a page token of at most 4096 characters). The MCP framing
 * carries the envelope twice like every other part of the value (see `mcpSize`), so the reserve covers that copy too.
 */
export const ENVELOPE_RESERVE = 24_576;

/** Largest export body (UTF-8 bytes) this service answers inline (Drive's own export limit error beyond it). */
export const MAX_EXPORT_BYTES = 900_000;

/** files.export `data` is declared with maxLength 400,000 characters; a larger rendering answers exportSizeLimitExceeded. */
export const MAX_EXPORT_CHARS = 400_000;

/** files.download `content` is base64 declared with maxLength 400,000, so an exported body may hold at most 300,000 bytes. */
export const MAX_DOWNLOAD_EXPORT_BYTES = 300_000;

/** True when an export rendering satisfies the files.export output schema and the response byte budget. */
export function exportFits(data) {
  return data.length <= MAX_EXPORT_CHARS && utf8Size(data) <= MAX_EXPORT_BYTES;
}

/** True when an export rendering, base64-encoded, satisfies the files.download output schema (checked before encoding). */
export function downloadExportFits(data) {
  return data.length <= MAX_DOWNLOAD_EXPORT_BYTES && utf8Size(data) <= MAX_DOWNLOAD_EXPORT_BYTES;
}

/** UTF-8 byte length of a string, from its code points. Lone surrogates count as the 3-byte replacement. */
export function utf8Size(text) {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) length += 1;
    else if (unit < 0x800) length += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        length += 4;
        index += 1;
      } else length += 3;
    } else length += 3;
  }
  return length;
}

/** UTF-8 byte length of the JSON encoding of a value (JSON.stringify escapes lone surrogates as ASCII). */
export function jsonSize(value) {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : utf8Size(text);
}

/**
 * Bytes one value costs on the widest surface it is returned on. The Drive-shaped REST routes send a `fields`-masked
 * rendering, the canonical `/v1/operations` endpoint sends the full operation value, and an MCP tool result carries
 * that same value twice - once JSON-escaped inside `content[0].text` and once as `structuredContent` - so an MCP
 * response is a little over twice the canonical one. Pages are filled against this size so a page that fits over REST
 * cannot overflow the framework's 1 MiB route cap on the canonical or MCP surface (measured: a 63,353-byte canonical
 * `files.list` value came back as a 136,985-byte MCP result).
 */
export function mcpSize(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return 0;
  return utf8Size(text) + utf8Size(JSON.stringify(text));
}

/**
 * Page filler: `admit(size)` returns true while the entry fits the remaining budget (and the count), false once the
 * page is full. The first entry of a page is always checked, so an entry larger than the budget reports `oversized`.
 */
export function pageFiller(pageSize, budget = PAGE_BYTE_BUDGET - ENVELOPE_RESERVE) {
  let used = 0;
  let count = 0;
  return {
    admit(size) {
      const cost = size + (count === 0 ? 0 : 1);
      if (count >= pageSize || used + cost > budget) return false;
      used += cost;
      count += 1;
      return true;
    },
    get count() {
      return count;
    },
    get used() {
      return used;
    },
    oversized(size) {
      return count === 0 && size > budget;
    },
  };
}
