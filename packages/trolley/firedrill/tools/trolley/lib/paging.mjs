// Trolley page-number paging: `page` (≥ 1), `pageSize` (1–1000, default 10), `meta { page, pages, records }`.
import { jsonBytes } from "./store.mjs";
import { checkEnum, checkText, hasOwn, invalid } from "./validate.mjs";

const BYTE_BUDGET = 900000;

export function pageArgs(context, input) {
  const page = hasOwn(input, "page") ? input.page : 1;
  const pageSize = hasOwn(input, "pageSize") ? input.pageSize : 10;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) invalid(context, "page", "Value must be a positive integer");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) invalid(context, "pageSize", "Value must be between 1 and 1000");
  return { page, pageSize };
}

/** Optional filter string: checked for invalid characters and length. */
export function filterText(context, input, key, max = 200) {
  if (!hasOwn(input, key)) return undefined;
  return checkText(context, input[key], key, max);
}

/** Comma list filter (`country=CA,GB`), trimmed, empty entries dropped. */
export function filterList(context, input, key) {
  const text = filterText(context, input, key, 1000);
  if (text === undefined) return undefined;
  const values = text.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (values.length === 0) invalid(context, key);
  return values;
}

export function sortArgs(context, input, allowed, fallback) {
  const orderBy = hasOwn(input, "orderBy") ? checkEnum(context, input.orderBy, allowed, "orderBy") : fallback;
  const sortBy = hasOwn(input, "sortBy") ? checkEnum(context, input.sortBy, ["asc", "desc"], "sortBy") : "desc";
  return { orderBy, sortBy };
}

function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "bigint" || typeof a === "number") return a < b ? -1 : 1;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  if (x === y) return String(a) < String(b) ? -1 : 1;
  return x < y ? -1 : 1;
}

/** Sorts in place by `key(item)`; nulls last in both directions; ties broken by id ascending. */
export function sortItems(items, key, direction) {
  return items.sort((left, right) => {
    const primary = compareValues(key(left), key(right));
    if (primary !== 0) return direction === "asc" ? primary : -primary;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** One page of `items` as `{ [listKey]: mapped, meta }`, refusing bodies over the byte budget. */
export function pageOf(context, items, { page, pageSize }, listKey, map = (item) => item) {
  const records = items.length;
  const pages = Math.max(1, Math.ceil(records / pageSize));
  const start = (page - 1) * pageSize;
  const slice = start >= records ? [] : items.slice(start, start + pageSize).map(map);
  const body = { ok: true, [listKey]: slice, meta: { page, pages, records } };
  if (jsonBytes(body) > BYTE_BUDGET) invalid(context, "pageSize", "Response too large, reduce pageSize");
  return body;
}
