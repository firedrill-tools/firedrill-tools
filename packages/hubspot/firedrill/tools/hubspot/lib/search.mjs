// CRM search semantics: filterGroups (OR of ANDs), free-text query and sorting. Pure functions over record property
// maps and property definitions. Matching is linear in the property values and every request carries a work budget.
import { clip, parseMillis } from "./state.mjs";
import { charge, globMatcher, lowerBound } from "./search-matchers.mjs";

export { MAX_MATCH_WORK, createWorkBudget } from "./search-matchers.mjs";

export const OPERATORS = Object.freeze([
  "EQ",
  "NEQ",
  "LT",
  "LTE",
  "GT",
  "GTE",
  "BETWEEN",
  "IN",
  "NOT_IN",
  "HAS_PROPERTY",
  "NOT_HAS_PROPERTY",
  "CONTAINS_TOKEN",
  "NOT_CONTAINS_TOKEN",
]);

export const MAX_FILTER_GROUPS = 5;
export const MAX_FILTERS_PER_GROUP = 6;
export const MAX_FILTERS_TOTAL = 18;

/** HubSpot caps a search `query` at 3,000 characters; filter values use the same bound. */
export const MAX_SEARCH_TEXT = 3000;

const TOKEN_SEPARATOR = /[^\p{L}\p{N}@._+-]+/u;

function isDateType(definition) {
  return definition.type === "datetime" || definition.type === "date";
}

