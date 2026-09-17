// Payments inside batches: create, list, get (two paths), update, delete.
import { requireKey } from "../lib/access.mjs";
import { isId } from "../lib/ids.mjs";
import { filterText, pageArgs, pageOf, sortItems } from "../lib/paging.mjs";
import { pricePayment } from "../lib/pricing.mjs";
import { accountsOf, batchOrFail, merchantId, notFound, paymentOrFail, paymentsOf } from "../lib/records.mjs";
import { paymentOut, primaryAccount } from "../lib/serialize.mjs";
import { accountRowId, paymentRowId } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";
import { checkEnum, empty, hasOwn, invalid, rejectReservedKeys } from "../lib/validate.mjs";
import { amountChoice, applyPaymentDetails, assertExternalIdFree, createPayment } from "./payment-build.mjs";

const STATUSES = ["pending", "processing", "processed", "failed"];

function openBatch(context, id) {
  const batch = batchOrFail(context, id);
  if (batch.status !== "open") context.fail({ code: "INVALID_STATUS", message: "Batch is not open" });
  return batch;
}

/** A changed batch needs a new quote. */
function clearQuote(context, batch, now) {
  const next = { ...batch, quoteExpiredAt: null, updatedAt: now };
  context.state.put("batches", batch.id, next);
  return next;
}

const out = (context, row, batch) => paymentOut(row, context.state.get("recipients", row.recipientId), batch, merchantId(context));

export function paymentsCreate(input, context) {
  requireKey(context, true);
  rejectReservedKeys(context, input);
  const batch = openBatch(context, input.batchId);
  const now = nowIso(context);
  const { batchId, ...payload } = input;
  const { row } = createPayment(context, batch, payload, "", now, paymentsOf(context, batch.id));
  return { ok: true, payment: out(context, row, clearQuote(context, batch, now)) };
}

export function paymentsList(input, context) {
  requireKey(context, false);
  const batch = batchOrFail(context, input.batchId);
  const paging = pageArgs(context, input);
  const status = hasOwn(input, "status") ? checkEnum(context, input.status, STATUSES, "status") : undefined;
  const search = filterText(context, input, "search");
  const needle = search?.toLowerCase();
  const recipients = new Map();
  const recipientOf = (id) => {
    if (!recipients.has(id)) recipients.set(id, context.state.get("recipients", id));
    return recipients.get(id);
  };
  const rows = paymentsOf(context, batch.id).filter((row) => {
    if (status !== undefined && row.status !== status) return false;
    if (needle === undefined) return true;
    const recipient = recipientOf(row.recipientId);
    return [recipient?.name, recipient?.email, recipient?.referenceId, row.memo, row.externalId]
      .some((field) => typeof field === "string" && field.toLowerCase().includes(needle));
  });
  sortItems(rows, (row) => row.createdAt, "asc");
  const merchant = merchantId(context);
  return pageOf(context, rows, paging, "payments", (row) => paymentOut(row, recipientOf(row.recipientId), batch, merchant));
}

export function paymentsGet(input, context) {
  requireKey(context, false);
  let batchId = input.batchId;
  if (batchId === undefined) {
    const index = isId("P", input.paymentId) ? context.state.get("payment_index", input.paymentId) : null;
    if (index === null) notFound(context, "Payment");
    batchId = index.batchId;
  }
  const row = paymentOrFail(context, batchId, input.paymentId);
  return { ok: true, payment: out(context, row, context.state.get("batches", row.batchId)) };
}

export function paymentsUpdate(input, context) {
  requireKey(context, true);
  rejectReservedKeys(context, input);
  const batch = batchOrFail(context, input.batchId);
  const current = paymentOrFail(context, batch.id, input.paymentId);
  const { batchId, paymentId, ...changes } = input;
  if (Object.keys(changes).length === 0) empty(context, "body");
  if (hasOwn(changes, "recipient")) invalid(context, "recipient", "Create a new payment to change the recipient");
  if (hasOwn(changes, "status")) invalid(context, "status", "Field is read-only");
  if (batch.status !== "open" || current.status !== "pending") context.fail({ code: "INVALID_STATUS", message: "Only pending payments in an open batch can be changed" });
  const now = nowIso(context);
  let row = { ...current, updatedAt: now };
  const stored = context.state.get("recipient_accounts", accountRowId(current.recipientId, current.accountId));
  const account = stored !== null && stored.status !== "disabled" ? stored : primaryAccount(accountsOf(context, current.recipientId));
  if (account === null) context.fail({ code: "INVALID_STATUS", message: "Recipient has no primary payout method" });
  const amountKeys = ["amount", "currency", "sourceAmount", "sourceCurrency", "targetAmount", "targetCurrency"];
  if (amountKeys.some((key) => hasOwn(changes, key))) {
    const choice = amountChoice(context, changes, "", batch.currency, account);
    row = { ...row, amountSide: choice.side, sourceAmount: choice.side === "source" ? choice.amount : row.sourceAmount, targetAmount: choice.side === "target" ? choice.amount : row.targetAmount };
  }
  applyPaymentDetails(context, changes, "", row);
  if (hasOwn(changes, "externalId")) assertExternalIdFree(context, paymentsOf(context, batch.id), row.externalId, row.id, "externalId");
  row = pricePayment(context, row, account);
  context.state.put("payments", paymentRowId(batch.id, row.id), row);
  return { ok: true, payment: out(context, row, clearQuote(context, batch, now)) };
}

export function paymentsDelete(input, context) {
  requireKey(context, true);
  const batch = batchOrFail(context, input.batchId);
  const row = paymentOrFail(context, batch.id, input.paymentId);
  if (batch.status !== "open" || row.status !== "pending") context.fail({ code: "INVALID_STATUS", message: "Only pending payments in an open batch can be deleted" });
  context.state.delete("payments", paymentRowId(batch.id, row.id));
  context.state.delete("payment_index", row.id);
  clearQuote(context, batch, nowIso(context));
  return { ok: true };
}
