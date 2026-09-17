// Merge a caller invoice element into a stored invoice (or a new one) following Xero's status and editing rules.
import { mergeContact, storeContact } from "./contact-rules.mjs";
import { parseDate } from "./dates.mjs";
import { LINE_AMOUNT_TYPES, approvalErrors, buildLines, totalsOf, transitionError } from "./ledger.mjs";
import { toCents } from "./money.mjs";
import { drawGuid, fold, hasOwn, normalGuid, own } from "./util.mjs";

const STATUSES = new Set(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"]);
const EDIT_KEYS_ALLOWED_WITH_PAYMENTS = new Set(["InvoiceID", "Status"]);

/** Set of ACCREC invoice numbers in use (non-DELETED) → invoiceId, built once per session. */
function numberIndex(s) {
  if (s.numberIndex === undefined) {
    s.numberIndex = new Map();
    for (const invoice of s.rows("invoices").values()) {
      if (invoice.Type === "ACCREC" && invoice.Status !== "DELETED" && invoice.InvoiceNumber !== "") s.numberIndex.set(invoice.InvoiceNumber, invoice.InvoiceID);
    }
  }
  return s.numberIndex;
}

function nextNumber(s, index) {
  const counters = s.get("meta", "counters") ?? {};
  let next = Number.isInteger(counters.invoiceNumber) && counters.invoiceNumber >= 1 ? counters.invoiceNumber : 1;
  for (let guard = 0; index.has(`INV-${String(next).padStart(4, "0")}`); guard += 1) {
    if (guard > s.bound) s.bound(`No free invoice number within the supported bound of ${s.bound} rows.`);
    next += 1;
  }
  s.put("meta", "counters", { ...counters, invoiceNumber: next + 1, contactNumber: Number.isInteger(counters.contactNumber) ? counters.contactNumber : 0 });
  return `INV-${String(next).padStart(4, "0")}`;
}

function resolveContact(s, element, errors) {
  const ref = own(element, "Contact");
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return errors.push("A Contact with a ContactID or Name is required"), { contact: null };
  if (hasOwn(ref, "ContactID") && ref.ContactID !== null) {
    const id = normalGuid(ref.ContactID);
    const contact = id === null ? null : s.get("contacts", id);
    if (contact === null) errors.push("The Contact could not be found (ContactID)");
    return { contact };
  }
  if (typeof own(ref, "Name") === "string" && ref.Name.trim().length > 0) {
    const folded = fold(ref.Name.trim());
    for (const contact of s.rows("contacts").values()) if (contact.ContactStatus === "ACTIVE" && fold(contact.Name) === folded) return { contact };
    return { contact: null, newName: ref.Name };
  }
  return errors.push("A Contact with a ContactID or Name is required"), { contact: null };
}

function dateField(element, field, errors, fallback) {
  if (!hasOwn(element, field)) return fallback;
  if (element[field] === null || element[field] === "") return null;
  const date = parseDate(element[field]);
  if (date === null) errors.push(`${field} must be a valid date`);
  return date ?? fallback;
}

/** Returns { invoice, errors, newContactName }. Writes nothing. */
export function mergeInvoice(s, element, existing) {
  const errors = [];
  if (existing !== null) {
    const statusError = transitionError(existing, hasOwn(element, "Status") ? element.Status : existing.Status);
    if (existing.Status === "PAID" || existing.Status === "VOIDED" || existing.Status === "DELETED") return { invoice: null, errors: ["Invoice not of valid status for modification"] };
    if ((toCents(existing.AmountPaid) ?? 0) > 0 && Object.keys(element).some((key) => !EDIT_KEYS_ALLOWED_WITH_PAYMENTS.has(key))) {
      return { invoice: null, errors: ["This document cannot be edited as it has a payment or credit allocated to it."] };
    }
    if (statusError !== null && hasOwn(element, "Status") && STATUSES.has(element.Status)) errors.push(statusError);
  }
  const type = existing?.Type ?? own(element, "Type");
  if (type !== "ACCREC" && type !== "ACCPAY") return { invoice: null, errors: ["Type must be ACCREC or ACCPAY"] };
  if (existing !== null && hasOwn(element, "Type") && element.Type !== existing.Type) errors.push("The Type of an existing invoice cannot be changed");
  const base = existing ?? {
    InvoiceID: null, Type: type, ContactID: null, InvoiceNumber: "", Reference: null, Date: s.clock.today, DueDate: null,
    LineAmountTypes: "Exclusive", LineItems: [], Status: "DRAFT", CurrencyCode: "NZD", CurrencyRate: 1, SentToContact: false,
    ExpectedPaymentDate: null, PlannedPaymentDate: null, SubTotal: 0, TotalTax: 0, Total: 0, AmountPaid: 0, paymentIds: [], FullyPaidOnDate: null,
    UpdatedDateUTC: s.clock.iso,
  };
  const next = { ...base, UpdatedDateUTC: s.clock.iso };
  let newContactName;
  if (existing === null || hasOwn(element, "Contact")) {
    const { contact, newName } = resolveContact(s, element, errors);
    if (contact !== null) next.ContactID = contact.ContactID;
    newContactName = newName;
  }
  if (hasOwn(element, "Status")) {
    if (!STATUSES.has(element.Status)) errors.push("Status must be DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED or DELETED");
    else if (existing === null && (element.Status === "PAID" || element.Status === "VOIDED" || element.Status === "DELETED")) errors.push(`A new invoice cannot be created with status ${element.Status}`);
    else next.Status = element.Status;
  }
  next.Date = dateField(element, "Date", errors, base.Date) ?? base.Date;
  next.DueDate = dateField(element, "DueDate", errors, base.DueDate);
  next.ExpectedPaymentDate = dateField(element, "ExpectedPaymentDate", errors, base.ExpectedPaymentDate);
  next.PlannedPaymentDate = dateField(element, "PlannedPaymentDate", errors, base.PlannedPaymentDate);
  if (hasOwn(element, "LineAmountTypes")) {
    if (!LINE_AMOUNT_TYPES.has(element.LineAmountTypes)) errors.push("LineAmountTypes must be Exclusive, Inclusive or NoTax");
    else next.LineAmountTypes = element.LineAmountTypes;
  }
  if (hasOwn(element, "Reference") && element.Reference !== null && element.Reference !== "") {
    if (type === "ACCPAY") errors.push("Reference is not valid on bills (ACCPAY); use InvoiceNumber");
    else if (typeof element.Reference !== "string" || element.Reference.length > 255) errors.push("Reference must be text of at most 255 characters");
    else next.Reference = element.Reference;
  } else if (hasOwn(element, "Reference")) next.Reference = null;
  if (hasOwn(element, "InvoiceNumber") && element.InvoiceNumber !== null) {
    const number = element.InvoiceNumber;
    if (typeof number !== "string" || number.length > 255) errors.push("InvoiceNumber must be text of at most 255 characters");
    else next.InvoiceNumber = number.trim();
  }
  if (hasOwn(element, "SentToContact")) {
    if (typeof element.SentToContact !== "boolean") errors.push("SentToContact must be true or false");
    else next.SentToContact = element.SentToContact;
  }
  if (hasOwn(element, "CurrencyCode") && element.CurrencyCode !== null && element.CurrencyCode !== "NZD") errors.push("CurrencyCode must be NZD (multicurrency is not supported by this Tool)");
  if (hasOwn(element, "BrandingThemeID") && element.BrandingThemeID !== null) errors.push("BrandingThemeID is not supported by this Tool");
  if (hasOwn(element, "LineItems") || next.LineAmountTypes !== base.LineAmountTypes) {
    const raw = hasOwn(element, "LineItems") ? element.LineItems : base.LineItems;
    const built = buildLines(s, raw, type, next.LineAmountTypes, base.LineItems);
    errors.push(...built.errors);
    next.LineItems = built.lines;
  }
  Object.assign(next, totalsOf(next.LineItems, next.LineAmountTypes));
  if (type === "ACCREC" && next.InvoiceNumber !== "") {
    const holder = numberIndex(s).get(next.InvoiceNumber);
    if (holder !== undefined && holder !== base.InvoiceID) errors.push("Invoice # must be unique.");
  }
  if (errors.length === 0 && (next.Status === "SUBMITTED" || next.Status === "AUTHORISED")) {
    const contact = next.ContactID === null ? (newContactName === undefined ? null : { ContactStatus: "ACTIVE" }) : s.get("contacts", next.ContactID);
    errors.push(...approvalErrors(s, next, contact));
  }
  return { invoice: next, errors: [...new Set(errors)], newContactName };
}

/** Persist a merged invoice (creating a contact by name when needed) and emit events. */
export function storeInvoice(s, merged, isNew) {
  const invoice = { ...merged.invoice };
  if (invoice.ContactID === null && merged.newContactName !== undefined) {
    const contact = mergeContact(s, { Name: merged.newContactName }, null);
    if (contact.errors.length > 0) s.validation(contact.errors, { Name: String(merged.newContactName).slice(0, 255) });
    invoice.ContactID = storeContact(s, contact.value, true).ContactID;
  }
  const index = numberIndex(s);
  if (isNew) {
    invoice.InvoiceID = drawGuid(s.context);
    if (invoice.Type === "ACCREC" && invoice.InvoiceNumber === "") invoice.InvoiceNumber = nextNumber(s, index);
  }
  if (invoice.Type === "ACCREC") {
    for (const [number, id] of index) if (id === invoice.InvoiceID) index.delete(number);
    if (invoice.Status !== "DELETED" && invoice.InvoiceNumber !== "") index.set(invoice.InvoiceNumber, invoice.InvoiceID);
  }
  s.put("invoices", invoice.InvoiceID, invoice);
  s.emit("invoice.changed", "Invoices", invoice.InvoiceID, isNew ? "CREATE" : "UPDATE", { status: invoice.Status });
  return invoice;
}

/** Element projection for error bodies (never names an id created in this call). */
export function invoiceElement(element, existing) {
  const out = {};
  if (typeof own(element, "Type") === "string") out.Type = element.Type.slice(0, 10);
  if (typeof own(element, "InvoiceNumber") === "string") out.InvoiceNumber = element.InvoiceNumber.slice(0, 255);
  if (existing !== null) {
    out.InvoiceID = existing.InvoiceID;
    out.InvoiceNumber = existing.InvoiceNumber;
    out.Status = existing.Status;
  }
  return out;
}
