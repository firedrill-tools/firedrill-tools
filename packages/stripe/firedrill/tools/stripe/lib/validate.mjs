// Parameter validation shared by the operation handlers: e-mail addresses, metadata maps, addresses, shipping
// blocks, currencies and amounts. Every failure is a declared `INVALID_REQUEST` in Stripe's wording.

import { CURRENCIES, MAX_CHARGE_AMOUNT, MIN_CHARGE_AMOUNT, formatAmount, isCurrency, isInteger, normalizeCurrency } from "./money.mjs";
import { invalid, invalidEmpty, invalidInteger, parameterMissing, parameterUnknown } from "./state.mjs";

export const MAX_METADATA_KEYS = 50;
export const MAX_METADATA_KEY = 40;
export const MAX_METADATA_VALUE = 500;
const ADDRESS_FIELDS = ["city", "country", "line1", "line2", "postal_code", "state"];

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `""` clears a nullable string parameter (Stripe); undefined keeps the stored value. */
export function optionalString(context, input, name, current, maxLength = 5_000) {
  const value = input[name];
  if (value === undefined) return current;
  if (value === null) return null;
  if (typeof value !== "string") return invalid(context, `Invalid string: ${String(value)}`, "parameter_invalid_string", name);
  if (value.length > maxLength) return invalid(context, `The '${name}' parameter cannot be longer than ${maxLength} characters.`, "parameter_invalid_string", name);
  return value.length === 0 ? null : value;
}

export function requireString(context, input, name, maxLength = 5_000) {
  const value = input[name];
  if (value === undefined || value === null) return parameterMissing(context, name);
  if (typeof value !== "string") return invalid(context, `Invalid string: ${String(value)}`, "parameter_invalid_string", name);
  if (value.length === 0) return invalidEmpty(context, name);
  if (value.length > maxLength) return invalid(context, `The '${name}' parameter cannot be longer than ${maxLength} characters.`, "parameter_invalid_string", name);
  return value;
}

export function optionalEnum(context, input, name, values, current) {
  const value = input[name];
  if (value === undefined) return current;
  if (!values.includes(value)) return invalid(context, `Invalid ${name}: must be one of ${values.join(", ")}`, "parameter_invalid", name);
  return value;
}

export function optionalBoolean(context, input, name, current) {
  const value = input[name];
  if (value === undefined) return current;
  if (typeof value !== "boolean") return invalid(context, `Invalid boolean: ${String(value)}`, "parameter_invalid_boolean", name);
  return value;
}

export function optionalInteger(context, input, name, current, { min, max } = {}) {
  const value = input[name];
  if (value === undefined) return current;
  if (!isInteger(value)) return invalidInteger(context, name, value);
  if (min !== undefined && value < min) return invalid(context, `Invalid integer: ${value}. ${name} must be at least ${min}.`, "parameter_invalid_integer", name);
  if (max !== undefined && value > max) return invalid(context, `Invalid integer: ${value}. ${name} must be at most ${max}.`, "parameter_invalid_integer", name);
  return value;
}

export function requireInteger(context, input, name, bounds) {
  if (input[name] === undefined || input[name] === null) return parameterMissing(context, name);
  return optionalInteger(context, input, name, undefined, bounds);
}

export function validateEmail(context, value, name = "email") {
  if (value === null) return null;
  const match = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 512;
  return match ? value : invalid(context, `Invalid email address: ${value}`, "email_invalid", name);
}

export function requireCurrency(context, value, name = "currency") {
  if (value === undefined || value === null) return parameterMissing(context, name);
  if (typeof value !== "string" || value.length === 0) return invalidEmpty(context, name);
  if (!isCurrency(value)) return invalid(context, `Invalid currency: ${value}. Stripe currently supports these currencies: ${CURRENCIES.join(", ")}`, "parameter_invalid", name);
  return normalizeCurrency(value);
}

/** Charge-able amount: integer, ≥ 50 minor units (every currency), ≤ 99,999,999. */
export function requireChargeAmount(context, value, currency, name = "amount") {
  if (value === undefined || value === null) return parameterMissing(context, name);
  if (!isInteger(value)) return invalidInteger(context, name, value);
  if (value < MIN_CHARGE_AMOUNT) {
    return invalid(context, `Amount must be at least ${formatAmount(MIN_CHARGE_AMOUNT, currency)} ${currency}`, "amount_too_small", name);
  }
  if (value > MAX_CHARGE_AMOUNT) {
    return invalid(context, `Amount must be no more than ${formatAmount(MAX_CHARGE_AMOUNT, currency)} ${currency}`, "amount_too_large", name);
  }
  return value;
}

