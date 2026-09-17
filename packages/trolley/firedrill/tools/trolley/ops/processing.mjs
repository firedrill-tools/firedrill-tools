// POST /v1/batches/{id}/generate-quote and /start-processing. Every check runs before any write; processing then
// settles in the same invocation (each payment processed or failed, balance debited, batch complete or failed).
import { requireKey } from "../lib/access.mjs";
import { fromCents, toCents } from "../lib/money.mjs";
import { minimumCents, pricePayment } from "../lib/pricing.mjs";
import { accountsOf, batchOrFail, merchantId, paymentsOf } from "../lib/records.mjs";
import { batchOut, paymentOut, primaryAccount } from "../lib/serialize.mjs";
import { paymentRowId } from "../lib/store.mjs";
import { isoFromMs, msFromIso, nowIso, nowMs } from "../lib/time.mjs";
import { fieldError } from "../lib/validate.mjs";

const QUOTE_MS = 90 * 60 * 1000;

function currentAccount(context, payment) {
  return primaryAccount(accountsOf(context, payment.recipientId));
}

export function batchesGenerateQuote(input, context) {
  requireKey(context, true);
  const batch = batchOrFail(context, input.batchId);
  if (batch.status !== "open") context.fail({ code: "INVALID_STATUS", message: "Quotes can only be generated for open batches" });
  const now = nowIso(context);
  const payments = [];
  for (const payment of paymentsOf(context, batch.id)) {
    const account = payment.status === "pending" ? currentAccount(context, payment) : null;
    const next = account === null ? payment : { ...pricePayment(context, payment, account), updatedAt: now };
    if (next !== payment) context.state.put("payments", paymentRowId(batch.id, next.id), next);
    payments.push(next);
  }
  const quoted = { ...batch, quoteExpiredAt: isoFromMs(nowMs(context) + QUOTE_MS), updatedAt: now };
  context.state.put("batches", batch.id, quoted);
  return { ok: true, batch: batchOut(quoted, payments) };
}

function event(context, model, action, key, value) {
  context.events.emit(`${model}.${action}`, { model, action, body: { [key]: value } });
}

export function batchesStartProcessing(input, context) {
  requireKey(context, true);
  const batch = batchOrFail(context, input.batchId);
  if (batch.status !== "open") context.fail({ code: "INVALID_STATUS", message: "Batch is not open" });
  const payments = paymentsOf(context, batch.id);
  if (payments.length === 0) context.fail({ code: "INVALID_STATUS", message: "Batch has no payments" });

  // Plan: which payments are attempted, with their payout account; which fail and why.
  const plan = payments.map((payment) => {
    const recipient = context.state.get("recipients", payment.recipientId);
    if (payment.status !== "pending") return { payment, recipient, skip: true };
    if (recipient === null || recipient.status !== "active") return { payment, recipient, failure: "Recipient is not active" };
    const account = currentAccount(context, payment);
    if (account === null) return { payment, recipient, failure: "Recipient has no primary payout method" };
    const priced = account.id === payment.accountId && account.type === payment.payoutMethod ? payment : pricePayment(context, payment, account);
    return { payment: priced, recipient };
  });
  const attempted = plan.filter((entry) => !entry.skip && entry.failure === undefined);
  const nowAt = nowMs(context);
  if (attempted.some((entry) => entry.payment.sourceCurrency !== entry.payment.targetCurrency)) {
    const expires = msFromIso(batch.quoteExpiredAt);
    if (expires === null || expires <= nowAt) context.fail({ code: "EXPIRED_QUOTE", message: "Quote is expired" });
  }
  let debit = 0n;
  for (const { payment } of attempted) {
    if (toCents(payment.sourceAmount) < minimumCents(context, payment.payoutMethod, payment.sourceCurrency)) {
      fieldError(context, "INVALID_FIELD", "amount", "Payment amount is below the minimum for this payout method");
    }
    debit += toCents(payment.sourceAmount) + toCents(payment.merchantFees);
  }
  const balanceId = `paymentrails:${batch.currency}`;
  const balance = context.state.get("balances", balanceId);
  const available = balance === null ? 0n : toCents(balance.amount);
  if (debit > available) context.fail({ code: "NON_SUFFICIENT_FUNDS", message: "Insufficient funds" });

  // Settle.
  const now = nowIso(context);
  const merchant = merchantId(context);
  const sending = { ...batch, status: "processing", sentAt: now, updatedAt: now };
  event(context, "batch", "processing", "batch", batchOut(sending, plan.map((entry) => entry.payment)));
  const settled = [];
  let processed = 0;
  for (const entry of plan) {
    if (entry.skip) {
      settled.push(entry.payment);
      continue;
    }
    const ok = entry.failure === undefined;
    const row = {
      ...entry.payment,
      status: ok ? "processed" : "failed",
      failureMessage: ok ? null : entry.failure,
      initiatedAt: now,
      processedAt: ok ? now : null,
      updatedAt: now,
    };
    context.state.put("payments", paymentRowId(batch.id, row.id), row);
    settled.push(row);
    if (ok) processed += 1;
    event(context, "payment", ok ? "processed" : "failed", "payment", paymentOut(row, entry.recipient, sending, merchant));
  }
  if (balance !== null && debit > 0n) context.state.put("balances", balanceId, { ...balance, amount: fromCents(available - debit) });
  const final = { ...sending, status: processed > 0 ? "complete" : "failed", completedAt: now };
  context.state.put("batches", batch.id, final);
  return { ok: true, batch: batchOut(final, settled) };
}
