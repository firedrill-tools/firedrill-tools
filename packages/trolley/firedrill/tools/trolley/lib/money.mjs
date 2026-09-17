// Decimal-string money in integer minor units (BigInt), two decimals for every supported currency.
// FX rates are 6-decimal strings held as integer micro-units. No floating point anywhere.
const AMOUNT = /^(0|[1-9][0-9]{0,9})(\.[0-9]{2})?$/;
const RATE = /^(0|[1-9][0-9]{0,5})\.[0-9]{6}$/;

export function isAmount(value) {
  return typeof value === "string" && AMOUNT.test(value);
}

/** "150" or "150.00" → 15000n. Caller checks `isAmount` first. */
export function toCents(value) {
  const [whole, fraction = "00"] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction);
}

export function fromCents(cents) {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Canonical two-decimal rendering of a valid amount string. */
export function normalizeAmount(value) {
  return fromCents(toCents(value));
}

export function isRate(value) {
  return typeof value === "string" && RATE.test(value);
}

export function toMicros(rate) {
  const [whole, fraction] = rate.split(".");
  return BigInt(whole) * 1000000n + BigInt(fraction);
}

export function fromMicros(micros) {
  return `${micros / 1000000n}.${(micros % 1000000n).toString().padStart(6, "0")}`;
}

/** Integer division rounding half up (non-negative operands). */
export function divRound(numerator, denominator) {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** amount (cents) × rate (micros) → cents, half up. */
export function convert(cents, rateMicros) {
  return divRound(cents * rateMicros, 1000000n);
}

/** Inverse conversion: target cents ÷ rate → source cents, half up. */
export function convertBack(cents, rateMicros) {
  return rateMicros === 0n ? 0n : divRound(cents * 1000000n, rateMicros);
}
