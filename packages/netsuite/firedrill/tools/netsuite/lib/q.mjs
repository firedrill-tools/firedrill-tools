// The `q` record-filter grammar. Hand-written tokenizer and precedence parser: no regular expression is ever
// built from caller text, and every string match is a single linear scan.
import { quote } from "./errors.mjs";
import { parseDate } from "./primitives.mjs";

export const MAX_Q = 2000;
const MAX_COMPARISONS = 30;
const MAX_LIST = 20;
const MAX_DEPTH = 10;

const WORD_STOP = new Set([" ", "\t", "\n", "\r", "(", ")", "[", "]", ",", '"']);

class QError extends Error {}
const bad = (message) => {
  throw new QError(message);
};

export function tokenize(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      index += 1;
      continue;
    }
    if (character === "\uFFFD") bad(`unreadable character at position ${index}`);
    if (character === "(" || character === ")" || character === "[" || character === "]" || character === ",") {
      tokens.push({ kind: character, at: index });
      index += 1;
      continue;
    }
    if (character === '"') {
      let value = "";
      let cursor = index + 1;
      let closed = false;
      while (cursor < text.length) {
        const current = text[cursor];
        if (current === "\\") {
          const next = text[cursor + 1];
          if (next !== '"' && next !== "\\") bad(`unsupported escape at position ${cursor}`);
          value += next;
          cursor += 2;
          continue;
        }
        if (current === '"') {
          closed = true;
          cursor += 1;
          break;
        }
        if (current === "\uFFFD") bad(`unreadable character at position ${cursor}`);
        value += current;
        cursor += 1;
      }
      if (!closed) bad(`unterminated string starting at position ${index}`);
      tokens.push({ kind: "value", value, quoted: true, at: index });
      index = cursor;
      continue;
    }
    let cursor = index;
    let word = "";
    while (cursor < text.length && !WORD_STOP.has(text[cursor])) {
      if (text[cursor] === "\uFFFD") bad(`unreadable character at position ${cursor}`);
      word += text[cursor];
      cursor += 1;
    }
    if (word.length === 0) bad(`unexpected character at position ${index}`);
    tokens.push({ kind: "word", value: word, at: index });
    index = cursor;
  }
  return tokens;
}

const NONE_OPS = new Set(["EMPTY", "EMPTY_NOT"]);
const OPS = {
  boolean: new Set(["IS", "IS_NOT"]),
  numeric: new Set([
    "ANY_OF", "ANY_OF_NOT", "BETWEEN", "BETWEEN_NOT", "EQUAL", "EQUAL_NOT",
    "GREATER", "GREATER_NOT", "GREATER_OR_EQUAL", "GREATER_OR_EQUAL_NOT",
    "LESS", "LESS_NOT", "LESS_OR_EQUAL", "LESS_OR_EQUAL_NOT", "WITHIN", "WITHIN_NOT",
  ]),
  string: new Set([
    "CONTAIN", "CONTAIN_NOT", "IS", "IS_NOT", "START_WITH", "START_WITH_NOT", "ENDWITH", "ENDWITH_NOT",
  ]),
  date: new Set([
    "AFTER", "AFTER_NOT", "BEFORE", "BEFORE_NOT", "ON", "ON_NOT",
    "ON_OR_AFTER", "ON_OR_AFTER_NOT", "ON_OR_BEFORE", "ON_OR_BEFORE_NOT",
  ]),
};
const TWO_VALUE = new Set(["BETWEEN", "BETWEEN_NOT", "WITHIN", "WITHIN_NOT"]);
const LIST_OPS = new Set(["ANY_OF", "ANY_OF_NOT"]);

