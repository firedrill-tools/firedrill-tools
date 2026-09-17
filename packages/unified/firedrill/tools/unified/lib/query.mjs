// List parameters shared by every list operation: limit/offset paging, updated_gte, sort/order, query search,
// reference filters, `fields` projection and the encoded-page byte budget.
import { PAGE_BYTE_BUDGET, badRequest, tooLarge } from "./errors.mjs";
import { parseIsoUs } from "./time.mjs";
import { clip, compareText, containsFolded, fold, isHex24, jsonBytes } from "./util.mjs";

export const MAX_LIMIT = 100;
const SORTS = new Set(["name", "updated_at", "created_at"]);
const ORDERS = new Set(["asc", "desc"]);
const MAX_QUERY_LENGTH = 2000;
const MAX_FIELDS = 64;

const isInt = (value) => typeof value === "number" && Number.isInteger(value);

/** Parses the shared list parameters; every problem is BAD_REQUEST with the provider's wording. */
export function parseListParams(input, context) {
  let limit = MAX_LIMIT;
  if (input.limit !== undefined && input.limit !== null) {
    if (!isInt(input.limit) || input.limit < 1) badRequest(context, "limit must be a positive integer");
    limit = Math.min(input.limit, MAX_LIMIT);
  }
  let offset = 0;
  if (input.offset !== undefined && input.offset !== null) {
    if (!isInt(input.offset) || input.offset < 0 || input.offset > Number.MAX_SAFE_INTEGER) badRequest(context, "offset must be a non-negative integer");
    offset = input.offset;
  }
  let updatedGteUs = null;
  if (input.updated_gte !== undefined && input.updated_gte !== null) {
    updatedGteUs = parseIsoUs(input.updated_gte);
    if (updatedGteUs === null) badRequest(context, "updated_gte must be an ISO-8601 date or date-time");
  }
  let sort = null;
  if (input.sort !== undefined && input.sort !== null) {
    if (typeof input.sort !== "string" || !SORTS.has(input.sort)) badRequest(context, "sort must be one of name, updated_at, created_at");
    sort = input.sort;
  }
  let order = "asc";
  if (input.order !== undefined && input.order !== null) {
    if (typeof input.order !== "string" || !ORDERS.has(input.order)) badRequest(context, "order must be asc or desc");
    order = input.order;
  }
  let query = null;
  if (input.query !== undefined && input.query !== null) {
    if (typeof input.query !== "string" || input.query.length > MAX_QUERY_LENGTH) badRequest(context, `query must be a string of at most ${MAX_QUERY_LENGTH} characters`);
    if (input.query.includes("�")) badRequest(context, "query contains malformed percent-encoding");
    query = fold(input.query);
  }
  return { limit, offset, updatedGteUs, sort, order, query };
}

/** A reference filter (`company_id`, `channel_id`, ...) must be a well-formed id; an unknown id matches nothing. */
export function idFilter(input, context, name, extra = null) {
  const value = input[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || (!isHex24(value) && !(extra !== null && extra.has(value)))) {
    badRequest(context, `${name} must be a valid id`);
  }
  return value;
}

/** A plain string filter (`user_id`, `external_xref`). */
export function textFilter(input, context, name, max = 256) {
  const value = input[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > max) badRequest(context, `${name} must be a string of at most ${max} characters`);
  return value;
}

export function enumFilter(input, context, name, allowed) {
  const value = input[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !allowed.includes(value)) badRequest(context, `${name} must be one of ${allowed.join(", ")}`);
  return value;
}

/** True when any of the row's searchable strings contains the folded query. */
export function matchesQuery(row, query, fields) {
  if (query === null) return true;
  for (const field of fields) {
    const value = row[field];
    if (typeof value === "string") {
      if (containsFolded(value, query)) return true;
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        const text = typeof entry === "string" ? entry : entry?.email;
        if (typeof text === "string" && containsFolded(text, query)) return true;
      }
    } else if (value !== null && typeof value === "object") {
      for (const inner of Object.values(value)) if (containsFolded(inner, query)) return true;
    }
  }
  return false;
}

export const updatedSince = (row, updatedGteUs) => updatedGteUs === null || (parseIsoUs(row.updated_at) ?? 0) >= updatedGteUs;

/** Sorts in place by the requested field (ties by id); no sort keeps creation (row-id) order. */
export function sortRows(rows, sort, order, nameField = "name") {
  if (sort === null) {
    if (order === "desc") rows.reverse();
    return rows;
  }
  const field = sort === "name" ? nameField : sort;
  const sign = order === "desc" ? -1 : 1;
  rows.sort((a, b) => {
    const left = a[field] ?? "";
    const right = b[field] ?? "";
    const cmp = compareText(String(left), String(right));
    return cmp !== 0 ? sign * cmp : compareText(a.id, b.id);
  });
  return rows;
}

/** Parses `fields` (comma-separated or an array) into a Set, or null for the default projection. */
export function parseFields(input, context) {
  const raw = input.fields;
  if (raw === undefined || raw === null) return null;
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (parts === null) badRequest(context, "fields must be a comma-separated list of field names");
  const set = new Set();
  for (const part of parts) {
    if (typeof part !== "string") badRequest(context, "fields must be a comma-separated list of field names");
    for (const name of part.split(",")) {
      const trimmed = name.trim();
      if (trimmed.length > 0 && trimmed.length <= 200) set.add(trimmed);
      if (set.size > MAX_FIELDS) badRequest(context, `fields lists more than ${MAX_FIELDS} names`);
    }
  }
  set.add("id");
  return set;
}

/** Applies the projection: default is every field except `raw`; `id` is always present; unknown names are ignored. */
export function project(row, fields, hidden = []) {
  const out = {};
  for (const key of Object.keys(row)) {
    if (key === "connection_id" || hidden.includes(key)) continue;
    if (fields === null ? key !== "raw" : fields.has(key)) out[key] = row[key];
  }
  return out;
}

/** Slices the page and refuses one whose encoding would exceed the byte budget (offset paging cannot shorten it). */
export function finishPage(context, rows, params, fields, hidden = []) {
  const page = rows.slice(params.offset, params.offset + params.limit).map((row) => project(row, fields, hidden));
  let bytes = 2;
  for (const item of page) {
    bytes += jsonBytes(item) + 1;
    if (bytes > PAGE_BYTE_BUDGET) tooLarge(context);
  }
  return page;
}

export const describe = (value) => clip(typeof value === "string" ? value : JSON.stringify(value), 80);