/** Comparable form of a raw value (number, epoch ms or lower-cased string); undefined when empty or unparsable. */
function comparable(definition, value) {
  if (value === null || value === undefined || value === "") return undefined;
  if (definition.type === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  if (isDateType(definition)) return parseMillis(String(value));
  return String(value).toLowerCase();
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function splitTokens(folded) {
  return folded.split(TOKEN_SEPARATOR).filter((token) => token.length > 0);
}

/** An own property of a record's property map (never an inherited member such as `constructor`). */
function own(properties, name) {
  return Object.hasOwn(properties, name) ? properties[name] : undefined;
}

/**
 * The framework decodes query strings and request bodies leniently, so malformed percent-encoding
 * (`%E0%A4%A`) reaches the Tool as U+FFFD. A search value holding U+FFFD is a mangled request, not
 * search text: reject it instead of running a corrupted filter that silently matches nothing. A
 * correctly encoded U+FFFD (`%EF%BF%BD`) is rejected the same way; `%ZZ` stays literal and matches.
 */
export function isMangled(value) {
  return typeof value === "string" && value.includes("\uFFFD");
}

/**
 * Validate one filter and return `{ filter }` (normalised, with its comparison values precomputed) or `{ error }`.
 * `definitions` is a Map of property name → definition for the object type.
 */
export function normalizeFilter(filter, definitions) {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return { error: "Each filter must be an object" };
  const name = filter.propertyName;
  if (typeof name !== "string" || name.length === 0) return { error: "propertyName is required on every filter" };
  const definition = definitions.get(name);
  if (definition === undefined) return { error: `Property "${clip(name)}" does not exist` };
  const operator = filter.operator;
  if (typeof operator !== "string" || !OPERATORS.includes(operator)) {
    return { error: `Invalid operator ${clip(JSON.stringify(operator ?? null))}; supported operators: ${OPERATORS.join(", ")}` };
  }
  const scalar = (value) => (typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined);
  const tooLong = (field) => `Filter ${operator} on "${clip(name)}": ${field} exceeds the maximum length of ${MAX_SEARCH_TEXT} characters`;
  const mangledValue = (field) => `Filter ${operator} on "${clip(name)}": ${field} contains an invalid character (U+FFFD); check the encoding of the request`;
  const isDate = isDateType(definition);
  const invalidDate = (text) => `${clip(JSON.stringify(text))} is not a valid date for "${clip(name)}"; use epoch milliseconds or ISO 8601`;
  if (operator === "IN" || operator === "NOT_IN") {
    if (!Array.isArray(filter.values) || filter.values.length === 0) return { error: `Filter ${operator} on "${clip(name)}" requires a non-empty values array` };
    const values = [];
    for (const item of filter.values) {
      const value = scalar(item);
      if (value === undefined) return { error: `Filter ${operator} on "${clip(name)}" has a non-scalar value` };
      if (value.length > MAX_SEARCH_TEXT) return { error: tooLong("a value in values") };
      if (isMangled(value)) return { error: mangledValue("a value in values") };
      if (isDate && parseMillis(value) === undefined) return { error: invalidDate(value) };
      values.push(value);
    }
    const valueSet = new Set();
    for (const value of values) {
      const key = comparable(definition, value);
      if (key !== undefined) valueSet.add(key);
    }
    return { filter: { definition, operator, values, valueSet } };
  }
  if (operator === "HAS_PROPERTY" || operator === "NOT_HAS_PROPERTY") return { filter: { definition, operator } };
  const value = scalar(filter.value);
  if (value === undefined) return { error: `Filter ${operator} on "${clip(name)}" requires a value` };
  if (value.length > MAX_SEARCH_TEXT) return { error: tooLong("value") };
  if (isMangled(value)) return { error: mangledValue("value") };
  if (isDate && operator !== "CONTAINS_TOKEN" && operator !== "NOT_CONTAINS_TOKEN" && parseMillis(value) === undefined) return { error: invalidDate(value) };
  if (operator === "BETWEEN") {
    const highValue = scalar(filter.highValue);
    if (highValue === undefined) return { error: `Filter BETWEEN on "${clip(name)}" requires a highValue` };
    if (highValue.length > MAX_SEARCH_TEXT) return { error: tooLong("highValue") };
    if (isMangled(highValue)) return { error: mangledValue("highValue") };
    if (isDate && parseMillis(highValue) === undefined) return { error: invalidDate(highValue) };
    return { filter: { definition, operator, value, highValue, expected: comparable(definition, value), high: comparable(definition, highValue) } };
  }
  if (operator === "CONTAINS_TOKEN" || operator === "NOT_CONTAINS_TOKEN") return { filter: { definition, operator, value, match: globMatcher(value) } };
  return { filter: { definition, operator, value, expected: comparable(definition, value) } };
}

/** Validate a whole `filterGroups` array → `{ groups }` or `{ error }`. */
export function normalizeFilterGroups(filterGroups, definitions) {
  if (filterGroups === undefined) return { groups: [] };
  if (!Array.isArray(filterGroups)) return { error: "filterGroups must be an array" };
  if (filterGroups.length > MAX_FILTER_GROUPS) return { error: `At most ${MAX_FILTER_GROUPS} filterGroups are allowed` };
  const groups = [];
  let total = 0;
  for (const group of filterGroups) {
    const filters = typeof group === "object" && group !== null ? group.filters : undefined;
    if (!Array.isArray(filters)) return { error: "Each filterGroup must carry a filters array" };
    if (filters.length > MAX_FILTERS_PER_GROUP) return { error: `At most ${MAX_FILTERS_PER_GROUP} filters are allowed per filterGroup` };
    total += filters.length;
    if (total > MAX_FILTERS_TOTAL) return { error: `At most ${MAX_FILTERS_TOTAL} filters are allowed across all filterGroups` };
    const normalized = [];
    for (const filter of filters) {
      const result = normalizeFilter(filter, definitions);
      if (result.error !== undefined) return { error: result.error };
      normalized.push(result.filter);
    }
    groups.push(normalized);
  }
  return { groups };
}

/**
 * A per-request record predicate: OR across groups, AND within a group (no groups → every record matches), then
 * every free-text query token must be a prefix of some token in one of the `searchable` properties. Each record's
 * property values are folded and tokenised at most once, all work is charged to `budget`, and evaluation stops as
 * soon as the budget is exhausted (the caller must check `budget.exceeded` and fail the request).
 */
export function createRecordMatcher(groups, query, searchable, budget) {
  const needles = [...new Set(splitTokens(String(query).toLowerCase()))];
  return (properties) => {
    const entries = new Map();
    const entry = (name) => {
      let found = entries.get(name);
      if (found === undefined) {
        found = { raw: own(properties, name), folded: undefined, tokens: undefined };
        entries.set(name, found);
      }
      return found;
    };
    const folded = (item) => {
      if (item.folded === undefined) {
        const text = String(item.raw);
        charge(budget, text.length);
        item.folded = text.toLowerCase();
      }
      return item.folded;
    };
    const tokensOf = (item) => {
      if (item.tokens === undefined) {
        const text = folded(item);
        charge(budget, text.length);
        item.tokens = splitTokens(text);
      }
      return item.tokens;
    };
    const actualOf = (definition, item) => {
      if (!hasValue(item.raw)) return undefined;
      if (definition.type === "number" || isDateType(definition)) {
        charge(budget, String(item.raw).length);
        return comparable(definition, item.raw);
      }
      return folded(item);
    };
    const matchesFilter = (filter) => {
      const { definition, operator } = filter;
      const item = entry(definition.name);
      switch (operator) {
        case "HAS_PROPERTY":
          return hasValue(item.raw);
        case "NOT_HAS_PROPERTY":
          return !hasValue(item.raw);
        case "IN":
        case "NOT_IN": {
          const actual = actualOf(definition, item);
          const hit = actual !== undefined && filter.valueSet.has(actual);
          return operator === "IN" ? hit : !hit;
        }
        case "CONTAINS_TOKEN":
        case "NOT_CONTAINS_TOKEN": {
          let hit = false;
          if (hasValue(item.raw)) {
            const tokens = tokensOf(item);
            if (!charge(budget, item.folded.length + tokens.length)) return false;
            hit = tokens.some(filter.match);
          }
          return operator === "CONTAINS_TOKEN" ? hit : !hit;
        }
        default: {
          const actual = actualOf(definition, item);
          const expected = filter.expected;
          if (operator === "NEQ") return actual === undefined || expected === undefined || actual !== expected;
          if (actual === undefined || expected === undefined) return false;
          if (operator === "EQ") return actual === expected;
          if (operator === "LT") return actual < expected;
          if (operator === "LTE") return actual <= expected;
          if (operator === "GT") return actual > expected;
          if (operator === "GTE") return actual >= expected;
          if (operator === "BETWEEN") return filter.high !== undefined && actual >= expected && actual <= filter.high;
          return false;
        }
      }
    };
    if (groups.length > 0 && !groups.some((group) => group.every((filter) => !budget.exceeded && matchesFilter(filter)))) return false;
    if (budget.exceeded || needles.length === 0) return !budget.exceeded;
    const unique = new Set();
    for (const name of searchable) {
      const item = entry(name);
      if (hasValue(item.raw)) for (const token of tokensOf(item)) unique.add(token);
    }
    const haystack = [...unique].sort();
    const steps = Math.ceil(Math.log2(haystack.length + 1)) + 1;
    if (!charge(budget, haystack.length * steps)) return false;
    for (const needle of needles) {
      if (!charge(budget, needle.length * steps)) return false;
      const candidate = haystack[lowerBound(haystack, needle)];
      if (candidate === undefined || !candidate.startsWith(needle)) return false;
    }
    return true;
  };
}

/** Validate `sorts` (objects or `"-name"` strings) → `{ sort }` (or `{ sort: undefined }`) or `{ error }`. */
export function normalizeSorts(sorts, definitions) {
  if (sorts === undefined) return { sort: undefined };
  if (!Array.isArray(sorts)) return { error: "sorts must be an array" };
  if (sorts.length === 0) return { sort: undefined };
  if (sorts.length > 1) return { error: "Only one sort is supported" };
  const entry = sorts[0];
  let name;
  let direction = "ASCENDING";
  if (typeof entry === "string") {
    name = entry.startsWith("-") ? entry.slice(1) : entry;
    direction = entry.startsWith("-") ? "DESCENDING" : "ASCENDING";
  } else if (typeof entry === "object" && entry !== null) {
    name = entry.propertyName;
    direction = entry.direction ?? "ASCENDING";
  }
  if (typeof name !== "string" || name.length === 0) return { error: "sorts[0].propertyName is required" };
  const definition = definitions.get(name);
  if (definition === undefined) return { error: `Property "${clip(name)}" does not exist` };
  if (direction !== "ASCENDING" && direction !== "DESCENDING") return { error: "sorts[0].direction must be ASCENDING or DESCENDING" };
  return { sort: { definition, direction } };
}

/**
 * Sort records in place by `sort` (missing values last in both directions, ties by numeric id). Sort keys are
 * computed once per record and charged to `budget`, so comparisons never re-fold property values.
 */
export function sortRecords(records, sort, budget) {
  const { definition, direction } = sort;
  const keyed = records.map((record) => {
    const raw = own(record.properties, definition.name);
    if (typeof raw === "string") charge(budget, raw.length);
    return { record, key: comparable(definition, raw), id: Number(record.id) };
  });
  if (budget.exceeded) return records;
  keyed.sort((left, right) => {
    const a = left.key;
    const b = right.key;
    let order = 0;
    if (a === undefined && b !== undefined) order = 1;
    else if (b === undefined && a !== undefined) order = -1;
    else if (a !== undefined && b !== undefined) {
      order = a < b ? -1 : a > b ? 1 : 0;
      if (direction === "DESCENDING") order = -order;
    }
    return order || left.id - right.id;
  });
  keyed.forEach((entry, index) => {
    records[index] = entry.record;
  });
  return records;
}
