// Declared-error helpers, bounded scans, virtual-time seconds, permissions and list pagination. Every function
// is pure or reads `context`; nothing keeps module-level state.
import { OBJECT_BYTE_BUDGET, PAGE_BYTE_BUDGET, jsonBytes, tooLargeObject } from "./size.mjs";


export const SCAN_STEP = 500;
export const SCAN_CAP = 10_000;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 10;

const OBJECT_NAMES = {
  customers: "customer",
  payment_methods: "PaymentMethod",
  payment_intents: "PaymentIntent",
  charges: "charge",
  refunds: "refund",
  products: "product",
  prices: "price",
  invoice_items: "invoiceitem",
  invoices: "invoice",
  subscriptions: "subscription",
  subscription_items: "subscription_item",
};

// ---------------------------------------------------------------------------------------------
// Declared errors
// ---------------------------------------------------------------------------------------------

export function fail(context, code, message, details) {
  return context.fail(details === undefined ? { code, message } : { code, message, details });
}

/** 400 `invalid_request_error` for a parameter problem; `stripeCode` is Stripe's `error.code`. */
export function invalid(context, message, stripeCode = "parameter_invalid", param) {
  return fail(context, "INVALID_REQUEST", message, { code: stripeCode, ...(param === undefined ? {} : { param }) });
}

export function parameterMissing(context, param) {
  return invalid(context, `Missing required param: ${param}.`, "parameter_missing", param);
}

export function parameterUnknown(context, param) {
  return invalid(context, `Received unknown parameter: ${param}`, "parameter_unknown", param);
}

export function invalidInteger(context, param, value) {
  return invalid(context, `Invalid integer: ${String(value)}`, "parameter_invalid_integer", param);
}

export function invalidEmpty(context, param) {
  return invalid(context, `You passed an empty string for '${param}'. We assume empty values are an attempt to unset a parameter; however '${param}' cannot be unset. You should remove '${param}' from your request or supply a non-empty value.`, "parameter_invalid_empty", param);
}

/** 404 `resource_missing`: `No such customer: 'cus_x'`. */
export function resourceMissing(context, namespace, id, param) {
  const name = OBJECT_NAMES[namespace] ?? namespace;
  return fail(context, "RESOURCE_MISSING", `No such ${name}: '${String(id)}'`, { code: "resource_missing", param: param ?? (name === "PaymentMethod" ? "payment_method" : name === "PaymentIntent" ? "payment_intent" : name) });
}

/** 400 `invalid_request_error` for a status-machine violation. */
export function invalidState(context, message, stripeCode) {
  return fail(context, "INVALID_STATE", message, stripeCode === undefined ? {} : { code: stripeCode });
}

export function tooLarge(context, namespace) {
  return invalid(context, `This synthetic account holds more than ${SCAN_CAP} ${namespace} rows; the Tool refuses to answer with a truncated list.`, "state_bound_exceeded");
}

// ---------------------------------------------------------------------------------------------
// Permissions and mode (actor attributes)
// ---------------------------------------------------------------------------------------------

export const PERMISSION_GROUPS = Object.freeze(["balance", "customers", "payment_methods", "payment_intents", "charges", "refunds", "products", "invoices", "subscriptions"]);
const LEVELS = { none: 0, read: 1, write: 2 };

export function permissionLevel(context, group) {
  const permissions = context.actor.attributes?.permissions;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) return "write";
  const level = permissions[group];
  return level === "read" || level === "write" ? level : "none";
}

function accountId(context) {
  const account = context.state.get("meta", "account");
  return account !== null && typeof account.id === "string" ? account.id : "acct_synthetic";
}

/** Fail `PERMISSION_DENIED` unless the actor's restricted-key permissions cover `group: level`. */
export function requirePermission(context, group, level) {
  const granted = permissionLevel(context, group);
  if (LEVELS[granted] >= LEVELS[level]) return;
  return fail(
    context,
    "PERMISSION_DENIED",
    `This API key does not have the required permissions for this endpoint on account ${accountId(context)}. Having the '${group}: ${level}' permission would allow this request to continue.`,
    { group, level },
  );
}

export function requirePermissions(context, pairs) {
  for (const [group, level] of pairs) requirePermission(context, group, level);
}

export function livemode(context) {
  return context.actor.attributes?.livemode === true;
}

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

export function nowSeconds(context) {
  return Math.floor(context.clock.nowUs() / 1_000_000);
}

// ---------------------------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------------------------

