// Linear filter evaluation (IssueFilter and friends, the documented subset), ISO durations
// relative to virtual now, ordering and opaque cursors. Pure: rows in, rows out; unknown
// fields and comparators raise through the injected `invalid` callback.
import { clipValue } from "./errors.mjs";

import { base64urlDecode, base64urlEncode, compareStrings, fnv1a, hasForgedPrototype, isPlainObject, ownEntry, parseTimestamp } from "./state.mjs";

const DURATION = /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** An ISO-8601 date-time, date, or duration (`-P1D`, `P2W`, `PT6H`) relative to `nowMs` → epoch ms, or NaN. */
export function parseInstant(value, nowMs) {
  if (typeof value !== "string" || value.length === 0) return Number.NaN;
  const duration = DURATION.exec(value);
  if (duration !== null) {
    const sign = duration[1] === "-" ? -1 : 1;
    const [, , years, months, weeks, days, hours, minutes, seconds] = duration;
    // ISO 8601 requires at least one component, and a `T` must be followed by one: `P`, `PT`, `-P` and `P1DT` are invalid.
    const timeGiven = hours !== undefined || minutes !== undefined || seconds !== undefined;
    if (!timeGiven && (years === undefined && months === undefined && weeks === undefined && days === undefined)) return Number.NaN;
    if (value.includes("T") && !timeGiven) return Number.NaN;
    const date = new Date(nowMs);
    if (years !== undefined) date.setUTCFullYear(date.getUTCFullYear() + sign * Number(years));
    if (months !== undefined) date.setUTCMonth(date.getUTCMonth() + sign * Number(months));
    const dayMs = (Number(weeks ?? 0) * 7 + Number(days ?? 0)) * 86_400_000;
    const timeMs = Number(hours ?? 0) * 3_600_000 + Number(minutes ?? 0) * 60_000 + Number(seconds ?? 0) * 1000;
    return date.getTime() + sign * (dayMs + timeMs);
  }
  return parseTimestamp(value);
}

const STRING_COMPARATORS = new Set(["eq", "neq", "in", "nin", "contains", "containsIgnoreCase", "startsWith", "null", "lt", "lte", "gt", "gte"]);
const NUMBER_COMPARATORS = new Set(["eq", "neq", "in", "nin", "lt", "lte", "gt", "gte", "null"]);
const DATE_COMPARATORS = new Set(["eq", "neq", "lt", "lte", "gt", "gte", "null", "in", "nin"]);
const BOOLEAN_COMPARATORS = new Set(["eq", "neq"]);

/** Per-evaluation cache on the (per-call) env object, never in module state. */
function envCache(env, name) {
  if (env[name] === undefined) env[name] = new Map();
  return env[name];
}

/**
 * The per-evaluation cache for one caller object used at one position kind (a filter type name, or a comparator path and
 * kind). One JSON object can reach several positions: a GraphQL variable used twice (`{ title: $c, createdAt: $c }`,
 * `{ team: $f, assignee: $f }`) is the same object each time, so a cache keyed by identity alone would reuse a result
 * validated for another type and skip that type's validation.
 */
function typedCache(env, name, object, position) {
  const cache = envCache(env, name);
  let byPosition = cache.get(object);
  if (byPosition === undefined) {
    byPosition = new Map();
    cache.set(object, byPosition);
  }
  return byPosition;
}

/**
 * A comparator object validated and normalised once per filter evaluation: unknown comparators, a non-list `in`/`nin`
 * and unparseable date values fail INVALID_INPUT before any row value is consulted, and dates are parsed against virtual
 * now once instead of once per row. Returns `{ kind, tests: [[comparator, right]] }`.
 */
