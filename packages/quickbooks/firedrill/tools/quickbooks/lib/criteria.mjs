// MCP search criteria → query AST. Accepted forms: a simple object of equalities, an array of
// { field, value, operator? } (or legacy { key, value }), or { filters | criteria: [...], asc, desc, limit, offset,
// count, fetchAll }. Option names inside the array form are options, not conditions. Values never become query text.
import { dayNumber } from "./common.mjs";
import { isObject, own } from "./fields.mjs";

const OPTIONS = new Set(["limit", "offset", "asc", "desc", "count", "fetchAll"]);
const OPERATORS = new Map([["=", "="], ["<", "<"], [">", ">"], ["<=", "<="], [">=", ">="], ["like", "like"], ["in", "in"]]);

function bad(s, detail) {
  return s.fail("QUERY_VALIDATION_ERROR", `QueryValidationError: ${detail}`, "criteria");
}

function literal(s, field, value) {
  if (typeof value === "string") return { kind: "string", value };
  if (typeof value === "number" && Number.isFinite(value)) return { kind: "number", value: String(value) };
  if (typeof value === "boolean") return { kind: "bool", value };
  return bad(s, `value for '${String(field).slice(0, 64)}' must be a string, number or boolean`);
}

function condition(s, field, value, operator) {
  if (typeof field !== "string" || field.length === 0 || field.length > 64) return bad(s, "each criterion needs a field name");
  const op = operator === undefined || operator === null ? (Array.isArray(value) ? "in" : "=") : typeof operator === "string" ? OPERATORS.get(operator.toLowerCase()) : undefined;
  if (op === undefined) return bad(s, `operator ${JSON.stringify(String(operator)).slice(0, 40)} is not supported`);
  if (op === "in") {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) return bad(s, `IN for '${field}' needs 1 to 100 values`);
    return { prop: field, op, values: value.map((item) => literal(s, field, item)) };
  }
  return { prop: field, op, values: [literal(s, field, value)] };
}

function applyOption(s, options, name, value) {
  if (name === "limit") {
    if (!Number.isInteger(value) || value < 1 || value > 1000) bad(s, "limit must be an integer between 1 and 1000");
    options.limit = value;
  } else if (name === "offset") {
    if (!Number.isInteger(value) || value < 0 || value > 1_000_000) bad(s, "offset must be a non-negative integer");
    options.offset = value;
  } else if (name === "asc" || name === "desc") {
    if (typeof value !== "string" || value.length === 0 || value.length > 64) bad(s, `${name} must name a sortable property`);
    options.order.push({ prop: value, dir: name });
    if (options.order.length > 3) bad(s, "at most 3 sort keys are supported");
  } else {
    if (typeof value !== "boolean") bad(s, `${name} must be true or false`);
    options[name] = value;
  }
}

function fromArray(s, entries, options, where) {
  if (entries.length > 50) bad(s, "at most 50 criteria entries are supported");
  for (const entry of entries) {
    if (!isObject(entry)) bad(s, "each criterion must be an object");
    const field = own(entry, "field") ?? own(entry, "key");
    const value = own(entry, "value");
    if (typeof field === "string" && OPTIONS.has(field)) applyOption(s, options, field, value);
    else where.push(condition(s, field, value, own(entry, "operator")));
  }
}

/** Compile criteria plus optional top-level options (search_customers) into { ast, all, count }. */
export function compileCriteria(s, entity, criteria, topLevel = {}) {
  const options = { limit: undefined, offset: undefined, order: [], count: false, fetchAll: false };
  const where = [];
  if (Array.isArray(criteria)) fromArray(s, criteria, options, where);
  else if (isObject(criteria)) {
    const list = own(criteria, "filters") ?? own(criteria, "criteria");
    if (Array.isArray(list)) {
      fromArray(s, list, options, where);
      for (const name of OPTIONS) if (own(criteria, name) !== undefined) applyOption(s, options, name, criteria[name]);
    } else {
      const keys = Object.keys(criteria);
      if (keys.length > 50) bad(s, "at most 50 criteria entries are supported");
      for (const key of keys) {
        if (key === "filters" || key === "criteria") bad(s, `${key} must be an array`);
        if (OPTIONS.has(key)) applyOption(s, options, key, criteria[key]);
        else where.push(condition(s, key, criteria[key], undefined));
      }
    }
  } else if (criteria !== undefined && criteria !== null) bad(s, "criteria must be an object or an array");
  for (const name of OPTIONS) if (topLevel[name] !== undefined) applyOption(s, options, name, topLevel[name]);
  if (where.length > 20) bad(s, "at most 20 conditions are supported");
  const ast = {
    entity,
    select: { kind: options.count ? "count" : "all" },
    where,
    order: options.order,
    start: (options.offset ?? 0) + 1,
    max: options.limit ?? 100,
  };
  return { ast, all: options.fetchAll, count: options.count };
}

/** search_payments { customer_ref, txn_date_from, txn_date_to, limit } → AST (dates inclusive). */
export function paymentSearchAst(s, input) {
  const where = [];
  if (input.customer_ref !== undefined) where.push({ prop: "CustomerRef", op: "=", values: [{ kind: "string", value: input.customer_ref }] });
  const from = input.txn_date_from === undefined ? null : dayNumber(input.txn_date_from);
  const to = input.txn_date_to === undefined ? null : dayNumber(input.txn_date_to);
  if (input.txn_date_from !== undefined && from === null) bad(s, "txn_date_from must be a valid YYYY-MM-DD date");
  if (input.txn_date_to !== undefined && to === null) bad(s, "txn_date_to must be a valid YYYY-MM-DD date");
  if (from !== null && to !== null && from > to) bad(s, "txn_date_from is after txn_date_to");
  if (from !== null) where.push({ prop: "TxnDate", op: ">=", values: [{ kind: "string", value: input.txn_date_from }] });
  if (to !== null) where.push({ prop: "TxnDate", op: "<=", values: [{ kind: "string", value: input.txn_date_to }] });
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) bad(s, "limit must be an integer between 1 and 1000");
  return { entity: "Payment", select: { kind: "all" }, where, order: [{ prop: "TxnDate", dir: "desc" }], start: 1, max: limit };
}
