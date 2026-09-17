// Batches: create (optionally with payments), get, update, delete, list, summary.
import { merchant, requireKey } from "../lib/access.mjs";
import { nextId } from "../lib/ids.mjs";
import { fromCents, toCents } from "../lib/money.mjs";
import { filterList, filterText, pageArgs, pageOf, sortArgs, sortItems } from "../lib/paging.mjs";
import { batchOrFail, paymentsOf } from "../lib/records.mjs";
import { batchOut } from "../lib/serialize.mjs";
import { paymentRowId, scanAll } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";
import { CURRENCIES, checkCurrency, checkEnum, checkTags, checkText, hasOwn, invalid, rejectReservedKeys } from "../lib/validate.mjs";
import { MAX_PAYMENTS, createPayment } from "./payment-build.mjs";

const STATUSES = ["open", "processing", "complete", "failed"];

export function batchesCreate(input, context) {
  requireKey(context, true);
  rejectReservedKeys(context, input);
  const payments = hasOwn(input, "payments") ? input.payments : [];
  if (!Array.isArray(payments)) invalid(context, "payments");
  if (payments.length > MAX_PAYMENTS) invalid(context, "payments", `A batch can hold at most ${MAX_PAYMENTS} payments`);
  const first = payments[0] !== null && typeof payments[0] === "object" ? payments[0] : {};
  const currencySource = hasOwn(input, "currency") ? ["currency", input.currency]
    : hasOwn(first, "sourceCurrency") ? ["payments[0].sourceCurrency", first.sourceCurrency]
    : hasOwn(first, "currency") && hasOwn(first, "amount") ? ["payments[0].currency", first.currency] : undefined;
  const currency = currencySource === undefined ? merchant(context).defaultCurrency : checkCurrency(context, currencySource[1], currencySource[0]);
  const now = nowIso(context);
  const batch = {
    id: nextId(context, "B"), status: "open", currency,
    description: hasOwn(input, "description") && input.description !== null ? checkText(context, input.description, "description", 1024) : "",
    tags: hasOwn(input, "tags") ? checkTags(context, input.tags) : [],
    quoteExpiredAt: null, sentAt: null, completedAt: null, createdAt: now, updatedAt: now,
  };
  context.state.put("batches", batch.id, batch);
  const rows = [];
  for (const [index, payment] of payments.entries()) {
    rows.push(createPayment(context, batch, payment, `payments[${index}].`, now, rows).row);
  }
  return { ok: true, batch: batchOut(batch, rows) };
}

export function batchesGet(input, context) {
  requireKey(context, false);
  const batch = batchOrFail(context, input.batchId);
  return { ok: true, batch: batchOut(batch, paymentsOf(context, batch.id)) };
}

export function batchesUpdate(input, context) {
  requireKey(context, true);
  rejectReservedKeys(context, input);
  const batch = batchOrFail(context, input.batchId);
  for (const key of ["status", "amount", "totalPayments", "quoteExpiredAt", "sentAt", "completedAt"]) {
    if (hasOwn(input, key)) invalid(context, key, "Field is read-only");
  }
  if (batch.status !== "open") context.fail({ code: "INVALID_STATUS", message: "Batch is not open" });
  const payments = paymentsOf(context, batch.id);
  const next = { ...batch, updatedAt: nowIso(context) };
  if (hasOwn(input, "description")) next.description = input.description === null ? "" : checkText(context, input.description, "description", 1024);
  if (hasOwn(input, "tags")) next.tags = checkTags(context, input.tags);
  if (hasOwn(input, "currency")) {
    const currency = checkCurrency(context, input.currency, "currency");
    if (currency !== batch.currency && payments.length > 0) invalid(context, "currency", "Currency cannot change once the batch has payments");
    if (currency !== batch.currency) next.quoteExpiredAt = null;
    next.currency = currency;
  }
  context.state.put("batches", batch.id, next);
  return { ok: true, batch: batchOut(next, payments) };
}

export function batchesDelete(input, context) {
  requireKey(context, true);
  const batch = batchOrFail(context, input.batchId);
  if (batch.status !== "open") context.fail({ code: "INVALID_STATUS", message: "Only open batches can be deleted" });
  for (const payment of paymentsOf(context, batch.id)) {
    context.state.delete("payments", paymentRowId(batch.id, payment.id));
    context.state.delete("payment_index", payment.id);
  }
  context.state.delete("batches", batch.id);
  return { ok: true };
}

export function batchesList(input, context) {
  requireKey(context, false);
  const paging = pageArgs(context, input);
  const search = filterText(context, input, "search")?.toLowerCase();
  const status = hasOwn(input, "status") ? checkEnum(context, input.status, STATUSES, "status") : undefined;
  const currency = hasOwn(input, "currency") ? checkEnum(context, String(input.currency).toUpperCase(), CURRENCIES, "currency") : undefined;
  const tags = filterList(context, input, "tags");
  const { orderBy, sortBy } = sortArgs(context, input, ["createdAt", "amount", "status"], "createdAt");
  const byBatch = new Map();
  for (const payment of scanAll(context, "payments")) {
    if (!byBatch.has(payment.batchId)) byBatch.set(payment.batchId, []);
    byBatch.get(payment.batchId).push(payment);
  }
  const items = scanAll(context, "batches")
    .filter((batch) => {
      if (status !== undefined && batch.status !== status) return false;
      if (currency !== undefined && batch.currency !== currency) return false;
      if (tags !== undefined && !tags.every((tag) => (batch.tags ?? []).includes(tag))) return false;
      if (search !== undefined && ![batch.id, batch.description, ...(batch.tags ?? [])].some((field) => String(field).toLowerCase().includes(search))) return false;
      return true;
    })
    .map((batch) => batchOut(batch, byBatch.get(batch.id) ?? []));
  sortItems(items, orderBy === "amount" ? (item) => toCents(item.amount) : (item) => item[orderBy], sortBy);
  return pageOf(context, items, paging, "batches");
}

function emptySummary() {
  return { count: 0, totalFees: 0n, merchantFees: 0n, sendingAmount: 0n };
}

function renderSummary(entry) {
  return {
    count: entry.count,
    totalFees: fromCents(entry.totalFees),
    merchantFees: fromCents(entry.merchantFees),
    debitAmount: fromCents(entry.sendingAmount + entry.merchantFees),
    sendingAmount: fromCents(entry.sendingAmount),
    totalWithheld: "0.00",
  };
}

export function batchesSummary(input, context) {
  requireKey(context, false);
  const batch = batchOrFail(context, input.batchId);
  const detail = new Map();
  const total = emptySummary();
  for (const payment of paymentsOf(context, batch.id)) {
    if (!detail.has(payment.payoutMethod)) detail.set(payment.payoutMethod, emptySummary());
    for (const entry of [detail.get(payment.payoutMethod), total]) {
      entry.count += 1;
      entry.totalFees += toCents(payment.fees);
      entry.merchantFees += toCents(payment.merchantFees);
      entry.sendingAmount += toCents(payment.sourceAmount);
    }
  }
  const rendered = {};
  for (const method of [...detail.keys()].sort()) rendered[method] = renderSummary(detail.get(method));
  return { ok: true, batchSummary: { detail: rendered, total: renderSummary(total) } };
}
