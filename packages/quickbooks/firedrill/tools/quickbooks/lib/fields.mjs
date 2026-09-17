// Validation of caller-supplied QuickBooks entity JSON. Every helper reads own properties only and answers the
// provider's business-validation fault for a wrong shape, so no caller value can crash a handler.
import { RESERVED_KEYS, clip, dayNumber, isId, toCents } from "./common.mjs";

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function has(object, key) {
  return isObject(object) && Object.hasOwn(object, key);
}

export function own(object, key) {
  return has(object, key) ? object[key] : undefined;
}

/** Refuse unknown or reserved top-level properties. `readonly` names are accepted and ignored. */
export function checkKeys(s, body, writable, readonly) {
  for (const key of Object.keys(body)) {
    if (RESERVED_KEYS.has(key) || (!writable.has(key) && !readonly.has(key))) {
      s.fail("BUSINESS_VALIDATION", `Request has invalid or unsupported property : Property Name:${clip(key, 80)} specified is unsupported or invalid`, clip(key, 80));
    }
  }
}

function invalid(s, key, what) {
  return s.fail("BUSINESS_VALIDATION", `Invalid value for ${key}: ${what}`, key);
}

/** undefined when absent, null when null or empty, otherwise a string no longer than max. */
export function optString(s, body, key, max) {
  if (!has(body, key)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "string") return invalid(s, key, "expected a string");
  if (value.length > max) return s.fail("BUSINESS_VALIDATION", `String length is either shorter or longer than supported by specification. Min:0 Max:${max} supported. Supplied length:${value.length}`, key);
  return value.length === 0 ? null : value;
}

export function optBool(s, body, key) {
  if (!has(body, key)) return undefined;
  const value = body[key];
  if (typeof value !== "boolean") return invalid(s, key, "expected true or false");
  return value;
}

export function optEnum(s, body, key, allowed) {
  if (!has(body, key)) return undefined;
  const value = body[key];
  if (typeof value !== "string" || !allowed.includes(value)) return invalid(s, key, `expected one of ${allowed.join(", ")}`);
  return value;
}

export function optDate(s, body, key) {
  if (!has(body, key)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (dayNumber(value) === null) return invalid(s, key, "expected a date formatted YYYY-MM-DD");
  return value;
}

/** Reference `{ value, name? }`; returns undefined / null / the id string. */
export function optRef(s, body, key) {
  if (!has(body, key)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (!isObject(value)) return invalid(s, key, "expected an object with a value");
  for (const inner of Object.keys(value)) {
    if (inner !== "value" && inner !== "name" && inner !== "type") return invalid(s, key, `unsupported property ${clip(inner, 40)}`);
  }
  const id = value.value;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return invalid(s, key, "value must be a non-empty string");
  return id;
}

export function validEmail(text) {
  if (typeof text !== "string" || text.length < 3 || text.length > 100) return false;
  const at = text.indexOf("@");
  if (at <= 0 || at !== text.lastIndexOf("@") || at === text.length - 1) return false;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code <= 32 || char === "," || char === ";" || char === "<" || char === ">" || char === "\"") return false;
  }
  const domain = text.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

export function optEmail(s, body, key) {
  if (!has(body, key)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (!isObject(value) || Object.keys(value).some((inner) => inner !== "Address")) return invalid(s, key, "expected { Address }");
  if (value.Address === null || value.Address === undefined || value.Address === "") return null;
  if (!validEmail(value.Address)) return s.fail("BUSINESS_VALIDATION", "Invalid Email Address format : Please enter a valid email address.", `${key}.Address`);
  return { Address: value.Address };
}

export function optPhone(s, body, key) {
  if (!has(body, key)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (!isObject(value) || Object.keys(value).some((inner) => inner !== "FreeFormNumber")) return invalid(s, key, "expected { FreeFormNumber }");
  const number = value.FreeFormNumber;
  if (number === null || number === undefined || number === "") return null;
  if (typeof number !== "string" || number.length > 30) return invalid(s, `${key}.FreeFormNumber`, "expected a string of at most 30 characters");
  return { FreeFormNumber: number };
}

const ADDR_FIELDS = [["Line1", 500], ["Line2", 500], ["City", 255], ["CountrySubDivisionCode", 255], ["PostalCode", 30], ["Country", 255]];

export function optAddr(s, body, key) {
  if (!has(body, key)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (!isObject(value)) return invalid(s, key, "expected an address object");
  const out = { Id: null, Line1: null, Line2: null, City: null, CountrySubDivisionCode: null, PostalCode: null, Country: null };
  for (const inner of Object.keys(value)) {
    if (inner === "Id") {
      if (value.Id !== null && !isId(value.Id)) return invalid(s, `${key}.Id`, "expected a numeric id");
      out.Id = value.Id;
      continue;
    }
    const spec = ADDR_FIELDS.find(([name]) => name === inner);
    if (spec === undefined) return invalid(s, key, `unsupported property ${clip(inner, 40)}`);
    const text = optString(s, value, inner, spec[1]);
    out[inner] = text === undefined ? null : text;
  }
  return out;
}

/** Money: number with at most two decimals. */
export function optMoney(s, body, key, { allowNegative = false } = {}) {
  if (!has(body, key)) return undefined;
  const cents = toCents(body[key], { allowNegative });
  if (cents === null) return invalid(s, key, "expected an amount with at most two decimals");
  return cents;
}

/** Deep-check a caller object for reserved keys (iterative; bounded by the framework body size). */
export function reservedKeyIn(value) {
  const stack = [value];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (++visited > 100_000) return "the request body has too many values";
    if (Array.isArray(current)) {
      for (const item of current) if (item !== null && typeof item === "object") stack.push(item);
    } else if (current !== null && typeof current === "object") {
      for (const key of Object.keys(current)) {
        if (RESERVED_KEYS.has(key)) return `the property name ${key} is not allowed`;
        const inner = current[key];
        if (inner !== null && typeof inner === "object") stack.push(inner);
      }
    }
  }
  return null;
}
