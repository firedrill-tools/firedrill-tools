// Response byte budget. The framework refuses any HTTP route response larger than 1 MiB (answering an opaque 500
// after the operation committed), so list pages are filled by the encoded UTF-8 size of the objects actually
// returned, and a single object that cannot fit answers Stripe's own `invalid_request_error` instead.
// Sizes are UTF-8 bytes of `JSON.stringify` output, computed from code points (no Buffer in behavior modules).

import { invalid } from "./state.mjs";

/** Largest encoded single object (with its expansions) this Tool returns, alone or as one list item. */
export const OBJECT_BYTE_BUDGET = 900_000;
/**
 * Bytes of list items (objects plus separators) one page may carry. At least `OBJECT_BYTE_BUDGET`, so every object
 * that can be retrieved alone can also be listed; the list envelope, headers and a route's `url` rewrite fit in the
 * remaining space below the framework's 1 MiB response cap.
 */
export const PAGE_BYTE_BUDGET = 950_000;

/** UTF-8 byte length of a string: 1-3 bytes per BMP code unit, 4 per surrogate pair, 3 for a lone surrogate. */
export function utf8Bytes(text) {
  let bytes = 0;
  const length = text.length;
  for (let index = 0; index < length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Encoded JSON size of a value, in UTF-8 bytes. */
export function jsonBytes(value) {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : utf8Bytes(text);
}

/** Fail with `invalid_request_error` naming `what` ("The invoice in_…", "This object") and its encoded size. */
export function tooLargeObject(context, what, bytes) {
  return invalid(
    context,
    `${what} is too large to return in one response (${bytes} bytes; the limit is ${OBJECT_BYTE_BUDGET} bytes). Reduce its metadata or text fields, or request fewer expansions.`,
    "parameter_invalid",
  );
}

/** Return `value` when its encoded body fits the object budget, otherwise fail with the declared error. */
export function requireFits(context, value, what) {
  const bytes = jsonBytes(value);
  return bytes > OBJECT_BYTE_BUDGET ? tooLargeObject(context, what, bytes) : value;
}
