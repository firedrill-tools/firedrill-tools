// Trolley field checks. Every failure names the field (`details.field`) so the wire envelope can carry it.
export const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "MXN"];
export const COUNTRIES = ["US", "CA", "GB", "DE", "FR", "ES", "NL", "IE", "IT", "PT", "BE", "AT", "FI", "SE", "DK", "NO", "CH", "PL",
  "CZ", "AU", "NZ", "MX", "BR", "AR", "CO", "IN", "JP", "SG", "PH", "ZA"];
export const IBAN_COUNTRIES = ["DE", "FR", "ES", "NL", "IE", "GB"];
export const PAYOUT_METHODS = ["bank-transfer", "paypal", "check", "venmo"];
export const CATEGORIES = ["services", "rent", "royalties", "royalties_film", "prizes", "education", "refunds"];
const RESERVED_KEYS = ["__proto__", "constructor", "prototype"];
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** True for C0 controls, DEL and U+FFFD (a mangled request). */
function hasBadCharacter(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127 || code === 0xfffd) return true;
  }
  return false;
}

export function fieldError(context, code, field, message) {
  const safeField = typeof field === "string" ? field.slice(0, 200) : undefined;
  context.fail({ code, message, ...(safeField === undefined ? {} : { details: { field: safeField } }) });
}

export const invalid = (context, field, message = "Value is invalid") => fieldError(context, "INVALID_FIELD", field, message);
export const empty = (context, field) => fieldError(context, "EMPTY_FIELD", field, "Value cannot be empty");

export function hasOwn(object, key) {
  return object !== null && typeof object === "object" && Object.hasOwn(object, key);
}

/** Rejects prototype-polluting keys anywhere in a caller object (explicit stack, no recursion). */
export function rejectReservedKeys(context, value, root = "") {
  const stack = [[value, root]];
  while (stack.length > 0) {
    const [node, path] = stack.pop();
    if (node === null || typeof node !== "object") continue;
    for (const key of Object.keys(node)) {
      const next = path === "" ? key : `${path}.${key}`;
      if (RESERVED_KEYS.includes(key)) invalid(context, next, "Field is not allowed");
      stack.push([node[key], next]);
    }
  }
}

export function checkText(context, value, field, max = 1024) {
  if (typeof value !== "string") invalid(context, field);
  if (hasBadCharacter(value)) invalid(context, field, "Value contains invalid characters");
  if (value.length > max) invalid(context, field, `Value must be at most ${max} characters`);
  return value;
}

/** Non-empty string (after trim) or EMPTY_FIELD. */
export function requireText(context, input, key, max, field = key) {
  const value = hasOwn(input, key) ? input[key] : undefined;
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) empty(context, field);
  return checkText(context, value, field, max);
}

/** Present → checked string; absent → undefined; null → null. */
export function optionalText(context, input, key, max, field = key) {
  if (!hasOwn(input, key)) return undefined;
  if (input[key] === null) return null;
  return checkText(context, input[key], field, max);
}

export function checkEmail(context, value, field = "email") {
  if (typeof value !== "string" || value.trim() === "") empty(context, field);
  if (value.length > 254 || !EMAIL.test(value)) invalid(context, field, "Email is invalid");
  return value.toLowerCase();
}

export function checkEnum(context, value, allowed, field) {
  if (typeof value !== "string" || !allowed.includes(value)) invalid(context, field);
  return value;
}

export function checkCountry(context, value, field) {
  if (typeof value !== "string" || value === "") empty(context, field);
  return checkEnum(context, value.toUpperCase(), COUNTRIES, field);
}

export function checkCurrency(context, value, field) {
  if (typeof value !== "string" || value === "") empty(context, field);
  return checkEnum(context, value.toUpperCase(), CURRENCIES, field);
}

export function checkTags(context, value, field = "tags") {
  if (!Array.isArray(value) || value.length > 20) invalid(context, field);
  const tags = [];
  for (const [index, tag] of value.entries()) {
    checkText(context, tag, `${field}[${index}]`, 50);
    if (tag.trim() === "") invalid(context, `${field}[${index}]`);
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

export function checkDigits(context, value, field, min, max) {
  if (typeof value !== "string" || value === "") empty(context, field);
  if (!/^[0-9]+$/.test(value) || value.length < min || value.length > max) invalid(context, field, "Value must contain only digits");
  return value;
}

/** Rejects fields the operation does not accept (read-only or unknown), naming the first one. */
export function onlyFields(context, input, allowed, readOnly = []) {
  for (const key of Object.keys(input)) {
    if (readOnly.includes(key)) invalid(context, key, "Field is read-only");
    if (!allowed.includes(key)) invalid(context, key, "Field is not allowed");
  }
}
