// Read operations: the five record collections, their singular reads, the sales-order item sublist and subsidiaries.
import { quote } from "./errors.mjs";
import { requireId } from "./primitives.mjs";
import { open } from "./session.mjs";
import { applyFilter, booleanOf, collection, paging, projectionContext } from "./collections.mjs";
import { projectCustomer, projectLine, selfLinks } from "./project.mjs";
import { projectInvoice, projectItem, projectPayment, projectSalesOrder, projectSubsidiary } from "./project-tran.mjs";

const REC = "/services/rest/record/v1";

export const KINDS = {
  customer: { namespace: "customers", resource: "customer", permission: "LIST_CUSTJOB", label: "customer" },
  "sales-order": { namespace: "sales-orders", resource: "salesOrder", permission: "TRAN_SALESORD", label: "sales order" },
  invoice: { namespace: "invoices", resource: "invoice", permission: "TRAN_CUSTINVC", label: "invoice" },
  "customer-payment": { namespace: "customer-payments", resource: "customerPayment", permission: "TRAN_CUSTPYMT", label: "customer payment" },
  "inventory-item": { namespace: "items", resource: "inventoryItem", permission: "LIST_ITEM", label: "inventory item" },
};

const visible = (session, kind, row) => (kind === "inventory-item"
  ? row.subsidiaryIds.some((id) => session.inScope(id)) && row.itemType === "inventoryItem"
  : session.inScope(row.subsidiaryId));

export function loadRecord(session, kind, recordId) {
  const definition = KINDS[kind];
  requireId(session.context, recordId, "id");
  const row = session.get(definition.namespace, recordId);
  if (row === null || !visible(session, kind, row)) {
    session.fail("NONEXISTENT_ID", `Invalid ${definition.resource} reference key ${quote(recordId)}.`, {
      urlPath: `${REC}/${definition.resource}/${recordId}`,
    });
  }
  return row;
}

/** Most field names one `fields` selection may name, matching the documented REST record-service bound. */
const MAX_FIELDS = 40;
/** Longest single field name accepted before it can only be an unknown field. */
const MAX_FIELD_NAME = 120;

/** Restrict a projected record to the caller's `fields` selection. */
function selectFields(session, record, fields) {
  if (fields === undefined) return record;
  if (!Array.isArray(fields)) {
    session.fail("INVALID_PARAMETER", "The fields parameter must be a comma-separated list of field names.", { errorQueryParam: "fields" });
  }
  if (fields.length > MAX_FIELDS) {
    session.fail("INVALID_PARAMETER", `The fields parameter is limited to ${MAX_FIELDS} field names.`, { errorQueryParam: "fields" });
  }
  const picked = { links: record.links, id: record.id };
  for (const name of fields) {
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_FIELD_NAME) {
      session.fail("INVALID_PARAMETER", "The fields parameter must be a comma-separated list of field names.", { errorQueryParam: "fields" });
    }
    if (!Object.hasOwn(record, name)) {
      session.fail("INVALID_PARAMETER", `Unknown field ${quote(name)} in the fields parameter.`, { errorQueryParam: "fields" });
    }
    picked[name] = record[name];
  }
  return picked;
}

export function projectOne(session, kind, row, expand) {
  if (kind === "inventory-item") {
    const subsidiaries = new Map();
    for (const id of row.subsidiaryIds) {
      const subsidiary = session.get("subsidiaries", id);
      if (subsidiary !== null) subsidiaries.set(id, subsidiary);
    }
    return projectItem(row, subsidiaries);
  }
  const context = projectionContext(session, expand);
  if (kind === "customer") return projectCustomer(row, context);
  if (kind === "sales-order") return projectSalesOrder(row, context);
  if (kind === "invoice") return projectInvoice(row, context);
  return projectPayment(row, context);
}

function listHandler(kind) {
  const definition = KINDS[kind];
  return (input, context) => {
    const session = open(context);
    session.permit(definition.permission, "view");
    const { limit, offset } = paging(session, input);
    const rows = session.rows(definition.namespace).filter((row) => visible(session, kind, row));
    const filtered = applyFilter(session, definition.resource, rows, input.q);
    const page = filtered.slice(offset, offset + limit);
    const entries = page.map((row) => ({ links: selfLinks(definition.resource, row.id), id: row.id }));
    return collection(session, `${REC}/${definition.resource}`, entries, {
      limit, offset, total: filtered.length, q: input.q,
    });
  };
}

function getHandler(kind) {
  const definition = KINDS[kind];
  return (input, context) => {
    const session = open(context);
    session.permit(definition.permission, "view");
    const expand = booleanOf(session, input.expandSubResources, "expandSubResources");
    booleanOf(session, input.simpleEnumFormat, "simpleEnumFormat");
    const row = loadRecord(session, kind, input.recordId);
    return selectFields(session, projectOne(session, kind, row, expand), input.fields);
  };
}

export const readOperations = {
  "customer.list": listHandler("customer"),
  "customer.get": getHandler("customer"),
  "sales-order.list": listHandler("sales-order"),
  "sales-order.get": getHandler("sales-order"),
  "invoice.list": listHandler("invoice"),
  "invoice.get": getHandler("invoice"),
  "customer-payment.list": listHandler("customer-payment"),
  "customer-payment.get": getHandler("customer-payment"),
  "inventory-item.list": listHandler("inventory-item"),
  "inventory-item.get": getHandler("inventory-item"),

  "sales-order.items.list": (input, context) => {
    const session = open(context);
    session.permit("TRAN_SALESORD", "view");
    const { limit, offset } = paging(session, input);
    const order = loadRecord(session, "sales-order", input.recordId);
    const projection = projectionContext(session, true);
    const entries = order.lines
      .slice(offset, offset + limit)
      .map((line) => projectLine("salesOrder", order.id, line, projection.items));
    return collection(session, `${REC}/salesOrder/${order.id}/item`, entries, {
      limit, offset, total: order.lines.length,
    });
  },

  "subsidiary.list": (input, context) => {
    const session = open(context);
    session.permit("LIST_SUBSIDIARY", "view");
    const { limit, offset } = paging(session, input);
    const rows = session.rows("subsidiaries").filter((row) => session.inScope(row.id));
    const index = new Map(rows.map((row) => [row.id, row]));
    const entries = rows.slice(offset, offset + limit).map((row) => projectSubsidiary(row, index));
    return collection(session, `${REC}/subsidiary`, entries, { limit, offset, total: rows.length });
  },
};
