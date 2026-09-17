// UTF-8 byte accounting for response budgets. The framework refuses an HTTP response body over 1 MiB, so every
// rendered object is bounded when it is written and every list page is filled by encoded bytes. No module state.

/** Hard bound on one encoded response body (the framework's cap is 1,048,576 bytes; the rest is headroom). */
export const MAX_RESPONSE_BYTES = 1_000_000;
/** Encoded bytes of `results` one list page may fill before it ends early with a real next_cursor. */
export const PAGE_BUDGET_BYTES = 900_000;
/** Rendered size a stored page, block, comment, database or data source may reach when it is written. */
export const OBJECT_BUDGET_BYTES = 800_000;
/** Rendered size of one data source schema (its property keys are repeated in every page of the data source). */
export const SCHEMA_BUDGET_BYTES = 150_000;
/**
 * Worst-case bytes a data source schema adds to the rendering of each of its pages (every property with an empty
 * value, created_by / last_edited_by as the widest expanded user). A page is bounded by OBJECT_BUDGET_BYTES when it
 * is written, including the schema of that moment; a later schema change adds at most this much to it, so
 * OBJECT_BUDGET_BYTES + SCHEMA_PAGE_BUDGET_BYTES stays under one list item (MAX_RESPONSE_BYTES - 4096).
 */
export const SCHEMA_PAGE_BUDGET_BYTES = 150_000;
/** Block content (rich text, captions, urls) one create or append request may add. */
export const REQUEST_CONTENT_BYTES = 900_000;

/** UTF-8 length of a string computed from its code points (1, 2, 3 or 4 bytes each). */
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

/** Encoded bytes of a value as it is sent: JSON text (escapes included) measured in UTF-8. */
export function jsonBytes(value) {
  const text = JSON.stringify(value);
  return typeof text === "string" ? utf8Length(text) : 0;
}
