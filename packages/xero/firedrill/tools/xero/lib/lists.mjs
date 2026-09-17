// Shared list pipeline: where → search → order → optional page, sized by count and UTF-8 bytes.
import { parseInstant } from "./dates.mjs";
import { fold, jsonBytes } from "./util.mjs";
import { compileWhere, parseOrder, sortRecords } from "./where-eval.mjs";

export const MAX_RESPONSE_BYTES = 900 * 1024;

/** Validate paging arguments (only for operations that declare VALIDATION_EXCEPTION). */
export function pagingOf(s, input) {
  let page = null;
  let pageSize = 100;
  if (input.page !== undefined) {
    if (!Number.isInteger(input.page) || input.page < 1 || input.page > 1000000) s.validation("page must be a positive integer");
    page = input.page;
  }
  if (input.pageSize !== undefined) {
    if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1000) s.validation("pageSize must be an integer between 1 and 1000");
    pageSize = input.pageSize;
  }
  return { page, pageSize };
}

/** If-Modified-Since → epoch ms or null (declared VALIDATION_EXCEPTION when malformed). */
export function modifiedSinceOf(s, input) {
  if (input.ifModifiedSince === undefined) return null;
  const ms = parseInstant(input.ifModifiedSince);
  if (ms === null) s.validation("If-Modified-Since must be an RFC 1123 or ISO-8601 date-time");
  return ms;
}

/** Case-insensitive contains over the listed record fields. */
export function searchFilter(term, fieldsToSearch) {
  const needle = fold(term);
  return (record) => fieldsToSearch.some((field) => typeof record.get(field) === "string" && fold(record.get(field)).includes(needle));
}

/**
 * items: [{ row, record }] where record is a filter Map. options: { fields, where, order, defaultOrder, idField,
 * filters: [predicate(record)], page, pageSize, render(row) }. Returns { rendered, pagination? }.
 */
export function runList(s, items, options) {
  const predicates = [...(options.filters ?? [])];
  if (options.where !== undefined && options.where.trim().length > 0) predicates.push(compileWhere(options.where, options.fields, s.parse));
  else if (options.where !== undefined && options.where.includes("�")) s.parse("where expression contains an invalid character (malformed encoding)");
  const keys = options.order !== undefined && options.order.trim().length > 0 ? parseOrder(options.order, options.fields, s.parse) : options.defaultOrder;
  const matched = items.filter((item) => predicates.every((predicate) => predicate(item.record)));
  const byRecord = new Map(matched.map((item) => [item.record, item.row]));
  const ordered = sortRecords(matched.map((item) => item.record), keys, options.idField).map((record) => byRecord.get(record));
  let slice = ordered;
  let pagination;
  if (options.page !== null && options.page !== undefined) {
    const start = (options.page - 1) * options.pageSize;
    slice = start >= ordered.length ? [] : ordered.slice(start, start + options.pageSize);
    pagination = { page: options.page, pageSize: options.pageSize, pageCount: Math.ceil(ordered.length / options.pageSize), itemCount: ordered.length };
  }
  const rendered = [];
  let bytes = 256;
  for (const row of slice) {
    const value = options.render(row);
    bytes += jsonBytes(value) + 1;
    if (bytes > MAX_RESPONSE_BYTES) s.bound("Response too large; lower pageSize or narrow the where filter.");
    rendered.push(value);
  }
  return pagination === undefined ? { rendered } : { rendered, pagination };
}
