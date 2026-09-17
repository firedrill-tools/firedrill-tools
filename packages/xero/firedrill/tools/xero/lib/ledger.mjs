// Invoice ledger rules: line items, totals and tax, account and tax-type checks, status transitions, payment effects.
import { basisPoints, fromCents, fromScaled4, lineCents, taxCents, toCents, toScaled4 } from "./money.mjs";
import { drawGuid, hasOwn, isGuid, own } from "./util.mjs";

export const LINE_AMOUNT_TYPES = new Set(["Exclusive", "Inclusive", "NoTax"]);

/** Account code → account row, built once per session. */
export function accountByCode(s, code) {
  if (s.accountIndex === undefined) {
    s.accountIndex = new Map();
    for (const account of s.rows("accounts").values()) s.accountIndex.set(account.Code, account);
  }
  return s.accountIndex.get(code) ?? null;
}

/** Can this account be used on a line of this document type? */
export function accountFitsDocument(account, type) {
  if (account === null || account.Status !== "ACTIVE" || account.Type === "BANK" || account.SystemAccount !== null) return false;
  return type === "ACCPAY" ? account.Class !== "REVENUE" : account.Class !== "EXPENSE";
}

function taxRateFor(s, taxType, type, errors) {
  const rate = typeof taxType === "string" && taxType.length <= 50 ? s.get("tax-rates", taxType) : null;
  const applies = rate !== null && rate.Status === "ACTIVE" && (type === "ACCPAY" ? rate.CanApplyToExpenses : rate.CanApplyToRevenue);
  if (!applies) {
    errors.push(`The TaxType code '${String(taxType).slice(0, 50)}' does not exist or cannot be used with this type of document.`);
    return null;
  }
  return rate;
}

/** Build stored line items from caller lines. Returns { lines, errors }. */
export function buildLines(s, rawLines, type, lineAmountTypes, existingLines = []) {
  const errors = [];
  if (!Array.isArray(rawLines) || rawLines.length > 250) return { lines: [], errors: ["LineItems must be a list of at most 250 lines"] };
  const existingIds = new Set(existingLines.map((line) => line.LineItemID));
  const lines = [];
  for (const raw of rawLines) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push("Each line item must be an object");
      continue;
    }
    const lineErrors = [];
    const text = (field, max) => {
      const value = own(raw, field);
      if (value === undefined || value === null || value === "") return null;
      if (typeof value !== "string" || value.length > max) return lineErrors.push(`${field} must be text of at most ${max} characters`), null;
      return value;
    };
    const description = text("Description", 4000);
    const itemCode = text("ItemCode", 30);
    const accountCode = text("AccountCode", 10);
    const quantity4 = hasOwn(raw, "Quantity") && raw.Quantity !== null ? toScaled4(raw.Quantity) : 10000;
    const unit4 = hasOwn(raw, "UnitAmount") && raw.UnitAmount !== null ? toScaled4(raw.UnitAmount) : 0;
    if (quantity4 === null || quantity4 < 0) lineErrors.push("Quantity must be a number of zero or more");
    if (unit4 === null) lineErrors.push("UnitAmount must be a number");
    if (Array.isArray(own(raw, "Tracking")) && raw.Tracking.length > 0) lineErrors.push("Tracking categories are not supported by this Tool");
    for (const field of ["DiscountRate", "DiscountAmount"]) if (own(raw, field) !== undefined && raw[field] !== null && raw[field] !== 0) lineErrors.push(`${field} is not supported by this Tool`);
    let account = null;
    if (accountCode !== null) {
      account = accountByCode(s, accountCode);
      if (!accountFitsDocument(account, type)) lineErrors.push(`Account code '${accountCode}' is not a valid code for this document.`);
    }
    let taxType = text("TaxType", 50);
    if (taxType === null) taxType = lineAmountTypes === "NoTax" ? "NONE" : account !== null ? account.TaxType : null;
    const rate = taxType === null ? null : taxRateFor(s, taxType, type, lineErrors);
    let amount = null;
    if (quantity4 !== null && unit4 !== null) {
      amount = lineCents(quantity4, unit4);
      if (amount === null) lineErrors.push("LineAmount is too large");
    }
    if (lineErrors.length > 0 || amount === null) {
      errors.push(...lineErrors);
      continue;
    }
    const tax = rate === null ? 0 : taxCents(amount, basisPoints(rate.EffectiveRate), lineAmountTypes);
    const givenId = own(raw, "LineItemID");
    const lineId = isGuid(givenId) && existingIds.has(givenId.toLowerCase()) ? givenId.toLowerCase() : drawGuid(s.context);
    lines.push({
      LineItemID: lineId, Description: description, Quantity: fromScaled4(quantity4), UnitAmount: fromScaled4(unit4), ItemCode: itemCode,
      AccountCode: accountCode, TaxType: taxType, TaxAmount: fromCents(tax), LineAmount: fromCents(amount), DiscountRate: null,
    });
  }
  return { lines, errors };
}