/** Every row of a namespace in row-id (creation) order; fails when the bound is exceeded. */
export function allRows(context, namespace) {
  const rows = [];
  let after;
  for (;;) {
    const batch = context.state.scan(namespace, { ...(after === undefined ? {} : { afterRowId: after }), limit: SCAN_STEP });
    if (batch.length === 0) return rows;
    for (const record of batch) {
      after = record.rowId;
      rows.push(record.value);
      if (rows.length >= SCAN_CAP) return tooLarge(context, namespace);
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

export function getRow(context, namespace, id) {
  return typeof id === "string" && id.length > 0 && id.length <= 255 ? context.state.get(namespace, id) : null;
}

export function requireRow(context, namespace, id, param) {
  if (typeof id !== "string" || id.length === 0) return parameterMissing(context, param ?? OBJECT_NAMES[namespace] ?? namespace);
  const row = getRow(context, namespace, id);
  return row === null ? resourceMissing(context, namespace, id, param) : row;
}

// ---------------------------------------------------------------------------------------------
// Lists (newest first, cursor pagination)
// ---------------------------------------------------------------------------------------------

function compareNewestFirst(left, right) {
  if (left.created !== right.created) return right.created - left.created;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

export function validateLimit(context, limit) {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    return invalid(context, `Invalid integer: ${String(limit)}. limit must be between 1 and ${MAX_LIST_LIMIT}.`, "parameter_invalid_integer", "limit");
  }
  return limit;
}

/** `created`/`due_date` style range filter: an integer (equality) or `{ gt, gte, lt, lte }`. */
export function matchesRange(value, filter, context, param) {
  if (filter === undefined) return true;
  if (typeof filter === "number") {
    if (!Number.isInteger(filter)) return invalidInteger(context, param, filter);
    return value === filter;
  }
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return invalidInteger(context, param, filter);
  if (value === null || value === undefined) return false;
  for (const [key, bound] of Object.entries(filter)) {
    if (!["gt", "gte", "lt", "lte"].includes(key)) return parameterUnknown(context, `${param}[${key}]`);
    if (!Number.isInteger(bound)) return invalidInteger(context, `${param}[${key}]`, bound);
    if (key === "gt" && !(value > bound)) return false;
    if (key === "gte" && !(value >= bound)) return false;
    if (key === "lt" && !(value < bound)) return false;
    if (key === "lte" && !(value <= bound)) return false;
  }
  return true;
}

/**
 * Paginate `rows` (already filtered) newest first. Cursors must name an existing row of the namespace
 * (Stripe answers `resource_missing` on the cursor otherwise); the page is everything after/before that row in
 * list order, so a cursor outside the filtered set still positions correctly.
 *
 * `render` returns the object exactly as the response carries it (expansions included). Pages are filled by count
 * (`limit`) and by the encoded UTF-8 size of those objects (`PAGE_BYTE_BUDGET`): a page stops before the object that
 * would pass the budget and answers `has_more: true`, so the next `starting_after` (last object) or `ending_before`
 * (first object) resumes exactly at the first object not returned. Backward pages are filled from the cursor
 * outward. One object larger than `OBJECT_BYTE_BUDGET` answers `invalid_request_error`, never a truncated page.
 */
export function paginate(context, namespace, rows, input, url, render) {
  const limit = validateLimit(context, input.limit);
  if (input.starting_after !== undefined && input.ending_before !== undefined) {
    return invalid(context, "You cannot specify both starting_after and ending_before.", "parameter_invalid", "starting_after");
  }
  const sorted = [...rows].sort(compareNewestFirst);
  if (input.ending_before !== undefined) {
    const cursor = requireRow(context, namespace, input.ending_before, "ending_before");
    const before = sorted.filter((row) => compareNewestFirst(row, cursor) < 0);
    const { data, taken } = fillPage(context, namespace, before.length, limit, (step) => before[before.length - 1 - step], render);
    return { object: "list", data: data.reverse(), has_more: taken < before.length, url };
  }
  let candidates = sorted;
  if (input.starting_after !== undefined) {
    const cursor = requireRow(context, namespace, input.starting_after, "starting_after");
    candidates = sorted.filter((row) => compareNewestFirst(row, cursor) > 0);
  }
  const { data, taken } = fillPage(context, namespace, candidates.length, limit, (step) => candidates[step], render);
  return { object: "list", data, has_more: taken < candidates.length, url };
}

/** Render up to `limit` of `count` rows (`rowAt(step)`, nearest the cursor first) within the page byte budget. */
function fillPage(context, namespace, count, limit, rowAt, render) {
  const data = [];
  let bytes = 0;
  while (data.length < limit && data.length < count) {
    const row = rowAt(data.length);
    const item = render(row);
    const itemBytes = jsonBytes(item);
    if (itemBytes > OBJECT_BYTE_BUDGET) return tooLargeObject(context, `The ${OBJECT_NAMES[namespace] ?? namespace} ${row.id}`, itemBytes);
    const size = itemBytes + 1;
    if (bytes + size > PAGE_BYTE_BUDGET) break;
    bytes += size;
    data.push(item);
  }
  return { data, taken: data.length };
}
