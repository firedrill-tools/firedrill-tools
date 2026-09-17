// SuiteQL evaluation: resolve the parsed plan against the analytics tables and render every scalar as a string.
import { quote } from "./errors.mjs";
import { parseSql, SqlError, sqlBad } from "./suiteql-parse.mjs";
import { buildTables, COLUMNS, displayIndex, DF_SOURCE, TABLES } from "./suiteql-tables.mjs";

const canonicalTable = (name) => {
  const canonical = TABLES.get(name.toLowerCase());
  if (canonical === undefined) sqlBad(`unknown table ${quote(name)}`);
  return canonical;
};

class Scope {
  constructor() {
    this.sources = [];
  }

  add(canonical, alias) {
    const key = (alias ?? canonical).toLowerCase();
    if (this.sources.some((source) => source.key === key)) sqlBad(`duplicate table alias ${quote(alias ?? canonical)}`);
    this.sources.push({ key, canonical, columns: new Set(COLUMNS[canonical]) });
  }

  /** Resolve a column reference to the flat row key `<alias>.<column>`. */
  resolve(reference) {
    const column = reference.name.toLowerCase();
    if (reference.qualifier !== null) {
      const source = this.sources.find((entry) => entry.key === reference.qualifier.toLowerCase());
      if (source === undefined) sqlBad(`unknown table qualifier ${quote(reference.qualifier)}`);
      if (!source.columns.has(column)) sqlBad(`unknown column ${quote(`${reference.qualifier}.${reference.name}`)}`);
      return { key: `${source.key}.${column}`, column, canonical: source.canonical };
    }
    const matches = this.sources.filter((entry) => entry.columns.has(column));
    if (matches.length === 0) sqlBad(`unknown column ${quote(reference.name)}`);
    if (matches.length > 1) sqlBad(`column ${quote(reference.name)} is ambiguous; qualify it with its table`);
    return { key: `${matches[0].key}.${column}`, column, canonical: matches[0].canonical };
  }

  star(qualifier) {
    if (qualifier === null) {
      if (this.sources.length > 1) sqlBad("SELECT * needs a table qualifier when the statement joins tables");
      return this.sources.flatMap((source) => [...source.columns].map((column) => ({ key: `${source.key}.${column}`, name: column })));
    }
    const source = this.sources.find((entry) => entry.key === qualifier.toLowerCase());
    if (source === undefined) sqlBad(`unknown table qualifier ${quote(qualifier)}`);
    return [...source.columns].map((column) => ({ key: `${source.key}.${column}`, name: column }));
  }
}

const flatten = (source, key, row) => {
  const flat = {};
  for (const column of COLUMNS[source]) flat[`${key}.${column}`] = row[column] ?? null;
  return flat;
};

/** Both sides of a join must be plain column equalities so the right table can be indexed once. */
function joinKeys(node, scope, rightKey, keys = []) {
  if (node.kind === "and") {
    joinKeys(node.left, scope, rightKey, keys);
    joinKeys(node.right, scope, rightKey, keys);
    return keys;
  }
  if (node.kind !== "compare" || node.operator !== "=") {
    sqlBad("a JOIN condition must be one or more column equalities");
  }
  if (node.left.kind !== "column" || node.right.kind !== "column") {
    sqlBad("a JOIN condition must compare two columns");
  }
  const left = scope.resolve(node.left);
  const right = scope.resolve(node.right);
  const leftIsRightTable = left.key.startsWith(`${rightKey}.`);
  const rightIsRightTable = right.key.startsWith(`${rightKey}.`);
  if (leftIsRightTable === rightIsRightTable) sqlBad("a JOIN condition must relate the joined table to an earlier one");
  keys.push(leftIsRightTable ? { outer: right.key, inner: left.key } : { outer: left.key, inner: right.key });
  return keys;
}

const text = (value) => (value === null || value === undefined ? "" : String(value));

/** One aggregate over a group bucket's already-evaluated argument values. */
export function aggregate(name, values, distinct) {
  const present = values.filter((entry) => entry !== null && entry !== undefined);
  if (name === "COUNT") {
    return distinct === true ? new Set(present.map((entry) => String(entry))).size : present.length;
  }
  if (present.length === 0) return null;
  const numbers = present.map((entry) => {
    const parsed = typeof entry === "number" ? entry : Number(entry);
    if (!Number.isFinite(parsed)) sqlBad(`${name} needs numeric values`);
    return parsed;
  });
  const total = numbers.reduce((sum, entry) => sum + entry, 0);
  if (name === "SUM") return Math.round(total * 1e6) / 1e6;
  if (name === "AVG") return Math.round((total / numbers.length) * 1e6) / 1e6;
  if (name === "MIN") return Math.min(...numbers);
  return Math.max(...numbers);
}

function likeMatch(value, pattern) {
  const subject = text(value).toLowerCase();
  const source = text(pattern).toLowerCase();
  let index = 0;
  let anchored = true;
  let cursor = 0;
  while (index < source.length) {
    if (source[index] === "%") {
      anchored = false;
      index += 1;
      continue;
    }
    let segment = "";
    let singles = 0;
    while (index < source.length && source[index] !== "%") {
      if (source[index] === "_") singles += 1;
      else segment += source[index];
      index += 1;
    }
    if (singles > 0) {
      // `_` is matched positionally: consume one character per underscore around the literal segment.
      if (anchored) {
        if (cursor + singles + segment.length > subject.length) return false;
        if (!subject.startsWith(segment, cursor + singles)) return false;
        cursor += singles + segment.length;
      } else {
        const found = subject.indexOf(segment, cursor + singles);
        if (found < 0) return false;
        cursor = found + segment.length;
      }
    } else if (anchored) {
      if (!subject.startsWith(segment, cursor)) return false;
      cursor += segment.length;
    } else {
      const found = subject.indexOf(segment, cursor);
      if (found < 0) return false;
      cursor = found + segment.length;
    }
    anchored = true;
  }
  return anchored ? cursor === subject.length : true;
}

