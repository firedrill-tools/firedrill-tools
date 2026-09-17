// SuiteQL subset tokenizer and parser. Hand-written; no regular expression is built from caller text.
import { quote } from "./errors.mjs";

export const MAX_SQL = 8000;
const MAX_PREDICATES = 30;
const MAX_SELECT = 40;
const MAX_JOINS = 2;
const MAX_DEPTH = 10;

export class SqlError extends Error {}
export const sqlBad = (message) => {
  throw new SqlError(message);
};

const DIGIT = "0123456789";
const isDigit = (character) => DIGIT.indexOf(character) >= 0;
const isWordStart = (character) => /[A-Za-z_]/.test(character) === true;
const isWordPart = (character) => /[A-Za-z0-9_$#]/.test(character) === true;

const SYMBOLS = ["<>", "!=", "<=", ">=", "(", ")", ",", ".", "*", "=", "<", ">", "?", ";", "|"];

export function tokenizeSql(text) {
  if (text.length > MAX_SQL) sqlBad(`a SuiteQL statement is limited to ${MAX_SQL} characters`);
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      index += 1;
      continue;
    }
    if (character === "\uFFFD") sqlBad(`unreadable character at position ${index}`);
    if (character === "'") {
      let value = "";
      let cursor = index + 1;
      let closed = false;
      while (cursor < text.length) {
        if (text[cursor] === "'") {
          if (text[cursor + 1] === "'") {
            value += "'";
            cursor += 2;
            continue;
          }
          closed = true;
          cursor += 1;
          break;
        }
        value += text[cursor];
        cursor += 1;
      }
      if (!closed) sqlBad(`unterminated string literal at position ${index}`);
      tokens.push({ kind: "string", value, at: index });
      index = cursor;
      continue;
    }
    if (isDigit(character)) {
      let cursor = index;
      let value = "";
      let dots = 0;
      while (cursor < text.length && (isDigit(text[cursor]) || text[cursor] === ".")) {
        if (text[cursor] === ".") {
          if (dots === 1) break;
          if (!isDigit(text[cursor + 1] ?? "")) break;
          dots += 1;
        }
        value += text[cursor];
        cursor += 1;
      }
      tokens.push({ kind: "number", value: Number(value), at: index });
      index = cursor;
      continue;
    }
    if (isWordStart(character)) {
      let cursor = index;
      let value = "";
      while (cursor < text.length && isWordPart(text[cursor])) {
        value += text[cursor];
        cursor += 1;
      }
      tokens.push({ kind: "word", value, upper: value.toUpperCase(), at: index });
      index = cursor;
      continue;
    }
    const symbol = SYMBOLS.find((candidate) => text.startsWith(candidate, index));
    if (symbol === undefined) sqlBad(`unexpected character at position ${index}`);
    tokens.push({ kind: symbol, at: index });
    index += symbol.length;
  }
  return tokens;
}

const UNSUPPORTED = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "DROP", "ALTER", "TRUNCATE", "GRANT",
  "UNION", "INTERSECT", "MINUS", "CASE", "OVER", "PARTITION", "WITH",
]);
const AGGREGATES = new Set(["COUNT", "SUM", "MIN", "MAX", "AVG"]);
const SCALARS = new Set(["UPPER", "LOWER", "NVL"]);

