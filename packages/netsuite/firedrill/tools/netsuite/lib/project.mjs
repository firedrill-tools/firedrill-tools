// Provider-shaped projections: state rows → the JSON NetSuite's REST record service returns.
import { dateToDays, round2 } from "./primitives.mjs";

const REC = "/services/rest/record/v1";

export const RESOURCE = {
  customer: "customer",
  salesOrder: "salesOrder",
  invoice: "invoice",
  customerPayment: "customerPayment",
  inventoryItem: "inventoryItem",
  subsidiary: "subsidiary",
};

export const selfLinks = (resource, id) => [{ rel: "self", href: `${REC}/${resource}/${id}` }];

const SO_STATUS = new Map([
  ["pendingApproval", ["A", "Pending Approval"]],
  ["pendingFulfillment", ["B", "Pending Fulfillment"]],
  ["partiallyFulfilled", ["D", "Partially Fulfilled"]],
  ["pendingBillingPartFulfilled", ["E", "Pending Billing/Partially Fulfilled"]],
  ["pendingBilling", ["F", "Pending Billing"]],
  ["billed", ["G", "Billed"]],
  ["closed", ["H", "Closed"]],
]);
const INV_STATUS = new Map([
  ["open", ["A", "Open"]],
  ["paidInFull", ["B", "Paid In Full"]],
  ["pendingApproval", ["C", "Pending Approval"]],
  ["voided", ["V", "Voided"]],
]);
const PAY_STATUS = new Map([
  ["deposited", ["A", "Deposited"]],
  ["notDeposited", ["B", "Not Deposited"]],
]);
const CURRENCY = new Map([
  ["1", "USD"],
  ["3", "CAD"],
]);
const TERMS = new Map([
  ["1", "Net 15"],
  ["2", "Net 30"],
  ["3", "Due on receipt"],
]);

const enumRef = (table, key) => {
  const entry = table.get(key);
  return entry === undefined ? { id: key, refName: key } : { id: entry[0], refName: entry[1] };
};

export const soStatus = (key) => enumRef(SO_STATUS, key);
export const invStatus = (key) => enumRef(INV_STATUS, key);
export const payStatus = (key) => enumRef(PAY_STATUS, key);

export function currencyRef(id) {
  const name = CURRENCY.get(id);
  return name === undefined ? null : { id, refName: name };
}

export function termsRef(id) {
  if (id === null || id === undefined) return null;
  const name = TERMS.get(id);
  return name === undefined ? null : { id, refName: name };
}

/** Index rows by internal id for refName resolution without a rescan. */
export function indexById(rows) {
  const index = new Map();
  for (const row of rows) index.set(row.id, row);
  return index;
}

export const customerRefName = (row) => (row === undefined || row === null ? null : row.entityId);
export const itemRefName = (row) => (row === undefined || row === null ? null : row.itemId);
export const subsidiaryRefName = (row) => (row === undefined || row === null ? null : row.name);

export function ref(resource, id, refName) {
  if (id === null || id === undefined) return null;
  return { links: selfLinks(resource, id), id, refName: refName ?? id };
}

/** Customer balances, computed from transactions on every read — never stored. */
export function customerTotals(customerId, invoices, orders, today) {
  let balance = 0;
  let overdue = 0;
  const todayDays = dateToDays(today) ?? 0;
  for (const invoice of invoices) {
    if (invoice.entityId !== customerId) continue;
    if (invoice.status === "voided") continue;
    const remaining = round2(invoice.total - invoice.amountPaid);
    if (remaining <= 0) continue;
    balance += remaining;
    const due = dateToDays(invoice.dueDate);
    if (due !== null && due < todayDays) overdue += remaining;
  }
  let unbilled = 0;
  for (const order of orders) {
    if (order.entityId !== customerId) continue;
    if (order.status === "closed" || order.status === "billed") continue;
    const open = round2(order.total - order.billedTotal);
    if (open > 0) unbilled += open;
  }
  return { balance: round2(balance), overdueBalance: round2(overdue), unbilledOrders: round2(unbilled) };
}

export function projectCustomer(row, context) {
  const totals = customerTotals(row.id, context.invoiceRows, context.orderRows, context.today);
  const record = {
    links: selfLinks("customer", row.id),
    id: row.id,
    entityId: row.entityId,
    isPerson: row.isPerson,
    isInactive: row.isInactive,
    subsidiary: ref("subsidiary", row.subsidiaryId, subsidiaryRefName(context.subsidiaries.get(row.subsidiaryId))),
    currency: currencyRef(row.currencyId),
    balance: totals.balance,
    unbilledOrders: totals.unbilledOrders,
    overdueBalance: totals.overdueBalance,
    dateCreated: row.dateCreated,
    lastModifiedDate: row.lastModifiedDate,
  };
  for (const [key, value] of [
    ["companyName", row.companyName],
    ["firstName", row.firstName],
    ["middleName", row.middleName],
    ["lastName", row.lastName],
    ["email", row.email],
    ["phone", row.phone],
    ["altPhone", row.altPhone],
    ["comments", row.comments],
    ["defaultAddress", row.defaultAddress],
  ]) {
    if (value !== null && value !== undefined) record[key] = value;
  }
  if (row.creditLimit !== null && row.creditLimit !== undefined) record.creditLimit = row.creditLimit;
  const terms = termsRef(row.termsId);
  if (terms !== null) record.terms = terms;
  if (context.expand === true) {
    record.addressBook = {
      links: [{ rel: "self", href: `${REC}/customer/${row.id}/addressBook` }],
      items: row.addressBook.map((entry) => ({
        links: [{ rel: "self", href: `${REC}/customer/${row.id}/addressBook/${entry.addrId}` }],
        addressBookAddress: {
          addressee: entry.addressee,
          addr1: entry.addr1,
          ...(entry.addr2 === null ? {} : { addr2: entry.addr2 }),
          city: entry.city,
          state: entry.state,
          zip: entry.zip,
          country: { id: entry.country, refName: entry.country },
        },
        defaultBilling: entry.defaultBilling,
        defaultShipping: entry.defaultShipping,
        label: entry.label,
      })),
      totalResults: row.addressBook.length,
    };
  } else {
    record.addressBook = { links: [{ rel: "self", href: `${REC}/customer/${row.id}/addressBook` }] };
  }
  return record;
}

export function projectLine(resource, recordId, line, items) {
  return {
    links: [{ rel: "self", href: `${REC}/${resource}/${recordId}/item/${line.line}` }],
    line: line.line,
    item: ref("inventoryItem", line.itemId, itemRefName(items.get(line.itemId))),
    quantity: line.quantity,
    rate: line.rate,
    amount: line.amount,
    ...(line.description === null ? {} : { description: line.description }),
    taxRate: line.taxRate,
    taxAmount: line.taxAmount,
    ...(line.orderLine === null ? {} : { orderLine: line.orderLine }),
    quantityBilled: line.quantityBilled,
  };
}