function prepareComparators(comparators, kind, env, typeName, name) {
  const path = `${typeName}.${name}`;
  const cache = typedCache(env, "comparators", comparators);
  const position = `${kind}:${path}`;
  const hit = cache.get(position);
  if (hit !== undefined) return hit;
  if (!isPlainObject(comparators)) return env.invalid(`Filter field ${clipValue(path)} expects a comparator object`);
  if (hasForgedPrototype(comparators)) return env.invalid(`Unknown comparator "__proto__" on ${clipValue(path)}`);
  const allowed = kind === "string" ? STRING_COMPARATORS : kind === "number" ? NUMBER_COMPARATORS : kind === "boolean" ? BOOLEAN_COMPARATORS : DATE_COMPARATORS;
  const tests = [];
  for (const [comparator, expected] of Object.entries(comparators)) {
    if (!allowed.has(comparator)) return env.invalid(`Unknown comparator "${clipValue(comparator)}" on ${clipValue(path)}`);
    if (comparator === "null") {
      tests.push([comparator, expected === true]);
    } else if (comparator === "in" || comparator === "nin") {
      if (!Array.isArray(expected)) return env.invalid(`Comparator "${clipValue(comparator)}" on ${clipValue(path)} expects a list`);
      const candidates = kind === "date" ? expected.map((candidate) => parseInstant(candidate, env.nowMs)) : expected;
      if (kind === "date" && candidates.some((instant) => Number.isNaN(instant))) return env.invalid(`Invalid date-time value on ${clipValue(path)}`);
      // JSON values only, so SameValueZero (Set) and strict equality (the former `includes`) agree.
      const set = new Set(candidates);
      // V8 hashes strings longer than 16,383 characters by length only, so looking a long row value up compares it with
      // every long candidate: charge those candidates' characters on each lookup (see compareScalar).
      set.longCharacters = candidates.reduce((total, candidate) => total + (typeof candidate === "string" && candidate.length > 16_383 ? candidate.length : 0), 0);
      tests.push([comparator, set]);
    } else if (comparator === "containsIgnoreCase" || comparator === "contains") {
      // The needle is folded (containsIgnoreCase) and prepared for linear search once here; row values are folded once per
      // request (see `foldText`).
      tests.push([comparator, typeof expected === "string" ? prepareNeedle(env, comparator === "contains" ? expected : expected.toLowerCase()) : null]);
    } else if (kind === "date") {
      const instant = parseInstant(expected, env.nowMs);
      if (Number.isNaN(instant)) return env.invalid(`Invalid date-time value on ${clipValue(path)}`);
      tests.push([comparator, instant]);
    } else {
      tests.push([comparator, expected]);
    }
  }
  const prepared = { kind, tests };
  cache.set(position, prepared);
  return prepared;
}

/** A stored date value as epoch ms, parsed once per distinct string per evaluation. */
function rowInstant(value, env) {
  const cache = envCache(env, "instants");
  const hit = cache.get(value);
  if (hit !== undefined) return hit;
  const instant = parseTimestamp(value);
  cache.set(value, instant);
  return instant;
}

function compareScalar(actual, prepared, env, row, field) {
  const isNull = actual === null || actual === undefined;
  let left;
  for (const [comparator, right] of prepared.tests) {
    if (comparator === "null") {
      if (isNull !== right) return false;
      continue;
    }
    if (isNull) return false;
    if (left === undefined) left = prepared.kind === "date" ? rowInstant(actual, env) : actual;
    // String work is proportional to the compared characters, so it is charged to the request budget by length: substring
    // search (JavaScript KMP) per CHARACTERS_PER_STEP, native equality, ordering and set lookups per COMPARED_CHARACTERS_PER_STEP.
    if (comparator === "contains" || comparator === "containsIgnoreCase") chargeCharacters(env, String(left).length);
    else if (typeof left === "string") chargeCompared(env, left.length + (typeof right === "string" ? right.length : right instanceof Set && left.length > 16_383 ? right.longCharacters : 0));
    let holds;
    switch (comparator) {
      case "in":
        holds = right.has(left);
        break;
      case "nin":
        holds = !right.has(left);
        break;
      case "eq":
        holds = left === right;
        break;
      case "neq":
        holds = left !== right;
        break;
      case "lt":
        holds = left < right;
        break;
      case "lte":
        holds = left <= right;
        break;
      case "gt":
        holds = left > right;
        break;
      case "gte":
        holds = left >= right;
        break;
      case "contains":
        holds = right !== null && containsText(String(left), right);
        break;
      case "containsIgnoreCase":
        holds = right !== null && containsText(foldText(env, String(left), row, field), right);
        break;
      case "startsWith":
        holds = typeof right === "string" && String(left).startsWith(right);
        break;
      default:
        holds = false;
    }
    if (!holds) return false;
  }
  return true;
}

