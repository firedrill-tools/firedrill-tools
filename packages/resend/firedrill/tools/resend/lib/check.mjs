// Input validation helpers raising Resend's declared errors. Every regex runs on length-bounded input.
import { fail, hasReservedKey } from "./core.mjs";

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/;
const NAMED = /^([^<>]{0,200})<([^<>\s]+)>$/;

export function present(value) {
  return value !== undefined && value !== null && !(typeof value === "string" && value.trim().length === 0);
}

/** `addr` or `Name <addr>` → `{ address, domain }` (domain lowercased) or `null`. */
export function parseAddress(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 320 || text.includes("�")) return null;
  const trimmed = text.trim();
  const named = NAMED.exec(trimmed);
  const address = named === null ? trimmed : named[2];
  if (address.length > 254) return null;
  const match = ADDRESS.exec(address);
  if (match === null || address.split("@")[0].length > 64) return null;
  return { address, domain: match[1].toLowerCase() };
}

/** Normalise a `string | string[]` recipient field into a list, validating each address. */
export function addressList(context, value, field, { max = 50, required = false } = {}) {
  if (!present(value) || (Array.isArray(value) && value.length === 0)) {
    if (required) fail(context, "MISSING_REQUIRED_FIELD", `Missing \`${field}\` field.`);
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  if (list.length > max) fail(context, "VALIDATION_ERROR", `The \`${field}\` field must contain at most ${max} addresses.`);
  for (const entry of list) {
    if (parseAddress(entry) === null) {
      fail(context, "VALIDATION_ERROR", `Invalid \`${field}\` field. The email address needs to follow the \`email@example.com\` or \`Name <email@example.com>\` format.`);
    }
  }
  return list.map((entry) => entry.trim());
}

export function boundedString(context, value, field, { min = 1, max, code = "VALIDATION_ERROR" }) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail(context, code, `The \`${field}\` field must be between ${min} and ${max} characters.`);
  }
  return value;
}

export function utf8Bytes(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Plain object check that also refuses reserved prototype keys. */
export function safeObject(context, value, field, maxKeys) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || hasReservedKey(value)) {
    fail(context, "VALIDATION_ERROR", `The \`${field}\` field must be an object without reserved keys.`);
  }
  if (Object.keys(value).length > maxKeys) fail(context, "VALIDATION_ERROR", `The \`${field}\` field accepts at most ${maxKeys} keys.`);
  return value;
}

export function rejectPresent(context, input, fields, message) {
  for (const field of fields) {
    if (Object.hasOwn(input, field) && input[field] !== null && input[field] !== undefined) {
      fail(context, "VALIDATION_ERROR", message(field));
    }
  }
}
