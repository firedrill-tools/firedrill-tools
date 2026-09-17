// Invoice entity: rendering (computed LinkedTxn and subtotal line), create / update / void / delete / send, and the
// MCP argument mappings. Balances follow linked payments; every write bumps SyncToken and emits invoice.changed.
import { NOT_FOUND_DETAIL, bumpToken, load, staleCheck } from "./access.mjs";
import { RESERVED_KEYS, USD, clip, fromCents, padId, toCents } from "./common.mjs";
import { updateTarget } from "./customers.mjs";
import { has, isObject, own, validEmail } from "./fields.mjs";
import { draftInvoice } from "./invoice-draft.mjs";
import { refName } from "./items.mjs";

export function renderInvoice(s, row) {
  const links = s.applied().get(row.Id)?.paymentIds ?? [];
  let subtotal = 0;
  const lines = row.Line.map((line) => {
    subtotal += toCents(line.Amount) ?? 0;
    const detail = line.SalesItemLineDetail;
    const out = {
      Id: line.Id,
      LineNum: line.LineNum,
      Amount: line.Amount,
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: { ItemRef: refName(s, "items", detail.ItemRef, "Name"), Qty: detail.Qty, UnitPrice: detail.UnitPrice, TaxCodeRef: detail.TaxCodeRef },
    };
    if (line.Description !== null) out.Description = line.Description;
    if (detail.ServiceDate !== null) out.SalesItemLineDetail.ServiceDate = detail.ServiceDate;
    return out;
  });
  lines.push({ Amount: fromCents(subtotal), DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} });
  const out = {
    Id: row.Id,
    SyncToken: row.SyncToken,
    domain: "QBO",
    sparse: false,
    MetaData: row.MetaData,
    DocNumber: row.DocNumber,
    TxnDate: row.TxnDate,
    DueDate: row.DueDate,
    CurrencyRef: USD,
    LinkedTxn: links.map((id) => ({ TxnId: id, TxnType: "Payment" })),
    Line: lines,
    TxnTaxDetail: { TotalTax: 0 },
    CustomerRef: refName(s, "customers", row.CustomerRef, "DisplayName"),
    TotalAmt: row.TotalAmt,
    ApplyTaxAfterDiscount: false,
    PrintStatus: row.PrintStatus,
    EmailStatus: row.EmailStatus,
    Balance: row.Balance,
  };
  for (const key of ["SalesTermRef", "BillEmail", "BillAddr", "CustomerMemo", "PrivateNote", "DeliveryInfo"]) if (row[key] !== null) out[key] = row[key];
  return out;
}

export function saveInvoice(s, body, current, sparse, allowDuplicate) {
  const { next, docNumber } = draftInvoice(s, body, current, sparse);
  const applied = current === null ? 0 : (s.applied().get(current.Id)?.cents ?? 0);
  if (current !== null && applied > 0 && next.CustomerRef.value !== current.CustomerRef.value) {
    s.fail("BUSINESS_VALIDATION", "The customer can't be changed while payments are applied to this invoice.", "CustomerRef");
  }
  const total = toCents(next.TotalAmt) ?? 0;
  if (total < applied) s.fail("BUSINESS_VALIDATION", `The invoice total can't be less than the ${fromCents(applied).toFixed(2)} already received for it.`, "Line");
  next.Balance = fromCents(total - applied);
  const invoices = s.rows("invoices");
  if (typeof docNumber === "string") {
    if (!allowDuplicate && (current === null || current.DocNumber !== docNumber)) {
      const other = invoices.find((row) => row.DocNumber === docNumber && (current === null || row.Id !== current.Id));
      if (other !== undefined) {
        s.fail("DUPLICATE_DOC_NUMBER", `Duplicate Document Number Error : You must specify a different number. This number has already been used. DocNumber=${clip(docNumber, 21)} is assigned to TxnType=Invoice with TxnId=${other.Id}`, "DocNumber");
      }
    }
    next.DocNumber = docNumber;
  } else if (current === null) {
    const used = new Set(invoices.map((row) => row.DocNumber));
    let n = s.counter("docNumber");
    while (used.has(String(n))) n += 1;
    next.DocNumber = String(n);
    s.setCounter("docNumber", n + 1);
  }
  if (current === null) {
    next.Id = s.nextId("invoice", "invoices");
    next.SyncToken = "0";
    next.MetaData = { CreateTime: s.clock.meta, LastUpdatedTime: s.clock.meta };
  } else {
    next.SyncToken = bumpToken(current);
    next.MetaData = { CreateTime: current.MetaData.CreateTime, LastUpdatedTime: s.clock.meta };
  }
  s.put("invoices", next);
  s.emit("invoice.changed", "Invoice", next.Id, current === null ? "Create" : "Update");
  return { row: next, action: current === null ? "create" : "update" };
}