function compareValues(left, right) {
  if (left === null || right === null) return null;
  const leftNumber = typeof left === "number" ? left : Number(left);
  const rightNumber = typeof right === "number" ? right : Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && text(left).trim() !== "" && text(right).trim() !== "") {
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  const leftText = text(left);
  const rightText = text(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

export function runSql(session, statement, params) {
  const plan = parseSql(statement);
  const scope = new Scope();
  const tables = buildTables(session);
  const fromCanonical = canonicalTable(plan.from.name);
  scope.add(fromCanonical, plan.from.alias);
  const fromKey = scope.sources[0].key;
  let rows = tables.rows(fromCanonical).map((row) => flatten(fromCanonical, fromKey, row));

  for (const join of plan.joins) {
    const canonical = canonicalTable(join.table.name);
    scope.add(canonical, join.table.alias);
    const key = scope.sources[scope.sources.length - 1].key;
    const keys = joinKeys(join.on, scope, key, []);
    const index = new Map();
    const rightRows = tables.rows(canonical).map((row) => flatten(canonical, key, row));
    for (const row of rightRows) {
      const composite = keys.map((entry) => text(row[entry.inner])).join("\u0000");
      const bucket = index.get(composite);
      if (bucket === undefined) index.set(composite, [row]);
      else bucket.push(row);
    }
    const joined = [];
    const empty = Object.fromEntries(COLUMNS[canonical].map((column) => [`${key}.${column}`, null]));
    for (const row of rows) {
      const composite = keys.map((entry) => text(row[entry.outer])).join("\u0000");
      const matches = index.get(composite);
      if (matches === undefined) {
        if (join.kind === "left") joined.push({ ...row, ...empty });
        continue;
      }
      for (const match of matches) joined.push({ ...row, ...match });
    }
    rows = joined;
  }

  const display = displayIndex(session);
  if (plan.paramCount > params.length) {
    sqlBad(`the statement uses ${plan.paramCount} ? parameters but ${params.length} were supplied`);
  }

  function value(node, row) {
    if (node.kind === "literal") return node.value;
    if (node.kind === "param") return params[node.index] ?? null;
    if (node.kind === "column") return row[scope.resolve(node).key] ?? null;
    if (node.kind === "df") {
      const resolved = scope.resolve(node.column);
      const source = DF_SOURCE[resolved.column];
      if (source === undefined) sqlBad(`BUILTIN.DF is not supported for column ${quote(node.column.name)}`);
      const raw = row[resolved.key] ?? null;
      if (source === "status") return raw;
      if (raw === null) return null;
      return display.get(source)?.get(String(raw)) ?? null;
    }
    if (node.kind === "call") {
      const args = node.args.map((argument) => value(argument, row));
      if (node.name === "UPPER") return args[0] === null ? null : text(args[0]).toUpperCase();
      if (node.name === "LOWER") return args[0] === null ? null : text(args[0]).toLowerCase();
      return args[0] === null ? (args[1] ?? null) : args[0];
    }
    if (node.kind === "aggregate") {
      const bucket = Object.hasOwn(row, "__bucket__") ? row.__bucket__ : null;
      if (!Array.isArray(bucket)) sqlBad("an aggregate is only supported in the select list, HAVING and ORDER BY");
      if (node.args[0].kind === "star") return bucket.length;
      return aggregate(node.name, bucket.map((entry) => value(node.args[0], entry)), node.distinct);
    }
    if (node.kind === "star") sqlBad("* cannot be used here");
    sqlBad("unsupported expression");
    return null;
  }

  function test(node, row) {
    if (node.kind === "and") return test(node.left, row) && test(node.right, row);
    if (node.kind === "or") return test(node.left, row) || test(node.right, row);
    if (node.kind === "not") return !test(node.operand, row);
    if (node.kind === "isNull") {
      const actual = value(node.operand, row);
      return node.negated ? actual !== null : actual === null;
    }
    if (node.kind === "like") {
      const result = likeMatch(value(node.left, row), value(node.right, row));
      return node.negated ? !result : result;
    }
    if (node.kind === "between") {
      const actual = value(node.left, row);
      const low = compareValues(actual, value(node.low, row));
      const high = compareValues(actual, value(node.high, row));
      const result = low !== null && high !== null && low >= 0 && high <= 0;
      return node.negated ? !result : result;
    }
    if (node.kind === "in") {
      const actual = value(node.left, row);
      const result = node.values.some((entry) => compareValues(actual, value(entry, row)) === 0);
      return node.negated ? !result : result;
    }
    const order = compareValues(value(node.left, row), value(node.right, row));
    if (order === null) return false;
    switch (node.operator) {
      case "=": return order === 0;
      case "<>": return order !== 0;
      case "<": return order < 0;
      case "<=": return order <= 0;
      case ">": return order > 0;
      default: return order >= 0;
    }
  }

  if (plan.where !== null) {
    const filtered = [];
    for (const row of rows) {
      if (test(plan.where, row)) filtered.push(row);
    }
    rows = filtered;
  }
  return { plan, scope, rows, value, test, display };
}

export { SqlError };
