// Shared list-filter parsing. Filters are normalized so `next`/`previous` URLs and cursor digests are stable.
import { isId } from "../lib/ids.mjs";
import { bad, hasOwn } from "../lib/validate.mjs";

/** `id` filter: up to 100 strings; returns a Set or undefined. */
export function idFilter(context, input, filters) {
  if (!hasOwn(input, "id")) return undefined;
  const list = input.id;
  if (!Array.isArray(list) || list.length > 100 || !list.every((v) => typeof v === "string" && v.length > 0 && v.length <= 100)) {
    bad(context, "id", "Provide up to 100 ids.");
  }
  filters.id = [...list];
  return new Set(list);
}

/** A reference filter such as `company=com_…`; malformed ids are a validation error. */
export function refFilter(context, input, filters, name, prefix) {
  if (!hasOwn(input, name)) return undefined;
  if (!isId(prefix, input[name])) bad(context, name, "Invalid id.");
  filters[name] = input[name];
  return input[name];
}

export function boolFilter(context, input, filters, name, fallback) {
  const value = hasOwn(input, name) ? input[name] : fallback;
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") bad(context, name, "Must be a valid boolean.");
  filters[name] = value;
  return value;
}

export const cursorArg = (context, input) => {
  if (!hasOwn(input, "cursor")) return undefined;
  if (typeof input.cursor !== "string") bad(context, "cursor", "Invalid cursor.");
  return input.cursor;
};

/** Stable sort by name-like string then seq. */
export const nameKey = (value) => (typeof value === "string" ? value : "");
