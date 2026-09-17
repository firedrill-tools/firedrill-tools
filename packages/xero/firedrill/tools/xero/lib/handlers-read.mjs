// Read operations: organisation, accounts, tax rates, contacts, invoices and payments (lists and single reads).
import { lookupsOf, open } from "./access.mjs";
import { modifiedSinceOf, pagingOf, runList, searchFilter } from "./lists.mjs";
import { CONTACT_FIELDS, INVOICE_FIELDS, contactBalances, contactFlags, contactRecord, invoiceRecord, renderContact, renderInvoice } from "./views-docs.mjs";
import { ACCOUNT_FIELDS, PAYMENT_FIELDS, TAX_RATE_FIELDS, accountRecord, paymentRecord, renderAccount, renderOrganisation, renderPayment, renderTaxRate, taxRateRecord } from "./views-ref.mjs";
import { containsReplacement, fold, normalGuid } from "./util.mjs";

const INVOICE_STATUSES = new Set(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"]);

function guidList(s, values, name) {
  if (values === undefined) return null;
  if (values.length > 100) s.validation(`${name} supports at most 100 values`);
  const set = new Set();
  for (const value of values) {
    const id = normalGuid(value);
    if (id === null) s.validation(`${name} must contain only GUIDs`);
    set.add(id);
  }
  return set;
}

function searchTermOf(s, input) {
  if (input.searchTerm === undefined || input.searchTerm.length === 0) return null;
  if (input.searchTerm.length > 255) s.validation("searchTerm must be at most 255 characters");
  if (containsReplacement(input.searchTerm)) s.validation("searchTerm contains an invalid character (malformed encoding)");
  return input.searchTerm;
}

const unitdpOf = (s, input) => {
  if (input.unitdp === undefined) return 2;
  if (input.unitdp !== 2 && input.unitdp !== 4) s.validation("unitdp must be 2 or 4");
  return input.unitdp;
};

/** Contact by GUID or ContactNumber; null when missing. */
function findContact(s, key) {
  const id = normalGuid(key);
  if (id !== null) return s.get("contacts", id);
  if (typeof key !== "string" || key.length === 0 || key.length > 255) return null;
  for (const contact of s.rows("contacts").values()) if (contact.ContactNumber === key) return contact;
  return null;
}

/** Invoice by GUID or InvoiceNumber (non-DELETED preferred); null when missing. */
export function findInvoice(s, key) {
  const id = normalGuid(key);
  if (id !== null) return s.get("invoices", id);
  if (typeof key !== "string" || key.length === 0 || key.length > 255) return null;
  let fallback = null;
  for (const invoice of s.rows("invoices").values()) {
    if (invoice.InvoiceNumber !== key) continue;
    if (invoice.Status !== "DELETED") return invoice;
    fallback ??= invoice;
  }
  return fallback;
}

export const readOperations = {
  "organisation.get": (input, context) => {
    const s = open(context, input, "settings", "read");
    return s.envelope({ Organisations: [renderOrganisation(s.org)], organisationDate: s.clock.today });
  },
  "accounts.list": (input, context) => {
    const s = open(context, input, "settings", "read");
    const items = [...s.rows("accounts").values()].map((row) => ({ row, record: accountRecord(row) }));
    const { rendered } = runList(s, items, { fields: ACCOUNT_FIELDS, where: input.where, order: input.order, defaultOrder: [{ path: "Code", desc: false }], idField: "AccountID", render: renderAccount });
    return s.envelope({ Accounts: rendered });
  },
  "accounts.get": (input, context) => {
    const s = open(context, input, "settings", "read");
    const id = normalGuid(input.accountId);
    const account = id === null ? null : s.get("accounts", id);
    if (account === null) s.notFound();
    return s.envelope({ Accounts: [renderAccount(account)] });
  },
  "tax-rates.list": (input, context) => {
    const s = open(context, input, "settings", "read");
    if (containsReplacement(input.taxType)) s.parse("TaxType contains an invalid character (malformed encoding)");
    const filters = input.taxType === undefined ? [] : [(record) => record.get("TaxType") === input.taxType];
    const items = [...s.rows("tax-rates").values()].map((row) => ({ row, record: taxRateRecord(row) }));
    const { rendered } = runList(s, items, { fields: TAX_RATE_FIELDS, where: input.where, order: input.order, filters, defaultOrder: [{ path: "Name", desc: false }], idField: "TaxType", render: renderTaxRate });
    return s.envelope({ TaxRates: rendered });
  },
  "contacts.list": (input, context) => {
    const s = open(context, input, "contacts", "read");
    const { page, pageSize } = pagingOf(s, input);
    const since = modifiedSinceOf(s, input);
    const ids = guidList(s, input.ids, "IDs");
    const term = searchTermOf(s, input);
    const flags = contactFlags(s.rows("invoices"));
    const filters = [];
    const namesStatus = typeof input.where === "string" && input.where.includes("ContactStatus");
    if (ids !== null) filters.push((r) => ids.has(r.get("ContactID")));
    else if (input.includeArchived !== true && !namesStatus) filters.push((r) => r.get("ContactStatus") !== "ARCHIVED");
    if (since !== null) filters.push((r) => r.get("UpdatedDateUTC") > since);
    if (term !== null) filters.push(searchFilter(term, ["Name", "FirstName", "LastName", "ContactNumber", "EmailAddress"]));
    const items = [...s.rows("contacts").values()].map((row) => ({ row, record: contactRecord(row, flags) }));
    const summaryOnly = input.summaryOnly === true;
    const result = runList(s, items, { fields: CONTACT_FIELDS, where: input.where, order: input.order, filters, page, pageSize, defaultOrder: [{ path: "Name", desc: false }], idField: "ContactID", render: (row) => renderContact(row, { flags, summaryOnly }) });
    return s.envelope({ Contacts: result.rendered, ...(result.pagination === undefined ? {} : { pagination: result.pagination }) });
  },
  "contacts.get": (input, context) => {
    const s = open(context, input, "contacts", "read");
    const contact = findContact(s, input.contactId);
    if (contact === null) s.notFound();
    const invoices = s.rows("invoices");
    return s.envelope({ Contacts: [renderContact(contact, { flags: contactFlags(invoices), balances: contactBalances(invoices, contact.ContactID, s.clock.today) })] });
  },
  "invoices.list": (input, context) => {
    const s = open(context, input, "transactions", "read");
    const { page, pageSize } = pagingOf(s, input);
    const since = modifiedSinceOf(s, input);
    if (input.createdByMyApp === true) s.validation("createdByMyApp is not supported by this Tool");
    const unitdp = unitdpOf(s, input);
    const ids = guidList(s, input.ids, "IDs");
    const contactIds = guidList(s, input.contactIds, "ContactIDs");
    const term = searchTermOf(s, input);
    const filters = [];
    if (ids !== null) filters.push((r) => ids.has(r.get("InvoiceID")));
    if (contactIds !== null) filters.push((r) => contactIds.has(r.get("Contact.ContactID")));
    if (input.invoiceNumbers !== undefined) {
      if (input.invoiceNumbers.length > 100) s.validation("InvoiceNumbers supports at most 100 values");
      if (input.invoiceNumbers.some(containsReplacement)) s.validation("InvoiceNumbers contains an invalid character (malformed encoding)");
      const numbers = new Set(input.invoiceNumbers);
      filters.push((r) => numbers.has(r.get("InvoiceNumber")));
    }
    if (input.statuses !== undefined) {
      if (input.statuses.length > 100 || input.statuses.some((status) => !INVOICE_STATUSES.has(status))) s.validation("Statuses must contain only DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED or DELETED");
      const statuses = new Set(input.statuses);
      filters.push((r) => statuses.has(r.get("Status")));
    }
    if (since !== null) filters.push((r) => r.get("UpdatedDateUTC") > since);
    if (term !== null) filters.push(searchFilter(term, ["InvoiceNumber", "Reference"]));
    const lookups = lookupsOf(s);
    const items = [...s.rows("invoices").values()].map((row) => ({ row, record: invoiceRecord(row, lookups.contact(row.ContactID)) }));
    const options = { lines: page !== null, summaryOnly: input.summaryOnly === true, unitdp };
    const result = runList(s, items, { fields: INVOICE_FIELDS, where: input.where, order: input.order, filters, page, pageSize, defaultOrder: [{ path: "Date", desc: false }, { path: "InvoiceNumber", desc: false }], idField: "InvoiceID", render: (row) => renderInvoice(row, lookups, options) });
    return s.envelope({ Invoices: result.rendered, ...(result.pagination === undefined ? {} : { pagination: result.pagination }) });
  },
  "invoices.get": (input, context) => {
    const s = open(context, input, "transactions", "read");
    const unitdp = unitdpOf(s, input);
    const invoice = findInvoice(s, input.invoiceId);
    if (invoice === null) s.notFound();
    return s.envelope({ Invoices: [renderInvoice(invoice, lookupsOf(s), { unitdp })] });
  },
  "payments.list": (input, context) => {
    const s = open(context, input, "transactions", "read");
    const { page, pageSize } = pagingOf(s, input);
    const since = modifiedSinceOf(s, input);
    const filters = [];
    for (const [name, value] of [["Invoice.InvoiceNumber", input.invoiceNumber], ["Invoice.InvoiceID", input.invoiceId], ["PaymentID", input.paymentId], ["Reference", input.reference]]) {
      if (containsReplacement(value)) s.validation(`${name} contains an invalid character (malformed encoding)`);
    }
    const eq = (field, value) => filters.push((r) => typeof r.get(field) === "string" && fold(r.get(field)) === fold(value));
    if (input.invoiceNumber !== undefined) eq("Invoice.InvoiceNumber", input.invoiceNumber);
    if (input.invoiceId !== undefined) eq("Invoice.InvoiceID", input.invoiceId);
    if (input.paymentId !== undefined) eq("PaymentID", input.paymentId);
    if (input.reference !== undefined) eq("Reference", input.reference);
    if (since !== null) filters.push((r) => r.get("UpdatedDateUTC") > since);
    const lookups = lookupsOf(s);
    const items = [...s.rows("payments").values()].map((row) => ({ row, record: paymentRecord(row, lookups) }));
    const result = runList(s, items, { fields: PAYMENT_FIELDS, where: input.where, order: input.order, filters, page, pageSize, defaultOrder: [{ path: "Date", desc: false }], idField: "PaymentID", render: (row) => renderPayment(row, lookups) });
    return s.envelope({ Payments: result.rendered, ...(result.pagination === undefined ? {} : { pagination: result.pagination }) });
  },
  "payments.get": (input, context) => {
    const s = open(context, input, "transactions", "read");
    const id = normalGuid(input.paymentId);
    const payment = id === null ? null : s.get("payments", id);
    if (payment === null) s.notFound();
    return s.envelope({ Payments: [renderPayment(payment, lookupsOf(s))] });
  },
};
