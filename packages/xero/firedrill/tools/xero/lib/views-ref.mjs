// Wire projections and filter fields for the organisation, accounts, tax rates and payments.
import { dateMs, wireDate, wireDateString, wireInstant } from "./dates.mjs";

/** Copy of an object without null or undefined fields (shallow). */
export function compact(object) {
  const out = {};
  for (const key of Object.keys(object)) if (object[key] !== null && object[key] !== undefined) out[key] = object[key];
  return out;
}

export function renderOrganisation(org) {
  const { tenantId, PeriodLockDate, CreatedDateUTC, Addresses, Phones, ...rest } = org;
  return compact({
    ...rest,
    PeriodLockDate: wireDate(PeriodLockDate),
    CreatedDateUTC: wireInstant(CreatedDateUTC),
    Addresses: Addresses.map(compact),
    Phones: Phones.map(compact),
  });
}

export function renderAccount(account) {
  return compact({ ...account, UpdatedDateUTC: wireInstant(account.UpdatedDateUTC) });
}

export const renderTaxRate = (rate) => compact({ ...rate, TaxComponents: rate.TaxComponents.map((c) => ({ ...c })) });

export const ACCOUNT_FIELDS = new Map([
  ["AccountID", "guid"],
  ["Code", "string"],
  ["Name", "string"],
  ["Type", "string"],
  ["Class", "string"],
  ["Status", "string"],
  ["TaxType", "string"],
  ["EnablePaymentsToAccount", "boolean"],
  ["SystemAccount", "string"],
]);

export const accountRecord = (a) =>
  new Map([
    ["AccountID", a.AccountID],
    ["Code", a.Code],
    ["Name", a.Name],
    ["Type", a.Type],
    ["Class", a.Class],
    ["Status", a.Status],
    ["TaxType", a.TaxType],
    ["EnablePaymentsToAccount", a.EnablePaymentsToAccount],
    ["SystemAccount", a.SystemAccount],
  ]);

export const TAX_RATE_FIELDS = new Map([
  ["TaxType", "string"],
  ["Name", "string"],
  ["Status", "string"],
  ["EffectiveRate", "number"],
]);

export const taxRateRecord = (t) =>
  new Map([
    ["TaxType", t.TaxType],
    ["Name", t.Name],
    ["Status", t.Status],
    ["EffectiveRate", t.EffectiveRate],
  ]);

/** Payment projection; `lookups` supplies invoice, contact and account rows (rows may be missing in consumer data). */
export function renderPayment(payment, lookups) {
  const invoice = lookups.invoice(payment.InvoiceID);
  const account = lookups.account(payment.AccountID);
  const contact = invoice === null ? null : lookups.contact(invoice.ContactID);
  return compact({
    PaymentID: payment.PaymentID,
    Date: wireDate(payment.Date),
    DateString: wireDateString(payment.Date),
    Amount: payment.Amount,
    BankAmount: payment.BankAmount,
    Reference: payment.Reference,
    CurrencyRate: payment.CurrencyRate,
    PaymentType: payment.PaymentType,
    Status: payment.Status,
    IsReconciled: payment.IsReconciled,
    HasAccount: true,
    HasValidationErrors: false,
    UpdatedDateUTC: wireInstant(payment.UpdatedDateUTC),
    Account: compact({ AccountID: payment.AccountID, Code: account?.Code ?? null, Name: account?.Name ?? null }),
    Invoice: compact({
      InvoiceID: payment.InvoiceID,
      InvoiceNumber: invoice?.InvoiceNumber ?? null,
      Type: invoice?.Type ?? null,
      Contact: contact === null ? null : { ContactID: contact.ContactID, Name: contact.Name },
    }),
  });
}

export const PAYMENT_FIELDS = new Map([
  ["PaymentID", "guid"],
  ["Date", "date"],
  ["Amount", "number"],
  ["Reference", "string"],
  ["Status", "string"],
  ["PaymentType", "string"],
  ["IsReconciled", "boolean"],
  ["Invoice.InvoiceID", "guid"],
  ["Invoice.InvoiceNumber", "string"],
  ["Account.AccountID", "guid"],
  ["Account.Code", "string"],
  ["UpdatedDateUTC", "date"],
]);

export function paymentRecord(payment, lookups) {
  const invoice = lookups.invoice(payment.InvoiceID);
  const account = lookups.account(payment.AccountID);
  return new Map([
    ["PaymentID", payment.PaymentID],
    ["Date", dateMs(payment.Date)],
    ["Amount", payment.Amount],
    ["Reference", payment.Reference],
    ["Status", payment.Status],
    ["PaymentType", payment.PaymentType],
    ["IsReconciled", payment.IsReconciled],
    ["Invoice.InvoiceID", payment.InvoiceID],
    ["Invoice.InvoiceNumber", invoice?.InvoiceNumber ?? null],
    ["Account.AccountID", payment.AccountID],
    ["Account.Code", account?.Code ?? null],
    ["UpdatedDateUTC", Date.parse(payment.UpdatedDateUTC)],
  ]);
}
