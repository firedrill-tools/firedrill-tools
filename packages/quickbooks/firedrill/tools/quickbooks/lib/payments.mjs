// Payment entity (receive payment): rendering, create / update / void / delete, with invoice balances kept in sync.
import { bumpToken } from "./access.mjs";
import { USD, clip, fromCents, isId, toCents } from "./common.mjs";
import { updateTarget } from "./customers.mjs";
import { INACTIVE_DETAIL } from "./invoice-draft.mjs";
import { refName } from "./items.mjs";
import { checkKeys, has, isObject, optDate, optMoney, optRef, optString, own } from "./fields.mjs";

const WRITABLE = new Set(["CustomerRef", "TotalAmt", "TxnDate", "PaymentRefNum", "PaymentMethodRef", "DepositToAccountRef", "PrivateNote", "Line", "ProcessPayment", "CurrencyRef", "ExchangeRate"]);
const READONLY = new Set(["Id", "SyncToken", "sparse", "domain", "MetaData", "UnappliedAmt"]);

export function renderPayment(s, row) {
  const applied = row.Line.reduce((sum, line) => sum + (toCents(line.Amount) ?? 0), 0);
  const out = {
    CustomerRef: refName(s, "customers", row.CustomerRef, "DisplayName"),
    DepositToAccountRef: refName(s, "accounts", row.DepositToAccountRef, "Name"),
    TotalAmt: row.TotalAmt,
    UnappliedAmt: fromCents((toCents(row.TotalAmt) ?? 0) - applied),
    ProcessPayment: false,
    domain: "QBO",
    sparse: false,
    Id: row.Id,
    SyncToken: row.SyncToken,
    MetaData: row.MetaData,
    TxnDate: row.TxnDate,
    CurrencyRef: USD,
    Line: row.Line.map((line) => ({ Amount: line.Amount, LinkedTxn: line.LinkedTxn.map((txn) => ({ TxnId: txn.TxnId, TxnType: txn.TxnType })) })),
  };
  for (const key of ["PaymentRefNum", "PaymentMethodRef", "PrivateNote"]) if (row[key] !== null) out[key] = row[key];
  return out;
}

function perInvoice(lines) {
  const map = new Map();
  for (const line of lines) map.set(line.LinkedTxn[0].TxnId, (map.get(line.LinkedTxn[0].TxnId) ?? 0) + (toCents(line.Amount) ?? 0));
  return map;
}

/** Move invoice balances by (old − new) applied cents; one invoice.changed Update per touched invoice. */
function rebalance(s, oldLines, newLines) {
  const before = perInvoice(oldLines);
  const after = perInvoice(newLines);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => Number(a) - Number(b));
  for (const id of ids) {
    const delta = (before.get(id) ?? 0) - (after.get(id) ?? 0);
    if (delta === 0) continue;
    const invoice = s.get("invoices", id);
    if (invoice === null) continue;
    const balance = (toCents(invoice.Balance) ?? 0) + delta;
    s.put("invoices", { ...invoice, Balance: fromCents(Math.max(0, balance)), SyncToken: bumpToken(invoice), MetaData: { ...invoice.MetaData, LastUpdatedTime: s.clock.meta } });
    s.emit("invoice.changed", "Invoice", id, "Update");
  }
}