/**
 * Filter bounds, checked once before any row is evaluated. Depth counts the nested filters a clause opens: every
 * relation (`parent: {…}`), collection (`children: { some: {…} }`) and `and`/`or` entry adds one level below the top-level
 * filter (level 0). Nodes count every object key and array entry anywhere in the filter, comparator lists included.
 * JSON depth bounds every nested object and array, including comparator values that are never evaluated.
 */
export const MAX_FILTER_DEPTH = 16;
export const MAX_FILTER_NODES = 2000;
export const MAX_FILTER_JSON_DEPTH = 64;
/**
 * Work bound for every filter evaluated by one request: each clause checked on a row and each related row visited counts
 * one step. Depth and node bounds alone still allow 390 `children.some` clauses over 10,000 issues (millions of steps,
 * seconds of blocked server), and a GraphQL document can repeat such a filter under 100 aliases, so the counter lives on
 * `env.budget`, which the caller shares across all filters of the request. Past the budget the call fails INVALID_INPUT.
 * A 20-clause filter over the 10,000-issue scan bound costs about 200,000 steps.
 */
export const MAX_FILTER_STEPS = 2_000_000;
/**
 * Substring searches cost one extra step per this many searched characters (each row value searched, each needle prepared);
 * lower-casing and native equality are cheaper per character and charged separately (FOLDED_/COMPARED_CHARACTERS_PER_STEP). A clause over a 65,536-character description is
 * therefore about 4,000 steps, not one, and the whole budget allows at most about 32 million compared characters. Every
 * charged string operation is linear in its characters (see `containsText`), so the worst permitted request stays near
 * 200 ms of work before it answers or fails (see SPEC Bounds for the measured figures).
 */
export const CHARACTERS_PER_STEP = 16;

/** Needles up to this length use native search, whose worst case is value length × needle length (at most 6 per character). */
const NATIVE_NEEDLE_MAX = 6;

/**
 * A substring needle prepared for `containsText`: the KMP failure table is built once (charged by needle length). Native
 * `String.prototype.includes` is not linear for longer needles: a 32,001-character needle `a…aba…a` took 138 ms against
 * one 65,536-character value of `a`, and even 256-character needles took about 5 ms, so a character budget could not
 * bound it.
 */
export function prepareNeedle(env, needle) {
  chargeCharacters(env, needle.length);
  if (needle.length <= NATIVE_NEEDLE_MAX) return { needle, table: null };
  const table = new Int32Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length; index += 1) {
    const code = needle.charCodeAt(index);
    while (matched > 0 && code !== needle.charCodeAt(matched)) matched = table[matched - 1];
    if (code === needle.charCodeAt(matched)) matched += 1;
    table[index] = matched;
  }
  return { needle, table };
}

/** Whether `haystack` contains the prepared needle, in time linear in `haystack.length` + needle length (KMP). */
export function containsText(haystack, prepared) {
  const { needle, table } = prepared;
  if (table === null) return haystack.includes(needle);
  const length = needle.length;
  if (length > haystack.length) return false;
  const first = needle.charCodeAt(0);
  let matched = 0;
  for (let index = 0; index < haystack.length; index += 1) {
    const code = haystack.charCodeAt(index);
    if (matched === 0) {
      if (code === first) matched = 1;
      continue;
    }
    while (matched > 0 && code !== needle.charCodeAt(matched)) matched = table[matched - 1];
    if (code === needle.charCodeAt(matched)) {
      matched += 1;
      if (matched === length) return true;
    }
  }
  return false;
}

