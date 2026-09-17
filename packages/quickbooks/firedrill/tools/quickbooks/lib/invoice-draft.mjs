// Parsing and validation of an invoice body (create, full update, sparse update) into a stored invoice row.
import { TERMS, clip, dateFromDay, dayNumber, fromCents, lineCents, toCents, toScaled4, utf8Bytes } from "./common.mjs";
import { checkKeys, has, isObject, optAddr, optDate, optEmail, optEnum, optRef, optString, own } from "./fields.mjs";

const WRITABLE = new Set(["DocNumber", "TxnDate", "DueDate", "CustomerRef", "SalesTermRef", "BillEmail", "BillAddr", "Line", "CustomerMemo", "PrivateNote", "EmailStatus", "PrintStatus", "GlobalTaxCalculation"]);
const READONLY = new Set(["Id", "SyncToken", "sparse", "domain", "MetaData", "TotalAmt", "Balance", "LinkedTxn", "TxnTaxDetail", "CurrencyRef", "ApplyTaxAfterDiscount", "DeliveryInfo"]);
const LINE_KEYS = new Set(["Id", "LineNum", "Description", "Amount", "DetailType", "SalesItemLineDetail", "SubTotalLineDetail", "LineEx"]);
const DETAIL_KEYS = new Set(["ItemRef", "Qty", "UnitPrice", "ServiceDate", "TaxCodeRef"]);
/**
 * Upper bound on the JSON-encoded UTF-8 bytes of all line Descriptions on one invoice, measured as the text is returned
 * (`JSON.stringify` without the surrounding quotes, so `\n`, `"` and `\\` count 2 bytes and control characters 6, while
 * CJK counts its 3 UTF-8 bytes). Each Description may be 4,000 characters and an invoice 250 lines, so without this bound a
 * stored invoice could render to 3-6 MB — over the framework's 1 MiB response cap for GET, PDF and query alike. With it, a
 * maximal invoice (600 KB of encoded descriptions plus at most about 250 KB of other line and header fields) always fits
 * one query page; `evaluate` in query-eval.mjs stays the last line of defence for any single row over RESPONSE_BYTE_BUDGET.
 */
export const INVOICE_DESCRIPTION_BYTES = 600_000;
/** Bytes a string occupies inside a JSON response, without its two quotes: the size that counts against the response cap. */
export function encodedBytes(text) {
  return utf8Bytes(JSON.stringify(text)) - 2;
}
export const INACTIVE_DETAIL = "Invalid Reference Id : Something you're trying to use has been made inactive. Check the fields with accounts, customers, items, vendors or employees.";

