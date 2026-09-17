// Data-source query semantics: Notion's per-type filter conditions, compound filters (two levels, ≤ 100
// conditions per group), relative date windows from virtual time, and stable sorts.
import { TEXT_TYPES, findDefinition, propertyValue } from "./properties.mjs";
import { plainText } from "./rich-text.mjs";
import { isMangled, mangledError, shown, validationError } from "./state.mjs";

const DAY_MS = 86400000;
const MAX_GROUP = 100;
const MAX_DEPTH = 2;
const TEXT_CONDITIONS = ["equals", "does_not_equal", "contains", "does_not_contain", "starts_with", "ends_with", "is_empty", "is_not_empty"];
const NUMBER_CONDITIONS = ["equals", "does_not_equal", "greater_than", "less_than", "greater_than_or_equal_to", "less_than_or_equal_to", "is_empty", "is_not_empty"];
const CHECKBOX_CONDITIONS = ["equals", "does_not_equal"];
const OPTION_CONDITIONS = ["equals", "does_not_equal", "is_empty", "is_not_empty"];
const CONTAINS_CONDITIONS = ["contains", "does_not_contain", "is_empty", "is_not_empty"];
const DATE_CONDITIONS = ["equals", "before", "after", "on_or_before", "on_or_after", "is_empty", "is_not_empty", "this_week", "past_week", "past_month", "past_year", "next_week", "next_month", "next_year"];
const DATE_TYPES = ["date", "created_time", "last_edited_time"];

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function conditionsFor(type) {
  if (TEXT_TYPES.includes(type)) return TEXT_CONDITIONS;
  if (type === "number") return NUMBER_CONDITIONS;
  if (type === "checkbox") return CHECKBOX_CONDITIONS;
  if (type === "select" || type === "status") return OPTION_CONDITIONS;
  if (type === "multi_select" || type === "people" || type === "relation" || type === "created_by" || type === "last_edited_by") return CONTAINS_CONDITIONS;
  if (DATE_TYPES.includes(type)) return DATE_CONDITIONS;
  return [];
}

function textOf(type, value) {
  if (value === null || value === undefined) return "";
  return type === "title" || type === "rich_text" ? plainText(value) : String(value);
}

function dayIndex(ms) {
  return Math.floor(ms / DAY_MS);
}

/** Compare a stored date (`{start}` or timestamp) with a filter value; date-only values compare by UTC day. */
function compareDates(stored, filterValue) {
  const storedString = isObject(stored) ? stored.start : stored;
  const storedMs = Date.parse(storedString);
  const filterMs = Date.parse(filterValue);
  if (Number.isNaN(storedMs) || Number.isNaN(filterMs)) return undefined;
  const dayOnly = storedString.length === 10 || filterValue.length === 10;
  const left = dayOnly ? dayIndex(storedMs) : storedMs;
  const right = dayOnly ? dayIndex(filterMs) : filterMs;
  return left < right ? -1 : left > right ? 1 : 0;
}

function windowFor(condition, nowMs) {
  const dayStart = dayIndex(nowMs) * DAY_MS;
  switch (condition) {
    case "past_week":
      return [nowMs - 7 * DAY_MS, nowMs];
    case "past_month":
      return [nowMs - 30 * DAY_MS, nowMs];
    case "past_year":
      return [nowMs - 365 * DAY_MS, nowMs];
    case "next_week":
      return [nowMs, nowMs + 7 * DAY_MS];
    case "next_month":
      return [nowMs, nowMs + 30 * DAY_MS];
    case "next_year":
      return [nowMs, nowMs + 365 * DAY_MS];
    case "this_week": {
      const weekday = (new Date(dayStart).getUTCDay() + 6) % 7; // Monday = 0
      const monday = dayStart - weekday * DAY_MS;
      return [monday, monday + 7 * DAY_MS - 1];
    }
    default:
      return undefined;
  }
}

