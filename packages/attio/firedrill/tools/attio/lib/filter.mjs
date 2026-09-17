// Attio filter and sort syntax: validated up front into a predicate tree, evaluated in time linear in the
// data (substring tests use indexOf/startsWith/endsWith, never a RegExp built from caller text).
import { clip, compare, isPlainObject, isReserved, validation } from "./common.mjs";
import { FIELDS, PRIMARY_FIELD, fieldValue, parseInstant, resolveDef } from "./values.mjs";

const MAX_DEPTH = 8;
const MAX_CLAUSES = 100;
const MAX_IN = 100;
const MAX_LOGICAL = 50;
const MAX_STRING = 3_000;
const MAX_SORTS = 5;
const STRING_OPS = new Set(["$eq", "$in", "$contains", "$starts_with", "$ends_with", "$not_empty"]);
const ORDERED_OPS = new Set(["$eq", "$gt", "$gte", "$lt", "$lte", "$not_empty"]);
const NUMERIC_FIELDS = new Set(["value:number", "currency_value:currency"]);

function kindOf(def, field) {
  if (NUMERIC_FIELDS.has(`${field}:${def.type}`)) return "number";
  if (field === "value" && def.type === "checkbox") return "boolean";
  if (field === "value" && def.type === "date") return "date";
  if (field === "value" && def.type === "timestamp") return "timestamp";
  return "string";
}

function fold(text) {
  return text.toLowerCase();
}

/** Compile a filter object. `scope` = { defs, systemFields: boolean, path?: (objectSlug) => defs | undefined, listSlug? }. */
export function compileFilter(context, filter, scope) {
  if (filter === undefined || filter === null) return () => true;
  const budget = { clauses: 0 };
  return node(context, filter, scope, budget, 1);
}

function node(context, value, scope, budget, depth) {
  if (depth > MAX_DEPTH) return validation(context, `Filter is nested more than ${MAX_DEPTH} levels deep.`);
  if (!isPlainObject(value)) return validation(context, "Filter must be an object.");
  const keys = Object.keys(value);
  if (keys.length === 0) return () => true;
  if (Object.hasOwn(value, "path")) return pathNode(context, value, scope, budget, depth);
  const parts = [];
  for (const key of keys) {
    if (++budget.clauses > MAX_CLAUSES) return validation(context, `Filter has more than ${MAX_CLAUSES} clauses.`);
    const operand = value[key];
    if (key === "$and" || key === "$or") {
      if (!Array.isArray(operand) || operand.length === 0 || operand.length > MAX_LOGICAL) {
        return validation(context, `"${key}" expects an array of 1 to ${MAX_LOGICAL} filters.`);
      }
      const children = operand.map((child) => node(context, child, scope, budget, depth + 1));
      parts.push(key === "$and" ? (row) => children.every((child) => child(row)) : (row) => children.some((child) => child(row)));
    } else if (key === "$not") {
      const child = node(context, operand, scope, budget, depth + 1);
      parts.push((row) => !child(row));
    } else if (key.startsWith("$")) {
      return validation(context, `Unknown filter operator "${clip(key)}".`);
    } else {
      parts.push(attributeNode(context, key, operand, scope, budget));
    }
  }
  return parts.length === 1 ? parts[0] : (row) => parts.every((part) => part(row));
}

function pathNode(context, value, scope, budget, depth) {
  const { path, constraints } = value;
  if (scope.path === undefined || !Array.isArray(path) || path.length !== 2 || !isPlainObject(constraints)) {
    return validation(context, "Invalid path filter: expected { path: [[list, \"parent_record\"], [object, attribute]], constraints }.");
  }
  const [first, second] = path;
  if (!Array.isArray(first) || first.length !== 2 || first[0] !== scope.listSlug || first[1] !== "parent_record") {
    return validation(context, "Path filters must start with [<list slug>, \"parent_record\"].");
  }
  if (!Array.isArray(second) || second.length !== 2 || typeof second[0] !== "string" || typeof second[1] !== "string") {
    return validation(context, "Invalid path filter step.");
  }
  const parentDefs = scope.path(second[0]);
  if (parentDefs === undefined) return validation(context, `Path filter object "${clip(second[0])}" is not the list's parent object.`);
  const inner = attributeNode(context, second[1], constraints, { defs: parentDefs, systemFields: true }, budget, depth + 1);
  return (row) => {
    const parent = row.parent();
    return parent !== null && inner(parent);
  };
}

