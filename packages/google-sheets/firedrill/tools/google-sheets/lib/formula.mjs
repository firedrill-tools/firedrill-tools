// A bounded Sheets formula engine: tokenizer, recursive-descent parser, evaluator over an environment supplied by the
// handler, and reference adjustment for row/column insertion and deletion and sheet renames. Pure functions.
//
// Grammar: numbers, strings ("a""b"), TRUE/FALSE, error literals, cell references with optional `$` and a sheet
// qualifier ('Q3 Budget'!$B$2), ranges (A1:B2, A:C, 1:3), named ranges, unary + and -, postfix %, ^, * /, + -, &,
// comparisons = <> < <= > >=, parentheses and function calls. The function list is FUNCTIONS below; anything else
// evaluates to #NAME?. No caller-supplied regular expression is ever compiled.

import { columnToIndex, indexToColumn, quoteSheetName } from "./a1.mjs";
import { generalNumber } from "./format.mjs";
import { parseUserEntered } from "./input.mjs";

export class FormulaParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "FormulaParseError";
  }
}

/** Thrown when evaluation crosses a documented bound; the handler answers FAILED_PRECONDITION. */
export class EvaluationBoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvaluationBoundError";
  }
}

export const MAX_FORMULA_LENGTH = 2000;

/** Sheets' own cap on a text result; checked arithmetically before concatenating, so chained cells cannot double text. */
export const MAX_TEXT_RESULT = 50_000;

function textTooLong(fn) {
  return makeError("#VALUE!", `Text result of ${fn} is longer than the limit of ${MAX_TEXT_RESULT} characters.`);
}

export const ERROR_TYPES = {
  "#NULL!": "NULL_VALUE",
  "#DIV/0!": "DIVIDE_BY_ZERO",
  "#VALUE!": "VALUE",
  "#REF!": "REF",
  "#NAME?": "NAME",
  "#NUM!": "NUM",
  "#N/A": "N_A",
  "#ERROR!": "ERROR",
};

export function isError(value) {
  return value !== null && typeof value === "object" && typeof value.error === "string";
}

export function makeError(code, message) {
  return { error: code, message };
}

// ---------------------------------------------------------------------------------------------
// Tokenizer (keeps source spans so reference adjustment can rewrite text in place)
// ---------------------------------------------------------------------------------------------

const ERROR_LITERAL = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|ERROR!)/i;
const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})(?![A-Za-z0-9_(!.])/;
const COLUMN = /^(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(!.$])/;
const ROW = /^(\$?)([0-9]{1,7})(?![0-9.eE])/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_.]*/;
const NUMBER_LITERAL = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;