/** Parse a single SuiteQL SELECT; returns a plan object or throws SqlError. */
export function parseSql(text) {
  const tokens = tokenizeSql(text);
  let position = 0;
  let predicates = 0;
  let paramCount = 0;
  const peek = (ahead = 0) => (position + ahead < tokens.length ? tokens[position + ahead] : null);
  const next = () => {
    const token = peek();
    if (token === null) sqlBad("unexpected end of the SuiteQL statement");
    position += 1;
    return token;
  };
  const isWord = (token, upper) => token !== null && token.kind === "word" && token.upper === upper;
  const acceptWord = (upper) => {
    if (isWord(peek(), upper)) {
      position += 1;
      return true;
    }
    return false;
  };
  const expectWord = (upper) => {
    if (!acceptWord(upper)) sqlBad(`expected ${upper} in the SuiteQL statement`);
  };
  const accept = (kind) => {
    if (peek() !== null && peek().kind === kind) {
      position += 1;
      return true;
    }
    return false;
  };
  const expect = (kind) => {
    if (!accept(kind)) sqlBad(`expected ${kind} in the SuiteQL statement`);
  };

  for (const token of tokens) {
    if (token.kind === "word" && UNSUPPORTED.has(token.upper)) {
      sqlBad(`${quote(token.value)} is not supported by this SuiteQL subset`);
    }
    if (token.kind === ";" && token !== tokens[tokens.length - 1]) {
      sqlBad("only a single SuiteQL statement is supported");
    }
  }

  expectWord("SELECT");
  const distinct = acceptWord("DISTINCT");
  const select = [];
  for (;;) {
    select.push(selectItem());
    if (select.length > MAX_SELECT) sqlBad(`a SuiteQL select list is limited to ${MAX_SELECT} items`);
    if (!accept(",")) break;
  }
  expectWord("FROM");
  const from = tableRef();
  const joins = [];
  for (;;) {
    const kind = acceptWord("INNER") ? "inner" : acceptWord("LEFT") ? "left" : null;
    if (kind !== null) acceptWord("OUTER");
    if (!isWord(peek(), "JOIN")) {
      if (kind !== null) sqlBad("expected JOIN after the join type");
      break;
    }
    position += 1;
    const table = tableRef();
    expectWord("ON");
    joins.push({ kind: kind ?? "inner", table, on: predicate(1) });
    if (joins.length > MAX_JOINS) sqlBad(`a SuiteQL statement is limited to ${MAX_JOINS} joins`);
  }
  const where = acceptWord("WHERE") ? predicate(1) : null;
  let groupBy = [];
  if (acceptWord("GROUP")) {
    expectWord("BY");
    for (;;) {
      groupBy.push(columnRef());
      if (!accept(",")) break;
    }
  }
  const having = acceptWord("HAVING") ? predicate(1) : null;
  let orderBy = [];
  if (acceptWord("ORDER")) {
    expectWord("BY");
    for (;;) {
      const expression = selectItem().expression;
      const direction = acceptWord("DESC") ? "desc" : (acceptWord("ASC"), "asc");
      orderBy.push({ expression, direction });
      if (!accept(",")) break;
    }
  }
  let fetch = null;
  if (acceptWord("FETCH")) {
    if (!acceptWord("FIRST")) expectWord("NEXT");
    const count = next();
    if (count.kind !== "number") sqlBad("FETCH FIRST needs a row count");
    fetch = count.value;
    if (!acceptWord("ROWS")) expectWord("ROW");
    expectWord("ONLY");
  }
  accept(";");
  if (position !== tokens.length) sqlBad(`unexpected token at position ${tokens[position].at}`);
  return { distinct, select, from, joins, where, groupBy, having, orderBy, fetch, paramCount };

  function tableRef() {
    const name = next();
    if (name.kind !== "word") sqlBad("expected a table name");
    let alias = null;
    if (acceptWord("AS")) {
      const token = next();
      if (token.kind !== "word") sqlBad("expected a table alias after AS");
      alias = token.value;
    } else if (peek() !== null && peek().kind === "word" && !RESERVED.has(peek().upper)) {
      alias = next().value;
    }
    return { name: name.value, alias };
  }

  function columnRef() {
    const first = next();
    if (first.kind !== "word") sqlBad("expected a column name");
    if (peek() !== null && peek().kind === ".") {
      position += 1;
      if (peek() !== null && peek().kind === "*") {
        position += 1;
        return { kind: "star", qualifier: first.value };
      }
      const column = next();
      if (column.kind !== "word") sqlBad("expected a column name after .");
      return { kind: "column", qualifier: first.value, name: column.value };
    }
    return { kind: "column", qualifier: null, name: first.value };
  }

  function selectItem() {
    const expression = valueExpression();
    let alias = null;
    if (acceptWord("AS")) {
      const token = next();
      if (token.kind !== "word") sqlBad("expected a column alias after AS");
      alias = token.value;
    } else if (peek() !== null && peek().kind === "word" && !RESERVED.has(peek().upper)) {
      alias = next().value;
    }
    return { expression, alias };
  }

  function valueExpression() {
    const token = peek();
    if (token === null) sqlBad("unexpected end of the SuiteQL statement");
    if (token.kind === "*") {
      position += 1;
      return { kind: "star", qualifier: null };
    }
    if (token.kind === "string") {
      position += 1;
      return { kind: "literal", value: token.value };
    }
    if (token.kind === "number") {
      position += 1;
      return { kind: "literal", value: token.value };
    }
    if (token.kind === "?") {
      position += 1;
      paramCount += 1;
      return { kind: "param", index: paramCount - 1 };
    }
    if (token.kind === "(") {
      position += 1;
      const inner = valueExpression();
      expect(")");
      return inner;
    }
    if (token.kind !== "word") sqlBad(`unexpected token at position ${token.at}`);
    if (token.upper === "NULL") {
      position += 1;
      return { kind: "literal", value: null };
    }
    if (token.upper === "BUILTIN" && peek(1) !== null && peek(1).kind === ".") {
      position += 2;
      const fn = next();
      if (fn.kind !== "word" || fn.upper !== "DF") sqlBad("only BUILTIN.DF is supported");
      expect("(");
      const column = columnRef();
      expect(")");
      return { kind: "df", column };
    }
    if (peek(1) !== null && peek(1).kind === "(" && (AGGREGATES.has(token.upper) || SCALARS.has(token.upper))) {
      position += 2;
      const name = token.upper;
      const args = [];
      if (name === "COUNT" && peek() !== null && peek().kind === "*") {
        position += 1;
        expect(")");
        return { kind: "aggregate", name, args: [{ kind: "star", qualifier: null }] };
      }
      const distinctArgument = acceptWord("DISTINCT");
      for (;;) {
        args.push(valueExpression());
        if (!accept(",")) break;
      }
      expect(")");
      return AGGREGATES.has(name)
        ? { kind: "aggregate", name, args, distinct: distinctArgument }
        : { kind: "call", name, args };
    }
    return columnRef();
  }

  function predicate(depth) {
    if (depth > MAX_DEPTH) sqlBad(`the SuiteQL predicate nests deeper than ${MAX_DEPTH} levels`);
    let node = predicateTerm(depth);
    while (acceptWord("OR")) node = { kind: "or", left: node, right: predicateTerm(depth) };
    return node;
  }

  function predicateTerm(depth) {
    let node = predicateFactor(depth);
    while (acceptWord("AND")) node = { kind: "and", left: node, right: predicateFactor(depth) };
    return node;
  }

  function predicateFactor(depth) {
    if (acceptWord("NOT")) return { kind: "not", operand: predicateFactor(depth) };
    if (peek() !== null && peek().kind === "(" && looksLikeGroup()) {
      position += 1;
      const inner = predicate(depth + 1);
      expect(")");
      return inner;
    }
    predicates += 1;
    if (predicates > MAX_PREDICATES) sqlBad(`a SuiteQL statement is limited to ${MAX_PREDICATES} predicates`);
    const left = valueExpression();
    if (acceptWord("IS")) {
      const negated = acceptWord("NOT");
      expectWord("NULL");
      return { kind: "isNull", operand: left, negated };
    }
    const negated = acceptWord("NOT");
    if (acceptWord("LIKE")) return { kind: "like", left, right: valueExpression(), negated };
    if (acceptWord("BETWEEN")) {
      const low = valueExpression();
      expectWord("AND");
      return { kind: "between", left, low, high: valueExpression(), negated };
    }
    if (acceptWord("IN")) {
      expect("(");
      const values = [];
      for (;;) {
        values.push(valueExpression());
        if (!accept(",")) break;
      }
      expect(")");
      return { kind: "in", left, values, negated };
    }
    if (negated) sqlBad("NOT must be followed by LIKE, BETWEEN or IN");
    const operator = next();
    const symbol = operator.kind;
    if (symbol !== "=" && symbol !== "<" && symbol !== ">" && symbol !== "<=" && symbol !== ">=" && symbol !== "<>" && symbol !== "!=") {
      sqlBad(`unsupported comparison operator at position ${operator.at}`);
    }
    return { kind: "compare", operator: symbol === "!=" ? "<>" : symbol, left, right: valueExpression() };
  }

  /** A "(" starts a predicate group when the matching content contains a logical operator or comparison. */
  function looksLikeGroup() {
    let depth = 0;
    for (let index = position; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.kind === "(") depth += 1;
      else if (token.kind === ")") {
        depth -= 1;
        if (depth === 0) return false;
      } else if (depth === 1) {
        if (token.kind === "word" && (token.upper === "AND" || token.upper === "OR" || token.upper === "NOT")) return true;
        if (["=", "<", ">", "<=", ">=", "<>", "!="].includes(token.kind)) return true;
      }
    }
    return false;
  }
}

export const RESERVED = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "ASC", "DESC", "JOIN", "INNER", "LEFT",
  "RIGHT", "OUTER", "ON", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "BETWEEN", "FETCH", "FIRST",
  "NEXT", "ROWS", "ROW", "ONLY", "AS", "DISTINCT",
]);
