// Transaction projections: sales order, invoice, customer payment, item and subsidiary records.
import { round2 } from "./primitives.mjs";
import {
  currencyRef, invStatus, itemRefName, payStatus, projectLine, ref, selfLinks, soStatus,
  subsidiaryRefName, termsRef, customerRefName,
} from "./project.mjs";

const REC = "/services/rest/record/v1";

function sublist(resource, recordId, lines, items, expand) {
  const links = [{ rel: "self", href: `${REC}/${resource}/${recordId}/item` }];
  if (expand !== true) return { links };
  return {
    links,
    items: lines.map((line) => projectLine(resource, recordId, line, items)),
    totalResults: lines.length,
  };
}

export function projectSalesOrder(row, context) {
  const record = {
    links: selfLinks("salesOrder", row.id),
    id: row.id,
    tranId: row.tranId,
    tranDate: row.tranDate,
    entity: ref("customer", row.entityId, customerRefName(context.customers.get(row.entityId))),
    subsidiary: ref("subsidiary", row.subsidiaryId, subsidiaryRefName(context.subsidiaries.get(row.subsidiaryId))),
    status: soStatus(row.status),
    currency: currencyRef(row.currencyId),
    subtotal: row.subtotal,
    taxTotal: row.taxTotal,
    total: row.total,
    createdDate: row.createdDate,
    lastModifiedDate: row.lastModifiedDate,
    item: sublist("salesOrder", row.id, row.lines, context.items, context.expand),
  };
  if (row.memo !== null) record.memo = row.memo;
  if (row.otherRefNum !== null) record.otherRefNum = row.otherRefNum;
  const terms = termsRef(row.termsId);
  if (terms !== null) record.terms = terms;
  return record;
}

export function projectInvoice(row, context) {
  const record = {
    links: selfLinks("invoice", row.id),
    id: row.id,
    tranId: row.tranId,
    tranDate: row.tranDate,
    dueDate: row.dueDate,
    entity: ref("customer", row.entityId, customerRefName(context.customers.get(row.entityId))),
    subsidiary: ref("subsidiary", row.subsidiaryId, subsidiaryRefName(context.subsidiaries.get(row.subsidiaryId))),
    status: invStatus(row.status),
    currency: currencyRef(row.currencyId),
    subtotal: row.subtotal,
    taxTotal: row.taxTotal,
    total: row.total,
    amountPaid: row.amountPaid,
    amountRemaining: round2(row.total - row.amountPaid),
    createdDate: row.createdDate,
    lastModifiedDate: row.lastModifiedDate,
    item: sublist("invoice", row.id, row.lines, context.items, context.expand),
  };
  if (row.memo !== null) record.memo = row.memo;
  if (row.otherRefNum !== null) record.otherRefNum = row.otherRefNum;
  if (row.createdFromId !== null) {
    const order = context.orders.get(row.createdFromId);
    record.createdFrom = ref("salesOrder", row.createdFromId, order === undefined ? row.createdFromId : order.tranId);
  }
  const terms = termsRef(row.termsId);
  if (terms !== null) record.terms = terms;
  return record;
}

export function projectPayment(row, context) {
  const record = {
    links: selfLinks("customerPayment", row.id),
    id: row.id,
    tranId: row.tranId,
    tranDate: row.tranDate,
    customer: ref("customer", row.entityId, customerRefName(context.customers.get(row.entityId))),
    subsidiary: ref("subsidiary", row.subsidiaryId, subsidiaryRefName(context.subsidiaries.get(row.subsidiaryId))),
    payment: row.payment,
    unapplied: row.unapplied,
    account: { refName: row.accountName },
    currency: currencyRef(row.currencyId),
    status: payStatus(row.status),
    createdDate: row.createdDate,
    lastModifiedDate: row.lastModifiedDate,
  };
  if (row.memo !== null) record.memo = row.memo;
  const links = [{ rel: "self", href: `${REC}/customerPayment/${row.id}/apply` }];
  record.apply = context.expand === true
    ? {
        links,
        items: row.applied.map((entry) => {
          const invoice = context.invoices.get(entry.invoiceId);
          return {
            doc: entry.invoiceId,
            refName: invoice === undefined ? entry.invoiceId : invoice.tranId,
            applyDate: row.tranDate,
            amount: entry.amount,
            apply: true,
          };
        }),
        totalResults: row.applied.length,
      }
    : { links };
  return record;
}

export function projectItem(row, subsidiaries) {
  const record = {
    links: selfLinks("inventoryItem", row.id),
    id: row.id,
    itemId: row.itemId,
    basePrice: row.basePrice,
    quantityOnHand: row.quantityOnHand,
    incomeAccount: { refName: row.incomeAccountName },
    taxSchedule: { refName: row.taxScheduleName },
    isInactive: row.isInactive,
    lastModifiedDate: row.lastModifiedDate,
    subsidiary: {
      links: [{ rel: "self", href: `${REC}/inventoryItem/${row.id}/subsidiary` }],
      items: row.subsidiaryIds.map((id) => ref("subsidiary", id, subsidiaryRefName(subsidiaries.get(id)))),
      totalResults: row.subsidiaryIds.length,
    },
  };
  if (row.displayName !== null) record.displayName = row.displayName;
  if (row.description !== null) record.description = row.description;
  if (row.cost !== null) record.cost = row.cost;
  return record;
}

export function projectSubsidiary(row, subsidiaries) {
  const record = {
    links: selfLinks("subsidiary", row.id),
    id: row.id,
    name: row.name,
    country: { id: row.country, refName: row.country },
    currency: { refName: row.currencyName },
    isElimination: row.isElimination,
    isInactive: row.isInactive,
    fiscalCalendar: { refName: row.fiscalCalendarName },
    lastModifiedDate: row.lastModifiedDate,
  };
  if (row.parentId !== null) {
    record.parent = ref("subsidiary", row.parentId, subsidiaryRefName(subsidiaries.get(row.parentId)));
  }
  return record;
}

export const ITEM_REF_NAME = itemRefName;
