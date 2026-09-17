// Wire projections, derived flags and filter fields for contacts and invoices.
import { dateMs, wireDate, wireDateString, wireInstant } from "./dates.mjs";
import { fromCents, toCents, unitAmountOut, toScaled4 } from "./money.mjs";
import { compact } from "./views-ref.mjs";

const OPEN_FLAG_STATUSES = new Set(["SUBMITTED", "AUTHORISED", "PAID", "VOIDED"]);

/** AmountDue as Xero reports it: zero for VOIDED and DELETED documents. */
export function amountDue(invoice) {
  if (invoice.Status === "VOIDED" || invoice.Status === "DELETED") return 0;
  return fromCents((toCents(invoice.Total) ?? 0) - (toCents(invoice.AmountPaid) ?? 0));
}

/** contactId → { customer, supplier } from one pass over the invoices map. */
export function contactFlags(invoices) {
  const flags = new Map();
  for (const invoice of invoices.values()) {
    if (!OPEN_FLAG_STATUSES.has(invoice.Status)) continue;
    const entry = flags.get(invoice.ContactID) ?? { customer: false, supplier: false };
    if (invoice.Type === "ACCREC") entry.customer = true;
    else entry.supplier = true;
    flags.set(invoice.ContactID, entry);
  }
  return flags;
}

/** Outstanding and overdue receivable/payable balances of one contact, in cents. */
export function contactBalances(invoices, contactId, today) {
  const sums = { ACCREC: [0, 0], ACCPAY: [0, 0] };
  for (const invoice of invoices.values()) {
    if (invoice.ContactID !== contactId || invoice.Status !== "AUTHORISED") continue;
    const due = toCents(amountDue(invoice)) ?? 0;
    sums[invoice.Type === "ACCPAY" ? "ACCPAY" : "ACCREC"][0] += due;
    if (invoice.DueDate !== null && invoice.DueDate < today) sums[invoice.Type === "ACCPAY" ? "ACCPAY" : "ACCREC"][1] += due;
  }
  return {
    AccountsReceivable: { Outstanding: fromCents(sums.ACCREC[0]), Overdue: fromCents(sums.ACCREC[1]) },
    AccountsPayable: { Outstanding: fromCents(sums.ACCPAY[0]), Overdue: fromCents(sums.ACCPAY[1]) },
  };
}

export function renderContact(contact, { flags, balances = null, summaryOnly = false }) {
  const flag = flags.get(contact.ContactID) ?? { customer: false, supplier: false };
  const out = compact({
    ContactID: contact.ContactID,
    ContactNumber: contact.ContactNumber,
    AccountNumber: contact.AccountNumber,
    ContactStatus: contact.ContactStatus,
    Name: contact.Name,
    FirstName: contact.FirstName,
    LastName: contact.LastName,
    EmailAddress: contact.EmailAddress,
    CompanyNumber: contact.CompanyNumber,
    TaxNumber: summaryOnly ? null : contact.TaxNumber,
    AccountsReceivableTaxType: contact.AccountsReceivableTaxType,
    AccountsPayableTaxType: contact.AccountsPayableTaxType,
    Addresses: summaryOnly ? null : contact.Addresses.map(compact),
    Phones: summaryOnly ? null : contact.Phones.map(compact),
    DefaultCurrency: contact.DefaultCurrency,
    Website: contact.Website,
    PaymentTerms: contact.PaymentTerms,
    UpdatedDateUTC: wireInstant(contact.UpdatedDateUTC),
    IsSupplier: flag.supplier,
    IsCustomer: flag.customer,
    HasAttachments: false,
    HasValidationErrors: false,
    Balances: balances,
  });
  return out;
}

export const CONTACT_FIELDS = new Map([
  ["ContactID", "guid"],
  ["ContactNumber", "string"],
  ["AccountNumber", "string"],
  ["Name", "string"],
  ["FirstName", "string"],
  ["LastName", "string"],
  ["EmailAddress", "string"],
  ["ContactStatus", "string"],
  ["IsCustomer", "boolean"],
  ["IsSupplier", "boolean"],
  ["UpdatedDateUTC", "date"],
]);

export function contactRecord(contact, flags) {
  const flag = flags.get(contact.ContactID) ?? { customer: false, supplier: false };
  return new Map([
    ["ContactID", contact.ContactID],
    ["ContactNumber", contact.ContactNumber],
    ["AccountNumber", contact.AccountNumber],
    ["Name", contact.Name],
    ["FirstName", contact.FirstName],
    ["LastName", contact.LastName],
    ["EmailAddress", contact.EmailAddress],
    ["ContactStatus", contact.ContactStatus],
    ["IsCustomer", flag.customer],
    ["IsSupplier", flag.supplier],
    ["UpdatedDateUTC", Date.parse(contact.UpdatedDateUTC)],
  ]);
}