function charge(env, units) {
  if (env.budget === undefined) env.budget = { steps: 0 };
  env.budget.steps += units;
  if (env.budget.steps > MAX_FILTER_STEPS) {
    env.invalid(`Filter is too complex: evaluating the filters and searches of this request would take more than ${String(MAX_FILTER_STEPS)} steps. Use fewer "or"/"and" entries, relation filters or text comparisons on long fields, or narrow the list first.`);
  }
}

function step(env) {
  charge(env, 1);
}

/** Charges the request budget for searching or lower-casing `length` characters (nothing below CHARACTERS_PER_STEP). */
export function chargeCharacters(env, length) {
  const units = Math.floor(length / CHARACTERS_PER_STEP);
  if (units > 0) charge(env, units);
}

/**
 * Native string equality and ordering compare about 0.02 ns per character (measured on 65,536-character values), roughly
 * 100 times cheaper than the JavaScript substring search, so they cost one step per this many characters: the whole budget
 * then allows about 2 GB of compared characters, about 50 ms, and short values such as titles cost nothing extra.
 */
export const COMPARED_CHARACTERS_PER_STEP = 1024;

/** Native `toLowerCase` measured about 0.13 ns per character, so lower-casing a value costs one step per this many characters. */
export const FOLDED_CHARACTERS_PER_STEP = 256;

function chargeFolded(env, length) {
  const units = Math.floor(length / FOLDED_CHARACTERS_PER_STEP);
  if (units > 0) charge(env, units);
}

function chargeCompared(env, length) {
  const units = Math.floor(length / COMPARED_CHARACTERS_PER_STEP);
  if (units > 0) charge(env, units);
}

/**
 * `value.toLowerCase()` for field `field` of `row`, computed once per (row, field) per request: `env.folds` is a Map the
 * caller shares across every filter and search of the request, so a long description is folded once however many clauses
 * or aliases read it. The cache is keyed by row object identity, never by the string: V8 hashes strings longer than
 * 16,383 characters by length only, so a Map keyed by long descriptions degrades to comparing their contents.
 */
export function foldText(env, value, row, field) {
  if (typeof row !== "object" || row === null) {
    chargeFolded(env, value.length);
    return value.toLowerCase();
  }
  if (env.folds === undefined) env.folds = new Map();
  let byField = env.folds.get(row);
  if (byField === undefined) {
    byField = new Map();
    env.folds.set(row, byField);
  }
  const hit = byField.get(field);
  if (hit !== undefined && hit.value === value) return hit.folded;
  chargeFolded(env, value.length);
  const folded = value.toLowerCase();
  byField.set(field, { value, folded });
  return folded;
}

/**
 * Fails through `invalid(message)` when `filter` exceeds a bound. Iterative (explicit stack) and stops at the first
 * violation, so an arbitrarily deep or wide caller value costs at most MAX_FILTER_NODES steps. It does not validate
 * field names or comparators; `matches` does that.
 */
