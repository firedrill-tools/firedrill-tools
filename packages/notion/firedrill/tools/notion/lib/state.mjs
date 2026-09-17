// Failure helpers with Notion's wording, bounded scans and virtual-time formatting. No module state.

import { jsonBytes, MAX_RESPONSE_BYTES, OBJECT_BUDGET_BYTES, PAGE_BUDGET_BYTES } from "./size.mjs";

export const SCAN_STEP = 500;
const DEFAULT_LIMITS = Object.freeze({
  max_rows_per_namespace: 10000,
  max_page_size: 100,
  max_children_per_append: 100,
  max_markdown_bytes: 102400,
});

// The framework's outcome contract caps an error message at 1000 characters; messages echo caller input (ids, property
// keys), so a long value would otherwise make the whole response unmappable (HTTP 500).
const MAX_MESSAGE = 1000;

function capMessage(message) {
  if (message.length <= MAX_MESSAGE) return message;
  let end = MAX_MESSAGE - 1;
  const unit = message.charCodeAt(end - 1);
  if (unit >= 0xd800 && unit <= 0xdbff) end -= 1;
  return `${message.slice(0, end)}…`;
}

export function fail(context, code, message, details) {
  const text = capMessage(message);
  return context.fail(details === undefined ? { code, message: text } : { code, message: text, details });
}

/** A caller value as Notion prints it in validation messages: strings verbatim, everything else as JSON. */
export function shown(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") return String(typeof value);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return String(typeof value);
  }
}

export function validationError(context, message) {
  return fail(context, "VALIDATION_ERROR", message);
}

export function restricted(context, message) {
  return fail(context, "RESTRICTED_RESOURCE", message);
}

const SHARE_HINT = "Make sure the relevant pages and databases are shared with your integration.";

export function notFound(context, kind, id) {
  const label = kind === "data-source" ? "data source" : kind;
  const suffix = kind === "user" ? "" : ` ${SHARE_HINT}`;
  return fail(context, "OBJECT_NOT_FOUND", `Could not find ${label} with ID: ${id}.${suffix}`);
}

export function limits(context) {
  const stored = context.state.get("meta", "limits");
  return stored === null ? { ...DEFAULT_LIMITS } : { ...DEFAULT_LIMITS, ...stored };
}

/** Every row of a namespace in row-id order; fails FAILED_PRECONDITION instead of truncating at the bound. */
export function allRows(context, namespace) {
  const bound = limits(context).max_rows_per_namespace;
  const rows = [];
  let after;
  for (;;) {
    const batch = context.state.scan(namespace, { ...(after === undefined ? {} : { afterRowId: after }), limit: SCAN_STEP });
    if (batch.length === 0) return rows;
    for (const record of batch) {
      after = record.rowId;
      rows.push(record.value);
      if (rows.length > bound) {
        return fail(context, "FAILED_PRECONDITION", `state exceeds the supported bound of ${bound} rows in ${namespace}`);
      }
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

export function isoFromUs(us) {
  return new Date(Math.floor(us / 1000)).toISOString();
}

export function isoNow(context) {
  return isoFromUs(context.clock.nowUs());
}

/**
 * Validate `page_size` (1..max, default max). Provider-shaped query routes pass a query value that is not a plain
 * decimal integer through as the raw string, so it fails here with Notion's validation_error instead of a mapping
 * error. `field` names the parameter the way the caller sent it (`query.page_size` on GET routes,
 * `body.page_size` on POST routes), so the message points at the input the caller actually wrote.
 */
export function pageSize(context, input, field = "query.page_size") {
  const max = limits(context).max_page_size;
  const value = input.page_size;
  const section = field.split(".")[0];
  const printed = typeof value === "string" ? JSON.stringify(value) : shown(value);
  if (value === undefined) return max;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return validationError(context, `${section} failed validation: ${field} should be a number, instead was \`${printed}\`.`);
  }
  if (!Number.isInteger(value)) {
    return validationError(context, `${section} failed validation: ${field} should be an integer, instead was ${value}.`);
  }
  if (value < 1) {
    return validationError(context, `${section} failed validation: ${field} should be \u2265 1, instead was ${value}.`);
  }
  if (value > max) {
    return validationError(context, `${section} failed validation: ${field} should be \u2264 ${max}, instead was ${value}.`);
  }
  return value;
}

/**
 * True when a caller string carries U+FFFD. The framework decodes query strings and form bodies leniently, so
 * malformed percent-encoding arrives as the replacement character; in a query-language input that means the
 * request was mangled in transit, never a literal the caller meant to match.
 */
export function isMangled(value) {
  return typeof value === "string" && value.includes("\uFFFD");
}

/** Notion-shaped validation_error for a query-language input that arrived mangled. */
export function mangledError(context, field) {
  const section = field.split(".")[0];
  return validationError(context, `${section} failed validation: ${field} contains an invalid character (U+FFFD); check the request's percent-encoding.`);
}

/**
 * Slice an ordered list the way Notion paginates (cursor = id of the last returned item). A page ends at
 * `page_size` items or once the encoded results would pass PAGE_BUDGET_BYTES, whichever comes first, so
 * `next_cursor` always names the last item returned and the next page starts exactly at the first item omitted.
 * `render` produces the returned shape; each item is measured as it is rendered, never an internal summary.
 */
export function paginate(context, items, input, itemId = (item) => item.id, render = (item) => item, field = "query.page_size") {
  const size = pageSize(context, input, field);
  let start = 0;
  if (input.start_cursor !== undefined) {
    const index = items.findIndex((item) => itemId(item) === input.start_cursor);
    if (index < 0) return validationError(context, "The start_cursor provided is invalid.");
    start = index + 1;
  }
  const results = [];
  let bytes = 0;
  let index = start;
  while (index < items.length && results.length < size) {
    const rendered = render(items[index]);
    const itemBytes = jsonBytes(rendered) + 1;
    if (results.length > 0 && bytes + itemBytes > PAGE_BUDGET_BYTES) break;
    if (itemBytes > MAX_RESPONSE_BYTES - 4096) tooLarge(context, itemBytes, "one result of this list");
    results.push(rendered);
    bytes += itemBytes;
    index += 1;
  }
  const hasMore = index < items.length;
  return { page: items.slice(start, index), results, next_cursor: hasMore && results.length > 0 ? itemId(items[index - 1]) : null, has_more: hasMore };
}

/** Notion's validation_error for a read whose encoded response would pass the response bound. */
export function tooLarge(context, bytes, what) {
  return validationError(context, `The response is too large: ${what} would be ${bytes} bytes, and one response may be at most ${MAX_RESPONSE_BYTES} bytes.`);
}

/** Return `value` when its encoded form fits one response; otherwise answer validation_error. */
export function sized(context, value, what) {
  const bytes = jsonBytes(value);
  return bytes > MAX_RESPONSE_BYTES ? tooLarge(context, bytes, what) : value;
}

/** Write-time bound: a stored object whose rendered form would pass OBJECT_BUDGET_BYTES is refused. */
export function withinBudget(context, rendered, what, budget = OBJECT_BUDGET_BYTES) {
  const bytes = jsonBytes(rendered);
  if (bytes > budget) return validationError(context, `body failed validation: ${what} would be ${bytes} bytes once rendered; the limit is ${budget} bytes.`);
  return rendered;
}

export function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function slug(text) {
  const cleaned = text
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned.replace(/-+$/g, "");
}
