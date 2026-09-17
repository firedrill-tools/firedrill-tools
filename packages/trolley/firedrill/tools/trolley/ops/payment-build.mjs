// Payment validation and construction shared by POST /v1/batches (with payments) and POST /v1/batches/{id}/payments.
import { nextId } from "../lib/ids.mjs";
import { fromCents, isAmount, toCents } from "../lib/money.mjs";
import { pricePayment } from "../lib/pricing.mjs";
import { accountsOf, resolveRecipient } from "../lib/records.mjs";
import { primaryAccount } from "../lib/serialize.mjs";
import { paymentRowId } from "../lib/store.mjs";
import { CATEGORIES, checkCurrency, checkTags, checkText, empty, fieldError, hasOwn, invalid } from "../lib/validate.mjs";

export const MAX_PAYMENTS = 1000;
const BLOCKED = ["archived", "suspended", "blocked", "disabled"];
const PAIRS = [["amount", "currency"], ["sourceAmount", "sourceCurrency"], ["targetAmount", "targetCurrency"]];

function checkAmount(context, value, field) {
  if (value === undefined || value === null || value === "") empty(context, field);
  if (!isAmount(value) || toCents(value) === 0n) invalid(context, field, "Amount must be a positive decimal with at most two decimals");
  return fromCents(toCents(value));
}

/** The amount pair the caller fixed: `{ side, amount }` for the batch currency or the payout account currency. */
export function amountChoice(context, input, p, batchCurrency, account) {
  const present = PAIRS.filter(([amountKey, currencyKey]) => hasOwn(input, amountKey) || hasOwn(input, currencyKey));
  if (present.length === 0) empty(context, `${p}amount`);
  if (present.length > 1) invalid(context, `${p}${present[1][0]}`, "Send exactly one amount and currency pair");
  const [amountKey, currencyKey] = present[0];
  const amount = checkAmount(context, input[amountKey], `${p}${amountKey}`);
  if (!hasOwn(input, currencyKey)) empty(context, `${p}${currencyKey}`);
  const currency = checkCurrency(context, input[currencyKey], `${p}${currencyKey}`);
  const payoutCurrency = account.type === "paypal" ? batchCurrency : account.currency;
  const isSource = currency === batchCurrency && amountKey !== "targetAmount";
  const isTarget = currency === payoutCurrency && amountKey !== "sourceAmount";
  if (!isSource && !isTarget) invalid(context, `${p}${currencyKey}`, "Currency must be the batch currency or the recipient's payout currency");
  return isSource ? { side: "source", amount } : { side: "target", amount };
}

/** Optional descriptive payment fields into `row`. */
export function applyPaymentDetails(context, input, p, row) {
  if (hasOwn(input, "memo")) row.memo = input.memo === null ? "" : checkText(context, input.memo, `${p}memo`, 1024);
  if (hasOwn(input, "externalId")) row.externalId = input.externalId === null || input.externalId === "" ? null : checkText(context, input.externalId, `${p}externalId`, 100);
  if (hasOwn(input, "coverFees")) {
    if (typeof input.coverFees !== "boolean") invalid(context, `${p}coverFees`);
    row.coverFees = input.coverFees;
  }
  if (hasOwn(input, "category")) {
    if (input.category !== null && !CATEGORIES.includes(input.category)) invalid(context, `${p}category`);
    row.category = input.category;
  }
  if (hasOwn(input, "tags")) row.tags = checkTags(context, input.tags, `${p}tags`);
}

export function assertExternalIdFree(context, payments, externalId, selfId, field) {
  if (typeof externalId !== "string") return;
  if (payments.some((payment) => payment.id !== selfId && payment.externalId === externalId)) invalid(context, field, "External ID already exists in this batch");
}

/** Validates and stores one pending payment in `batch`; returns `{ row, recipient }`. */
export function createPayment(context, batch, input, p, now, existing) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) invalid(context, p.replace(/\.$/, ""));
  if (existing.length >= MAX_PAYMENTS) invalid(context, `${p}amount`, "Batch has the maximum number of payments");
  if (!hasOwn(input, "recipient")) empty(context, `${p}recipient`);
  const recipient = resolveRecipient(context, input.recipient, `${p}recipient`);
  if (BLOCKED.includes(recipient.status)) fieldError(context, "INVALID_STATUS", `${p}recipient`, `Recipient is ${recipient.status}`);
  const account = primaryAccount(accountsOf(context, recipient.id));
  if (account === null) fieldError(context, "INVALID_STATUS", `${p}recipient`, "Recipient has no primary payout method");
  const choice = amountChoice(context, input, p, batch.currency, account);
  const row = {
    id: nextId(context, "P"), batchId: batch.id, recipientId: recipient.id, accountId: account.id, status: "pending",
    amountSide: choice.side, sourceAmount: choice.side === "source" ? choice.amount : "0.00", sourceCurrency: batch.currency,
    targetAmount: choice.side === "target" ? choice.amount : "0.00", targetCurrency: batch.currency, exchangeRate: "1.000000",
    fees: "0.00", recipientFees: "0.00", merchantFees: "0.00", coverFees: false, payoutMethod: account.type, memo: "",
    externalId: null, category: null, tags: [], failureMessage: null, initiatedAt: null, processedAt: null, createdAt: now, updatedAt: now,
  };
  applyPaymentDetails(context, input, p, row);
  assertExternalIdFree(context, existing, row.externalId, row.id, `${p}externalId`);
  const priced = pricePayment(context, row, account);
  context.state.put("payments", paymentRowId(batch.id, priced.id), priced);
  context.state.put("payment_index", priced.id, { batchId: batch.id });
  return { row: priced, recipient };
}
