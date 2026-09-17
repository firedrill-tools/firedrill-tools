// Offset paging (`start`/`count`) with Rest.li links and a UTF-8 byte budget per page.
import { fail, invalidValue } from "./errors.mjs";
import { jsonBytes } from "./text.mjs";

export const PAGE_BYTE_BUDGET = 900000;

export function pageArgs(context, input, { defaultCount = 10, maxCount = 100 } = {}) {
  const start = input.start ?? 0;
  const count = input.count ?? defaultCount;
  if (!Number.isInteger(start) || start < 0 || start > 1000000) invalidValue(context, "start", start);
  if (!Number.isInteger(count) || count < 1 || count > maxCount) invalidValue(context, "count", count);
  return { start, count };
}

function encode(value) {
  try {
    return encodeURIComponent(value);
  } catch {
    return "";
  }
}

/** Query string from ordered [name, value] pairs (values null/undefined skipped). */
export function queryString(pairs) {
  return pairs.filter(([, value]) => value !== null && value !== undefined).map(([name, value]) => `${name}=${encode(String(value))}`).join("&");
}

/**
 * Builds `{ paging, elements }` from the full ordered `items`, rendering with `render` from `start` while the page has room
 * in `count` and in the byte budget. A byte-limited page ends early with a `next` link at the first omitted item.
 */
export function buildPage(context, items, render, { start, count, path, query = [], withTotal = true }) {
  const elements = [];
  let bytes = 200;
  for (let i = start; i < items.length && elements.length < count; i += 1) {
    const element = render(items[i]);
    const size = jsonBytes(element) + 1;
    if (bytes + size > PAGE_BYTE_BUDGET) {
      if (elements.length === 0) fail(context, "INTERNAL_SERVER_ERROR", "a single element exceeds the response size budget");
      break;
    }
    bytes += size;
    elements.push(element);
  }
  const links = [];
  const next = start + elements.length;
  if (start > 0) {
    links.push({ rel: "prev", href: `${path}?${queryString([...query, ["start", Math.max(0, start - count)], ["count", count]])}`, type: "application/json" });
  }
  if (next < items.length) {
    links.push({ rel: "next", href: `${path}?${queryString([...query, ["start", next], ["count", count]])}`, type: "application/json" });
  }
  return { paging: { start, count, links, ...(withTotal ? { total: items.length } : {}) }, elements };
}