/** Sales lines → stored lines and total cents. SubTotalLineDetail lines echoed back by clients are ignored. */
export function parseLines(s, raw, currentLines) {
  if (!Array.isArray(raw)) s.fail("BUSINESS_VALIDATION", "Invalid value for Line: expected an array of lines", "Line");
  if (raw.length > 251) s.fail("BUSINESS_VALIDATION", "An invoice can have at most 250 lines.", "Line");
  const existing = new Set((currentLines ?? []).map((line) => line.SalesItemLineDetail.ItemRef.value));
  const lines = [];
  let total = 0;
  let descriptionBytes = 0;
  for (const [index, line] of raw.entries()) {
    const at = `Line[${index}]`;
    if (!isObject(line)) s.fail("BUSINESS_VALIDATION", `Invalid value for ${at}: expected a line object`, at);
    for (const key of Object.keys(line)) if (!LINE_KEYS.has(key)) s.fail("BUSINESS_VALIDATION", `Request has invalid or unsupported property : Property Name:${clip(key, 80)} specified is unsupported or invalid`, at);
    if (line.DetailType === "SubTotalLineDetail") continue;
    if (!has(line, "DetailType") || line.DetailType === null) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Line.DetailType", `${at}.DetailType`);
    if (line.DetailType !== "SalesItemLineDetail") s.fail("BUSINESS_VALIDATION", "Only SalesItemLineDetail lines are supported by this company (no discount, group or description-only lines).", `${at}.DetailType`);
    const detail = own(line, "SalesItemLineDetail");
    if (!isObject(detail)) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: SalesItemLineDetail", `${at}.SalesItemLineDetail`);
    for (const key of Object.keys(detail)) if (!DETAIL_KEYS.has(key)) s.fail("BUSINESS_VALIDATION", `Request has invalid or unsupported property : Property Name:${clip(key, 80)} specified is unsupported or invalid`, at);
    const itemId = optRef(s, detail, "ItemRef");
    if (typeof itemId !== "string") s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: ItemRef", `${at}.SalesItemLineDetail.ItemRef`);
    const item = s.get("items", itemId);
    if (item === null) s.fail("INVALID_REFERENCE", `Invalid Reference Id : Item assigned to line ${index + 1} does not exist: ${clip(itemId, 64)}`, `${at}.SalesItemLineDetail.ItemRef`);
    if (!item.Active && !existing.has(item.Id)) s.fail("INVALID_REFERENCE", INACTIVE_DETAIL, `${at}.SalesItemLineDetail.ItemRef`);
    const qty = has(detail, "Qty") && detail.Qty !== null ? detail.Qty : 1;
    const qtyScaled = toScaled4(qty, 999_999);
    if (qtyScaled === null || qtyScaled === 0) s.fail("BUSINESS_VALIDATION", "Qty must be a number greater than zero with at most four decimals.", `${at}.SalesItemLineDetail.Qty`);
    const price = has(detail, "UnitPrice") && detail.UnitPrice !== null ? detail.UnitPrice : item.UnitPrice;
    const priceScaled = toScaled4(price, 999_999_999);
    if (priceScaled === null) s.fail("BUSINESS_VALIDATION", "UnitPrice must be a non-negative number with at most four decimals.", `${at}.SalesItemLineDetail.UnitPrice`);
    const cents = lineCents(qtyScaled, priceScaled);
    if (has(line, "Amount") && line.Amount !== null && toCents(line.Amount) !== cents) {
      s.fail("BUSINESS_VALIDATION", `Amount is not equal to UnitPrice * Qty. Supplied value:${clip(String(line.Amount), 40)}`, `${at}.Amount`);
    }
    const description = optString(s, line, "Description", 4000);
    const serviceDate = optDate(s, detail, "ServiceDate");
    const taxCode = optRef(s, detail, "TaxCodeRef");
    if (typeof taxCode === "string" && taxCode !== "TAX" && taxCode !== "NON") s.fail("BUSINESS_VALIDATION", "TaxCodeRef must be TAX or NON for this US company.", `${at}.SalesItemLineDetail.TaxCodeRef`);
    total += cents;
    const storedDescription = description === undefined ? item.Description : description;
    if (typeof storedDescription === "string") descriptionBytes += encodedBytes(storedDescription);
    if (descriptionBytes > INVOICE_DESCRIPTION_BYTES) {
      s.fail("BUSINESS_VALIDATION", `The line descriptions on this invoice total more than 600,000 bytes of text as returned (JSON-encoded, including descriptions inherited from items); shorten the descriptions or split the invoice.`, `${at}.Description`);
    }
    lines.push({
      Id: String(lines.length + 1),
      LineNum: lines.length + 1,
      Description: storedDescription,
      Amount: fromCents(cents),
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        ItemRef: { value: item.Id, name: item.Name },
        Qty: qty,
        UnitPrice: price,
        ServiceDate: serviceDate ?? null,
        TaxCodeRef: { value: typeof taxCode === "string" ? taxCode : item.Taxable ? "TAX" : "NON" },
      },
    });
  }
  if (lines.length === 0) s.fail("BUSINESS_VALIDATION", "You must fill out at least one split line.", "Line");
  if (lines.length > 250) s.fail("BUSINESS_VALIDATION", "An invoice can have at most 250 lines.", "Line");
  if (total > 99_999_999_999) s.fail("BUSINESS_VALIDATION", "The invoice total exceeds the supported maximum.", "Line");
  return { lines, total };
}

