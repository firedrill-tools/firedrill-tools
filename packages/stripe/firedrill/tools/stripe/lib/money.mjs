// Amounts are integers in minor units; currencies are a fixed lower-case ISO-4217 list. Pure functions only.

export const CURRENCIES = Object.freeze(["usd", "eur", "gbp", "cad", "aud", "chf", "sek", "nok", "dkk", "jpy", "nzd", "sgd"]);
export const MIN_CHARGE_AMOUNT = 50;
export const MAX_CHARGE_AMOUNT = 99_999_999;

const SYMBOLS = { usd: "$", eur: "€", gbp: "£", cad: "CA$", aud: "A$", chf: "CHF ", sek: "kr ", nok: "kr ", dkk: "kr ", jpy: "¥", nzd: "NZ$", sgd: "S$" };

export function isCurrency(value) {
  return typeof value === "string" && CURRENCIES.includes(value.toLowerCase());
}

export function normalizeCurrency(value) {
  return value.toLowerCase();
}

export function isInteger(value) {
  return typeof value === "number" && Number.isInteger(value);
}

/** `$12.50` / `€3.00` / `¥500` formatting used in Stripe's error messages. */
export function formatAmount(amount, currency) {
  const symbol = SYMBOLS[currency] ?? `${currency.toUpperCase()} `;
  if (currency === "jpy") return `${symbol}${amount}`;
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  const major = Math.floor(absolute / 100);
  const minor = String(absolute % 100).padStart(2, "0");
  return `${sign}${symbol}${major}.${minor}`;
}

/** Legacy `unit_amount_decimal` / `amount_decimal` strings (Stripe renders integers as decimal strings). */
export function decimalString(amount) {
  return String(amount);
}