export function checkFilterBounds(typeName, filter, invalid) {
  if (typeof filter !== "object" || filter === null) return;
  let nodes = 0;
  // [value, jsonDepth, filterType | null (a plain value, not a filter), filterDepth]
  const stack = [[filter, 1, typeName, 0]];
  while (stack.length > 0) {
    const [value, jsonDepth, type, depth] = stack.pop();
    if (typeof value !== "object" || value === null) continue;
    if (jsonDepth > MAX_FILTER_JSON_DEPTH) return invalid(`Filter nests objects and lists deeper than the maximum depth of ${String(MAX_FILTER_JSON_DEPTH)}`);
    if (type !== null && depth > MAX_FILTER_DEPTH) return invalid(`Filter nesting depth exceeds the maximum of ${String(MAX_FILTER_DEPTH)} nested relation, collection and and/or filters`);
    if (Array.isArray(value) && nodes + value.length > MAX_FILTER_NODES) return invalid(`Filter has more than ${String(MAX_FILTER_NODES)} nodes`);
    const entries = Array.isArray(value) ? value.map((item) => [null, item]) : Object.entries(value);
    nodes += entries.length;
    if (nodes > MAX_FILTER_NODES) return invalid(`Filter has more than ${String(MAX_FILTER_NODES)} nodes`);
    const fields = type === null ? undefined : ownEntry(FILTER_TYPES, type);
    for (const [name, child] of entries) {
      if (typeof child !== "object" || child === null) continue;
      if (fields === undefined || name === null) {
        stack.push([child, jsonDepth + 1, null, depth]);
        continue;
      }
      if (name === "and" || name === "or") {
        if (!Array.isArray(child)) {
          stack.push([child, jsonDepth + 1, null, depth]);
          continue;
        }
        nodes += child.length;
        if (nodes > MAX_FILTER_NODES) return invalid(`Filter has more than ${String(MAX_FILTER_NODES)} nodes`);
        for (const entry of child) stack.push([entry, jsonDepth + 2, type, depth + 1]);
        continue;
      }
      const definition = ownEntry(fields, name);
      if (definition !== undefined && definition.relation !== undefined) {
        stack.push([child, jsonDepth + 1, definition.relation, depth + 1]);
      } else if (definition !== undefined && definition.collection !== undefined && !Array.isArray(child)) {
        // `{ some | every: filter }`, or a field written directly on the collection (one filter level either way).
        const modes = Object.entries(child);
        nodes += modes.length;
        if (nodes > MAX_FILTER_NODES) return invalid(`Filter has more than ${String(MAX_FILTER_NODES)} nodes`);
        for (const [mode, inner] of modes) {
          if (mode === "some" || mode === "every") stack.push([inner, jsonDepth + 2, definition.collection, depth + 1]);
          else stack.push([{ [mode]: inner }, jsonDepth + 1, definition.collection, depth + 1]);
        }
      } else {
        stack.push([child, jsonDepth + 1, null, depth]);
      }
    }
  }
  return undefined;
}

/**
 * Filter type definitions: field → { kind } for scalars, { relation, nullable } for single
 * relations (resolved through env.resolve[relation](row)), { collection } for collections
 * (rows through env.collect[collection](row)).
 */
