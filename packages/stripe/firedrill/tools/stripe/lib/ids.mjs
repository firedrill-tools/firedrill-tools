// Deterministic Stripe-style identifiers. Ids are `<prefix>_<6 base-36 sequence chars><8 hash chars>`: the
// zero-padded, upper-case base-36 object sequence keeps a namespace scan in creation order, the 8-character
// FNV-1a-derived suffix is a checksum only and is never parsed. Nothing here keeps state or reads a clock.

const B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 32-bit FNV-1a of a string, as an unsigned integer. */
export function fnv1a(text, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function encode(number, alphabet, width) {
  let out = "";
  let value = number;
  do {
    out = alphabet[value % alphabet.length] + out;
    value = Math.floor(value / alphabet.length);
  } while (value > 0);
  return out.padStart(width, alphabet[0]).slice(-width);
}

/** A deterministic base-62 token of `length` characters derived from `seed`. */
export function token(seed, length) {
  let out = "";
  let round = 0;
  while (out.length < length) {
    out += encode(fnv1a(`${seed}#${round}`), B62, 6);
    round += 1;
  }
  return out.slice(0, length);
}

/** Render the id of the `sequence`-th object with a Stripe prefix (`cus`, `pi`, `ch`, ...). */
export function renderId(prefix, sequence) {
  return `${prefix}_${encode(sequence, B36, 6)}${token(`${prefix}_${sequence}`, 8)}`;
}

/** Sequence number encoded in an id rendered by `renderId`, or undefined for foreign ids. */
export function sequenceOf(id) {
  const match = /^[a-z]+_([0-9A-Z]{6})[0-9A-Za-z]{8}$/.exec(id);
  if (match === null) return undefined;
  let value = 0;
  for (const character of match[1]) value = value * 36 + B36.indexOf(character);
  return value;
}

const COUNTER_START = 1000;

/** Allocate the next object sequence from the `meta/counters` row (created lazily at 1000). */
export function nextSequence(context) {
  const stored = context.state.get("meta", "counters");
  const next = stored === null || typeof stored.next !== "number" ? COUNTER_START : stored.next;
  context.state.put("meta", "counters", { next: next + 1 });
  return next;
}

export function nextId(context, prefix) {
  return renderId(prefix, nextSequence(context));
}

/** Customer invoice prefix: eight upper-case alphanumerics derived from the customer sequence. */
export function invoicePrefix(sequence) {
  return token(`invoice_prefix_${sequence}`, 8).toUpperCase();
}

/** A PaymentIntent client secret: never usable anywhere, deterministic per intent. */
export function clientSecret(intentId) {
  return `${intentId}_secret_${token(`secret_${intentId}`, 24)}`;
}

/** Acquirer reference number shown on refunds' destination details. */
export function acquirerReference(refundId) {
  return token(`arn_${refundId}`, 24).replace(/[a-z]/g, (character) => character.toUpperCase());
}

/** Deterministic 0–99 risk score for a charge outcome. */
export function riskScore(chargeId) {
  return fnv1a(`risk_${chargeId}`) % 100;
}