/** Body → next invoice row fields (Id, SyncToken, MetaData, DocNumber, balances are completed by the caller). */
export function draftInvoice(s, body, current, sparse) {
  if (!isObject(body)) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Invoice object", "Invoice");
  checkKeys(s, body, WRITABLE, READONLY);
  if (current !== null && current.voided) s.fail("BUSINESS_VALIDATION", "A voided invoice can't be changed.", "Id");
  const keep = (key) => current !== null && sparse && !has(body, key);
  const next = current === null ? { voided: false, DeliveryInfo: null, EmailStatus: "NotSet", PrintStatus: "NotSet" } : { ...current };

  let customer;
  if (keep("CustomerRef")) customer = s.get("customers", current.CustomerRef.value);
  else {
    const customerId = optRef(s, body, "CustomerRef");
    if (typeof customerId !== "string") s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: CustomerRef", "CustomerRef");
    customer = s.get("customers", customerId);
    if (customer === null) s.fail("INVALID_REFERENCE", `Invalid Reference Id : Customer assigned to this transaction does not exist: ${clip(customerId, 64)}`, "CustomerRef");
    const changed = current === null || current.CustomerRef.value !== customer.Id;
    if (!customer.Active && changed) s.fail("INVALID_REFERENCE", INACTIVE_DETAIL, "CustomerRef");
    next.CustomerRef = { value: customer.Id, name: customer.DisplayName };
  }
  if (!keep("Line")) {
    if (!has(body, "Line") || body.Line === null) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Line", "Line");
    const parsed = parseLines(s, body.Line, current === null ? null : current.Line);
    next.Line = parsed.lines;
    next.TotalAmt = fromCents(parsed.total);
  }
  const txnDate = optDate(s, body, "TxnDate");
  if (txnDate !== undefined && txnDate !== null) next.TxnDate = txnDate;
  else if (current === null) next.TxnDate = s.clock.date;

  const term = optRef(s, body, "SalesTermRef");
  if (typeof term === "string" && !TERMS.has(term)) s.fail("INVALID_REFERENCE", `Invalid Reference Id : Term assigned to this transaction does not exist: ${clip(term, 64)}`, "SalesTermRef");
  if (term !== undefined) next.SalesTermRef = typeof term === "string" ? { value: term, name: TERMS.get(term).name } : null;
  else if (current === null) next.SalesTermRef = customer !== null && customer.SalesTermRef !== null ? customer.SalesTermRef : null;
  else if (!sparse) next.SalesTermRef = null;

  const due = optDate(s, body, "DueDate");
  if (due !== undefined && due !== null) next.DueDate = due;
  else if (current === null || !sparse || due === null) {
    const days = next.SalesTermRef === null ? 30 : (TERMS.get(next.SalesTermRef.value)?.days ?? 30);
    next.DueDate = dateFromDay(dayNumber(next.TxnDate) + days);
  }
  if (dayNumber(next.DueDate) < dayNumber(next.TxnDate)) s.fail("BUSINESS_VALIDATION", "The due date can't be earlier than the invoice date.", "DueDate");

  const email = optEmail(s, body, "BillEmail");
  if (email !== undefined) next.BillEmail = email;
  else if (current === null) next.BillEmail = customer !== null ? customer.PrimaryEmailAddr : null;
  else if (!sparse) next.BillEmail = null;
  const addr = optAddr(s, body, "BillAddr");
  if (addr !== undefined) next.BillAddr = addr;
  else if (current === null) next.BillAddr = customer !== null ? customer.BillAddr : null;
  else if (!sparse) next.BillAddr = null;

  if (has(body, "CustomerMemo")) {
    const memo = body.CustomerMemo;
    if (memo === null) next.CustomerMemo = null;
    else {
      if (!isObject(memo) || Object.keys(memo).some((key) => key !== "value")) s.fail("BUSINESS_VALIDATION", "Invalid value for CustomerMemo: expected { value }", "CustomerMemo");
      const text = optString(s, memo, "value", 1000);
      next.CustomerMemo = typeof text === "string" ? { value: text } : null;
    }
  } else if (current === null || !sparse) next.CustomerMemo = null;
  const note = optString(s, body, "PrivateNote", 4000);
  if (note !== undefined) next.PrivateNote = note;
  else if (current === null || !sparse) next.PrivateNote = null;

  const emailStatus = optEnum(s, body, "EmailStatus", ["NotSet", "NeedToSend", "EmailSent"]);
  if (emailStatus === "EmailSent" && next.EmailStatus !== "EmailSent") s.fail("BUSINESS_VALIDATION", "EmailStatus EmailSent is set by sending the invoice.", "EmailStatus");
  if (emailStatus !== undefined) next.EmailStatus = emailStatus;
  const printStatus = optEnum(s, body, "PrintStatus", ["NotSet", "NeedToPrint", "PrintComplete"]);
  if (printStatus !== undefined) next.PrintStatus = printStatus;
  if (has(body, "GlobalTaxCalculation") && body.GlobalTaxCalculation !== "NotApplicable") {
    s.fail("BUSINESS_VALIDATION", "GlobalTaxCalculation is not applicable to this US company; only NotApplicable is accepted.", "GlobalTaxCalculation");
  }
  const currency = own(body, "CurrencyRef");
  if (currency !== undefined && currency !== null && own(currency, "value") !== "USD") s.fail("BUSINESS_VALIDATION", "Multicurrency is not enabled for this company: CurrencyRef must be USD.", "CurrencyRef");
  const docNumber = optString(s, body, "DocNumber", 21);
  return { next, docNumber, customer };
}
