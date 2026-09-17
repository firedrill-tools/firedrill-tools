// Pydantic-flavoured parsers for caller values that may arrive as strings (multipart, query) or typed JSON.
import { clip } from "./util.mjs";

const TRUE = new Set(["true", "1", "yes", "on", "t", "y"]);
const FALSE = new Set(["false", "0", "no", "off", "f", "n"]);

export function parseBool(value, loc, issues, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (TRUE.has(lower)) return true;
    if (FALSE.has(lower)) return false;
  }
  if (value === 1) return true;
  if (value === 0) return false;
  issues.add(loc, "Input should be a valid boolean, unable to interpret input");
  return fallback;
}

export function parseInteger(value, loc, issues, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  let number = value;
  if (typeof value === "string") {
    if (!/^\s*-?\d{1,15}\s*$/.test(value)) {
      issues.add(loc, "Input should be a valid integer, unable to parse string as an integer");
      return fallback;
    }
    number = Number(value.trim());
  }
  if (typeof number !== "number" || !Number.isInteger(number)) {
    issues.add(loc, "Input should be a valid integer");
    return fallback;
  }
  if (number < min) {
    issues.add(loc, `Input should be greater than or equal to ${min}`);
    return fallback;
  }
  if (number > max) {
    issues.add(loc, `Input should be less than or equal to ${max}`);
    return fallback;
  }
  return number;
}

const quoteList = (allowed) => {
  const quoted = allowed.map((item) => `'${item}'`);
  return quoted.length <= 1 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
};

export function parseEnum(value, loc, issues, allowed, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && allowed.includes(value)) return value;
  issues.add(loc, `Input should be ${quoteList(allowed)}`);
  return fallback;
}

export function parseString(value, loc, issues, { required = false, min = 0, max = 200 } = {}) {
  if (value === undefined || value === null) {
    if (required) issues.add(loc, "Field required");
    return null;
  }
  if (typeof value !== "string") {
    issues.add(loc, "Input should be a valid string");
    return null;
  }
  if (value.length < min) {
    issues.add(loc, `String should have at least ${min} character${min === 1 ? "" : "s"}`);
    return null;
  }
  if (value.length > max) {
    issues.add(loc, `String should have at most ${max} characters`);
    return null;
  }
  return value;
}

/** Strings must not carry U+FFFD (a mangled percent-encoding) when used as identifiers or filters. */
export const mangled = (value) => typeof value === "string" && value.includes("�");

export const describe = (value) => clip(typeof value === "string" ? value : JSON.stringify(value) ?? String(value), 100);

export const MAX_LANGUAGES = 20;
export const MAX_LANGUAGE_LENGTH = 20;

/**
 * The `languages` parameter: an array of strings or one comma-separated string. More than MAX_LANGUAGES entries, an
 * entry longer than MAX_LANGUAGE_LENGTH or a non-string entry is a validation issue; the list is never shortened.
 * Returns the list (empty when absent) or null (issue added).
 */
export function parseLanguages(value, loc, issues) {
  if (value === undefined || value === null || value === "") return [];
  let list;
  if (Array.isArray(value)) list = value;
  else if (typeof value === "string") list = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  else {
    issues.add(loc, "Input should be a valid list");
    return null;
  }
  if (list.length > MAX_LANGUAGES) {
    issues.add(loc, `List should have at most ${MAX_LANGUAGES} items after validation, not ${list.length}`);
    return null;
  }
  let ok = true;
  for (const [index, item] of list.entries()) {
    if (typeof item !== "string") {
      issues.add(`${loc}.${index}`, "Input should be a valid string");
      ok = false;
    } else if (item.length > MAX_LANGUAGE_LENGTH) {
      issues.add(`${loc}.${index}`, `String should have at most ${MAX_LANGUAGE_LENGTH} characters`);
      ok = false;
    }
  }
  return ok ? list : null;
}
