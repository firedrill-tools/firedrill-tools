// Payment writes: PUT/POST /Payments (batch), MCP create-payment, POST /Payments/{PaymentID} with Status DELETED.
import { elementsOf, failElements, lookupsOf, open } from "./access.mjs";
import { parseDate } from "./dates.mjs";
import { applyPayments, accountByCode } from "./ledger.mjs";
import { fromCents, toCents } from "./money.mjs";
import { renderPayment } from "./views-ref.mjs";
import { amountDue } from "./views-docs.mjs";
import { drawGuid, hasOwn, isRecord, normalGuid, own } from "./util.mjs";

function invoiceByNumber(s, number) {
  if (s.invoiceNumbers === undefined) {
    s.invoiceNumbers = new Map();
    for (const invoice of s.rows("invoices").values()) {
      if (invoice.Status !== "DELETED" && !s.invoiceNumbers.has(invoice.InvoiceNumber)) s.invoiceNumbers.set(invoice.InvoiceNumber, invoice.InvoiceID);
    }
  }
  const id = s.invoiceNumbers.get(number);
  return id === undefined ? null : s.get("invoices", id);
}

/** Validate and apply one payment element; returns { payment } or { errors }. Unknown invoice GUID → NOT_FOUND. */
function applyElement(s, element) {
  const errors = [];
  for (const target of ["CreditNote", "Prepayment", "Overpayment"]) if (isRecord(own(element, target))) errors.push(`Payments against a ${target} are not supported by this Tool`);
  const invoiceRef = own(element, "Invoice");
  let invoice = null;
  if (!isRecord(invoiceRef)) errors.push("An Invoice with an InvoiceID or InvoiceNumber is required");
  else if (hasOwn(invoiceRef, "InvoiceID") && invoiceRef.InvoiceID !== null) {
    const id = normalGuid(invoiceRef.InvoiceID);
    invoice = id === null ? null : s.get("invoices", id);
    if (invoice === null) s.notFound("Invoice could not be found");
  } else if (typeof own(invoiceRef, "InvoiceNumber") === "string" && invoiceRef.InvoiceNumber.length <= 255) {
    invoice = invoiceByNumber(s, invoiceRef.InvoiceNumber);
    if (invoice === null) errors.push(`Invoice number '${invoiceRef.InvoiceNumber}' could not be found`);
  } else errors.push("An Invoice with an InvoiceID or InvoiceNumber is required");
  const accountRef = own(element, "Account");
  let account = null;
  if (!isRecord(accountRef)) errors.push("An Account with an AccountID or Code is required");
  else if (hasOwn(accountRef, "AccountID") && accountRef.AccountID !== null) {
    const id = normalGuid(accountRef.AccountID);
    account = id === null ? null : s.get("accounts", id);
    if (account === null) errors.push("Account could not be found");
  } else if (typeof own(accountRef, "Code") === "string" && accountRef.Code.length <= 10) {
    account = accountByCode(s, accountRef.Code);
    if (account === null) errors.push(`Account code '${accountRef.Code}' could not be found`);
  } else errors.push("An Account with an AccountID or Code is required");
  if (account !== null && (account.Status !== "ACTIVE" || !(account.Type === "BANK" || account.EnablePaymentsToAccount === true))) {
    errors.push(`Account code '${account.Code}' is not a bank account or an account that accepts payments`);
  }
  const cents = toCents(own(element, "Amount"));
  if (cents === null || cents <= 0) errors.push("Payment amount must be greater than zero");
  let date = s.clock.today;
  if (hasOwn(element, "Date") && element.Date !== null) {
    date = parseDate(element.Date);
    if (date === null) errors.push("Date must be a valid date");
  }
  if (date !== null && s.org.PeriodLockDate !== null && date <= s.org.PeriodLockDate) errors.push(`The payment date must be after the period lock date (${s.org.PeriodLockDate}).`);
  const reference = own(element, "Reference");
  if (reference !== undefined && reference !== null && (typeof reference !== "string" || reference.length > 255)) errors.push("Reference must be text of at most 255 characters");
  if (invoice !== null) {
    if (invoice.Status !== "AUTHORISED") errors.push(`Payments can only be made against AUTHORISED invoices (this invoice is ${invoice.Status})`);
    else if (cents !== null && cents > (toCents(amountDue(invoice)) ?? 0)) errors.push("Payment amount exceeds the amount outstanding on this document.");
    if (invoice.paymentIds.length >= 250) errors.push("An invoice can have at most 250 payments");
  }
  if (errors.length > 0) return { errors: [...new Set(errors)] };
  const payment = {
    PaymentID: drawGuid(s.context), InvoiceID: invoice.InvoiceID, AccountID: account.AccountID, Date: date, Amount: fromCents(cents),
    BankAmount: fromCents(cents), CurrencyRate: 1, Reference: typeof reference === "string" && reference.length > 0 ? reference : null,
    IsReconciled: false, Status: "AUTHORISED", PaymentType: invoice.Type === "ACCPAY" ? "ACCPAYPAYMENT" : "ACCRECPAYMENT", UpdatedDateUTC: s.clock.iso,
  };
  s.put("payments", payment.PaymentID, payment);
  const updated = applyPayments(s, { ...invoice, paymentIds: [...invoice.paymentIds, payment.PaymentID] });
  s.put("invoices", updated.InvoiceID, updated);
  s.emit("invoice.changed", "Invoices", updated.InvoiceID, "UPDATE", { status: updated.Status });
  return { payment };
}

