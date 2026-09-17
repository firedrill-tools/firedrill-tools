// Synthetic FX, fee and route-minimum schedule from `meta/fx` and `meta/fees`. Not Trolley's pricing or live rates.
import { convert, convertBack, fromCents, fromMicros, isAmount, isRate, toCents, toMicros } from "./money.mjs";
import { invalid } from "./validate.mjs";

const EURO_ROUTE = ["DE", "FR", "ES", "NL", "IE", "IT", "PT", "BE", "AT", "FI"];

function fxRow(context) {
  const row = context.state.get("meta", "fx");
  return row !== null && row.rates !== null && typeof row.rates === "object" ? row : { base: "USD", rates: { USD: "1.000000" } };
}

function baseRate(context, currency, field) {
  const rates = fxRow(context).rates;
  const value = Object.hasOwn(rates, currency) ? rates[currency] : undefined;
  if (!isRate(value) || toMicros(value) === 0n) invalid(context, field, "Currency is not supported for conversion");
  return toMicros(value);
}

/** Cross rate source → target in micro-units, half up to 6 decimals. */
export function crossRate(context, source, target, field = "currency") {
  if (source === target) return 1000000n;
  const from = baseRate(context, source, field);
  const to = baseRate(context, target, field);
  return (to * 1000000n * 2n + from) / (from * 2n);
}

function feesRow(context) {
  const row = context.state.get("meta", "fees");
  return row !== null && typeof row === "object" ? row : { currency: "USD", fixed: {}, minimums: {} };
}

function scheduleCents(context, table, method, currency) {
  const row = feesRow(context);
  const entries = row[table] !== null && typeof row[table] === "object" ? row[table] : {};
  const value = Object.hasOwn(entries, method) ? entries[method] : "0.00";
  const cents = isAmount(value) ? toCents(value) : 0n;
  const scheduleCurrency = typeof row.currency === "string" ? row.currency : "USD";
  return convert(cents, crossRate(context, scheduleCurrency, currency));
}

export const feeCents = (context, method, currency) => scheduleCents(context, "fixed", method, currency);
export const minimumCents = (context, method, currency) => scheduleCents(context, "minimums", method, currency);

export function routeType(account) {
  if (account === null || account === undefined) return null;
  if (account.type !== "bank-transfer") return account.type;
  if (account.country === "US") return "ach";
  if (account.country === "CA") return "eft";
  if (account.country === "GB") return "bacs";
  if (EURO_ROUTE.includes(account.country)) return "sepa";
  return "wire";
}

/**
 * Recomputes a payment row's amounts for `account` from the side the caller fixed (`amountSide`).
 * PayPal pays in the source currency (never converted). Fees are charged in the source currency;
 * `coverFees` moves them from the recipient to the merchant.
 */
export function pricePayment(context, row, account) {
  const method = account.type;
  const sourceCurrency = row.sourceCurrency;
  const targetCurrency = method === "paypal" ? sourceCurrency : account.currency;
  const rate = crossRate(context, sourceCurrency, targetCurrency);
  const fee = feeCents(context, method, sourceCurrency);
  const recipientFee = row.coverFees ? 0n : fee;
  let source;
  let target;
  if (row.amountSide === "target" && targetCurrency !== sourceCurrency) {
    target = toCents(row.targetAmount);
    source = convertBack(target, rate) + recipientFee;
  } else {
    source = toCents(row.sourceAmount);
    const net = source > recipientFee ? source - recipientFee : 0n;
    target = convert(net, rate);
  }
  return {
    ...row,
    accountId: account.id,
    payoutMethod: method,
    sourceAmount: fromCents(source),
    targetAmount: fromCents(target),
    targetCurrency,
    exchangeRate: fromMicros(rate),
    fees: fromCents(fee),
    recipientFees: fromCents(recipientFee),
    merchantFees: fromCents(row.coverFees ? fee : 0n),
  };
}