function evaluate(type, condition, expected, value, nowMs) {
  if (TEXT_TYPES.includes(type)) {
    const text = textOf(type, value).toLowerCase();
    const needle = typeof expected === "string" ? expected.toLowerCase() : "";
    switch (condition) {
      case "equals": return text === needle;
      case "does_not_equal": return text !== needle;
      case "contains": return text.includes(needle);
      case "does_not_contain": return !text.includes(needle);
      case "starts_with": return text.startsWith(needle);
      case "ends_with": return text.endsWith(needle);
      case "is_empty": return text.length === 0;
      case "is_not_empty": return text.length > 0;
      default: return false;
    }
  }
  if (type === "number") {
    const empty = value === null || value === undefined;
    switch (condition) {
      case "is_empty": return empty;
      case "is_not_empty": return !empty;
      case "equals": return !empty && value === expected;
      case "does_not_equal": return empty || value !== expected;
      case "greater_than": return !empty && value > expected;
      case "less_than": return !empty && value < expected;
      case "greater_than_or_equal_to": return !empty && value >= expected;
      case "less_than_or_equal_to": return !empty && value <= expected;
      default: return false;
    }
  }
  if (type === "checkbox") return condition === "equals" ? value === expected : value !== expected;
  if (type === "select" || type === "status") {
    const name = value === null ? null : value.name;
    switch (condition) {
      case "equals": return name === expected;
      case "does_not_equal": return name !== expected;
      case "is_empty": return name === null;
      case "is_not_empty": return name !== null;
      default: return false;
    }
  }
  if (type === "multi_select" || type === "people" || type === "relation" || type === "created_by" || type === "last_edited_by") {
    const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
    const keys = items.map((item) => (type === "multi_select" ? item.name : item.id));
    switch (condition) {
      case "contains": return keys.includes(expected);
      case "does_not_contain": return !keys.includes(expected);
      case "is_empty": return keys.length === 0;
      case "is_not_empty": return keys.length > 0;
      default: return false;
    }
  }
  if (DATE_TYPES.includes(type)) {
    const empty = value === null || value === undefined;
    if (condition === "is_empty") return empty;
    if (condition === "is_not_empty") return !empty;
    if (empty) return false;
    const window = windowFor(condition, nowMs);
    if (window !== undefined) {
      const start = isObject(value) ? value.start : value;
      const ms = Date.parse(start);
      if (Number.isNaN(ms)) return false;
      // Date-only values are compared by UTC calendar day, so "today" falls inside next_week / this_week.
      if (start.length === 10) return dayIndex(ms) >= dayIndex(window[0]) && dayIndex(ms) <= dayIndex(window[1]);
      return ms >= window[0] && ms <= window[1];
    }
    const order = compareDates(value, expected);
    if (order === undefined) return false;
    switch (condition) {
      case "equals": return order === 0;
      case "before": return order < 0;
      case "after": return order > 0;
      case "on_or_before": return order <= 0;
      case "on_or_after": return order >= 0;
      default: return false;
    }
  }
  return false;
}

function expectedValueValid(type, condition, expected) {
  if (condition === "is_empty" || condition === "is_not_empty" || windowFor(condition, 0) !== undefined) return isObject(expected) || expected === true;
  if (TEXT_TYPES.includes(type) || type === "select" || type === "status" || type === "multi_select") return typeof expected === "string";
  if (type === "number") return typeof expected === "number" && Number.isFinite(expected);
  if (type === "checkbox") return typeof expected === "boolean";
  if (DATE_TYPES.includes(type)) return typeof expected === "string" && !Number.isNaN(Date.parse(expected));
  return typeof expected === "string";
}

