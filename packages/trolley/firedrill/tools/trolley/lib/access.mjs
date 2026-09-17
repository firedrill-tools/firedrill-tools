// API-key checks from actor attributes. A Trolley key belongs to one merchant and is account-wide; what varies is
// the merchant it belongs to and whether it may write. Fresh actors (no attributes) are the seeded merchant, full access.
export const DEFAULT_MERCHANT_ID = "M-4Lk9Qx2Rb7Tn3Vw8Yz1Ca6";

export function merchant(context) {
  const row = context.state.get("meta", "merchant");
  return row === null ? { id: DEFAULT_MERCHANT_ID, name: "Merchant", country: "US", defaultCurrency: "USD", sandbox: true } : row;
}

/** Key check for every operation: merchant mismatch or an unknown access level → INVALID_API_KEY; writes need full access. */
export function requireKey(context, write) {
  const attributes = context.actor.attributes ?? {};
  const claimed = Object.hasOwn(attributes, "merchantId") ? attributes.merchantId : undefined;
  const level = Object.hasOwn(attributes, "accessLevel") ? attributes.accessLevel : "full";
  if ((claimed !== undefined && claimed !== merchant(context).id) || (level !== "full" && level !== "read_only")) {
    context.fail({ code: "INVALID_API_KEY", message: "API key is invalid" });
  }
  if (write && level === "read_only") {
    context.fail({ code: "NOT_AUTHORIZED", message: "Authentication not permitted to access resource" });
  }
}