function entriesFor(row, def, systemFields) {
  if (systemFields && def.api_slug === "record_id") return [{ value: row.id }];
  if (systemFields && def.api_slug === "created_at") return [{ value: row.created_at }];
  if (systemFields && def.api_slug === "created_by") return [{ referenced_actor_type: row.created_by_actor.type, referenced_actor_id: row.created_by_actor.id }];
  return Object.hasOwn(row.values, def.api_slug) ? row.values[def.api_slug] : [];
}

function attributeNode(context, key, operand, scope, budget) {
  if (isReserved(key)) return validation(context, `Unknown attribute "${clip(key)}" in filter.`);
  const def = resolveDef(scope.defs, key);
  if (def === undefined || def.is_archived) return validation(context, `Unknown attribute "${clip(key)}" in filter.`);
  const primary = PRIMARY_FIELD[def.type] ?? "value";
  const conditions = [];
  if (!isPlainObject(operand)) {
    conditions.push(condition(context, def, primary, "$eq", operand));
  } else {
    const keys = Object.keys(operand);
    if (keys.length === 0) return validation(context, `Empty filter for attribute "${def.api_slug}".`);
    for (const inner of keys) {
      if (++budget.clauses > MAX_CLAUSES) return validation(context, `Filter has more than ${MAX_CLAUSES} clauses.`);
      const innerValue = operand[inner];
      if (inner.startsWith("$")) {
        conditions.push(condition(context, def, primary, inner, innerValue));
      } else {
        const fields = FIELDS[def.type] ?? ["value"];
        if (!fields.includes(inner)) return validation(context, `Unknown field "${clip(inner)}" for attribute "${def.api_slug}" of type ${def.type}.`);
        if (isPlainObject(innerValue)) {
          const ops = Object.keys(innerValue);
          if (ops.length === 0) return validation(context, `Empty filter for field "${inner}".`);
          for (const op of ops) {
            if (++budget.clauses > MAX_CLAUSES) return validation(context, `Filter has more than ${MAX_CLAUSES} clauses.`);
            conditions.push(condition(context, def, inner, op, innerValue[op]));
          }
        } else {
          conditions.push(condition(context, def, inner, "$eq", innerValue));
        }
      }
    }
  }
  const systemFields = scope.systemFields === true;
  return (row) => {
    const entries = entriesFor(row, def, systemFields);
    return conditions.every((test) => test(entries));
  };
}

function operandString(context, value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return validation(context, "Filter operands must be strings, numbers or booleans.");
  if (value.length > MAX_STRING) return validation(context, `Filter operands are limited to ${MAX_STRING} characters.`);
  if (value.includes("�")) return validation(context, "Filter operand contains an invalid character (U+FFFD).");
  return value;
}