/** Compile a filter object into a predicate over page rows; throws declared VALIDATION_ERRORs. */
export function compileFilter(context, definitions, filter, path = "filter", depth = 1) {
  if (!isObject(filter)) return validationError(context, `body failed validation: body.${path} should be an object.`);
  const compound = filter.and !== undefined ? "and" : filter.or !== undefined ? "or" : undefined;
  if (compound !== undefined) {
    if (depth > MAX_DEPTH) return validationError(context, `body failed validation: body.${path}.${compound} nests compound filters deeper than ${MAX_DEPTH} levels.`);
    const group = filter[compound];
    if (!Array.isArray(group)) return validationError(context, `body failed validation: body.${path}.${compound} should be an array.`);
    if (group.length > MAX_GROUP) return validationError(context, `body failed validation: body.${path}.${compound}.length should be ≤ ${MAX_GROUP}, instead was ${group.length}.`);
    const predicates = group.map((child, index) => compileFilter(context, definitions, child, `${path}.${compound}[${index}]`, depth + 1));
    return compound === "and" ? (page, nowMs) => predicates.every((predicate) => predicate(page, nowMs)) : (page, nowMs) => predicates.some((predicate) => predicate(page, nowMs));
  }
  let type;
  let read;
  if (typeof filter.timestamp === "string") {
    if (filter.timestamp !== "created_time" && filter.timestamp !== "last_edited_time") {
      return validationError(context, `body failed validation: body.${path}.timestamp should be "created_time" or "last_edited_time", instead was \`${filter.timestamp}\`.`);
    }
    type = filter.timestamp;
    read = (page) => page[type];
  } else {
    if (typeof filter.property !== "string") return validationError(context, `body failed validation: body.${path}.property should be a string.`);
    if (isMangled(filter.property)) return mangledError(context, `body.${path}.property`);
    const definition = findDefinition(definitions, filter.property);
    if (definition === undefined) return validationError(context, `Could not find property with name or id: ${filter.property}`);
    type = definition.type;
    read = (page) => propertyValue(page, definition);
  }
  const filterKey = filter[type] !== undefined ? type : type === "title" && filter.rich_text !== undefined ? "rich_text" : undefined;
  if (filterKey === undefined || !isObject(filter[filterKey])) {
    return validationError(context, `body failed validation: body.${path}.${type} should be defined, instead was \`undefined\`.`);
  }
  const conditions = Object.keys(filter[filterKey]);
  if (conditions.length !== 1) return validationError(context, `body failed validation: body.${path}.${filterKey} should contain exactly one condition.`);
  const condition = conditions[0];
  const allowed = conditionsFor(type);
  if (!allowed.includes(condition)) {
    return validationError(context, `body failed validation: body.${path}.${filterKey}.${condition} is not a supported condition for ${type} properties (supported: ${allowed.join(", ")}).`);
  }
  const expected = filter[filterKey][condition];
  // A filter value carrying U+FFFD is a mangled request, not a literal to match (RECIPE, lenient decoding).
  if (isMangled(expected)) return mangledError(context, `body.${path}.${filterKey}.${condition}`);
  if (!expectedValueValid(type, condition, expected)) {
    return validationError(context, `body failed validation: body.${path}.${filterKey}.${condition} should be a valid ${type} filter value, instead was \`${JSON.stringify(expected)}\`.`);
  }
  return (page, nowMs) => evaluate(type, condition, expected, read(page), nowMs);
}

function sortKey(type, value, definition) {
  if (value === null || value === undefined) return undefined;
  if (TEXT_TYPES.includes(type)) {
    const text = textOf(type, value);
    return text.length === 0 ? undefined : text.toLowerCase();
  }
  if (type === "number") return value;
  if (type === "checkbox") return value ? 1 : 0;
  if (type === "select" || type === "status") {
    const index = definition.config.options.findIndex((option) => option.id === value.id);
    return index < 0 ? undefined : index;
  }
  if (type === "multi_select") return value.length === 0 ? undefined : value[0].name.toLowerCase();
  if (type === "people" || type === "relation") return value.length === 0 ? undefined : value[0].id;
  if (type === "created_by" || type === "last_edited_by") return value.id;
  if (DATE_TYPES.includes(type)) {
    const ms = Date.parse(isObject(value) ? value.start : value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** Compile `sorts` into a comparator; empties sort last, ties keep creation (row-id) order. */
export function compileSorts(context, definitions, sorts) {
  if (sorts === undefined) return () => 0;
  if (!Array.isArray(sorts)) return validationError(context, "body failed validation: body.sorts should be an array.");
  const keys = sorts.map((sort, index) => {
    if (!isObject(sort)) return validationError(context, `body failed validation: body.sorts[${index}] should be an object.`);
    if (sort.direction !== "ascending" && sort.direction !== "descending") {
      return validationError(context, `body failed validation: body.sorts[${index}].direction should be "ascending" or "descending", instead was \`${shown(sort.direction)}\`.`);
    }
    const sign = sort.direction === "ascending" ? 1 : -1;
    if (typeof sort.timestamp === "string") {
      if (sort.timestamp !== "created_time" && sort.timestamp !== "last_edited_time") {
        return validationError(context, `body failed validation: body.sorts[${index}].timestamp should be "created_time" or "last_edited_time".`);
      }
      const field = sort.timestamp;
      return { sign, key: (page) => Date.parse(page[field]) };
    }
    if (typeof sort.property !== "string") return validationError(context, `body failed validation: body.sorts[${index}].property should be a string.`);
    if (isMangled(sort.property)) return mangledError(context, `body.sorts[${index}].property`);
    const definition = findDefinition(definitions, sort.property);
    if (definition === undefined) return validationError(context, `Could not find sort property with name or id: ${sort.property}`);
    return { sign, key: (page) => sortKey(definition.type, propertyValue(page, definition), definition) };
  });
  return (left, right) => {
    for (const { sign, key } of keys) {
      const a = key(left);
      const b = key(right);
      if (a === undefined && b === undefined) continue;
      if (a === undefined) return 1;
      if (b === undefined) return -1;
      if (a < b) return -sign;
      if (a > b) return sign;
    }
    return 0;
  };
}