export const FILTER_TYPES = {
  IssueFilter: {
    id: { kind: "string", get: (row) => row.id },
    number: { kind: "number", get: (row) => row.number },
    title: { kind: "string", get: (row) => row.title },
    description: { kind: "string", get: (row) => row.description ?? null },
    priority: { kind: "number", get: (row) => row.priority },
    estimate: { kind: "number", get: (row) => row.estimate ?? null },
    dueDate: { kind: "date", get: (row) => row.dueDate ?? null },
    createdAt: { kind: "date", get: (row) => row.createdAt },
    updatedAt: { kind: "date", get: (row) => row.updatedAt },
    completedAt: { kind: "date", get: (row) => row.completedAt ?? null },
    canceledAt: { kind: "date", get: (row) => row.canceledAt ?? null },
    startedAt: { kind: "date", get: (row) => row.startedAt ?? null },
    archivedAt: { kind: "date", get: (row) => row.archivedAt ?? null },
    team: { relation: "TeamFilter", resolve: "team" },
    state: { relation: "WorkflowStateFilter", resolve: "state" },
    assignee: { relation: "UserFilter", resolve: "assignee", nullable: true },
    creator: { relation: "UserFilter", resolve: "creator" },
    project: { relation: "ProjectFilter", resolve: "project", nullable: true },
    cycle: { relation: "CycleFilter", resolve: "cycle", nullable: true },
    parent: { relation: "IssueFilter", resolve: "parent", nullable: true },
    labels: { collection: "IssueLabelFilter", collect: "labels" },
    children: { collection: "IssueFilter", collect: "children" },
  },
  TeamFilter: {
    id: { kind: "string", get: (row) => row.id },
    key: { kind: "string", get: (row) => row.key },
    name: { kind: "string", get: (row) => row.name },
    createdAt: { kind: "date", get: (row) => row.createdAt },
    updatedAt: { kind: "date", get: (row) => row.updatedAt },
  },
  WorkflowStateFilter: {
    id: { kind: "string", get: (row) => row.id },
    name: { kind: "string", get: (row) => row.name },
    type: { kind: "string", get: (row) => row.type },
    team: { relation: "TeamFilter", resolve: "team" },
  },
  UserFilter: {
    id: { kind: "string", get: (row) => row.id },
    name: { kind: "string", get: (row) => row.name },
    displayName: { kind: "string", get: (row) => row.displayName },
    email: { kind: "string", get: (row) => row.email },
    active: { kind: "boolean", get: (row) => row.active },
    admin: { kind: "boolean", get: (row) => row.admin === true },
    isMe: { kind: "boolean", get: (row, env) => row.id === env.viewerId },
    createdAt: { kind: "date", get: (row) => row.createdAt },
    updatedAt: { kind: "date", get: (row) => row.updatedAt },
  },
  ProjectFilter: {
    id: { kind: "string", get: (row) => row.id },
    name: { kind: "string", get: (row) => row.name },
    slugId: { kind: "string", get: (row) => row.slugId },
    state: { kind: "string", get: (row) => row.state },
    priority: { kind: "number", get: (row) => row.priority },
    createdAt: { kind: "date", get: (row) => row.createdAt },
    updatedAt: { kind: "date", get: (row) => row.updatedAt },
    lead: { relation: "UserFilter", resolve: "lead", nullable: true },
    teams: { collection: "TeamFilter", collect: "teams" },
    accessibleTeams: { collection: "TeamFilter", collect: "teams" },
  },
  CycleFilter: {
    id: { kind: "string", get: (row) => row.id },
    number: { kind: "number", get: (row) => row.number },
    name: { kind: "string", get: (row) => row.name ?? null },
    isActive: { kind: "boolean", get: (row, env) => env.cycleFlags(row).isActive },
    isFuture: { kind: "boolean", get: (row, env) => env.cycleFlags(row).isFuture },
    isPast: { kind: "boolean", get: (row, env) => env.cycleFlags(row).isPast },
    team: { relation: "TeamFilter", resolve: "team" },
  },
  IssueLabelFilter: {
    id: { kind: "string", get: (row) => row.id },
    name: { kind: "string", get: (row) => row.name },
    team: { relation: "TeamFilter", resolve: "team", nullable: true },
  },
  CommentFilter: {
    id: { kind: "string", get: (row) => row.id },
    body: { kind: "string", get: (row) => row.body },
    createdAt: { kind: "date", get: (row) => row.createdAt },
    updatedAt: { kind: "date", get: (row) => row.updatedAt },
    issue: { relation: "IssueFilter", resolve: "issue" },
  },
};

/**
 * Evaluates one filter object of `typeName` against `row`. `env` provides `nowMs`, `viewerId`,
 * `invalid(message)`, `resolve.<relation>(row)` and `collect.<collection>(row)`.
 */
export function matches(typeName, filter, row, env) {
  return evaluate(typeName, filter, row, env);
}

/**
 * Evaluation on a related row (relation target or collection item), memoised per (filter object, row id). A
 * filter such as `children.some.parent.children.some…` revisits the same rows at every level; without the memo the cost
 * grows as (children per issue)^depth, with it each nested filter is evaluated at most once per row.
 */
