// Paging, the record-collection envelope and the filterable-field tables the `q` grammar checks against.
import { quote } from "./errors.mjs";
import { jsonBytes } from "./primitives.mjs";
import { evaluate, parseQ, QError } from "./q.mjs";
import { indexById } from "./project.mjs";

export const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 1000;

const integerOf = (value) => {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export function booleanOf(session, value, name) {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  session.fail("INVALID_PARAMETER", `Invalid value ${quote(String(value))} for the ${name} parameter. Use true or false.`, {
    errorQueryParam: name,
  });
  return false;
}

/** NetSuite paging: limit 1–1000 (default 1000) and an offset that is a multiple of limit. */
export function paging(session, input, defaultLimit = DEFAULT_LIMIT) {
  let limit = defaultLimit;
  if (input.limit !== undefined) {
    const parsed = integerOf(input.limit);
    if (parsed === null || parsed < 1 || parsed > MAX_LIMIT) {
      session.fail("INVALID_PARAMETER", `Invalid value ${quote(String(input.limit))} for the limit parameter. Use an integer between 1 and ${MAX_LIMIT}.`, {
        errorQueryParam: "limit",
      });
    }
    limit = parsed;
  }
  let offset = 0;
  if (input.offset !== undefined) {
    const parsed = integerOf(input.offset);
    if (parsed === null || parsed < 0) {
      session.fail("INVALID_PARAMETER", `Invalid value ${quote(String(input.offset))} for the offset parameter. Use an integer of 0 or more.`, {
        errorQueryParam: "offset",
      });
    }
    offset = parsed;
  }
  if (offset % limit !== 0) {
    session.fail("INVALID_PARAMETER", `Invalid value ${quote(String(offset))} for the offset parameter. The offset must be a multiple of the limit (${limit}).`, {
      errorQueryParam: "offset",
    });
  }
  return { limit, offset };
}

const day = (value) => (typeof value === "string" ? value.slice(0, 10) : null);

export const FILTER_FIELDS = {
  customer: {
    id: { type: "numeric", read: (row) => Number(row.id) },
    entityId: { type: "string", read: (row) => row.entityId },
    companyName: { type: "string", read: (row) => row.companyName },
    firstName: { type: "string", read: (row) => row.firstName },
    lastName: { type: "string", read: (row) => row.lastName },
    email: { type: "string", read: (row) => row.email },
    phone: { type: "string", read: (row) => row.phone },
    isPerson: { type: "boolean", read: (row) => row.isPerson },
    isInactive: { type: "boolean", read: (row) => row.isInactive },
    subsidiary: { type: "numeric", read: (row) => Number(row.subsidiaryId) },
    dateCreated: { type: "date", read: (row) => day(row.dateCreated) },
    lastModifiedDate: { type: "date", read: (row) => day(row.lastModifiedDate) },
  },
  salesOrder: {
    id: { type: "numeric", read: (row) => Number(row.id) },
    tranId: { type: "string", read: (row) => row.tranId },
    tranDate: { type: "date", read: (row) => row.tranDate },
    entity: { type: "numeric", read: (row) => Number(row.entityId) },
    subsidiary: { type: "numeric", read: (row) => Number(row.subsidiaryId) },
    status: { type: "string", read: (row) => row.status },
    total: { type: "numeric", read: (row) => row.total },
    memo: { type: "string", read: (row) => row.memo },
    otherRefNum: { type: "string", read: (row) => row.otherRefNum },
    lastModifiedDate: { type: "date", read: (row) => day(row.lastModifiedDate) },
  },
  invoice: {
    id: { type: "numeric", read: (row) => Number(row.id) },
    tranId: { type: "string", read: (row) => row.tranId },
    tranDate: { type: "date", read: (row) => row.tranDate },
    dueDate: { type: "date", read: (row) => row.dueDate },
    entity: { type: "numeric", read: (row) => Number(row.entityId) },
    subsidiary: { type: "numeric", read: (row) => Number(row.subsidiaryId) },
    status: { type: "string", read: (row) => row.status },
    total: { type: "numeric", read: (row) => row.total },
    amountRemaining: { type: "numeric", read: (row) => Math.round((row.total - row.amountPaid) * 100) / 100 },
    createdFrom: { type: "numeric", read: (row) => (row.createdFromId === null ? null : Number(row.createdFromId)) },
    memo: { type: "string", read: (row) => row.memo },
    otherRefNum: { type: "string", read: (row) => row.otherRefNum },
    lastModifiedDate: { type: "date", read: (row) => day(row.lastModifiedDate) },
  },
  customerPayment: {
    id: { type: "numeric", read: (row) => Number(row.id) },
    tranId: { type: "string", read: (row) => row.tranId },
    tranDate: { type: "date", read: (row) => row.tranDate },
    customer: { type: "numeric", read: (row) => Number(row.entityId) },
    payment: { type: "numeric", read: (row) => row.payment },
    status: { type: "string", read: (row) => row.status },
  },
  inventoryItem: {
    id: { type: "numeric", read: (row) => Number(row.id) },
    itemId: { type: "string", read: (row) => row.itemId },
    displayName: { type: "string", read: (row) => row.displayName },
    isInactive: { type: "boolean", read: (row) => row.isInactive },
    basePrice: { type: "numeric", read: (row) => row.basePrice },
  },
};

/** Apply a `q` filter to state rows; an unparsable or unsupported filter is INVALID_REQUEST. */
export function applyFilter(session, resource, rows, q) {
  if (q === undefined || q === null) return rows;
  if (typeof q !== "string") {
    session.fail("INVALID_REQUEST", "The q parameter must be a string.", { errorQueryParam: "q" });
  }
  const fields = FILTER_FIELDS[resource];
  let tree;
  try {
    tree = parseQ(q, fields);
  } catch (error) {
    if (error instanceof QError) {
      session.fail("INVALID_REQUEST", `Invalid search query: ${error.message}.`, { errorQueryParam: "q" });
    }
    throw error;
  }
  try {
    return rows.filter((row) => {
      const flat = {};
      for (const [name, field] of Object.entries(fields)) flat[name] = field.read(row);
      return evaluate(tree, flat);
    });
  } catch (error) {
    if (error instanceof QError) {
      session.fail("INVALID_REQUEST", `Invalid search query: ${error.message}.`, { errorQueryParam: "q" });
    }
    throw error;
  }
}

const pageHref = (path, limit, offset, q) =>
  `${path}?${q === undefined || q === null ? "" : `q=${encodeURIComponent(q)}&`}limit=${limit}&offset=${offset}`;

/**
 * Build a NetSuite record collection. Entries are admitted one at a time and the assembled body's UTF-8 size is
 * checked against maxPageBytes before it is returned, so an oversized single row fails rather than producing a
 * body the framework would reject opaquely.
 */
export function collection(session, path, entries, { limit, offset, total, q }) {
  const items = [];
  let bytes = 220;
  for (const entry of entries) {
    const size = jsonBytes(entry);
    if (bytes + size > session.maxPageBytes) {
      if (items.length === 0) {
        session.fail(
          "RESULT_SET_TOO_LARGE",
          `Search error occurred: one result row is ${size} bytes, larger than the supported page size of ${session.maxPageBytes} bytes.`,
        );
      }
      break;
    }
    bytes += size + 1;
    items.push(entry);
  }
  const returned = items.length;
  const hasMore = offset + returned < total;
  const links = [{ rel: "self", href: pageHref(path, limit, offset, q) }];
  if (hasMore) links.push({ rel: "next", href: pageHref(path, limit, offset + returned, q) });
  if (offset > 0) {
    links.push({ rel: "previous", href: pageHref(path, limit, Math.max(0, offset - limit), q) });
    links.push({ rel: "first", href: pageHref(path, limit, 0, q) });
  }
  if (total > 0) {
    const lastOffset = Math.floor(Math.max(0, total - 1) / limit) * limit;
    if (lastOffset !== offset) links.push({ rel: "last", href: pageHref(path, limit, lastOffset, q) });
  }
  return { links, items, count: returned, offset, hasMore, totalResults: total };
}

/** Shared lookup maps every projection needs, built from bounded scans. */
export function projectionContext(session, expand = false) {
  return {
    expand,
    today: session.today,
    customers: indexById(session.rows("customers")),
    items: indexById(session.rows("items")),
    subsidiaries: indexById(session.rows("subsidiaries")),
    invoices: indexById(session.rows("invoices")),
    orders: indexById(session.rows("sales-orders")),
    invoiceRows: session.rows("invoices"),
    orderRows: session.rows("sales-orders"),
  };
}