/** Remove this invoice's lines from every payment linked to it (payments keep TotalAmt and become unapplied). */
function unlinkPayments(s, invoiceId) {
  const paymentIds = [...(s.applied().get(invoiceId)?.paymentIds ?? [])];
  for (const paymentId of paymentIds) {
    const payment = s.get("payments", paymentId);
    if (payment === null) continue;
    const lines = payment.Line.filter((line) => line.LinkedTxn[0].TxnId !== invoiceId);
    s.put("payments", { ...payment, Line: lines, SyncToken: bumpToken(payment), MetaData: { ...payment.MetaData, LastUpdatedTime: s.clock.meta } });
    s.emit("payment.changed", "Payment", paymentId, "Update");
  }
}

export function voidInvoice(s, current) {
  if (current.voided) s.fail("BUSINESS_VALIDATION", "This invoice is already voided.", "Id");
  unlinkPayments(s, current.Id);
  const next = {
    ...current,
    Line: current.Line.map((line) => ({ ...line, Amount: 0 })),
    TotalAmt: 0,
    Balance: 0,
    voided: true,
    PrivateNote: current.PrivateNote === null ? "Voided" : `Voided - ${current.PrivateNote}`.slice(0, 4000),
    SyncToken: bumpToken(current),
    MetaData: { ...current.MetaData, LastUpdatedTime: s.clock.meta },
  };
  s.put("invoices", next);
  s.emit("invoice.changed", "Invoice", current.Id, "Void");
  return { row: next, action: "void" };
}

export function deleteInvoice(s, current) {
  unlinkPayments(s, current.Id);
  s.remove("invoices", current.Id);
  s.emit("invoice.changed", "Invoice", current.Id, "Delete");
  return { row: current, action: "delete" };
}

export function sendInvoice(s, id, sendTo) {
  const current = load(s, "invoices", id);
  if (sendTo !== undefined) {
    if (sendTo.includes(",") || sendTo.includes(";")) s.fail("BUSINESS_VALIDATION", "Only one e-mail address can be specified in sendTo.", "sendTo");
    if (sendTo.includes("\uFFFD")) s.fail("BUSINESS_VALIDATION", "Invalid Email Address format : Please enter a valid email address.", "sendTo");
    if (!validEmail(sendTo)) s.fail("BUSINESS_VALIDATION", "Invalid Email Address format : Please enter a valid email address.", "sendTo");
  }
  const address = sendTo ?? current.BillEmail?.Address;
  if (address === undefined) s.fail("BUSINESS_VALIDATION", "Email address is missing: supply sendTo or set BillEmail on the invoice before sending it.", "BillEmail");
  const prefix = `${padId(current.Id)}/`;
  let count = 0;
  for (const record of s.context.state.scan("deliveries", { afterRowId: prefix, limit: 10000 })) {
    if (!record.rowId.startsWith(prefix)) break;
    count += 1;
  }
  if (count >= 9999) s.fail("BUSINESS_VALIDATION", "This invoice has reached the supported number of sends.", "Id");
  const next = {
    ...current,
    BillEmail: { Address: address },
    EmailStatus: "EmailSent",
    DeliveryInfo: { DeliveryType: "Email", DeliveryTime: s.clock.meta },
    SyncToken: bumpToken(current),
    MetaData: { ...current.MetaData, LastUpdatedTime: s.clock.meta },
  };
  s.put("invoices", next);
  s.context.state.put("deliveries", `${prefix}${String(count + 1).padStart(4, "0")}`, {
    invoiceId: current.Id,
    sendTo: address,
    deliveryTime: s.clock.meta,
    actorId: s.context.actor.id,
    source: "invoices.send",
  });
  s.emit("invoice.changed", "Invoice", current.Id, "Emailed");
  return next;
}