function condition(context, def, field, op, operand) {
  const kind = kindOf(def, field);
  if (op === "$not_empty") {
    if (typeof operand !== "boolean") return validation(context, "\"$not_empty\" expects true or false.");
    return (entries) => (entries.some((entry) => fieldValue(def, entry, field) !== undefined && fieldValue(def, entry, field) !== null) === operand);
  }
  const allowed = kind === "string" ? STRING_OPS : kind === "boolean" ? new Set(["$eq"]) : ORDERED_OPS;
  if (!allowed.has(op)) return validation(context, `Operator "${clip(op)}" is not supported for field "${field}" of attribute "${def.api_slug}".`);
  const any = (test) => (entries) => entries.some((entry) => {
    const actual = fieldValue(def, entry, field);
    return actual !== undefined && actual !== null && test(actual);
  });
  if (kind === "boolean") {
    const expected = operand === true || operand === "true" ? true : operand === false || operand === "false" ? false : validation(context, "Checkbox filters expect true or false.");
    return any((actual) => actual === expected);
  }
  if (kind === "number") {
    let number = operand;
    if (typeof number === "string" && /^-?[0-9]{1,15}(?:\.[0-9]{1,10})?$/.test(number)) number = Number(number);
    if (typeof number !== "number" || !Number.isFinite(number)) return validation(context, `Operator "${op}" expects a number.`);
    return any((actual) => ordered(op, compare(actual, number)));
  }
  if (kind === "date" || kind === "timestamp") {
    const parsed = parseInstant(typeof operand === "string" ? operand : "");
    if (parsed === undefined) return validation(context, `Operator "${op}" expects an ISO 8601 ${kind}.`);
    const expected = kind === "date" ? parsed.date : parsed.timestamp;
    return any((actual) => ordered(op, compare(actual, expected)));
  }
  if (op === "$in") {
    if (!Array.isArray(operand) || operand.length === 0 || operand.length > MAX_IN) return validation(context, `"$in" expects an array of 1 to ${MAX_IN} values.`);
    const set = new Set(operand.map((item) => fold(operandString(context, item))));
    return any((actual) => set.has(fold(String(actual))));
  }
  const needle = fold(operandString(context, operand));
  switch (op) {
    case "$eq":
      return any((actual) => fold(String(actual)) === needle);
    case "$contains":
      return any((actual) => fold(String(actual)).includes(needle));
    case "$starts_with":
      return any((actual) => fold(String(actual)).startsWith(needle));
    default:
      return any((actual) => fold(String(actual)).endsWith(needle));
  }
}

function ordered(op, order) {
  switch (op) {
    case "$eq":
      return order === 0;
    case "$gt":
      return order > 0;
    case "$gte":
      return order >= 0;
    case "$lt":
      return order < 0;
    default:
      return order <= 0;
  }
}

/** Validate `sorts` and return a comparator over row views. */
export function compileSorts(context, sorts, defs, systemFields) {
  if (sorts === undefined || sorts === null) return (a, b) => compare(a.created_at, b.created_at) || compare(a.id, b.id);
  if (!Array.isArray(sorts) || sorts.length > MAX_SORTS) return validation(context, `"sorts" expects an array of at most ${MAX_SORTS} sorts.`);
  const keys = sorts.map((sort) => {
    if (!isPlainObject(sort) || (sort.direction !== "asc" && sort.direction !== "desc") || typeof sort.attribute !== "string") {
      return validation(context, "Each sort needs a direction (asc or desc) and an attribute.");
    }
    const def = isReserved(sort.attribute) ? undefined : resolveDef(defs, sort.attribute);
    if (def === undefined || def.is_archived) return validation(context, `Unknown attribute "${clip(sort.attribute)}" in sorts.`);
    const field = sort.field === undefined ? (PRIMARY_FIELD[def.type] ?? "value") : sort.field;
    if (typeof field !== "string" || !(FIELDS[def.type] ?? ["value"]).includes(field)) {
      return validation(context, `Unknown sort field "${clip(String(sort.field))}" for attribute "${def.api_slug}".`);
    }
    return { def, field, sign: sort.direction === "asc" ? 1 : -1 };
  });
  return (a, b) => {
    for (const key of keys) {
      const left = sortValue(a, key, systemFields);
      const right = sortValue(b, key, systemFields);
      if (left === undefined && right === undefined) continue;
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      const order = compare(left, right);
      if (order !== 0) return order * key.sign;
    }
    return compare(a.created_at, b.created_at) || compare(a.id, b.id);
  };
}

function sortValue(row, key, systemFields) {
  const entries = entriesFor(row, key.def, systemFields);
  if (entries.length === 0) return undefined;
  const value = fieldValue(key.def, entries[0], key.field);
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value.toLowerCase() : value;
}

// ------------------------------------------------------------------------------------------------------------
// Search

export function foldSearch(text) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function words(text) {
  const out = [];
  let current = "";
  for (const character of foldSearch(text)) {
    if ((character >= "a" && character <= "z") || (character >= "0" && character <= "9")) current += character;
    else if (current.length > 0) {
      out.push(current);
      current = "";
    }
    if (out.length > 200) break;
  }
  if (current.length > 0) out.push(current);
  return out;
}