function tokenize(source) {
  const tokens = [];
  let index = 0;
  const push = (token, length) => {
    tokens.push({ ...token, start: index, end: index + length });
    index += length;
  };
  const followedByColon = (length) => /^\s*:/.test(source.slice(index + length));
  const afterColon = () => tokens.length > 0 && tokens[tokens.length - 1].type === "colon";
  while (index < source.length) {
    const rest = source.slice(index);
    const character = rest[0];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '"') {
      let value = "";
      let position = 1;
      for (;;) {
        if (position >= rest.length) throw new FormulaParseError("Unterminated string literal.");
        if (rest[position] === '"') {
          if (rest[position + 1] === '"') {
            value += '"';
            position += 2;
            continue;
          }
          position += 1;
          break;
        }
        value += rest[position];
        position += 1;
      }
      push({ type: "str", value }, position);
      continue;
    }
    if (character === "'") {
      let name = "";
      let position = 1;
      for (;;) {
        if (position >= rest.length) throw new FormulaParseError("Unterminated sheet name.");
        if (rest[position] === "'") {
          if (rest[position + 1] === "'") {
            name += "'";
            position += 2;
            continue;
          }
          position += 1;
          break;
        }
        name += rest[position];
        position += 1;
      }
      if (rest[position] !== "!" || name.length === 0) throw new FormulaParseError("A quoted sheet name must be followed by !.");
      push({ type: "sheet", name }, position + 1);
      continue;
    }
    const errorMatch = ERROR_LITERAL.exec(rest);
    if (errorMatch !== null) {
      push({ type: "err", code: errorMatch[0].toUpperCase() }, errorMatch[0].length);
      continue;
    }
    const identSheet = /^([A-Za-z_][A-Za-z0-9_]*)!/.exec(rest);
    if (identSheet !== null) {
      push({ type: "sheet", name: identSheet[1] }, identSheet[0].length);
      continue;
    }
    const cell = CELL.exec(rest);
    if (cell !== null) {
      push(
        { type: "ref", absCol: cell[1] === "$", col: columnToIndex(cell[2]), absRow: cell[3] === "$", row: Number(cell[4]) - 1 },
        cell[0].length,
      );
      continue;
    }
    const column = COLUMN.exec(rest);
    if (column !== null && (followedByColon(column[0].length) || afterColon()) && !/^(TRUE|FALSE)$/i.test(column[2])) {
      push({ type: "ref", absCol: column[1] === "$", col: columnToIndex(column[2]), absRow: false, row: undefined }, column[0].length);
      continue;
    }
    const row = ROW.exec(rest);
    if (row !== null && (followedByColon(row[0].length) || (afterColon() && tokens.at(-2)?.col === undefined && tokens.at(-2)?.type === "ref"))) {
      push({ type: "ref", absCol: false, col: undefined, absRow: row[1] === "$", row: Number(row[2]) - 1 }, row[0].length);
      continue;
    }
    const number = NUMBER_LITERAL.exec(rest);
    if (number !== null) {
      push({ type: "num", value: Number(number[0]) }, number[0].length);
      continue;
    }
    const ident = IDENT.exec(rest);
    if (ident !== null) {
      push({ type: "ident", name: ident[0] }, ident[0].length);
      continue;
    }
    const two = rest.slice(0, 2);
    if (two === "<>" || two === "<=" || two === ">=") {
      push({ type: "op", value: two }, 2);
      continue;
    }
    if ("+-*/^&=<>%".includes(character)) {
      push({ type: "op", value: character }, 1);
      continue;
    }
    if (character === "(") {
      push({ type: "lparen" }, 1);
      continue;
    }
    if (character === ")") {
      push({ type: "rparen" }, 1);
      continue;
    }
    if (character === ",") {
      push({ type: "comma" }, 1);
      continue;
    }
    if (character === ":") {
      push({ type: "colon" }, 1);
      continue;
    }
    throw new FormulaParseError(`Unexpected character ${JSON.stringify(character)}.`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

/** Parses `=...` into an AST; throws FormulaParseError. */
export function parseFormula(text) {
  if (typeof text !== "string" || !text.startsWith("=") || text.length < 2) throw new FormulaParseError("Formula must start with =.");
  if (text.length > MAX_FORMULA_LENGTH) throw new FormulaParseError(`Formula exceeds ${MAX_FORMULA_LENGTH} characters.`);
  const tokens = tokenize(text.slice(1));
  let position = 0;
  let depth = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const isOp = (...values) => peek()?.type === "op" && values.includes(peek().value);

  const reference = (sheetName) => {
    const first = take();
    if (first === undefined || first.type !== "ref") throw new FormulaParseError("Expected a reference after the sheet name.");
    if (peek()?.type === "colon") {
      take();
      const second = take();
      if (second === undefined || second.type !== "ref") throw new FormulaParseError("Expected a reference after :.");
      const kind = (t) => (t.col === undefined ? "row" : t.row === undefined ? "col" : "cell");
      if (kind(first) !== kind(second)) throw new FormulaParseError("Mixed range references are not supported.");
      return {
        t: "range",
        sheet: sheetName,
        r1: first.row === undefined ? undefined : Math.min(first.row, second.row),
        r2: first.row === undefined ? undefined : Math.max(first.row, second.row),
        c1: first.col === undefined ? undefined : Math.min(first.col, second.col),
        c2: first.col === undefined ? undefined : Math.max(first.col, second.col),
      };
    }
    if (first.row === undefined || first.col === undefined) throw new FormulaParseError("A whole row or column needs a range.");
    return { t: "ref", sheet: sheetName, row: first.row, col: first.col };
  };

  const primary = () => {
    const token = peek();
    if (token === undefined) throw new FormulaParseError("Unexpected end of formula.");
    if (token.type === "num") {
      take();
      return { t: "num", v: token.value };
    }
    if (token.type === "str") {
      take();
      return { t: "str", v: token.value };
    }
    if (token.type === "err") {
      take();
      return { t: "err", code: token.code };
    }
    if (token.type === "sheet") {
      take();
      return reference(token.name);
    }
    if (token.type === "ref") return reference(undefined);
    if (token.type === "lparen") {
      take();
      const inner = expression();
      if (take()?.type !== "rparen") throw new FormulaParseError("Missing closing parenthesis.");
      return inner;
    }
    if (token.type === "ident") {
      take();
      if (peek()?.type === "lparen") {
        take();
        const args = [];
        if (peek()?.type === "rparen") {
          take();
          return { t: "call", name: token.name.toUpperCase(), args };
        }
        for (;;) {
          if (peek()?.type === "comma" || peek()?.type === "rparen") args.push({ t: "blank" });
          else args.push(expression());
          const separator = take();
          if (separator?.type === "rparen") break;
          if (separator?.type !== "comma") throw new FormulaParseError("Expected , or ) in the argument list.");
          if (args.length > 255) throw new FormulaParseError("Too many arguments.");
        }
        return { t: "call", name: token.name.toUpperCase(), args };
      }
      if (/^true$/i.test(token.name)) return { t: "bool", v: true };
      if (/^false$/i.test(token.name)) return { t: "bool", v: false };
      return { t: "name", name: token.name };
    }
    throw new FormulaParseError("Unexpected token.");
  };
  const postfix = () => {
    let node = primary();
    while (isOp("%")) {
      take();
      node = { t: "pct", e: node };
    }
    return node;
  };
  const unary = () => {
    if (isOp("-", "+")) {
      const op = take().value;
      depth += 1;
      if (depth > 64) throw new FormulaParseError("Formula nesting is too deep.");
      const operand = unary();
      depth -= 1;
      return op === "-" ? { t: "neg", e: operand } : { t: "pos", e: operand };
    }
    return postfix();
  };
  const binaryLevel = (next, ops) => () => {
    let left = next();
    while (isOp(...ops)) {
      const op = take().value;
      left = { t: "bin", op, l: left, r: next() };
    }
    return left;
  };
  const power = binaryLevel(unary, ["^"]);
  const multiplicative = binaryLevel(power, ["*", "/"]);
  const additive = binaryLevel(multiplicative, ["+", "-"]);
  const concat = binaryLevel(additive, ["&"]);
  const comparison = binaryLevel(concat, ["=", "<>", "<", "<=", ">", ">="]);
  function expression() {
    depth += 1;
    if (depth > 64) throw new FormulaParseError("Formula nesting is too deep.");
    const node = comparison();
    depth -= 1;
    return node;
  }
  const tree = expression();
  if (position !== tokens.length) throw new FormulaParseError("Unexpected trailing input.");
  return tree;
}

// ---------------------------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------------------------
//
// env: {
//   ownSheet: { sheetId, title, rowCount, columnCount },
//   resolveSheet(name) -> sheet | null,
//   resolveName(name) -> { sheetId, startRow, endRow, startColumn, endColumn } | null,
//   cell(sheetId, row, column) -> number | string | boolean | null | {error, message},
//   storedCells(sheetId, startRow, endRow, startColumn, endColumn) -> [{ row, column, value }] (non-empty, row order),
//   nowSerial: number,
// }

function rangeOf(node, env) {
  const sheet = node.sheet === undefined ? env.ownSheet : env.resolveSheet(node.sheet);
  if (sheet === null) return makeError("#REF!", `Unresolved sheet name '${node.sheet}'.`);
  const startRow = node.r1 ?? 0;
  const endRow = node.r2 === undefined ? sheet.rowCount : node.r2 + 1;
  const startColumn = node.c1 ?? 0;
  const endColumn = node.c2 === undefined ? sheet.columnCount : node.c2 + 1;
  if (endRow > sheet.rowCount || endColumn > sheet.columnCount) {
    return makeError("#REF!", "Range extends beyond the sheet's grid.");
  }
  return { range: true, sheetId: sheet.sheetId, startRow, endRow, startColumn, endColumn };
}

function isRange(value) {
  return value !== null && typeof value === "object" && value.range === true;
}

function evaluateNode(node, env) {
  switch (node.t) {
    case "num":
      return node.v;
    case "str":
      return node.v;
    case "bool":
      return node.v;
    case "blank":
      return null;
    case "err":
      return makeError(node.code, node.code === "#REF!" ? "Reference does not exist." : `Error literal ${node.code}.`);
    case "ref": {
      const sheet = node.sheet === undefined ? env.ownSheet : env.resolveSheet(node.sheet);
      if (sheet === null) return makeError("#REF!", `Unresolved sheet name '${node.sheet}'.`);
      if (node.row >= sheet.rowCount || node.col >= sheet.columnCount) return makeError("#REF!", "Reference is outside the sheet's grid.");
      return { range: true, sheetId: sheet.sheetId, startRow: node.row, endRow: node.row + 1, startColumn: node.col, endColumn: node.col + 1 };
    }
    case "range":
      return rangeOf(node, env);
    case "name": {
      const named = env.resolveName(node.name);
      if (named === null) return makeError("#NAME?", `Unknown range name: '${node.name.toUpperCase()}'.`);
      return { range: true, ...named };
    }
    case "neg": {
      const value = toNumber(scalar(evaluateNode(node.e, env), env), "UMINUS", 1);
      return isError(value) ? value : -value;
    }
    case "pos":
      return scalar(evaluateNode(node.e, env), env);
    case "pct": {
      const value = toNumber(scalar(evaluateNode(node.e, env), env), "UNARY_PERCENT", 1);
      return isError(value) ? value : value / 100;
    }
    case "bin":
      return binary(node.op, scalar(evaluateNode(node.l, env), env), scalar(evaluateNode(node.r, env), env));
    case "call":
      return callFunction(node, env);
    default:
      return makeError("#ERROR!", "Formula parse error.");
  }
}

/** Evaluates a parsed formula to a scalar effective value. */
export function evaluateFormula(tree, env) {
  const value = scalar(evaluateNode(tree, env), env);
  if (typeof value === "number" && !Number.isFinite(value)) return makeError("#NUM!", "The result is not a finite number.");
  return value;
}

function scalar(value, env) {
  if (!isRange(value)) return value;
  if (value.endRow - value.startRow === 1 && value.endColumn - value.startColumn === 1) {
    return env.cell(value.sheetId, value.startRow, value.startColumn);
  }
  return makeError("#VALUE!", "An array value could not be found.");
}

function toNumber(value, fn, position) {
  if (isError(value)) return value;
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value.trim().length === 0) return 0;
  const parsed = parseUserEntered(value.trim());
  if (parsed.value !== null && parsed.value.kind === "number") return parsed.value.number;
  return makeError(
    "#VALUE!",
    `Function ${fn} parameter ${position} expects number values. But '${value}' is a text and cannot be coerced to a number.`,
  );
}

function toText(value) {
  if (value === null) return "";
  if (typeof value === "number") return generalNumber(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return value;
}

function toBoolean(value, fn) {
  if (isError(value)) return value;
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  return makeError("#VALUE!", `Function ${fn} parameter 1 expects boolean values. But '${value}' is a text and cannot be coerced to a boolean.`);
}

/** Sheets ordering for comparisons: numbers < text < booleans; text compares case-insensitively. */
function compareScalars(left, right) {
  const rank = (v) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
  let a = left;
  let b = right;
  if (a === null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b === null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "string") {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (typeof a === "boolean") return Number(a) - Number(b);
  return a === b ? 0 : a < b ? -1 : 1;
}

function binary(op, left, right) {
  if (isError(left)) return left;
  if (isError(right)) return right;
  const names = { "+": "ADD", "-": "MINUS", "*": "MULTIPLY", "/": "DIVIDE", "^": "POW" };
  if (op in names) {
    const a = toNumber(left, names[op], 1);
    if (isError(a)) return a;
    const b = toNumber(right, names[op], 2);
    if (isError(b)) return b;
    switch (op) {
      case "+":
        return a + b;
      case "-":
        return a - b;
      case "*":
        return a * b;
      case "/":
        return b === 0 ? makeError("#DIV/0!", "Function DIVIDE parameter 2 cannot be zero.") : a / b;
      default: {
        const result = a ** b;
        return Number.isFinite(result) ? result : makeError("#NUM!", "Function POW caused a number error.");
      }
    }
  }
  if (op === "&") {
    const leftText = toText(left);
    const rightText = toText(right);
    return leftText.length + rightText.length > MAX_TEXT_RESULT ? textTooLong("CONCAT") : leftText + rightText;
  }
  const comparison = compareScalars(left, right);
  switch (op) {
    case "=":
      return comparison === 0;
    case "<>":
      return comparison !== 0;
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case ">":
      return comparison > 0;
    default:
      return comparison >= 0;
  }
}

function argumentCountError(name, expected, got) {
  return makeError("#N/A", `Wrong number of arguments to ${name}. Expected ${expected} arguments, but got ${got} arguments.`);
}

/** Every stored value of a range argument, or a single scalar; `onValue(value, fromRange)` may return an error to stop. */
function forEachValue(args, env, onValue) {
  for (const arg of args) {
    const value = evaluateNode(arg, env);
    if (isError(value)) return value;
    if (isRange(value)) {
      for (const entry of env.storedCells(value.sheetId, value.startRow, value.endRow, value.startColumn, value.endColumn)) {
        const stop = onValue(entry.value, true);
        if (stop !== undefined) return stop;
      }
    } else {
      const stop = onValue(value, false);
      if (stop !== undefined) return stop;
    }
  }
  return undefined;
}

function numericAggregate(name, args, env) {
  if (args.length === 0) return argumentCountError(name, "at least 1", 0);
  const numbers = [];
  const stop = forEachValue(args, env, (value, fromRange) => {
    if (isError(value)) return value;
    if (fromRange) {
      if (typeof value === "number") numbers.push(value);
      return undefined;
    }
    const number = toNumber(value, name, 1);
    if (isError(number)) return number;
    numbers.push(number);
    return undefined;
  });
  if (stop !== undefined) return stop;
  return numbers;
}

function parseCriterion(criterion) {
  if (typeof criterion === "number" || typeof criterion === "boolean") return { op: "=", operand: criterion };
  const text = criterion === null ? "" : String(criterion);
  const match = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(text);
  const op = match[1] ?? "=";
  const raw = match[2];
  const parsed = raw.trim().length === 0 ? null : parseUserEntered(raw.trim()).value;
  let operand = raw;
  if (parsed !== null && parsed.kind === "number") operand = parsed.number;
  else if (parsed !== null && parsed.kind === "bool") operand = parsed.bool;
  return { op, operand, blank: raw.length === 0 };
}

function matchesCriterion(value, criterion) {
  const { op, operand } = criterion;
  if (value === null) {
    if (op === "=") return criterion.blank === true;
    if (op === "<>") return criterion.blank !== true;
    return false;
  }
  if (isError(value)) return false;
  if (typeof operand === "number") {
    if (typeof value !== "number") return op === "<>";
    return binary(op, value, operand) === true;
  }
  if (typeof operand === "boolean") {
    if (typeof value !== "boolean") return op === "<>";
    return binary(op, value, operand) === true;
  }
  if (typeof value !== "string") return op === "<>";
  return binary(op, value, operand) === true;
}

function rangeArgument(node, env, name) {
  const value = evaluateNode(node, env);
  if (isError(value)) return value;
  if (!isRange(value)) return makeError("#VALUE!", `Function ${name} expects a range.`);
  return value;
}

function roundTo(value, digits, mode) {
  const factor = 10 ** Math.trunc(digits);
  const scaled = value * factor;
  const nudged = Math.abs(scaled) * (1 + 1e-15);
  let magnitude;
  if (mode === "up") magnitude = Math.ceil(nudged - 1e-9);
  else if (mode === "down") magnitude = Math.floor(nudged + 1e-9);
  else magnitude = Math.round(nudged);
  return (Math.sign(scaled) * magnitude) / factor;
}

const FUNCTIONS = {
  SUM(args, env) {
    const numbers = numericAggregate("SUM", args, env);
    return Array.isArray(numbers) ? numbers.reduce((total, n) => total + n, 0) : numbers;
  },
  AVERAGE(args, env) {
    const numbers = numericAggregate("AVERAGE", args, env);
    if (!Array.isArray(numbers)) return numbers;
    if (numbers.length === 0) return makeError("#DIV/0!", "Evaluation of function AVERAGE caused a divide by zero error.");
    return numbers.reduce((total, n) => total + n, 0) / numbers.length;
  },
  MIN(args, env) {
    const numbers = numericAggregate("MIN", args, env);
    return Array.isArray(numbers) ? (numbers.length === 0 ? 0 : Math.min(...numbers)) : numbers;
  },
  MAX(args, env) {
    const numbers = numericAggregate("MAX", args, env);
    return Array.isArray(numbers) ? (numbers.length === 0 ? 0 : Math.max(...numbers)) : numbers;
  },
  COUNT(args, env) {
    if (args.length === 0) return argumentCountError("COUNT", "at least 1", 0);
    let count = 0;
    forEachValue(args, env, (value, fromRange) => {
      if (typeof value === "number") count += 1;
      else if (!fromRange && !isError(value) && value !== null && typeof toNumber(value, "COUNT", 1) === "number") count += 1;
      return undefined;
    });
    return count;
  },
  COUNTA(args, env) {
    if (args.length === 0) return argumentCountError("COUNTA", "at least 1", 0);
    let count = 0;
    forEachValue(args, env, (value) => {
      if (value !== null) count += 1;
      return undefined;
    });
    return count;
  },
  COUNTIF(args, env) {
    if (args.length !== 2) return argumentCountError("COUNTIF", 2, args.length);
    const range = rangeArgument(args[0], env, "COUNTIF");
    if (isError(range)) return range;
    const criterionValue = scalar(evaluateNode(args[1], env), env);
    if (isError(criterionValue)) return criterionValue;
    const criterion = parseCriterion(criterionValue);
    const stored = env.storedCells(range.sheetId, range.startRow, range.endRow, range.startColumn, range.endColumn);
    let count = stored.filter((entry) => matchesCriterion(entry.value, criterion)).length;
    if (matchesCriterion(null, criterion)) {
      const area = (range.endRow - range.startRow) * (range.endColumn - range.startColumn);
      count += area - stored.length;
    }
    return count;
  },
  SUMIF(args, env) {
    if (args.length !== 2 && args.length !== 3) return argumentCountError("SUMIF", "2 or 3", args.length);
    const range = rangeArgument(args[0], env, "SUMIF");
    if (isError(range)) return range;
    const criterionValue = scalar(evaluateNode(args[1], env), env);
    if (isError(criterionValue)) return criterionValue;
    const criterion = parseCriterion(criterionValue);
    let sumRange = range;
    if (args.length === 3) {
      sumRange = rangeArgument(args[2], env, "SUMIF");
      if (isError(sumRange)) return sumRange;
    }
    let total = 0;
    for (const entry of env.storedCells(range.sheetId, range.startRow, range.endRow, range.startColumn, range.endColumn)) {
      if (!matchesCriterion(entry.value, criterion)) continue;
      const row = sumRange.startRow + (entry.row - range.startRow);
      const column = sumRange.startColumn + (entry.column - range.startColumn);
      const value = env.cell(sumRange.sheetId, row, column);
      if (isError(value)) return value;
      if (typeof value === "number") total += value;
    }
    return total;
  },
  IF(args, env) {
    if (args.length < 2 || args.length > 3) return argumentCountError("IF", "between 2 and 3", args.length);
    const condition = toBoolean(scalar(evaluateNode(args[0], env), env), "IF");
    if (isError(condition)) return condition;
    if (condition) return scalar(evaluateNode(args[1], env), env);
    return args.length === 3 ? scalar(evaluateNode(args[2], env), env) : false;
  },
  IFERROR(args, env) {
    if (args.length < 1 || args.length > 2) return argumentCountError("IFERROR", "between 1 and 2", args.length);
    const value = scalar(evaluateNode(args[0], env), env);
    if (!isError(value)) return value;
    return args.length === 2 ? scalar(evaluateNode(args[1], env), env) : null;
  },
  AND(args, env) {
    if (args.length === 0) return argumentCountError("AND", "at least 1", 0);
    let result = true;
    const stop = forEachValue(args, env, (value, fromRange) => {
      if (isError(value)) return value;
      if (fromRange && typeof value === "string") return undefined;
      const flag = toBoolean(value, "AND");
      if (isError(flag)) return flag;
      result = result && flag;
      return undefined;
    });
    return stop ?? result;
  },
  OR(args, env) {
    if (args.length === 0) return argumentCountError("OR", "at least 1", 0);
    let result = false;
    const stop = forEachValue(args, env, (value, fromRange) => {
      if (isError(value)) return value;
      if (fromRange && typeof value === "string") return undefined;
      const flag = toBoolean(value, "OR");
      if (isError(flag)) return flag;
      result = result || flag;
      return undefined;
    });
    return stop ?? result;
  },
  NOT(args, env) {
    if (args.length !== 1) return argumentCountError("NOT", 1, args.length);
    const flag = toBoolean(scalar(evaluateNode(args[0], env), env), "NOT");
    return isError(flag) ? flag : !flag;
  },
  ROUND: (args, env) => roundFunction("ROUND", "nearest", args, env),
  ROUNDUP: (args, env) => roundFunction("ROUNDUP", "up", args, env),
  ROUNDDOWN: (args, env) => roundFunction("ROUNDDOWN", "down", args, env),
  ABS(args, env) {
    if (args.length !== 1) return argumentCountError("ABS", 1, args.length);
    const value = toNumber(scalar(evaluateNode(args[0], env), env), "ABS", 1);
    return isError(value) ? value : Math.abs(value);
  },
  CONCATENATE(args, env) {
    if (args.length === 0) return argumentCountError("CONCATENATE", "at least 1", 0);
    let text = "";
    const stop = forEachValue(args, env, (value) => {
      if (isError(value)) return value;
      const next = toText(value);
      if (text.length + next.length > MAX_TEXT_RESULT) return textTooLong("CONCATENATE");
      text += next;
      return undefined;
    });
    return stop ?? text;
  },
  LEN: (args, env) => textFunction("LEN", args, env, (text) => [...text].length),
  UPPER: (args, env) => textFunction("UPPER", args, env, (text) => text.toUpperCase()),
  LOWER: (args, env) => textFunction("LOWER", args, env, (text) => text.toLowerCase()),
  TRIM: (args, env) => textFunction("TRIM", args, env, (text) => text.trim().replace(/ {2,}/g, " ")),
  LEFT: (args, env) => sliceFunction("LEFT", args, env, (chars, n) => chars.slice(0, n)),
  RIGHT: (args, env) => sliceFunction("RIGHT", args, env, (chars, n) => (n === 0 ? [] : chars.slice(-n))),
  VLOOKUP(args, env) {
    if (args.length < 3 || args.length > 4) return argumentCountError("VLOOKUP", "between 3 and 4", args.length);
    const key = scalar(evaluateNode(args[0], env), env);
    if (isError(key)) return key;
    const range = rangeArgument(args[1], env, "VLOOKUP");
    if (isError(range)) return range;
    const index = toNumber(scalar(evaluateNode(args[2], env), env), "VLOOKUP", 3);
    if (isError(index)) return index;
    const sorted = args.length === 4 ? toBoolean(scalar(evaluateNode(args[3], env), env), "VLOOKUP") : true;
    if (isError(sorted)) return sorted;
    if (sorted) {
      return makeError(
        "#N/A",
        "VLOOKUP approximate match (is_sorted TRUE or omitted) is not supported by this simulated service; pass FALSE.",
      );
    }
    const column = Math.trunc(index);
    if (column < 1) return makeError("#VALUE!", `Function VLOOKUP parameter 3 value is ${column}. It should be greater than or equal to 1.`);
    if (column > range.endColumn - range.startColumn) {
      return makeError("#REF!", `VLOOKUP evaluates to an out of bounds range.`);
    }
    for (const entry of env.storedCells(range.sheetId, range.startRow, range.endRow, range.startColumn, range.startColumn + 1)) {
      if (isError(entry.value)) continue;
      if (typeof entry.value === typeof key && compareScalars(entry.value, key) === 0) {
        return env.cell(range.sheetId, entry.row, range.startColumn + column - 1);
      }
    }
    return makeError("#N/A", `Did not find value '${toText(key)}' in VLOOKUP evaluation.`);
  },
  TODAY(args, env) {
    if (args.length !== 0) return argumentCountError("TODAY", 0, args.length);
    return Math.floor(env.nowSerial);
  },
  NOW(args, env) {
    if (args.length !== 0) return argumentCountError("NOW", 0, args.length);
    return env.nowSerial;
  },
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS);

function roundFunction(name, mode, args, env) {
  if (args.length < 1 || args.length > 2) return argumentCountError(name, "between 1 and 2", args.length);
  const value = toNumber(scalar(evaluateNode(args[0], env), env), name, 1);
  if (isError(value)) return value;
  const digits = args.length === 2 ? toNumber(scalar(evaluateNode(args[1], env), env), name, 2) : 0;
  if (isError(digits)) return digits;
  return roundTo(value, digits, mode);
}

function textFunction(name, args, env, apply) {
  if (args.length !== 1) return argumentCountError(name, 1, args.length);
  const value = scalar(evaluateNode(args[0], env), env);
  if (isError(value)) return value;
  return apply(toText(value));
}

function sliceFunction(name, args, env, apply) {
  if (args.length < 1 || args.length > 2) return argumentCountError(name, "between 1 and 2", args.length);
  const value = scalar(evaluateNode(args[0], env), env);
  if (isError(value)) return value;
  const count = args.length === 2 ? toNumber(scalar(evaluateNode(args[1], env), env), name, 2) : 1;
  if (isError(count)) return count;
  if (count < 0) return makeError("#VALUE!", `Function ${name} parameter 2 value is negative. It should be positive or zero.`);
  return apply([...toText(value)], Math.trunc(count)).join("");
}

function callFunction(node, env) {
  const fn = Object.hasOwn(FUNCTIONS, node.name) ? FUNCTIONS[node.name] : undefined;
  if (fn === undefined) return makeError("#NAME?", `Unknown function: '${node.name}'.`);
  return fn(node.args, env);
}

// ---------------------------------------------------------------------------------------------
// Reference adjustment
// ---------------------------------------------------------------------------------------------

function refText(token, row, col) {
  let text = "";
  if (col !== undefined) text += `${token.absCol ? "$" : ""}${indexToColumn(col)}`;
  if (row !== undefined) text += `${token.absRow ? "$" : ""}${row + 1}`;
  return text;
}

/**
 * Rewrites a formula for a structural change. `change` is one of
 * `{ kind: "insert" | "delete", dimension: "ROWS" | "COLUMNS", sheetTitle, start, count }` or
 * `{ kind: "rename", from, to }`. `ownSheetTitle` is the title of the sheet holding the formula (before the change).
 * Text that does not tokenize is returned unchanged (it evaluates to #ERROR! anyway).
 */
export function adjustFormula(text, ownSheetTitle, change) {
  if (typeof text !== "string" || !text.startsWith("=")) return text;
  let tokens;
  try {
    tokens = tokenize(text.slice(1));
  } catch {
    return text;
  }
  const body = text.slice(1);
  let out = "";
  let cursor = 0;
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "sheet" && change.kind === "rename") {
      if (same(token.name, change.from)) {
        out += body.slice(cursor, token.start) + `${quoteSheetName(change.to)}!`;
        cursor = token.end;
      }
      continue;
    }
    if (change.kind === "rename") continue;
    const sheetToken = token.type === "sheet" ? token : undefined;
    const first = sheetToken === undefined ? token : tokens[index + 1];
    if (first === undefined || first.type !== "ref") continue;
    const firstIndex = sheetToken === undefined ? index : index + 1;
    const hasRange = tokens[firstIndex + 1]?.type === "colon" && tokens[firstIndex + 2]?.type === "ref";
    const second = hasRange ? tokens[firstIndex + 2] : undefined;
    const groupStart = (sheetToken ?? first).start;
    const groupEnd = (second ?? first).end;
    index = hasRange ? firstIndex + 2 : firstIndex;
    const target = sheetToken?.name ?? ownSheetTitle;
    if (!same(target, change.sheetTitle)) continue;
    const rows = change.dimension === "ROWS";
    const pick = (t) => (rows ? t.row : t.col);
    const shift = (value, isEnd) => {
      if (value === undefined) return { value };
      if (change.kind === "insert") return { value: value >= change.start ? value + change.count : value };
      const deleteEnd = change.start + change.count;
      if (value < change.start) return { value };
      if (value >= deleteEnd) return { value: value - change.count };
      return { value: isEnd ? change.start - 1 : change.start, inside: true };
    };
    const prefix = sheetToken === undefined ? "" : body.slice(sheetToken.start, sheetToken.end);
    let replacement;
    if (second === undefined) {
      const moved = shift(pick(first), false);
      if (moved.inside) replacement = "#REF!";
      else replacement = prefix + (rows ? refText(first, moved.value, first.col) : refText(first, first.row, moved.value));
    } else {
      const a = shift(pick(first), false);
      const b = shift(pick(second), true);
      if (pick(first) !== undefined && (b.value < a.value || (a.inside && b.inside))) replacement = "#REF!";
      else if (rows) replacement = `${prefix}${refText(first, a.value, first.col)}:${refText(second, b.value, second.col)}`;
      else replacement = `${prefix}${refText(first, first.row, a.value)}:${refText(second, second.row, b.value)}`;
    }
    out += body.slice(cursor, groupStart) + replacement;
    cursor = groupEnd;
  }
  return `=${out}${body.slice(cursor)}`;
}