function relatedMatch(typeName, filter, row, env) {
  step(env);
  if (row === null || row === undefined || typeof row.id !== "string" || typeof filter !== "object" || filter === null) return evaluate(typeName, filter, row, env);
  const memo = envCache(env, "memo");
  const byType = typedCache(env, "memo", filter);
  let byRow = byType.get(typeName);
  if (byRow === undefined) {
    byRow = new Map();
    byType.set(typeName, byRow);
  }
  // Keyed by (filter object, type, row id): a shared variable can place one object at positions of different types.
  const hit = byRow.get(row.id);
  if (hit !== undefined) return hit;
  const result = evaluate(typeName, filter, row, env) === true;
  byRow.set(row.id, result);
  return result;
}

/**
 * One filter object compiled once per evaluation into clauses: field names resolved as own entries of the type table
 * (so `constructor`, `toString` and a literal `__proto__` are unknown fields), comparator objects prepared, `and`/`or`
 * entries compiled eagerly and derived objects (`{ null }` remainders, collection shorthands) built once so the
 * related-row memo sees a stable identity. Every row reuses the result, so per-row work is only the comparisons.
 */
function compile(typeName, filter, env) {
  const cache = typedCache(env, "compiled", filter);
  const hit = cache.get(typeName);
  if (hit !== undefined) return hit;
  if (!isPlainObject(filter)) return env.invalid(`${clipValue(typeName)} must be an object`);
  if (hasForgedPrototype(filter)) return env.invalid(`Unknown filter field "__proto__" on ${clipValue(typeName)}`);
  const fields = FILTER_TYPES[typeName];
  const clauses = [];
  for (const [name, clause] of Object.entries(filter)) {
    if (name === "and" || name === "or") {
      if (!Array.isArray(clause)) return env.invalid(`Filter "${clipValue(name)}" on ${clipValue(typeName)} expects a list`);
      for (const entry of clause) if (entry !== undefined && entry !== null) compile(typeName, entry, env);
      clauses.push({ name, clause, definition: null });
      continue;
    }
    const definition = ownEntry(fields, name);
    if (definition === undefined) return env.invalid(`Unknown filter field "${clipValue(name)}" on ${clipValue(typeName)}`);
    if (definition.kind !== undefined) {
      clauses.push({ name, clause: prepareComparators(clause, definition.kind, env, typeName, name), definition });
      continue;
    }
    if (!isPlainObject(clause)) return env.invalid(`Filter field ${clipValue(typeName)}.${clipValue(name)} expects an object`);
    if (hasForgedPrototype(clause)) return env.invalid(`Unknown filter field "__proto__" on ${clipValue(definition.relation ?? definition.collection)}`);
    if (definition.relation !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(clause, "null")) {
        clauses.push({ name, clause, definition, nullWanted: undefined, rest: clause });
        continue;
      }
      const rest = { ...clause };
      delete rest.null;
      clauses.push({ name, clause, definition, nullWanted: clause.null === true, rest: Object.keys(rest).length === 0 ? null : rest });
      continue;
    }
    const modes = [];
    for (const [mode, inner] of Object.entries(clause)) {
      if (mode === "length") return env.invalid(`Comparator "length" on ${clipValue(typeName)}.${clipValue(name)} is not supported`);
      // A field written directly on a collection filter means "some item matches that field".
      modes.push(mode === "some" || mode === "every" ? [mode, inner] : ["some", { [mode]: inner }]);
    }
    clauses.push({ name, clause, definition, modes });
  }
  cache.set(typeName, clauses);
  return clauses;
}