/** Parse one `q` expression against a field table; throws QError with a caller-safe message. */
export function parseQ(text, fields) {
  if (text.length > MAX_Q) bad(`the q parameter is limited to ${MAX_Q} characters`);
  const tokens = tokenize(text);
  let position = 0;
  let comparisons = 0;
  const peek = () => (position < tokens.length ? tokens[position] : null);
  const take = () => {
    const token = peek();
    if (token === null) bad("unexpected end of the q expression");
    position += 1;
    return token;
  };

  function value(token) {
    if (token.kind !== "word" && token.kind !== "value") bad(`expected a value near position ${token.at}`);
    return token.value;
  }

  function comparison() {
    comparisons += 1;
    if (comparisons > MAX_COMPARISONS) bad(`the q expression is limited to ${MAX_COMPARISONS} comparisons`);
    const fieldToken = take();
    if (fieldToken.kind !== "word") bad(`expected a field name near position ${fieldToken.at}`);
    const name = fieldToken.value;
    if (!Object.hasOwn(fields, name)) bad(`unknown field ${quote(name)} at position ${fieldToken.at}`);
    const type = fields[name].type;
    const operatorToken = take();
    if (operatorToken.kind !== "word") bad(`expected an operator near position ${operatorToken.at}`);
    const operator = operatorToken.value.toUpperCase();
    if (NONE_OPS.has(operator)) return { name, type, operator, values: [] };
    const allowed = OPS[type];
    if (allowed === undefined || !allowed.has(operator)) {
      bad(`operator ${quote(operator)} cannot be used with the ${type} field ${quote(name)}`);
    }
    const values = [];
    if (LIST_OPS.has(operator) && peek() !== null && peek().kind === "[") {
      take();
      for (;;) {
        const next = peek();
        if (next === null) bad("unterminated value list in the q expression");
        if (next.kind === "]") {
          take();
          break;
        }
        if (values.length > 0) {
          const comma = take();
          if (comma.kind !== ",") bad(`expected , in a value list at position ${comma.at}`);
        }
        values.push(value(take()));
        if (values.length > MAX_LIST) bad(`a value list is limited to ${MAX_LIST} values`);
      }
    } else {
      values.push(value(take()));
      if (TWO_VALUE.has(operator)) {
        const comma = peek();
        if (comma !== null && comma.kind === ",") take();
        values.push(value(take()));
      }
    }
    if (values.length === 0) bad(`operator ${quote(operator)} needs at least one value`);
    return { name, type, operator, values };
  }

  function expression(depth) {
    if (depth > MAX_DEPTH) bad(`the q expression nests deeper than ${MAX_DEPTH} levels`);
    let node = term(depth);
    for (;;) {
      const next = peek();
      if (next === null || next.kind !== "word" || next.value.toUpperCase() !== "OR") break;
      take();
      node = { kind: "or", left: node, right: term(depth) };
    }
    return node;
  }

  function term(depth) {
    let node = factor(depth);
    for (;;) {
      const next = peek();
      if (next === null || next.kind !== "word" || next.value.toUpperCase() !== "AND") break;
      take();
      node = { kind: "and", left: node, right: factor(depth) };
    }
    return node;
  }

  function factor(depth) {
    const next = peek();
    if (next === null) bad("unexpected end of the q expression");
    if (next.kind === "(") {
      take();
      const inner = expression(depth + 1);
      const close = take();
      if (close.kind !== ")") bad(`expected ) at position ${close.at}`);
      return inner;
    }
    return { kind: "comparison", ...comparison() };
  }

  const root = expression(1);
  if (position !== tokens.length) bad(`unexpected token at position ${tokens[position].at}`);
  return root;
}

export { QError };

const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");

function compareString(operator, actual, expected) {
  const left = lower(actual);
  const right = lower(expected);
  switch (operator) {
    case "IS": return left === right;
    case "CONTAIN": return left.indexOf(right) >= 0;
    case "START_WITH": return left.startsWith(right);
    case "ENDWITH": return left.endsWith(right);
    default: return false;
  }
}

function numberOf(text) {
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareNumber(operator, actual, values) {
  if (actual === null || actual === undefined) return false;
  const first = numberOf(values[0]);
  if (first === null) bad(`value ${quote(values[0])} is not a number`);
  switch (operator) {
    case "EQUAL": return actual === first;
    case "GREATER": return actual > first;
    case "GREATER_OR_EQUAL": return actual >= first;
    case "LESS": return actual < first;
    case "LESS_OR_EQUAL": return actual <= first;
    case "ANY_OF": return values.some((entry) => {
      const parsed = numberOf(entry);
      if (parsed === null) bad(`value ${quote(entry)} is not a number`);
      return actual === parsed;
    });
    case "BETWEEN":
    case "WITHIN": {
      const second = numberOf(values[1] ?? "");
      if (second === null) bad(`operator ${operator} needs two numeric values`);
      return actual >= first && actual <= second;
    }
    default: return false;
  }
}

function compareDate(operator, actual, values) {
  if (typeof actual !== "string" || actual.length === 0) return false;
  const first = parseDateValue(values[0]);
  switch (operator) {
    case "ON": return actual === first;
    case "AFTER": return actual > first;
    case "ON_OR_AFTER": return actual >= first;
    case "BEFORE": return actual < first;
    case "ON_OR_BEFORE": return actual <= first;
    default: return false;
  }
}

function parseDateValue(text) {
  const parsed = parseDate(text);
  if (parsed === null) bad(`value ${quote(text)} is not a date`);
  return parsed;
}

const isEmpty = (value) => value === null || value === undefined || value === "";

/** Evaluate a parsed q tree against one projected filter row. */
export function evaluate(node, row) {
  if (node.kind === "and") return evaluate(node.left, row) && evaluate(node.right, row);
  if (node.kind === "or") return evaluate(node.left, row) || evaluate(node.right, row);
  const actual = Object.hasOwn(row, node.name) ? row[node.name] : null;
  const negated = node.operator.endsWith("_NOT");
  const operator = negated ? node.operator.slice(0, -4) : node.operator;
  let result;
  if (operator === "EMPTY") result = isEmpty(actual);
  else if (node.type === "boolean") result = (lower(node.values[0]) === "true") === (actual === true);
  else if (node.type === "string") result = compareString(operator, actual, node.values[0]);
  else if (node.type === "numeric") result = compareNumber(operator, actual, node.values);
  else if (node.type === "date") result = compareDate(operator, actual, node.values);
  else result = false;
  return negated ? !result : result;
}