export function invoicesPost(s, input) {
  const operation = input.operation;
  const body = input.body;
  if (operation === undefined || operation === "update") {
    const hasId = has(body, "Id") && body.Id !== null;
    if (operation === "update" && !hasId) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Id", "Id");
    const current = hasId ? updateTarget(s, "invoices", body, "Id") : null;
    if (has(body, "sparse") && typeof body.sparse !== "boolean") s.fail("BUSINESS_VALIDATION", "Invalid value for sparse: expected true or false", "sparse");
    return saveInvoice(s, body, current, current !== null && body.sparse === true, input.include === "allowduplicatedocnum");
  }
  if (operation === "void" || operation === "delete") {
    if (!isObject(body)) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Invoice object", "Invoice");
    const current = updateTarget(s, "invoices", body, "Id");
    return operation === "void" ? voidInvoice(s, current) : deleteInvoice(s, current);
  }
  return s.fail("BUSINESS_VALIDATION", `Operation ${clip(String(operation), 32)} is not supported for Invoice.`, "operation");
}

/** create_invoice (MCP argument shape) → Invoice body. */
export function invoiceBodyFromMcp(input) {
  const body = {
    CustomerRef: { value: input.customer_ref },
    Line: (Array.isArray(input.line_items) ? input.line_items : []).map((item) => {
      const detail = { ItemRef: { value: own(item, "item_ref") }, Qty: own(item, "qty"), UnitPrice: own(item, "unit_price") };
      if (own(item, "tax_code_ref") !== undefined) detail.TaxCodeRef = { value: item.tax_code_ref };
      if (own(item, "service_date") !== undefined) detail.ServiceDate = item.service_date;
      const line = { DetailType: "SalesItemLineDetail", SalesItemLineDetail: detail };
      if (own(item, "description") !== undefined) line.Description = item.description;
      return line;
    }),
  };
  if (input.doc_number !== undefined) body.DocNumber = input.doc_number;
  if (input.txn_date !== undefined) body.TxnDate = input.txn_date;
  if (input.customer_memo !== undefined) body.CustomerMemo = { value: input.customer_memo };
  if (input.sales_term_ref !== undefined) body.SalesTermRef = { value: input.sales_term_ref };
  if (input.bill_email !== undefined) body.BillEmail = { Address: input.bill_email };
  if (input.global_tax_calculation !== undefined) body.GlobalTaxCalculation = input.global_tax_calculation;
  return body;
}

/** update_invoice: sparse update of `patch`; a missing SyncToken means the current one (the MCP server reads it first). */
export function updateInvoiceFromMcp(s, invoiceId, patch) {
  const current = load(s, "invoices", invoiceId, "invoice_id");
  if (!isObject(patch)) s.fail("BUSINESS_VALIDATION", "Invalid value for patch: expected an object", "patch");
  for (const key of Object.keys(patch)) if (RESERVED_KEYS.has(key)) s.fail("BUSINESS_VALIDATION", `Request has invalid or unsupported property : Property Name:${key} specified is unsupported or invalid`, key);
  const body = { ...patch, Id: current.Id, sparse: true };
  const token = own(patch, "SyncToken");
  body.SyncToken = token === undefined || token === null ? current.SyncToken : typeof token === "string" || typeof token === "number" ? String(token) : null;
  staleCheck(s, current, body.SyncToken);
  return saveInvoice(s, body, current, true, false);
}

export function entityRef(s, namespace, idOrEntity) {
  let id = "";
  let token;
  if (typeof idOrEntity === "string") id = idOrEntity;
  else if (isObject(idOrEntity)) {
    const rawId = own(idOrEntity, "Id");
    id = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
    const rawToken = own(idOrEntity, "SyncToken");
    if (rawToken !== undefined) token = typeof rawToken === "string" || typeof rawToken === "number" ? String(rawToken) : null;
  }
  const row = s.get(namespace, id);
  if (row === null) s.fail("OBJECT_NOT_FOUND", NOT_FOUND_DETAIL, "Id");
  if (token !== undefined) staleCheck(s, row, token);
  return row;
}