function parsePaymentLines(s, raw, customerId, currentLines, totalCents) {
  if (!Array.isArray(raw)) s.fail("BUSINESS_VALIDATION", "Invalid value for Line: expected an array", "Line");
  if (raw.length > 250) s.fail("BUSINESS_VALIDATION", "A payment can be applied to at most 250 transactions.", "Line");
  const previous = perInvoice(currentLines);
  const seen = new Set();
  const lines = [];
  let applied = 0;
  for (const [index, line] of raw.entries()) {
    const at = `Line[${index}]`;
    if (!isObject(line) || Object.keys(line).some((key) => key !== "Amount" && key !== "LinkedTxn" && key !== "LineEx")) s.fail("BUSINESS_VALIDATION", `Invalid value for ${at}: expected { Amount, LinkedTxn }`, at);
    const amount = toCents(line.Amount);
    if (amount === null || amount === 0) s.fail("BUSINESS_VALIDATION", "A payment line Amount must be greater than zero with at most two decimals.", `${at}.Amount`);
    const links = own(line, "LinkedTxn");
    if (!Array.isArray(links) || links.length !== 1 || !isObject(links[0])) s.fail("BUSINESS_VALIDATION", "Each payment line must link exactly one transaction.", `${at}.LinkedTxn`);
    if (own(links[0], "TxnType") !== "Invoice") s.fail("BUSINESS_VALIDATION", "Only Invoice transactions can be linked to a payment in this company.", `${at}.LinkedTxn.TxnType`);
    const rawId = own(links[0], "TxnId");
    const txnId = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
    const invoice = isId(txnId) ? s.get("invoices", txnId) : null;
    if (invoice === null) s.fail("INVALID_REFERENCE", `Invalid Reference Id : Invoice ${clip(txnId, 64)} linked to this payment does not exist`, `${at}.LinkedTxn.TxnId`);
    if (seen.has(invoice.Id)) s.fail("BUSINESS_VALIDATION", `Invoice ${invoice.Id} is linked by more than one line of this payment.`, `${at}.LinkedTxn.TxnId`);
    seen.add(invoice.Id);
    if (invoice.CustomerRef.value !== customerId) s.fail("BUSINESS_VALIDATION", `Invoice ${invoice.Id} belongs to another customer.`, `${at}.LinkedTxn.TxnId`);
    if (invoice.voided) s.fail("BUSINESS_VALIDATION", `Invoice ${invoice.Id} is voided and can't receive a payment.`, `${at}.LinkedTxn.TxnId`);
    const open = (toCents(invoice.Balance) ?? 0) + (previous.get(invoice.Id) ?? 0);
    if (amount > open) s.fail("BUSINESS_VALIDATION", `The payment amount applied to invoice ${invoice.Id} exceeds its open balance of ${fromCents(open).toFixed(2)}.`, `${at}.Amount`);
    applied += amount;
    lines.push({ Amount: fromCents(amount), LinkedTxn: [{ TxnId: invoice.Id, TxnType: "Invoice" }] });
  }
  if (applied > totalCents) s.fail("BUSINESS_VALIDATION", "The amount applied to transactions exceeds the payment amount (TotalAmt).", "Line");
  return lines;
}

export function savePayment(s, body, current, sparse) {
  if (!isObject(body)) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Payment object", "Payment");
  checkKeys(s, body, WRITABLE, READONLY);
  if (current !== null && current.voided) s.fail("BUSINESS_VALIDATION", "A voided payment can't be changed.", "Id");
  const keep = (key) => current !== null && sparse && !has(body, key);
  const next = current === null ? { voided: false } : { ...current };
  if (!keep("CustomerRef")) {
    const customerId = optRef(s, body, "CustomerRef");
    if (typeof customerId !== "string") s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: CustomerRef", "CustomerRef");
    const customer = s.get("customers", customerId);
    if (customer === null) s.fail("INVALID_REFERENCE", `Invalid Reference Id : Customer assigned to this transaction does not exist: ${clip(customerId, 64)}`, "CustomerRef");
    if (!customer.Active && (current === null || current.CustomerRef.value !== customer.Id)) s.fail("INVALID_REFERENCE", INACTIVE_DETAIL, "CustomerRef");
    next.CustomerRef = { value: customer.Id, name: customer.DisplayName };
  }
  if (!keep("TotalAmt")) {
    if (!has(body, "TotalAmt") || body.TotalAmt === null) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: TotalAmt", "TotalAmt");
    next.TotalAmt = fromCents(optMoney(s, body, "TotalAmt"));
  }
  const txnDate = optDate(s, body, "TxnDate");
  if (txnDate !== undefined && txnDate !== null) next.TxnDate = txnDate;
  else if (current === null) next.TxnDate = s.clock.date;
  for (const [key, max] of [["PaymentRefNum", 21], ["PrivateNote", 4000]]) {
    const value = optString(s, body, key, max);
    if (value !== undefined) next[key] = value;
    else if (current === null || !sparse) next[key] = null;
  }
  const method = optRef(s, body, "PaymentMethodRef");
  if (method !== undefined) next.PaymentMethodRef = method === null ? null : { value: method, name: typeof own(body.PaymentMethodRef, "name") === "string" ? body.PaymentMethodRef.name.slice(0, 100) : null };
  else if (current === null || !sparse) next.PaymentMethodRef = null;
  const depositId = optRef(s, body, "DepositToAccountRef");
  if (depositId !== undefined || current === null || !sparse) {
    const id = typeof depositId === "string" ? depositId : "4";
    const account = s.get("accounts", id);
    if (account === null || !account.Active || (account.AccountType !== "Bank" && account.AccountSubType !== "UndepositedFunds")) {
      s.fail("INVALID_REFERENCE", `Invalid Reference Id : Deposit account ${clip(id, 64)} does not exist or is not a bank or Undeposited Funds account.`, "DepositToAccountRef");
    }
    next.DepositToAccountRef = { value: account.Id, name: account.Name };
  }
  if (has(body, "ProcessPayment") && body.ProcessPayment !== false) s.fail("BUSINESS_VALIDATION", "Payment processing (ProcessPayment) is not available in this company.", "ProcessPayment");
  const currency = own(body, "CurrencyRef");
  if (currency !== undefined && currency !== null && own(currency, "value") !== "USD") s.fail("BUSINESS_VALIDATION", "Multicurrency is not enabled for this company: CurrencyRef must be USD.", "CurrencyRef");
  if (has(body, "ExchangeRate") && body.ExchangeRate !== 1) s.fail("BUSINESS_VALIDATION", "Multicurrency is not enabled for this company: ExchangeRate is not accepted.", "ExchangeRate");
  const oldLines = current === null ? [] : current.Line;
  if (!keep("Line") || !keep("CustomerRef") || !keep("TotalAmt")) {
    const raw = keep("Line") ? oldLines : has(body, "Line") && body.Line !== null ? body.Line : [];
    next.Line = parsePaymentLines(s, raw, next.CustomerRef.value, oldLines, toCents(next.TotalAmt));
  }
  if (current === null) {
    next.Id = s.nextId("payment", "payments");
    next.SyncToken = "0";
    next.MetaData = { CreateTime: s.clock.meta, LastUpdatedTime: s.clock.meta };
  } else {
    next.SyncToken = bumpToken(current);
    next.MetaData = { CreateTime: current.MetaData.CreateTime, LastUpdatedTime: s.clock.meta };
  }
  s.put("payments", next);
  s.emit("payment.changed", "Payment", next.Id, current === null ? "Create" : "Update");
  rebalance(s, oldLines, next.Line);
  return { row: next, action: current === null ? "create" : "update" };
}