function renderLine(line, unitdp) {
  return compact({
    LineItemID: line.LineItemID,
    Description: line.Description,
    Quantity: line.Quantity,
    UnitAmount: unitAmountOut(toScaled4(line.UnitAmount) ?? 0, unitdp),
    ItemCode: line.ItemCode,
    AccountCode: line.AccountCode,
    TaxType: line.TaxType,
    TaxAmount: line.TaxAmount,
    LineAmount: line.LineAmount,
    Tracking: [],
  });
}

/** Invoice projection. lookups: { contact(id), payment(id) }; options: { lines, summaryOnly, unitdp }. */
export function renderInvoice(invoice, lookups, { lines = true, summaryOnly = false, unitdp = 2 } = {}) {
  const contact = lookups.contact(invoice.ContactID);
  const payments = [];
  if (!summaryOnly) {
    for (const id of invoice.paymentIds) {
      const payment = lookups.payment(id);
      if (payment === null || payment.Status === "DELETED") continue;
      payments.push(compact({ PaymentID: id, Date: wireDate(payment.Date), Amount: payment.Amount, Reference: payment.Reference, CurrencyRate: 1, HasAccount: true, HasValidationErrors: false }));
    }
  }
  const contactOut = contact === null
    ? { ContactID: invoice.ContactID }
    : summaryOnly ? { ContactID: contact.ContactID, Name: contact.Name } : { ContactID: contact.ContactID, Name: contact.Name, ContactStatus: contact.ContactStatus };
  return compact({
    Type: invoice.Type,
    InvoiceID: invoice.InvoiceID,
    InvoiceNumber: invoice.InvoiceNumber,
    Reference: invoice.Reference,
    Payments: summaryOnly ? null : payments,
    CreditNotes: summaryOnly ? null : [],
    Prepayments: summaryOnly ? null : [],
    Overpayments: summaryOnly ? null : [],
    AmountDue: amountDue(invoice),
    AmountPaid: invoice.AmountPaid,
    AmountCredited: 0,
    CurrencyRate: invoice.CurrencyRate,
    IsDiscounted: false,
    HasAttachments: false,
    HasErrors: false,
    Contact: contactOut,
    DateString: wireDateString(invoice.Date),
    Date: wireDate(invoice.Date),
    DueDateString: wireDateString(invoice.DueDate),
    DueDate: wireDate(invoice.DueDate),
    ExpectedPaymentDate: wireDate(invoice.ExpectedPaymentDate),
    PlannedPaymentDate: wireDate(invoice.PlannedPaymentDate),
    Status: invoice.Status,
    LineAmountTypes: invoice.LineAmountTypes,
    LineItems: lines && !summaryOnly ? invoice.LineItems.map((line) => renderLine(line, unitdp)) : null,
    SubTotal: invoice.SubTotal,
    TotalTax: invoice.TotalTax,
    Total: invoice.Total,
    UpdatedDateUTC: wireInstant(invoice.UpdatedDateUTC),
    CurrencyCode: invoice.CurrencyCode,
    FullyPaidOnDate: wireDate(invoice.FullyPaidOnDate),
    SentToContact: invoice.SentToContact,
  });
}

export const INVOICE_FIELDS = new Map([
  ["InvoiceID", "guid"],
  ["InvoiceNumber", "string"],
  ["Reference", "string"],
  ["Type", "string"],
  ["Status", "string"],
  ["Date", "date"],
  ["DueDate", "date"],
  ["Contact.ContactID", "guid"],
  ["Contact.Name", "string"],
  ["Total", "number"],
  ["AmountDue", "number"],
  ["AmountPaid", "number"],
  ["SentToContact", "boolean"],
  ["UpdatedDateUTC", "date"],
]);

export function invoiceRecord(invoice, contact) {
  return new Map([
    ["InvoiceID", invoice.InvoiceID],
    ["InvoiceNumber", invoice.InvoiceNumber],
    ["Reference", invoice.Reference],
    ["Type", invoice.Type],
    ["Status", invoice.Status],
    ["Date", dateMs(invoice.Date)],
    ["DueDate", invoice.DueDate === null ? null : dateMs(invoice.DueDate)],
    ["Contact.ContactID", invoice.ContactID],
    ["Contact.Name", contact === null ? null : contact.Name],
    ["Total", invoice.Total],
    ["AmountDue", amountDue(invoice)],
    ["AmountPaid", invoice.AmountPaid],
    ["SentToContact", invoice.SentToContact],
    ["UpdatedDateUTC", Date.parse(invoice.UpdatedDateUTC)],
  ]);
}
