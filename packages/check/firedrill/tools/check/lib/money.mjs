// Decimal-string money held as integer cents (BigInt). Inputs accept 0–2 decimals; outputs always two. Half-up rounding.
const AMOUNT = /^-?(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/;

export function isMoney(value) {
  return typeof value === "string" && value.length <= 14 && AMOUNT.test(value);
}

export function toCents(value) {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
}

export function fromCents(cents) {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** Non-negative integer division rounding half up. */
export function divRound(numerator, denominator) {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** Hours with at most two decimals as integer hundredths, or null. */
export function hundredths(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 400) return null;
  const scaled = Math.round(value * 100);
  return Math.abs(scaled - value * 100) < 1e-6 ? BigInt(scaled) : null;
}