const paymentElement = (element) => {
  const out = {};
  const amount = own(element, "Amount");
  if (typeof amount === "number" && Number.isFinite(amount)) out.Amount = amount;
  const invoice = own(element, "Invoice");
  if (isRecord(invoice) && typeof own(invoice, "InvoiceNumber") === "string") out.Invoice = { InvoiceNumber: invoice.InvoiceNumber.slice(0, 255) };
  return out;
};

export const paymentWriteOperations = {
  "payments.create": (input, context) => {
    const s = open(context, input, "transactions", "write");
    if (input.idempotencyKeyProblem === true) s.validation("Idempotency-Key must be at most 128 characters");
    const elements = elementsOf(s, input, "Payments");
    const summarize = input.summarizeErrors !== false;
    const results = elements.map((element) => ({ element, ...applyElement(s, element) }));
    const failed = results.filter((r) => r.errors !== undefined).map((r) => ({ ...paymentElement(r.element), ValidationErrors: r.errors.map((Message) => ({ Message })) }));
    if (failed.length > 0 && summarize) failElements(s, failed);
    const lookups = lookupsOf(s);
    const Payments = results.map((r) => {
      if (r.errors !== undefined) return { ...paymentElement(r.element), ValidationErrors: r.errors.map((Message) => ({ Message })), StatusAttributeString: "ERROR" };
      const rendered = renderPayment(r.payment, lookups);
      return summarize ? rendered : { ...rendered, StatusAttributeString: "OK" };
    });
    return s.envelope({ Payments });
  },
  "payments.record": (input, context) => {
    const s = open(context, input, "transactions", "write");
    const element = { Invoice: { InvoiceID: input.invoiceId }, Account: { AccountID: input.accountId }, Amount: input.amount };
    if (input.date !== undefined) element.Date = input.date;
    if (input.reference !== undefined) element.Reference = input.reference;
    if (normalGuid(input.invoiceId) === null) s.notFound("Invoice could not be found");
    const result = applyElement(s, element);
    if (result.errors !== undefined) s.validation(result.errors, paymentElement(element));
    return renderPayment(result.payment, lookupsOf(s));
  },
  "payments.delete": (input, context) => {
    const s = open(context, input, "transactions", "write");
    if (input.idempotencyKeyProblem === true) s.validation("Idempotency-Key must be at most 128 characters");
    const id = normalGuid(input.paymentId);
    const payment = id === null ? null : s.get("payments", id);
    if (payment === null) s.notFound();
    if (typeof input.bodyProblem === "string") s.validation(input.bodyProblem);
    const element = { PaymentID: payment.PaymentID };
    if (!isRecord(input.body) || own(input.body, "Status") !== "DELETED") s.validation("Status must be DELETED to delete a payment", element);
    if (payment.Status === "DELETED") s.validation("This payment has already been deleted", element);
    if (payment.IsReconciled) s.validation("Payment cannot be deleted as it has been reconciled", element);
    const invoice = s.get("invoices", payment.InvoiceID);
    if (invoice !== null && invoice.Status === "VOIDED") s.validation("Payments on a voided invoice cannot be deleted", element);
    const deleted = { ...payment, Status: "DELETED", UpdatedDateUTC: s.clock.iso };
    s.put("payments", deleted.PaymentID, deleted);
    if (invoice !== null) {
      const updated = applyPayments(s, invoice);
      s.put("invoices", updated.InvoiceID, updated);
      s.emit("invoice.changed", "Invoices", updated.InvoiceID, "UPDATE", { status: updated.Status });
    }
    return s.envelope({ Payments: [renderPayment(deleted, lookupsOf(s))] });
  },
};
