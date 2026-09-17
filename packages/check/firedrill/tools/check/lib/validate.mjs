// Field checks. Failures carry the field path inside the message as `field=<dotted.path>: <text>`, which the wire codec
// turns into Check's `input_errors`. Caller text quoted in errors is clipped to 200 characters.
import { isMoney, toCents } from "./money.mjs";
import { parseDate } from "./dates.mjs";

const RESERVED = ["__proto__", "constructor", "prototype"];
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const US_STATE = /^[A-Z]{2}$/;

export const clip = (text) => {
  const value = String(text);
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
};

export function fail(context, code, field, message) {
  const text = field === null || field === undefined ? message : `field=${clip(field)}: ${message}`;
  return context.fail({ code, message: text });
}

export const bad = (context, field, message) => fail(context, "VALIDATION_ERROR", field, message);
export const rule = (context, message) => fail(context, "VALIDATION_ERROR", "non_field_errors", message);
export const notFound = (context, field, what) => fail(context, "NOT_FOUND", field, `${what} not found.`);

export const hasOwn = (object, key) => object !== null && typeof object === "object" && Object.hasOwn(object, key);

function badCharacters(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10) || code === 127 || code === 0xfffd) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** Rejects keys the operation does not accept; read-only keys get their own message. */
export function onlyFields(context, input, allowed, readOnly = {}) {
  for (const key of Object.keys(input)) {
    if (Object.hasOwn(readOnly, key)) bad(context, key, readOnly[key]);
    if (!allowed.includes(key)) bad(context, key, "This field is not supported.");
  }
}

export function text(context, value, field, max, { nullable = false, required = false } = {}) {
  if (value === null && nullable && !required) return null;
  if (typeof value !== "string") bad(context, field, "Not a valid string.");
  if (badCharacters(value)) bad(context, field, "Contains invalid characters.");
  if (required && value.trim() === "") bad(context, field, "This field may not be blank.");
  if (value.length > max) bad(context, field, `Ensure this field has no more than ${max} characters.`);
  return value;
}

export function requireField(context, input, key, field = key) {
  if (!hasOwn(input, key) || input[key] === null || input[key] === undefined) bad(context, field, "This field is required.");
  return input[key];
}

export function choice(context, value, allowed, field) {
  if (typeof value !== "string" || !allowed.includes(value)) bad(context, field, `"${clip(typeof value === "string" ? value : JSON.stringify(value) ?? "")}" is not a valid choice.`);
  return value;
}

export function bool(context, value, field) {
  if (typeof value !== "boolean") bad(context, field, "Must be a valid boolean.");
  return value;
}

export function integer(context, value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) bad(context, field, `Ensure this value is an integer between ${min} and ${max}.`);
  return value;
}

export function date(context, value, field, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  const days = parseDate(value);
  if (days === null) bad(context, field, "Date has wrong format. Use YYYY-MM-DD.");
  return days;
}

export function positiveMoney(context, value, field) {
  if (!isMoney(value)) bad(context, field, "A valid decimal amount with at most two decimal places is required.");
  const cents = toCents(value);
  if (cents <= 0n) bad(context, field, "Ensure this value is greater than 0.");
  return cents;
}

export function email(context, value, field, { nullable = true } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || value.length > 254 || !EMAIL.test(value)) bad(context, field, "Enter a valid email address.");
  return value.toLowerCase();
}

export function metadata(context, value, field = "metadata") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad(context, field, "Must be an object of string values.");
  const keys = Object.keys(value);
  if (keys.length > 50) bad(context, field, "At most 50 keys are allowed.");
  const out = {};
  for (const key of keys) {
    if (RESERVED.includes(key) || key.length === 0 || key.length > 40 || badCharacters(key)) bad(context, field, `Invalid key "${clip(key)}".`);
    out[key] = text(context, value[key], `${field}.${key}`, 500);
  }
  return out;
}

const ADDRESS_KEYS = ["line1", "line2", "city", "state", "postal_code", "country"];

/** A US address. `supported` (array of states) restricts `state` when given. */
export function address(context, value, field, supported) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad(context, field, "Must be an address object.");
  for (const key of Object.keys(value)) if (!ADDRESS_KEYS.includes(key)) bad(context, `${field}.${key}`, "This field is not supported.");
  const line1 = text(context, requireField(context, value, "line1", `${field}.line1`), `${field}.line1`, 200, { required: true });
  const line2 = hasOwn(value, "line2") ? text(context, value.line2, `${field}.line2`, 200, { nullable: true }) : null;
  const city = text(context, requireField(context, value, "city", `${field}.city`), `${field}.city`, 100, { required: true });
  const state = requireField(context, value, "state", `${field}.state`);
  if (typeof state !== "string" || !US_STATE.test(state)) bad(context, `${field}.state`, "Must be a two-letter US state code.");
  if (supported !== undefined && !supported.includes(state)) bad(context, `${field}.state`, "State is not supported by this Tool.");
  const postal = requireField(context, value, "postal_code", `${field}.postal_code`);
  if (typeof postal !== "string" || !/^[0-9]{5}$/.test(postal)) bad(context, `${field}.postal_code`, "Must be a five-digit ZIP code.");
  if (hasOwn(value, "country") && value.country !== "US") bad(context, `${field}.country`, "Only US addresses are supported.");
  return { line1, line2, city, state, postal_code: postal, country: "US" };
}
