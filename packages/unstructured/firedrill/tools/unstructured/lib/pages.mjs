// Response size budgeting: every route response must stay under the framework's 1 MiB cap, measured in UTF-8 bytes.
// The budget is `meta/limits.response_bytes` (default 900 KB). A response that would pass it fails RESPONSE_TOO_LARGE
// (413) — a page is never shortened silently.
import { fail } from "./errors.mjs";
import { limits } from "./ids.mjs";
import { utf8Length } from "./util.mjs";

/** UTF-8 size of the JSON encoding of a value. */
export const jsonBytes = (value) => utf8Length(JSON.stringify(value));

/** The response byte budget of this world (`meta/limits.response_bytes`). */
export const responseBudget = (context) => limits(context).response_bytes;

/**
 * Fails RESPONSE_TOO_LARGE when `bytes` passes the budget. `what` names the payload ("Partition output"); `hint` tells the
 * caller how to shrink it.
 */
export function assertWithinBudget(context, bytes, what, hint) {
  const budget = responseBudget(context);
  if (bytes > budget) fail(context, "RESPONSE_TOO_LARGE", `${what} of ${bytes} bytes exceeds the ${budget} byte response limit${hint ? `; ${hint}` : ""}`);
}

/** Fails RESPONSE_TOO_LARGE when the JSON encoding of `value` passes the budget; otherwise returns `value`. */
export function withinBudget(context, value, what, hint) {
  assertWithinBudget(context, jsonBytes(value), what, hint);
  return value;
}

/**
 * The page-numbered slice of `rows` (already sorted): rows [start, start + count). Every requested row is returned or
 * the call fails RESPONSE_TOO_LARGE telling the caller to lower `page_size` — a page never stops early at the budget,
 * because the next page would start at (page - 1) * page_size and the rows in between would be unreachable.
 */
export function pageOf(context, rows, start, count) {
  const items = rows.slice(start, start + count);
  let bytes = 2;
  for (const item of items) bytes += jsonBytes(item) + 1;
  assertWithinBudget(context, bytes, `A page of ${items.length} rows`, items.length > 1 ? "lower page_size" : "the row itself exceeds the budget");
  return items;
}