export function voidPayment(s, current) {
  if (current.voided) s.fail("BUSINESS_VALIDATION", "This payment is already voided.", "Id");
  const note = current.PrivateNote === null ? "Voided" : `Voided - ${current.PrivateNote}`.slice(0, 4000);
  const next = { ...current, TotalAmt: 0, Line: [], voided: true, PrivateNote: note, SyncToken: bumpToken(current), MetaData: { ...current.MetaData, LastUpdatedTime: s.clock.meta } };
  s.put("payments", next);
  s.emit("payment.changed", "Payment", current.Id, "Void");
  rebalance(s, current.Line, []);
  return { row: next, action: "void" };
}

export function deletePayment(s, current) {
  s.remove("payments", current.Id);
  s.emit("payment.changed", "Payment", current.Id, "Delete");
  rebalance(s, current.Line, []);
  return { row: current, action: "delete" };
}

export function paymentsPost(s, input) {
  const operation = input.operation;
  if (operation === undefined || operation === "update") {
    const body = input.body;
    const hasId = has(body, "Id") && body.Id !== null;
    if (operation === "update" && !hasId) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Id", "Id");
    const current = hasId ? updateTarget(s, "payments", body, "Id") : null;
    if (has(body, "sparse") && typeof body.sparse !== "boolean") s.fail("BUSINESS_VALIDATION", "Invalid value for sparse: expected true or false", "sparse");
    return savePayment(s, body, current, current !== null && body.sparse === true);
  }
  if (operation === "void" || operation === "delete") {
    if (!isObject(input.body)) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Payment object", "Payment");
    const current = updateTarget(s, "payments", input.body, "Id");
    return operation === "void" ? voidPayment(s, current) : deletePayment(s, current);
  }
  return s.fail("BUSINESS_VALIDATION", `Operation ${clip(String(operation), 32)} is not supported for Payment.`, "operation");
}

/** create_payment (MCP argument shape) → Payment body. */
export function paymentBodyFromMcp(input) {
  const body = { CustomerRef: { value: input.customer_ref }, TotalAmt: input.total_amt };
  if (input.payment_method_ref !== undefined) body.PaymentMethodRef = { value: input.payment_method_ref };
  if (input.deposit_to_account_ref !== undefined) body.DepositToAccountRef = { value: input.deposit_to_account_ref };
  if (input.txn_date !== undefined) body.TxnDate = input.txn_date;
  if (input.private_note !== undefined) body.PrivateNote = input.private_note;
  if (input.payment_ref_num !== undefined) body.PaymentRefNum = input.payment_ref_num;
  if (input.currency_ref !== undefined) body.CurrencyRef = { value: input.currency_ref };
  if (input.exchange_rate !== undefined) body.ExchangeRate = input.exchange_rate;
  if (Array.isArray(input.line)) {
    body.Line = input.line.map((line) => ({
      Amount: own(line, "amount"),
      LinkedTxn: (Array.isArray(own(line, "linked_txn")) ? line.linked_txn : []).map((txn) => ({ TxnId: own(txn, "txn_id"), TxnType: own(txn, "txn_type") })),
    }));
  }
  return body;
}
