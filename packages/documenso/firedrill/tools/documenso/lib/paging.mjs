// Page-number pagination as the provider returns it, with a UTF-8 byte budget on the encoded response.
import { bad, limitExceeded } from "./errors.mjs";
import { jsonBytes, toInt } from "./util.mjs";

export const RESPONSE_BYTE_BUDGET = 900_000;

/** The response budget: 900 KB, or less when `meta/limits.responseBytes` lowers it. */
export function responseBudget(context) {
  const n = context.state.get("meta", "limits")?.responseBytes;
  return Number.isSafeInteger(n) && n >= 1000 && n < RESPONSE_BYTE_BUDGET ? n : RESPONSE_BYTE_BUDGET;
}

export function pageArgs(context, input) {
  const page = input.page === undefined ? 1 : toInt(input.page, 1, 1_000_000_000);
  if (page === null) bad(context, "page must be a positive integer");
  const perPage = input.perPage === undefined ? 10 : toInt(input.perPage, 1, 100);
  if (perPage === null) bad(context, "perPage must be an integer between 1 and 100");
  if (input.orderByColumn !== undefined && input.orderByColumn !== "createdAt") bad(context, "orderByColumn must be createdAt");
  const direction = input.orderByDirection ?? "desc";
  if (direction !== "asc" && direction !== "desc") bad(context, "orderByDirection must be asc or desc");
  return { page, perPage, direction };
}

/** Renders one page of `items`; a body over the byte budget fails LIMIT_EXCEEDED instead of silently shortening the page. */
export function pageOf(context, items, { page, perPage }, render) {
  const start = (page - 1) * perPage;
  const slice = start >= items.length ? [] : items.slice(start, start + perPage);
  const body = { data: slice.map(render), count: items.length, currentPage: page, perPage, totalPages: Math.ceil(items.length / perPage) };
  if (jsonBytes(body) > responseBudget(context)) limitExceeded(context, "Response too large, request a smaller perPage");
  return body;
}

export function queryText(context, value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 255) bad(context, "query must be at most 255 characters");
  if (value.includes("�")) bad(context, "Invalid query");
  return value.trim().toLowerCase();
}

export function unsupportedParams(context, input, names) {
  for (const name of names) if (input !== null && typeof input === "object" && input[name] !== undefined) bad(context, `${name} is not supported by this simulation`);
}