function evaluate(typeName, filter, row, env) {
  if (filter === undefined || filter === null) return true;
  for (const entry of compile(typeName, filter, env)) {
    step(env);
    const definition = entry.definition;
    if (definition === null) {
      if (entry.name === "and") {
        for (const item of entry.clause) if (!evaluate(typeName, item, row, env)) return false;
      } else if (!entry.clause.some((item) => evaluate(typeName, item, row, env))) {
        return false;
      }
      continue;
    }
    if (definition.kind !== undefined) {
      if (!compareScalar(definition.get(row, env), entry.clause, env, row, `${typeName}.${entry.name}`)) return false;
      continue;
    }
    if (definition.relation !== undefined) {
      const target = env.resolve[definition.resolve](row);
      const isNull = target === null || target === undefined;
      if (entry.nullWanted !== undefined) {
        if (isNull !== entry.nullWanted) return false;
        if (entry.rest === null) continue;
      }
      if (isNull) return false;
      if (!relatedMatch(definition.relation, entry.rest, target, env)) return false;
      continue;
    }
    const items = env.collect[definition.collect](row);
    for (const [mode, inner] of entry.modes) {
      if (mode === "some" ? !items.some((item) => relatedMatch(definition.collection, inner, item, env)) : !items.every((item) => relatedMatch(definition.collection, inner, item, env))) return false;
    }
  }
  return true;
}

export const ORDER_FIELDS = Object.freeze(["createdAt", "updatedAt"]);

/**
 * Descending by the order field (Linear's default), ties broken by id ascending. Decorate-sort: each row's timestamp is
 * parsed once, not twice per comparison. Unparseable values sort as NaN did before (a NaN delta falls through to the id).
 */
export function orderRows(rows, orderBy) {
  const keyed = rows.map((row) => ({ row, at: parseTimestamp(row[orderBy]) }));
  keyed.sort((left, right) => {
    const delta = right.at - left.at;
    return delta !== 0 && !Number.isNaN(delta) ? delta : compareStrings(left.row.id, right.row.id);
  });
  return keyed.map((entry) => entry.row);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

export function filterHash(scope, filter) {
  return fnv1a(`${scope}\n${canonical(filter ?? null)}`);
}

export function encodeCursor(lastId, orderBy, hash) {
  return base64urlEncode(JSON.stringify({ v: 1, k: lastId, o: orderBy, f: hash }));
}

/**
 * Parses an opaque cursor; returns null when it is not a string, not canonical base64url of valid UTF-8 (see
 * `base64urlDecode`), not JSON, not exactly `{ v: 1, k: <non-empty string>, o: <string>, f: <string> }`, or issued for
 * another order/filter scope. Callers map null to Linear's `Invalid cursor` INVALID_INPUT error; this never throws.
 */
export function decodeCursor(cursor, orderBy, hash) {
  const text = base64urlDecode(cursor);
  if (text === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 4 || !["v", "k", "o", "f"].every((name) => Object.prototype.hasOwnProperty.call(parsed, name))) return null;
  if (parsed.v !== 1 || typeof parsed.k !== "string" || parsed.k.length === 0 || typeof parsed.o !== "string" || typeof parsed.f !== "string") return null;
  if (parsed.o !== orderBy || parsed.f !== hash) return null;
  return parsed.k;
}

/**
 * Cuts an ordered list at `first` rows after the cursor. Returns { rows, pageInfo } or null when
 * the cursor does not point into the list.
 */
export function page(ordered, { first, after, orderBy, hash, key = (row) => row.id }) {
  let start = 0;
  if (after !== undefined && after !== null) {
    const lastKey = decodeCursor(after, orderBy, hash);
    if (lastKey === null) return null;
    const index = ordered.findIndex((row) => key(row) === lastKey);
    if (index < 0) return null;
    start = index + 1;
  }
  const rows = ordered.slice(start, start + first);
  const cursorOf = (row) => encodeCursor(key(row), orderBy, hash);
  return {
    rows,
    cursors: rows.map(cursorOf),
    pageInfo: {
      hasNextPage: start + first < ordered.length,
      hasPreviousPage: false,
      startCursor: rows.length === 0 ? null : cursorOf(rows[0]),
      endCursor: rows.length === 0 ? null : cursorOf(rows[rows.length - 1]),
    },
  };
}
