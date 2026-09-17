// The synthetic test-card catalogue: Stripe's published test payment method ids and the outcome each one
// produces when it is confirmed. Constants only; materialised cards live in the `payment_methods` namespace.

const CARDS = Object.freeze({
  pm_card_visa: { brand: "visa", last4: "4242", funding: "credit", country: "US", outcome: "succeed", fingerprint: "Xt5EWLLDS7FJjR1c" },
  pm_card_visa_debit: { brand: "visa", last4: "5556", funding: "debit", country: "US", outcome: "succeed", fingerprint: "k9tPmQ2vR4sX7bLn" },
  pm_card_mastercard: { brand: "mastercard", last4: "4444", funding: "credit", country: "US", outcome: "succeed", fingerprint: "Q7mVdR2sK9pLxT4w" },
  pm_card_amex: { brand: "amex", last4: "8431", funding: "credit", country: "US", outcome: "succeed", fingerprint: "Bv3NcY6hJ8qWzP1r" },
  pm_card_chargeDeclined: { brand: "visa", last4: "0002", funding: "credit", country: "US", outcome: "decline_generic", fingerprint: "Dc0LnX4tG7vKrM2s" },
  pm_card_chargeDeclinedInsufficientFunds: { brand: "visa", last4: "9995", funding: "credit", country: "US", outcome: "decline_insufficient_funds", fingerprint: "If9Pq2Ws5RtY7uB3" },
  pm_card_authenticationRequired: { brand: "visa", last4: "3155", funding: "credit", country: "US", outcome: "requires_action", fingerprint: "Au3Rq8Zt1Vx6NmC5" },
});

export const TEST_CARD_IDS = Object.freeze(Object.keys(CARDS));

export function testCard(id) {
  return typeof id === "string" && Object.hasOwn(CARDS, id) ? CARDS[id] : undefined;
}

export function isTestCardId(id) {
  return testCard(id) !== undefined;
}

/** The `card` block of a PaymentMethod built from a catalogue entry. */
export function cardDetails(card) {
  return {
    brand: card.brand,
    checks: { address_line1_check: null, address_postal_code_check: null, cvc_check: "pass" },
    country: card.country,
    display_brand: card.brand,
    exp_month: 12,
    exp_year: 2034,
    fingerprint: card.fingerprint,
    funding: card.funding,
    generated_from: null,
    last4: card.last4,
    networks: { available: [card.brand], preferred: null },
    regulated_status: "unregulated",
    three_d_secure_usage: { supported: true },
    wallet: null,
  };
}

/** Decline details for the two synthetic decline outcomes; undefined for outcomes that do not decline. */
export function declineFor(outcome) {
  if (outcome === "decline_generic") {
    return { decline_code: "generic_decline", message: "Your card was declined." };
  }
  if (outcome === "decline_insufficient_funds") {
    return { decline_code: "insufficient_funds", message: "Your card has insufficient funds." };
  }
  return undefined;
}
