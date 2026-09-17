// Response and text size budgets. The framework refuses an HTTP response body above 1 MiB, so every
// page is filled by the UTF-8 bytes of the JSON actually returned, and text fields are capped on
// write with Jira's own limit. Pure functions only (no Buffer/TextEncoder dependency).

/** Encoded response body budget in bytes, kept well under the framework's 1 MiB cap. */
export const RESPONSE_BUDGET = 900_000;

/** Jira Cloud's limit for multi-line text fields (description, comment body). */
export const TEXT_LIMIT = 32_767;

export const TEXT_TOO_LONG = "The entered text is too long. It exceeds the allowed limit of 32,767 characters.";

/** UTF-8 byte length of a string, computed from its code points. */
export function utf8Length(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00 && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** UTF-8 bytes of `value` serialized as JSON (what the route encoder sends). */
export function jsonBytes(value) {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : utf8Length(text);
}

/**
 * Stored size of a text field in characters, as Jira counts it: the text itself for a plain string,
 * the serialized document for Atlassian Document Format.
 */
export function textFieldLength(raw, doc) {
  return typeof raw === "string" ? raw.length : JSON.stringify(doc).length;
}

/**
 * Renders `items` in order into an array whose JSON, inside an envelope of `envelopeBytes`, stays
 * within `budget`. Stops at the first item that does not fit. Returns `{ values, bytes }`; `values`
 * is empty when the first item alone is too large (the caller answers a declared error).
 */
export function fillByBytes(items, render, envelopeBytes, budget = RESPONSE_BUDGET) {
  const values = [];
  let bytes = envelopeBytes;
  for (const item of items) {
    const value = render(item);
    const size = jsonBytes(value) + (values.length === 0 ? 0 : 1);
    if (bytes + size > budget) break;
    values.push(value);
    bytes += size;
  }
  return { values, bytes };
}