/** Validate an incoming metadata map and merge it over `current` (`""` deletes a key). */
export function mergeMetadata(context, incoming, current = {}) {
  if (incoming === undefined) return { ...current };
  if (incoming === "" || incoming === null) return {};
  if (!isPlainObject(incoming)) return invalid(context, "Invalid metadata: must be a hash of string keys and string values.", "parameter_invalid", "metadata");
  const next = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") return parameterUnknown(context, `metadata[${key}]`);
    if (key.length === 0 || key.length > MAX_METADATA_KEY) {
      return invalid(context, `Metadata keys can be at most ${MAX_METADATA_KEY} characters.`, "parameter_invalid", `metadata[${key}]`);
    }
    if (typeof value !== "string") return invalid(context, "Metadata values must be strings.", "parameter_invalid", `metadata[${key}]`);
    if (value.length > MAX_METADATA_VALUE) return invalid(context, `Metadata values can be at most ${MAX_METADATA_VALUE} characters.`, "parameter_invalid", `metadata[${key}]`);
    if (value.length === 0) delete next[key];
    else next[key] = value;
  }
  if (Object.keys(next).length > MAX_METADATA_KEYS) {
    return invalid(context, `You can specify up to ${MAX_METADATA_KEYS} keys, with key names up to ${MAX_METADATA_KEY} characters long and values up to ${MAX_METADATA_VALUE} characters long.`, "parameter_invalid", "metadata");
  }
  return next;
}

/** `{ city, country, line1, line2, postal_code, state }` with nulls for absent fields; `""` clears the address. */
export function normalizeAddress(context, value, name = "address", current = null) {
  if (value === undefined) return current;
  if (value === null || value === "") return null;
  if (!isPlainObject(value)) return invalid(context, `Invalid ${name}: must be a hash.`, "parameter_invalid", name);
  const address = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!ADDRESS_FIELDS.includes(key)) return parameterUnknown(context, `${name}[${key}]`);
    if (entry !== null && typeof entry !== "string") return invalid(context, `Invalid string: ${String(entry)}`, "parameter_invalid_string", `${name}[${key}]`);
  }
  for (const field of ADDRESS_FIELDS) {
    const entry = value[field];
    address[field] = entry === undefined || entry === null || entry === "" ? null : entry;
  }
  if (address.country !== null && !/^[A-Za-z]{2}$/.test(address.country)) {
    return invalid(context, `Invalid country: ${address.country}. Use a two-letter ISO 3166-1 alpha-2 code.`, "parameter_invalid", `${name}[country]`);
  }
  if (address.country !== null) address.country = address.country.toUpperCase();
  return address;
}

export function normalizeShipping(context, value, current = null) {
  if (value === undefined) return current;
  if (value === null || value === "") return null;
  if (!isPlainObject(value)) return invalid(context, "Invalid shipping: must be a hash.", "parameter_invalid", "shipping");
  for (const key of Object.keys(value)) if (!["address", "name", "phone"].includes(key)) return parameterUnknown(context, `shipping[${key}]`);
  if (typeof value.name !== "string" || value.name.length === 0) return parameterMissing(context, "shipping[name]");
  if (value.address === undefined) return parameterMissing(context, "shipping[address]");
  const address = normalizeAddress(context, value.address, "shipping[address]");
  if (address === null) return parameterMissing(context, "shipping[address]");
  return { address, name: value.name, phone: typeof value.phone === "string" && value.phone.length > 0 ? value.phone : null };
}

export function optionalStringArray(context, input, name, current) {
  const value = input[name];
  if (value === undefined) return current;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return invalid(context, `Invalid array: ${name} must be an array of strings.`, "parameter_invalid", name);
  }
  return value;
}

/** Exactly one of the listed parameters must be present. */
export function requireExactlyOne(context, input, names) {
  const present = names.filter((name) => input[name] !== undefined);
  if (present.length === 1) return present[0];
  if (present.length === 0) return parameterMissing(context, names[0]);
  return invalid(context, `You may only specify one of these parameters: ${names.join(", ")}.`, "parameter_invalid", present[1]);
}

/**
 * The framework decodes query strings and form bodies leniently, so malformed percent-encoding (`%E0%A4%A`) reaches
 * a Tool as U+FFFD instead of failing the request. A filter value carrying U+FFFD is a mangled request, not a value
 * that legitimately matches nothing, so every list filter rejects it with Stripe's 400 `invalid_request_error`
 * rather than silently running a corrupted filter that returns an empty page. `%ZZ` (which stays literal) and
 * correctly encoded non-ASCII text (`caf%C3%A9`, CJK, emoji) are unaffected.
 */
export function rejectMangled(context, input, names) {
  for (const name of names) {
    const value = input[name];
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (typeof entry === "string" && entry.includes("�")) {
        return invalid(
          context,
          `Invalid ${name}: the value contains an invalid character (U+FFFD); check the percent-encoding of the request.`,
          "parameter_invalid",
          name,
        );
      }
    }
  }
  return undefined;
}
