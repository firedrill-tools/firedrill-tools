// Type-checks a parsed where AST against an entity's filterable fields, evaluates it over flat filter records and
// parses `order`. Field types: string, guid, number, boolean, date (epoch ms). String matching is case-insensitive
// and linear (String.prototype.includes / startsWith / endsWith on folded text).
import { validDate } from "./dates.mjs";
import { compareText, fold } from "./util.mjs";
import { parseWhere } from "./where-parse.mjs";

/** Compile `where` text into a predicate over filter records; fields is a Map name → type. */
export function compileWhere(text, fields, fail) {
  const ast = parseWhere(text, fail);
  const check = (node) => {
    if (node.kind === "or" || node.kind === "and") return { kind: node.kind, items: node.items.map(check) };
    if (node.kind === "not") return { kind: "not", item: check(node.item) };
    const type = fields.get(node.path);
    if (type === undefined) fail(`No property or field '${node.path}' exists (position ${node.at})`);
    if (node.kind === "method") {
      if (type !== "string") fail(`${node.method}() applies only to text fields, not '${node.path}'`);
      return { kind: "method", path: node.path, method: node.method, text: fold(node.text) };
    }
    return { kind: "cmp", path: node.path, op: node.op, value: literalFor(type, node, fail) };
  };
  const checked = check(ast);
  return (record) => evaluate(checked, record);
}

function literalFor(type, node, fail) {
  const { value, op, path } = node;
  if (value.type === "null") {
    if (op !== "==" && op !== "!=") fail(`null can only be compared with == or != (field '${path}')`);
    return null;
  }
  const ordered = op !== "==" && op !== "!=";
  switch (type) {
    case "string":
      if (value.type !== "string") fail(`Operator '${op}' incompatible with operand types 'String' and '${value.type}' (field '${path}')`);
      return fold(value.v);
    case "guid":
      if (value.type !== "string" && value.type !== "guid") fail(`field '${path}' must be compared with a guid`);
      if (ordered) fail(`Operator '${op}' is not defined for Guid field '${path}'`);
      return fold(value.v);
    case "number":
      if (value.type !== "number") fail(`field '${path}' must be compared with a number`);
      return value.v;
    case "boolean":
      if (value.type !== "boolean" || ordered) fail(`field '${path}' must be compared with true or false using == or !=`);
      return value.v;
    case "date": {
      if (value.type !== "datetime") fail(`field '${path}' must be compared with DateTime(year, month, day)`);
      const [y, mo, d, h = 0, mi = 0, s = 0] = value.v;
      if (!validDate(y, mo, d) || h > 23 || mi > 59 || s > 59) fail(`invalid DateTime value for field '${path}'`);
      return Date.UTC(y, mo - 1, d, h, mi, s);
    }
    default:
      return fail(`field '${path}' cannot be filtered`);
  }
}

function compare(actual, op, expected) {
  if (expected === null || actual === null || actual === undefined) {
    const isNull = actual === null || actual === undefined;
    if (op === "==") return expected === null ? isNull : false;
    if (op === "!=") return expected === null ? !isNull : true;
    return false;
  }
  const left = typeof actual === "string" ? fold(actual) : actual;
  const order = typeof left === "string" ? compareText(left, expected) : left === expected ? 0 : left < expected ? -1 : 1;
  switch (op) {
    case "==":
      return order === 0;
    case "!=":
      return order !== 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    default:
      return order <= 0;
  }
}

function evaluate(node, record) {
  // Iterative over and/or lists; depth is bounded by the parser (≤ 10 levels).
  switch (node.kind) {
    case "or":
      return node.items.some((item) => evaluate(item, record));
    case "and":
      return node.items.every((item) => evaluate(item, record));
    case "not":
      return !evaluate(node.item, record);
    case "method": {
      const actual = record.get(node.path);
      if (typeof actual !== "string") return false;
      const text = fold(actual);
      if (node.method === "Contains") return text.includes(node.text);
      if (node.method === "StartsWith") return text.startsWith(node.text);
      return text.endsWith(node.text);
    }
    default:
      return compare(record.get(node.path), node.op, node.value);
  }
}

/** Parse `order`: "Field [ASC|DESC], …" (≤ 3 keys). Returns [{ path, desc }]. */
export function parseOrder(text, fields, fail) {
  if (text.length > 500) fail("order exceeds 500 characters");
  if (text.includes("�")) fail("order contains an invalid character (malformed encoding)");
  const keys = [];
  for (const part of text.split(",")) {
    const words = part.split(" ").filter((w) => w.length > 0);
    if (words.length === 0 || words.length > 2) fail(`invalid order clause '${part.trim().slice(0, 100)}'`);
    if (!fields.has(words[0])) fail(`No property or field '${words[0].slice(0, 100)}' exists in order`);
    let desc = false;
    if (words.length === 2) {
      const direction = words[1].toUpperCase();
      if (direction !== "ASC" && direction !== "DESC") fail(`invalid order direction '${words[1].slice(0, 20)}'`);
      desc = direction === "DESC";
    }
    keys.push({ path: words[0], desc });
    if (keys.length > 3) fail("order supports at most 3 fields");
  }
  return keys;
}

/** Sort filter records (Maps) by order keys, then by the tie-breaker id field. */
export function sortRecords(records, keys, idField) {
  const cmp = (a, b) => {
    for (const { path, desc } of keys) {
      const x = a.get(path);
      const y = b.get(path);
      let order;
      if (x === y) order = 0;
      else if (x === null || x === undefined) order = -1;
      else if (y === null || y === undefined) order = 1;
      else if (typeof x === "string") order = compareText(fold(x), fold(y));
      else order = x < y ? -1 : 1;
      if (order !== 0) return desc ? -order : order;
    }
    return compareText(String(a.get(idField)), String(b.get(idField)));
  };
  return records.sort(cmp);
}
