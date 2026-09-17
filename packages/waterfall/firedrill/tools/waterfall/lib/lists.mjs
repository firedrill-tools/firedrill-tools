// List, enum and paging validation shared by the search operations. Enum matches are case-insensitive and answer
// the canonical spelling; page parameters follow the documented bounds.
import { clip, fail } from "./core.mjs";

export const DEPARTMENTS = [
  "C-Suite", "Product", "Engineering & Technical", "Design", "Education", "Finance", "Human Resources",
  "Information Technology", "Legal", "Marketing", "Medical & Health", "Operations", "Sales", "Consulting",
];
export const SENIORITIES = ["Owner", "CXO", "Partner", "Vice President", "Director", "Manager", "Senior", "Entry", "Other"];
export const COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"];

const bad = (context, detail) => fail(context, "VALIDATION_BAD_REQUEST", "Bad request", [detail]);

/** Optional list of strings; `null`/absent → `[]`. Bounds: item count and item length. */
export function stringList(context, input, name, { maxItems = 100, minLength = 1, maxLength = 200 } = {}) {
  if (!Object.hasOwn(input, name) || input[name] === null) return [];
  const value = input[name];
  if (!Array.isArray(value)) bad(context, `${name}: Input should be a valid list`);
  if (value.length > maxItems) bad(context, `${name}: List should have at most ${maxItems} items`);
  const items = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") bad(context, `${name}.${index}: Input should be a valid string`);
    if (item.trim().length < minLength) bad(context, `${name}.${index}: String should have at least ${minLength} character${minLength === 1 ? "" : "s"}`);
    if (item.length > maxLength) bad(context, `${name}.${index}: String should have at most ${maxLength} characters`);
    if (item.includes("�")) bad(context, `${name}.${index}: Invalid characters`);
    items.push(item);
  }
  return items;
}

/** Validate list items against an enum (case-insensitive); returns the canonical spellings. */
export function enumList(context, input, name, values, maxItems = 50) {
  const items = stringList(context, input, name, { maxItems, maxLength: 60 });
  const canonical = new Map(values.map((value) => [value.toLowerCase(), value]));
  return items.map((item, index) => {
    const match = canonical.get(item.trim().toLowerCase());
    if (match === undefined) bad(context, `${name}.${index}: Input should be one of ${values.join(", ")} (got ${clip(item, 60)})`);
    return match;
  });
}

/** Lowercased trimmed copies for case-insensitive exact matching. */
export function foldAll(items) {
  return items.map((item) => item.trim().toLowerCase());
}

/** `page_number` (1–100, default 1) and `page_size` (1–`maxSize`, default `defaultSize`). */
export function pageParameters(context, input, defaultSize, maxSize = 250) {
  const read = (name, fallback, max) => {
    if (!Object.hasOwn(input, name) || input[name] === null) return fallback;
    const value = input[name];
    if (typeof value !== "number" || !Number.isInteger(value)) bad(context, `${name}: Input should be a valid integer`);
    if (value < 1) bad(context, `${name}: Input should be greater than or equal to 1`);
    if (value > max) bad(context, `${name}: Input should be less than or equal to ${max}`);
    return value;
  };
  return { page_number: read("page_number", 1, 100), page_size: read("page_size", defaultSize, maxSize) };
}

/** True when `haystack` (a lowercase string or `null`) is one of the lowercase `needles` (an empty list matches all). */
export function matchesAny(needles, haystack) {
  if (needles.length === 0) return true;
  if (haystack === null || haystack === undefined) return false;
  const folded = haystack.toLowerCase();
  for (const needle of needles) if (needle === folded) return true;
  return false;
}
