// Money in integer cents (amounts) and ten-thousandths (quantities and unit prices). BigInt only for products.

export const MAX_CENTS = 99_999_999_999_99; // 99,999,999,999.99
export const MAX_SCALED4 = 9_999_999_999_9999; // 9,999,999,999.9999 in ten-thousandths

/** Round half away from zero to an integer. */
export function roundHalfAway(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Number with at most `places` decimals → scaled integer, or null when not a finite number in range. */
export function toScaled(value, places, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const scaled = roundHalfAway(value * 10 ** places);
  if (!Number.isSafeInteger(scaled) || Math.abs(scaled) > max) return null;
  return scaled;
}

export const toCents = (value) => toScaled(value, 2, MAX_CENTS);
export const toScaled4 = (value) => toScaled(value, 4, MAX_SCALED4);

export const fromCents = (cents) => cents / 100;
export const fromScaled4 = (scaled) => scaled / 10000;

/** Rounded division of two BigInts, half away from zero. */
function divRound(numerator, denominator) {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return negative ? -q : q;
}

/** LineAmount cents of quantity (x10^4) times unit amount (x10^4); null when out of range. */
export function lineCents(quantity4, unit4) {
  const cents = divRound(BigInt(quantity4) * BigInt(unit4), 1000000n);
  if (cents > BigInt(MAX_CENTS) || cents < -BigInt(MAX_CENTS)) return null;
  return Number(cents);
}

/** Basis points (hundredths of a percent) of a tax rate given as a percentage number. */
export const basisPoints = (rate) => roundHalfAway(rate * 100);

/** Tax cents of a line for Xero line amount types. */
export function taxCents(lineAmountCents, bp, lineAmountTypes) {
  if (lineAmountTypes === "NoTax" || bp === 0) return 0;
  if (lineAmountTypes === "Inclusive") return Number(divRound(BigInt(lineAmountCents) * BigInt(bp), BigInt(10000 + bp)));
  return Number(divRound(BigInt(lineAmountCents) * BigInt(bp), 10000n));
}

/** Rendering helper: unit amounts show 2 decimals unless unitdp=4 was requested. */
export function unitAmountOut(scaled4, unitdp) {
  if (unitdp === 4) return scaled4 / 10000;
  return roundHalfAway(scaled4 / 100) / 100;
}