/** SubTotal, TotalTax and Total of stored lines. */
export function totalsOf(lines, lineAmountTypes) {
  let sum = 0;
  let tax = 0;
  for (const line of lines) {
    sum += toCents(line.LineAmount) ?? 0;
    tax += toCents(line.TaxAmount) ?? 0;
  }
  const subTotal = lineAmountTypes === "Inclusive" ? sum - tax : sum;
  return { SubTotal: fromCents(subTotal), TotalTax: fromCents(tax), Total: fromCents(subTotal + tax) };
}

/** Status transition check; returns an error message or null. */
export function transitionError(invoice, next) {
  const from = invoice.Status;
  if (from === "PAID" || from === "VOIDED" || from === "DELETED") return "Invoice not of valid status for modification";
  if (next === "PAID") return "Invoice status PAID cannot be set directly; record a payment instead";
  if (from === "AUTHORISED") {
    if (next === "VOIDED") return (toCents(invoice.AmountPaid) ?? 0) > 0 ? "Payment must be deleted before the invoice can be voided" : null;
    if (next !== "AUTHORISED") return "Invoice not of valid status for modification";
    return null;
  }
  if (next === "VOIDED") return "Only AUTHORISED invoices can be voided";
  return null;
}

/** Checks for SUBMITTED and AUTHORISED documents. */
export function approvalErrors(s, invoice, contact) {
  const errors = [];
  if (contact === null || contact.ContactStatus !== "ACTIVE") errors.push("The contact is archived and cannot be used on an approved document");
  if (invoice.LineItems.length === 0) errors.push("At least one line item is required to approve a document");
  for (const line of invoice.LineItems) {
    if (line.AccountCode === null) errors.push("Every line item needs an AccountCode before the document can be approved");
    if (line.TaxType === null) errors.push("Every line item needs a TaxType before the document can be approved");
  }
  if (invoice.DueDate === null && invoice.Type === "ACCREC") errors.push("Due Date is required.");
  else if (invoice.DueDate !== null && invoice.DueDate < invoice.Date) errors.push("Due Date must not be before the invoice Date.");
  if (s.org.PeriodLockDate !== null && invoice.Date <= s.org.PeriodLockDate) errors.push(`The document date must be after the period lock date (${s.org.PeriodLockDate}).`);
  if ((toCents(invoice.Total) ?? 0) < 0) errors.push("Invoice total cannot be negative.");
  return [...new Set(errors)];
}

/** Recompute AmountPaid, Status and FullyPaidOnDate from the invoice's non-DELETED payments. */
export function applyPayments(s, invoice) {
  let paid = 0;
  let latest = null;
  for (const id of invoice.paymentIds) {
    const payment = s.get("payments", id);
    if (payment === null || payment.Status === "DELETED") continue;
    paid += toCents(payment.Amount) ?? 0;
    if (latest === null || payment.Date > latest) latest = payment.Date;
  }
  const next = { ...invoice, AmountPaid: fromCents(paid), UpdatedDateUTC: s.clock.iso };
  const due = (toCents(invoice.Total) ?? 0) - paid;
  if (next.Status === "AUTHORISED" && due <= 0 && paid > 0) {
    next.Status = "PAID";
    next.FullyPaidOnDate = latest;
  } else if (next.Status === "PAID" && due > 0) {
    next.Status = "AUTHORISED";
    next.FullyPaidOnDate = null;
  }
  return next;
}
