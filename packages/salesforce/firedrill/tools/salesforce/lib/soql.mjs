// The SOQL subset: tokenizer, parser, evaluator, date literals, ORDER BY, paging and the
// self-contained query locator. Everything is deterministic and computed from context.state; the
// supported grammar is listed in the README (unsupported syntax fails MALFORMED_QUERY, never
// silently).

import { childRelationship } from "./schema.mjs";
import { readPath, renderPaths, requireReadableType, resolvePath, visibleRows } from "./records.mjs";
import { clip, dateNow, fieldsOf, parseInstant, permissions, recordError } from "./state.mjs";
import { compileLike, foldText } from "./match.mjs";
import { RESPONSE_BYTE_BUDGET, byteBudget, jsonBytes } from "./bytes.mjs";

const DAY_MS = 86400000;
const MAX_OFFSET = 2000;
// LIMIT and OFFSET are 32-bit integers in Salesforce; larger literals fail MALFORMED_QUERY.
const MAX_INT32 = 2147483647;
const FIELDS_LIMIT = 200;
// Salesforce's maximum SOQL statement length.
export const MAX_STATEMENT_LENGTH = 100000;
// Salesforce allows at most 32 fields in ORDER BY.
const MAX_ORDER_BY_FIELDS = 32;
// Parenthesis / NOT nesting bound of this Tool (keeps the recursive parser and evaluator off the stack limit).
export const MAX_NESTING_DEPTH = 100;
// Salesforce's maximum length of a string literal in a WHERE clause.
export const MAX_STRING_LITERAL = 4000;
// Longest text area that stays filterable and sortable; longer ones are long text areas, which Salesforce
// refuses in WHERE and ORDER BY (INVALID_FIELD).
const MAX_FILTERABLE_TEXTAREA = 255;
/**
 * Filter work bound of one request: WHERE comparisons × candidate rows, summed over every statement,
 * subquery and search `where` of the request (a composite shares it). Filterable values hold at most
 * 255 characters and string literals at most 4,000, so each unit costs a bounded amount of work.
 */
export const MAX_FILTER_WORK = 500000;
/**
 * Sort key bound of one request: ORDER BY keys actually computed (a key is read only when earlier keys
 * tie), summed over every statement, subquery and search `orderBy` of the request.
 */
export const MAX_SORT_WORK = 200000;
// Backslash escapes Salesforce accepts inside quoted strings; `\_` and `\%` stay literal in LIKE.
const STRING_ESCAPES = { n: "\n", N: "\n", r: "\r", R: "\r", t: "\t", T: "\t", b: "\b", B: "\b", f: "\f", F: "\f", '"': '"', "'": "'", "\\": "\\", _: "_", "%": "%" };
// Salesforce clamps batchSize to 200–2000; the Tool honours values down to 1 so paging can be
// exercised against small worlds (documented deviation).
export const MIN_BATCH = 1;
export const MAX_BATCH = 2000;

const KEYWORDS = new Set(["SELECT", "FROM", "WHERE", "ORDER", "BY", "LIMIT", "OFFSET", "AND", "OR", "NOT", "IN", "LIKE", "ASC", "DESC", "NULLS", "FIRST", "LAST", "TRUE", "FALSE", "NULL"]);
const UNSUPPORTED_CLAUSES = { GROUP: "GROUP BY", HAVING: "HAVING", WITH: "WITH", USING: "USING SCOPE", FOR: "FOR UPDATE / FOR VIEW / FOR REFERENCE", ALL: "ALL ROWS", TYPEOF: "TYPEOF", INCLUDES: "INCLUDES", EXCLUDES: "EXCLUDES" };
const AGGREGATES = new Set(["COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"]);
const DATE_LITERALS = new Set(["TODAY", "YESTERDAY", "TOMORROW", "THIS_WEEK", "LAST_WEEK", "NEXT_WEEK", "THIS_MONTH", "LAST_MONTH", "NEXT_MONTH", "THIS_YEAR", "LAST_YEAR", "LAST_90_DAYS", "NEXT_90_DAYS"]);
const N_DATE_LITERALS = new Set(["LAST_N_DAYS", "NEXT_N_DAYS", "LAST_N_MONTHS", "NEXT_N_MONTHS"]);
const UNSUPPORTED_DATE_LITERALS = /^(N_DAYS_AGO|LAST_N_WEEKS|NEXT_N_WEEKS|N_WEEKS_AGO|N_MONTHS_AGO|LAST_N_QUARTERS|NEXT_N_QUARTERS|THIS_QUARTER|LAST_QUARTER|NEXT_QUARTER|N_QUARTERS_AGO|LAST_N_YEARS|NEXT_N_YEARS|N_YEARS_AGO|THIS_FISCAL_.*|LAST_FISCAL_.*|NEXT_FISCAL_.*|N_FISCAL_.*|LAST_N_FISCAL_.*|NEXT_N_FISCAL_.*)$/;

function malformed(message) {
  return recordError("MALFORMED_QUERY", message);
}

function unsupported(what) {
  return malformed(`${what}: unsupported in this synthetic Salesforce Tool`);
}

function unexpected(token) {
  return malformed(token === undefined ? "unexpected token: '<EOF>'" : `unexpected token: '${clip(token.text)}'`);
}

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2}))?/;
const NUMBER_PATTERN = /^-?\d+(\.\d+)?/;
const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*/;

export function tokenize(text) {
  if (text.length > MAX_STATEMENT_LENGTH) throw malformed(`SOQL statements cannot exceed ${MAX_STATEMENT_LENGTH} characters`);
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const rest = text.slice(index);
    if (char === "'") {
      // `wild` parallels `value` code unit for code unit: `%`/`_` mark unescaped LIKE wildcards, `.` literals.
      let value = "";
      let wild = "";
      let cursor = index + 1;
      let closed = false;
      while (cursor < text.length) {
        const current = text[cursor];
        if (current === "\\" && cursor + 1 < text.length) {
          const escaped = text[cursor + 1];
          const decoded = Object.hasOwn(STRING_ESCAPES, escaped) ? STRING_ESCAPES[escaped] : undefined;
          if (decoded === undefined) {
            const shown = String.fromCodePoint(text.codePointAt(cursor + 1));
            throw malformed(`Invalid string literal: illegal character sequence '\\${shown}' in string literal`);
          }
          value += decoded;
          wild += ".";
          cursor += 2;
          continue;
        }
        if (current === "'") {
          closed = true;
          cursor += 1;
          break;
        }
        value += current;
        wild += current === "%" || current === "_" ? current : ".";
        cursor += 1;
      }
      if (!closed) throw malformed("unexpected token: '<EOF>' (unterminated string literal)");
      if (value.length > MAX_STRING_LITERAL) throw malformed(`String literal exceeds the maximum length of ${MAX_STRING_LITERAL} characters`);
      tokens.push({ kind: "string", value, wild, text: text.slice(index, cursor) });
      index = cursor;
      continue;
    }
    const date = DATE_PATTERN.exec(rest);
    if (date !== null) {
      tokens.push({ kind: "date", value: date[0], datetime: date[1] !== undefined, text: date[0] });
      index += date[0].length;
      continue;
    }
    const number = NUMBER_PATTERN.exec(rest);
    if (number !== null && (char !== "-" || tokens.length === 0 || tokens[tokens.length - 1].kind === "punct")) {
      tokens.push({ kind: "number", value: Number(number[0]), text: number[0] });
      index += number[0].length;
      continue;
    }
    const ident = IDENT_PATTERN.exec(rest);
    if (ident !== null) {
      tokens.push({ kind: "ident", value: ident[0], upper: ident[0].toUpperCase(), text: ident[0] });
      index += ident[0].length;
      continue;
    }
    const punct = ["<>", "!=", "<=", ">=", "=", "<", ">", "(", ")", ",", ":"].find((candidate) => rest.startsWith(candidate));
    if (punct !== undefined) {
      tokens.push({ kind: "punct", value: punct, text: punct });
      index += punct.length;
      continue;
    }
    throw malformed(`unexpected token: '${char}'`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
    this.depth = 0;
  }
  enter() {
    this.depth += 1;
    if (this.depth > MAX_NESTING_DEPTH) throw malformed(`WHERE expression nesting exceeds the supported depth of ${MAX_NESTING_DEPTH}`);
  }
  leave() {
    this.depth -= 1;
  }
  peek(offset = 0) {
    return this.tokens[this.index + offset];
  }
  next() {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }
  isKeyword(word, offset = 0) {
    const token = this.peek(offset);
    return token !== undefined && token.kind === "ident" && token.upper === word;
  }
  isPunct(value, offset = 0) {
    const token = this.peek(offset);
    return token !== undefined && token.kind === "punct" && token.value === value;
  }
  expectKeyword(word) {
    if (!this.isKeyword(word)) throw unexpected(this.peek());
    return this.next();
  }
  expectPunct(value) {
    if (!this.isPunct(value)) throw unexpected(this.peek());
    return this.next();
  }
  expectName() {
    const token = this.peek();
    if (token === undefined || token.kind !== "ident" || KEYWORDS.has(token.upper)) throw unexpected(token);
    return this.next().value;
  }
  expectInteger() {
    const token = this.peek();
    if (token === undefined || token.kind !== "number" || !Number.isInteger(token.value) || token.value < 0) throw unexpected(token);
    if (token.value > MAX_INT32) throw malformed(`numeric value out of range: '${clip(token.text)}' (an integer between 0 and ${MAX_INT32} is expected)`);
    return this.next().value;
  }
}

function parseSelectList(parser, nested) {
  const items = [];
  for (;;) {
    if (parser.isPunct("(")) {
      if (nested) throw unsupported("nested subqueries");
      parser.next();
      const subquery = parseSelect(parser, true);
      parser.expectPunct(")");
      items.push({ kind: "subquery", ...subquery });
    } else {
      const token = parser.peek();
      if (token === undefined || token.kind !== "ident") throw unexpected(token);
      if (parser.isPunct("(", 1)) {
        const name = token.upper;
        parser.next();
        parser.next();
        if (name === "COUNT") {
          if (!parser.isPunct(")")) throw unsupported("COUNT(fieldName)");
          parser.next();
          items.push({ kind: "count" });
        } else if (name === "FIELDS") {
          const scope = parser.peek();
          if (scope === undefined || scope.kind !== "ident" || !["ALL", "STANDARD", "CUSTOM"].includes(scope.upper)) throw unexpected(scope);
          parser.next();
          parser.expectPunct(")");
          items.push({ kind: "fields", scope: scope.upper });
        } else {
          throw unsupported(AGGREGATES.has(name) ? `aggregate function ${clip(name)}()` : `${clip(token.value)}()`);
        }
      } else {
        if (token.upper === "TYPEOF") throw unsupported("TYPEOF");
        items.push({ kind: "field", path: parser.expectName() });
      }
    }
    if (parser.isPunct(",")) {
      parser.next();
      continue;
    }
    return items;
  }
}

function parseValue(parser, allowSubquery) {
  const token = parser.peek();
  if (token === undefined) throw unexpected(token);
  if (token.kind === "string") {
    parser.next();
    return { kind: "string", value: token.value, wild: token.wild };
  }
  if (token.kind === "number") return { kind: "number", value: parser.next().value };
  if (token.kind === "date") {
    parser.next();
    return { kind: "date", value: token.value, datetime: token.datetime };
  }
  if (token.kind === "punct" && token.value === "(" && parser.isKeyword("SELECT", 1)) {
    if (allowSubquery) throw unsupported("semi-join / anti-join subqueries (WHERE … IN (SELECT …))");
    throw unexpected(token);
  }
  if (token.kind === "ident") {
    if (token.upper === "TRUE" || token.upper === "FALSE") {
      parser.next();
      return { kind: "boolean", value: token.upper === "TRUE" };
    }
    if (token.upper === "NULL") {
      parser.next();
      return { kind: "null" };
    }
    if (DATE_LITERALS.has(token.upper)) {
      parser.next();
      return { kind: "dateLiteral", name: token.upper, n: null };
    }
    if (N_DATE_LITERALS.has(token.upper)) {
      parser.next();
      parser.expectPunct(":");
      return { kind: "dateLiteral", name: token.upper, n: parser.expectInteger() };
    }
    if (UNSUPPORTED_DATE_LITERALS.test(token.upper)) throw unsupported(`date literal ${clip(token.upper)}`);
    if (parser.isPunct("(", 1)) throw unsupported(`${clip(token.value)}()`);
  }
  throw unexpected(token);
}

function parseComparison(parser) {
  const token = parser.peek();
  if (token !== undefined && token.kind === "ident" && parser.isPunct("(", 1)) throw unsupported(`${clip(token.value)}()`);
  const path = parser.expectName();
  const operatorToken = parser.peek();
  if (operatorToken === undefined) throw unexpected(operatorToken);
  if (operatorToken.kind === "punct" && ["=", "!=", "<>", "<", "<=", ">", ">="].includes(operatorToken.value)) {
    parser.next();
    return { kind: "compare", path, operator: operatorToken.value === "<>" ? "!=" : operatorToken.value, value: parseValue(parser, true) };
  }
  if (operatorToken.kind === "ident" && operatorToken.upper === "LIKE") {
    parser.next();
    const value = parseValue(parser, false);
    if (value.kind !== "string") throw malformed("LIKE requires a string literal");
    return { kind: "like", path, value: value.value, wild: value.wild };
  }
  let negated = false;
  if (operatorToken.kind === "ident" && operatorToken.upper === "NOT") {
    negated = true;
    parser.next();
  }
  const listToken = parser.peek();
  if (listToken !== undefined && listToken.kind === "ident" && (listToken.upper === "INCLUDES" || listToken.upper === "EXCLUDES")) throw unsupported(listToken.upper);
  if (listToken === undefined || listToken.kind !== "ident" || listToken.upper !== "IN") throw unexpected(listToken);
  parser.next();
  parser.expectPunct("(");
  if (parser.isKeyword("SELECT")) throw unsupported("semi-join / anti-join subqueries (WHERE … IN (SELECT …))");
  const values = [];
  for (;;) {
    values.push(parseValue(parser, false));
    if (parser.isPunct(",")) {
      parser.next();
      continue;
    }
    break;
  }
  parser.expectPunct(")");
  return { kind: "in", path, negated, values };
}

function parseNot(parser) {
  if (parser.isKeyword("NOT")) {
    parser.next();
    parser.enter();
    const operand = parseNot(parser);
    parser.leave();
    return { kind: "not", operand };
  }
  if (parser.isPunct("(") && !parser.isKeyword("SELECT", 1)) {
    parser.next();
    parser.enter();
    const inner = parseOr(parser);
    parser.leave();
    parser.expectPunct(")");
    return inner;
  }
  return parseComparison(parser);
}

function parseAnd(parser) {
  const operands = [parseNot(parser)];
  while (parser.isKeyword("AND")) {
    parser.next();
    operands.push(parseNot(parser));
  }
  return operands.length === 1 ? operands[0] : { kind: "and", operands };
}

function parseOr(parser) {
  const operands = [parseAnd(parser)];
  while (parser.isKeyword("OR")) {
    parser.next();
    operands.push(parseAnd(parser));
  }
  return operands.length === 1 ? operands[0] : { kind: "or", operands };
}

function parseOrderBy(parser) {
  const entries = [];
  for (;;) {
    const path = parser.expectName();
    let descending = false;
    let nullsFirst = true;
    if (parser.isKeyword("ASC") || parser.isKeyword("DESC")) descending = parser.next().upper === "DESC";
    if (parser.isKeyword("NULLS")) {
      parser.next();
      const which = parser.peek();
      if (which === undefined || which.kind !== "ident" || (which.upper !== "FIRST" && which.upper !== "LAST")) throw unexpected(which);
      nullsFirst = parser.next().upper === "FIRST";
    }
    entries.push({ path, descending, nullsFirst });
    if (entries.length > MAX_ORDER_BY_FIELDS) throw malformed(`ORDER BY accepts at most ${MAX_ORDER_BY_FIELDS} fields`);
    if (parser.isPunct(",")) {
      parser.next();
      continue;
    }
    return entries;
  }
}

function parseSelect(parser, nested) {
  parser.expectKeyword("SELECT");
  const select = parseSelectList(parser, nested);
  parser.expectKeyword("FROM");
  const from = parser.expectName();
  let where = null;
  let orderBy = [];
  let limit = null;
  let offset = null;
  if (parser.isKeyword("WHERE")) {
    parser.next();
    where = parseOr(parser);
  }
  const trailing = parser.peek();
  if (trailing !== undefined && trailing.kind === "ident" && UNSUPPORTED_CLAUSES[trailing.upper] !== undefined) throw unsupported(UNSUPPORTED_CLAUSES[trailing.upper]);
  if (parser.isKeyword("ORDER")) {
    parser.next();
    parser.expectKeyword("BY");
    orderBy = parseOrderBy(parser);
  }
  if (parser.isKeyword("LIMIT")) {
    parser.next();
    limit = parser.expectInteger();
  }
  if (parser.isKeyword("OFFSET")) {
    if (nested) throw unsupported("OFFSET inside a subquery");
    parser.next();
    offset = parser.expectInteger();
  }
  return { select, from, where, orderBy, limit, offset };
}

/** Parse one SOQL statement (MALFORMED_QUERY on syntax errors or unsupported syntax). */
export function parseQuery(text) {
  const parser = new Parser(tokenize(text));
  const query = parseSelect(parser, false);
  const trailing = parser.peek();
  if (trailing !== undefined) {
    if (trailing.kind === "ident" && UNSUPPORTED_CLAUSES[trailing.upper] !== undefined) throw unsupported(UNSUPPORTED_CLAUSES[trailing.upper]);
    throw unexpected(trailing);
  }
  return query;
}

/** Parse a bare WHERE expression (parameterized search `where`). */
export function parseWhere(text) {
  const parser = new Parser(tokenize(text));
  const expression = parseOr(parser);
  const trailing = parser.peek();
  if (trailing !== undefined) throw unexpected(trailing);
  return expression;
}

/** Parse a bare ORDER BY list (parameterized search `orderBy`). */
export function parseOrder(text) {
  const parser = new Parser(tokenize(text));
  const entries = parseOrderBy(parser);
  const trailing = parser.peek();
  if (trailing !== undefined) throw unexpected(trailing);
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Date literals (UTC, Sunday-start weeks)
// ---------------------------------------------------------------------------------------------

function dayStart(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function monthStart(ms, delta = 0) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1);
}

function yearStart(ms, delta = 0) {
  return Date.UTC(new Date(ms).getUTCFullYear() + delta, 0, 1);
}

function weekStart(ms, delta = 0) {
  const start = dayStart(ms);
  const weekday = new Date(start).getUTCDay();
  return start - weekday * DAY_MS + delta * 7 * DAY_MS;
}

/** The `[start, end)` range (epoch ms) of a date literal relative to virtual today. */
export function dateLiteralRange(session, literal) {
  const today = dayStart(parseInstant(dateNow(session)));
  const n = literal.n ?? 0;
  switch (literal.name) {
    case "TODAY":
      return [today, today + DAY_MS];
    case "YESTERDAY":
      return [today - DAY_MS, today];
    case "TOMORROW":
      return [today + DAY_MS, today + 2 * DAY_MS];
    case "THIS_WEEK":
      return [weekStart(today), weekStart(today, 1)];
    case "LAST_WEEK":
      return [weekStart(today, -1), weekStart(today)];
    case "NEXT_WEEK":
      return [weekStart(today, 1), weekStart(today, 2)];
    case "THIS_MONTH":
      return [monthStart(today), monthStart(today, 1)];
    case "LAST_MONTH":
      return [monthStart(today, -1), monthStart(today)];
    case "NEXT_MONTH":
      return [monthStart(today, 1), monthStart(today, 2)];
    case "THIS_YEAR":
      return [yearStart(today), yearStart(today, 1)];
    case "LAST_YEAR":
      return [yearStart(today, -1), yearStart(today)];
    case "LAST_90_DAYS":
      return [today - 90 * DAY_MS, today + DAY_MS];
    case "NEXT_90_DAYS":
      return [today + DAY_MS, today + 91 * DAY_MS];
    case "LAST_N_DAYS":
      return [today - n * DAY_MS, today + DAY_MS];
    case "NEXT_N_DAYS":
      return [today + DAY_MS, today + (n + 1) * DAY_MS];
    case "LAST_N_MONTHS":
      return [monthStart(today, -n), monthStart(today)];
    case "NEXT_N_MONTHS":
      return [monthStart(today, 1), monthStart(today, n + 1)];
    default:
      throw unsupported(`date literal ${clip(literal.name)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Predicate compilation
// ---------------------------------------------------------------------------------------------

function typeOfPath(resolved) {
  return resolved.typeField ? "string" : resolved.field.type;
}

function isTextType(type) {
  return ["id", "string", "textarea", "email", "url", "phone", "picklist", "reference"].includes(type);
}

function isNumberType(type) {
  return ["int", "double", "currency", "percent"].includes(type);
}

/** Long text areas (and a relationship path ending in one) cannot be filtered or sorted in SOQL. */
export function isLongText(field) {
  return field !== null && field !== undefined && field.type === "textarea" && (field.length ?? 0) > MAX_FILTERABLE_TEXTAREA;
}

function requireFilterable(resolved) {
  if (!resolved.typeField && isLongText(resolved.field)) throw recordError("INVALID_FIELD", `field '${resolved.field.name}' can not be filtered in query call`, [resolved.field.name]);
}

function requireSortable(resolved) {
  if (!resolved.typeField && isLongText(resolved.field)) throw recordError("INVALID_FIELD", `field '${resolved.field.name}' can not be sorted in a query call`, [resolved.field.name]);
}

/** Number of comparisons (LIKE, IN and operator leaves) in a WHERE tree. */
export function comparisonCount(expression) {
  let count = 0;
  const stack = [expression];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.kind === "and" || node.kind === "or") stack.push(...node.operands);
    else if (node.kind === "not") stack.push(node.operand);
    else count += 1;
  }
  return count;
}

/**
 * Charge `comparisons × rows` to the request's filter work before a filter runs; beyond MAX_FILTER_WORK
 * the statement fails MALFORMED_QUERY with Salesforce's "too complicated" wording.
 */
export function chargeFilterWork(session, expression, rows) {
  if (expression === null || rows === 0) return;
  session.filterWork = (session.filterWork ?? 0) + comparisonCount(expression) * rows;
  if (session.filterWork > MAX_FILTER_WORK) {
    throw malformed(`Query is either selecting too many fields or the filter conditions are too complicated (this Tool evaluates at most ${MAX_FILTER_WORK} WHERE comparisons per row per request)`);
  }
}

function typedMismatch(resolved, expected) {
  return malformed(`value of filter criterion for field '${clip(resolved.path)}' must be of type ${expected} and should not be enclosed in quotes`);
}

/**
 * Compile one comparison of a field with a literal into `(value) => boolean`; null semantics as
 * Salesforce. The literal is type-checked and normalised once, not per row.
 */
function compileComparison(session, resolved, operator, literal) {
  const type = typeOfPath(resolved);
  if (literal.kind === "null") {
    if (operator === "=") return (value) => value === null;
    if (operator === "!=") return (value) => value !== null;
    return () => false;
  }
  if (isTextType(type)) {
    if (literal.kind !== "string") throw typedMismatch(resolved, "string");
    const right = literal.value.toLowerCase();
    return (value, lower) => {
      if (value === null) return operator === "!=";
      const left = lower();
      return orderCompare(left < right ? -1 : left > right ? 1 : 0, operator);
    };
  }
  if (isNumberType(type)) {
    if (literal.kind !== "number") throw typedMismatch(resolved, "number");
    return (value) => (value === null ? operator === "!=" : orderCompare(value < literal.value ? -1 : value > literal.value ? 1 : 0, operator));
  }
  if (type === "boolean") {
    if (literal.kind !== "boolean") throw typedMismatch(resolved, "boolean");
    if (operator !== "=" && operator !== "!=") throw malformed(`operator '${operator}' is not valid for boolean field '${clip(resolved.path)}'`);
    return (value) => (value === null ? operator === "!=" : operator === "=" ? value === literal.value : value !== literal.value);
  }
  if (type === "date" || type === "datetime") {
    const [start, end] = literalRange(session, resolved, type, literal);
    return (value) => {
      if (value === null) return operator === "!=";
      const ms = parseInstant(String(value));
      if (ms === null) return operator === "!=";
      switch (operator) {
        case "=":
          return ms >= start && ms < end;
        case "!=":
          return ms < start || ms >= end;
        case "<":
          return ms < start;
        case "<=":
          return ms < end;
        case ">":
          return ms >= end;
        default:
          return ms >= start;
      }
    };
  }
  throw typedMismatch(resolved, type);
}

function literalRange(session, resolved, type, literal) {
  if (literal.kind === "dateLiteral") return dateLiteralRange(session, literal);
  if (literal.kind === "date") {
    const ms = parseInstant(literal.value);
    if (ms === null) throw malformed(`invalid date: ${clip(literal.value)}`);
    return literal.datetime ? [ms, ms + 1] : [dayStart(ms), dayStart(ms) + DAY_MS];
  }
  throw typedMismatch(resolved, type === "date" ? "date" : "dateTime");
}

/**
 * Compile `IN (…)` into a membership test whose per-row cost does not grow with the list: text and
 * numbers and booleans become a Set, dates a sorted list of ranges searched by bisection.
 */
function compileMembership(session, resolved, literals) {
  const type = typeOfPath(resolved);
  const hasNull = literals.some((literal) => literal.kind === "null");
  const values = literals.filter((literal) => literal.kind !== "null");
  if (isTextType(type) || isNumberType(type) || type === "boolean") {
    const expected = isTextType(type) ? "string" : isNumberType(type) ? "number" : "boolean";
    const set = new Set();
    for (const literal of values) {
      if (literal.kind !== expected) throw typedMismatch(resolved, expected);
      set.add(expected === "string" ? literal.value.toLowerCase() : literal.value);
    }
    return (value, lower) => (value === null ? hasNull : set.has(expected === "string" ? lower() : value));
  }
  if (type === "date" || type === "datetime") {
    const ranges = values.map((literal) => literalRange(session, resolved, type, literal)).sort((a, b) => a[0] - b[0]);
    // Merge overlapping ranges so bisection on the start finds the only candidate.
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([range[0], range[1]]);
    }
    return (value) => {
      if (value === null) return hasNull;
      const ms = parseInstant(String(value));
      if (ms === null) return false;
      let low = 0;
      let high = merged.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (ms < merged[middle][0]) high = middle - 1;
        else if (ms >= merged[middle][1]) low = middle + 1;
        else return true;
      }
      return false;
    };
  }
  if (values.length > 0) throw typedMismatch(resolved, type);
  return (value) => value === null && hasNull;
}

function orderCompare(sign, operator) {
  switch (operator) {
    case "=":
      return sign === 0;
    case "!=":
      return sign !== 0;
    case "<":
      return sign < 0;
    case "<=":
      return sign <= 0;
    case ">":
      return sign > 0;
    default:
      return sign >= 0;
  }
}

/**
 * Per-query column cache: each row's value of one path is read, lower-cased and case-folded at most once
 * per query, however many clauses test it.
 */
function columnOf(session, type, resolved, columns) {
  const key = resolved.path.toLowerCase();
  let column = columns.get(key);
  if (column !== undefined) return column;
  const entries = new Map();
  const entry = (row) => {
    let cached = entries.get(row);
    if (cached === undefined) {
      cached = { value: readPath(session, type, row, resolved), lower: null, folded: null };
      entries.set(row, cached);
    }
    return cached;
  };
  column = {
    entry,
    lower: (cached) => (cached.lower ??= String(cached.value).toLowerCase()),
    folded: (cached) => (cached.folded ??= foldText(String(cached.value))),
  };
  columns.set(key, column);
  return column;
}

/**
 * Compile a parsed WHERE tree into `(row) => boolean` for `type`, resolving every field path. Call
 * `chargeFilterWork` with the candidate row count before filtering with it.
 */
export function compilePredicate(session, type, expression, columns = new Map()) {
  switch (expression.kind) {
    case "and": {
      const parts = expression.operands.map((operand) => compilePredicate(session, type, operand, columns));
      return (row) => parts.every((part) => part(row));
    }
    case "or": {
      const parts = expression.operands.map((operand) => compilePredicate(session, type, operand, columns));
      return (row) => parts.some((part) => part(row));
    }
    case "not": {
      const inner = compilePredicate(session, type, expression.operand, columns);
      return (row) => !inner(row);
    }
    case "compare": {
      const resolved = resolvePath(session, type, expression.path, "entity");
      requireFilterable(resolved);
      const test = compileComparison(session, resolved, expression.operator, expression.value);
      const column = columnOf(session, type, resolved, columns);
      return (row) => {
        const cached = column.entry(row);
        return test(cached.value, () => column.lower(cached));
      };
    }
    case "like": {
      const resolved = resolvePath(session, type, expression.path, "entity");
      requireFilterable(resolved);
      if (!isTextType(typeOfPath(resolved))) throw malformed(`LIKE is only valid on text fields: '${clip(resolved.path)}'`);
      const like = compileLike(expression.value, expression.wild, (message) => {
        throw malformed(message);
      });
      const column = columnOf(session, type, resolved, columns);
      return (row) => {
        const cached = column.entry(row);
        return cached.value !== null && like(String(cached.value), () => column.folded(cached));
      };
    }
    case "in": {
      const resolved = resolvePath(session, type, expression.path, "entity");
      requireFilterable(resolved);
      const member = compileMembership(session, resolved, expression.values);
      const column = columnOf(session, type, resolved, columns);
      return (row) => {
        const cached = column.entry(row);
        const hit = member(cached.value, () => column.lower(cached));
        return expression.negated ? !hit : hit;
      };
    }
    default:
      throw malformed("unsupported expression");
  }
}

/**
 * Compile ORDER BY entries into `(rows) => sortedCopy` (ASC NULLS FIRST by default). Sort keys are
 * computed once per row (read, lower-cased, parsed), so comparisons never re-read or re-fold values.
 * The sort is stable.
 */
export function compileOrder(session, type, entries) {
  const resolved = entries.map((entry) => {
    const path = resolvePath(session, type, entry.path, "entity");
    requireSortable(path);
    return { ...entry, resolved: path, kind: typeOfPath(path) };
  });
  const keyOf = (value, kind) => {
    if (value === null) return null;
    if (isNumberType(kind) || kind === "boolean") return value;
    if (kind === "date" || kind === "datetime") return parseInstant(String(value)) ?? 0;
    return String(value).toLowerCase();
  };
  // Keys are computed lazily, at most once per row and key: a later key is read only for rows whose
  // earlier keys tie.
  const key = (decorated, index) => {
    let value = decorated.keys[index];
    if (value === undefined) {
      session.sortWork = (session.sortWork ?? 0) + 1;
      if (session.sortWork > MAX_SORT_WORK) {
        throw malformed(`Query is either selecting too many fields or the filter conditions are too complicated (this Tool computes at most ${MAX_SORT_WORK} ORDER BY keys per request)`);
      }
      const entry = resolved[index];
      value = keyOf(readPath(session, type, decorated.row, entry.resolved), entry.kind);
      decorated.keys[index] = value;
    }
    return value;
  };
  const compare = (left, right) => {
    for (let index = 0; index < resolved.length; index += 1) {
      const entry = resolved[index];
      const a = key(left, index);
      const b = key(right, index);
      if (a === null || b === null) {
        if (a === null && b === null) continue;
        const nullFirst = entry.nullsFirst ? -1 : 1;
        return a === null ? nullFirst : -nullFirst;
      }
      const sign = a < b ? -1 : a > b ? 1 : 0;
      if (sign !== 0) return entry.descending ? -sign : sign;
    }
    return 0;
  };
  return (rows) =>
    rows
      .map((row) => ({ row, keys: new Array(resolved.length) }))
      .sort(compare)
      .map((decorated) => decorated.row);
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

function selectionFor(session, type, items, limit) {
  const paths = [];
  const subqueries = [];
  const selected = new Set();
  let count = false;
  for (const item of items) {
    if (item.kind === "count") count = true;
    else if (item.kind === "fields") {
      if ((item.scope === "ALL" || item.scope === "CUSTOM") && (limit === null || limit > FIELDS_LIMIT)) {
        throw malformed(`The SOQL FIELDS(${item.scope}) function must be used with a LIMIT of at most ${FIELDS_LIMIT}`);
      }
      for (const field of fieldsOf(session, type)) {
        if (item.scope === "ALL" || (item.scope === "CUSTOM" && field.custom) || (item.scope === "STANDARD" && !field.custom)) paths.push({ path: field.name, field, via: null });
      }
    } else if (item.kind === "field") {
      const resolved = resolvePath(session, type, item.path, "entity");
      // Salesforce rejects a field selected twice; this also bounds the select list to distinct paths.
      const key = resolved.path.toLowerCase();
      if (selected.has(key)) throw malformed(`duplicate field selected: ${clip(resolved.path)}`);
      selected.add(key);
      paths.push(resolved);
    } else subqueries.push(item);
  }
  if (count && (paths.length > 0 || subqueries.length > 0)) throw unsupported("COUNT() combined with other select items");
  return { count, paths, subqueries };
}

function relationshipFor(session, type, subquery) {
  const relationship = childRelationship(type, subquery.from);
  if (relationship === null) {
    throw recordError("INVALID_TYPE", `Didn't understand relationship '${clip(subquery.from)}' in FROM part of query call. If you are attempting to use a custom relationship, be sure to append the '__r' after the custom relationship name. Please reference your WSDL or the describe call for the appropriate names.`);
  }
  const childType = relationship.childSObject;
  if (!permissions(session, childType).read) throw recordError("INVALID_TYPE", `sObject type '${childType}' is not supported. If you are attempting to use a custom object, be sure to append the '__c' after the entity name. Please reference your WSDL or the describe call for the appropriate names.`);
  const selection = selectionFor(session, childType, subquery.select, subquery.limit);
  if (selection.count) throw unsupported("COUNT() inside a subquery");
  return {
    relationship,
    childType,
    selection,
    where: subquery.where,
    predicate: subquery.where === null ? null : compilePredicate(session, childType, subquery.where),
    order: subquery.orderBy.length === 0 ? null : compileOrder(session, childType, subquery.orderBy),
    limit: subquery.limit,
  };
}

/**
 * Visible child rows of one subquery grouped by parent id, computed once per query (filtered, sorted,
 * limited per parent) so a page of parents costs one pass over the children, not one pass per parent.
 */
function childGroups(session, plan) {
  let rows = visibleRows(session, plan.childType, false);
  if (plan.predicate !== null) {
    chargeFilterWork(session, plan.where, rows.length);
    rows = rows.filter(plan.predicate);
  }
  if (plan.order !== null) rows = plan.order(rows);
  const groups = new Map();
  for (const row of rows) {
    const parentId = row.fields?.[plan.relationship.field];
    if (typeof parentId !== "string") continue;
    let group = groups.get(parentId);
    if (group === undefined) {
      group = [];
      groups.set(parentId, group);
    }
    if (plan.limit === null || group.length < plan.limit) group.push(row);
  }
  return groups;
}

/** Message of the LIMIT_EXCEEDED raised when not even one row fits the response budget. */
export function tooLargeMessage(limit) {
  return `The response would exceed the ${limit.toLocaleString("en-US")}-byte response budget of this Tool; select fewer or narrower fields, add a filter or query fewer child rows`;
}

/**
 * Render one page row, measuring each child record before admitting it. Returns `{ rendered, size }`
 * (size = encoded bytes of the row) or null as soon as the row alone would pass `room` bytes.
 */
function renderRowWithin(session, type, row, selection, children, groups, version, room) {
  const rendered = renderPaths(session, type, row, version, selection.paths);
  for (const child of children) rendered[child.relationship.relationshipName] = null;
  let size = jsonBytes(rendered);
  if (size > room) return null;
  children.forEach((child, index) => {
    if (size === null) return;
    const rows = groups[index].get(row.Id);
    if (rows === undefined || rows.length === 0) return;
    const nested = { totalSize: rows.length, done: true, records: [] };
    size += jsonBytes(nested) - 4; // replaces the "null" placeholder
    for (const childRow of rows) {
      const record = renderPaths(session, child.childType, childRow, version, child.selection.paths);
      size += jsonBytes(record) + (nested.records.length > 0 ? 1 : 0);
      if (size > room) {
        size = null;
        return;
      }
      nested.records.push(record);
    }
    rendered[child.relationship.relationshipName] = nested;
  });
  return size === null ? null : { rendered, size };
}

function nextRecordsUrl(session, options, offset) {
  const locator = encodeLocator({ q: options.text, includeDeleted: options.includeDeleted, offset, batchSize: options.batchSize, userId: session.user.Id });
  return `/services/data/${options.version}/${options.includeDeleted ? "queryAll" : "query"}/${locator}`;
}

/**
 * Execute a parsed query. Returns Salesforce's `{ totalSize, done, records, nextRecordsUrl? }`;
 * `offset` is the paging position (from a locator), distinct from the query's own OFFSET clause.
 * A page holds at most `batchSize` rows and stops early once the encoded body would pass
 * `options.byteLimit` (default RESPONSE_BYTE_BUDGET); the locator then resumes at the first row not
 * returned. A single row larger than the budget fails LIMIT_EXCEEDED (never a truncated row).
 */
export function executeQuery(session, query, options) {
  const type = requireReadableType(session, query.from);
  if (query.offset !== null && query.offset > MAX_OFFSET) throw malformed(`NUMBER_OUTSIDE_VALID_RANGE: Maximum SOQL offset allowed is ${MAX_OFFSET}`);
  const selection = selectionFor(session, type, query.select, query.limit);
  const predicate = query.where === null ? null : compilePredicate(session, type, query.where);
  const order = query.orderBy.length === 0 ? null : compileOrder(session, type, query.orderBy);
  const children = selection.subqueries.map((subquery) => relationshipFor(session, type, subquery));
  let rows = visibleRows(session, type, options.includeDeleted);
  if (predicate !== null) {
    chargeFilterWork(session, query.where, rows.length);
    rows = rows.filter(predicate);
  }
  if (order !== null) rows = order(rows);
  if (query.offset !== null) rows = rows.slice(query.offset);
  if (query.limit !== null) rows = rows.slice(0, query.limit);
  if (selection.count) return { totalSize: rows.length, done: true, records: [] };
  const start = options.offset;
  if (start > 0 && start >= rows.length) throw recordError("INVALID_QUERY_LOCATOR", "invalid query locator");
  const last = Math.min(rows.length, start + options.batchSize);
  const limit = Math.min(RESPONSE_BYTE_BUDGET, options.byteLimit ?? RESPONSE_BYTE_BUDGET);
  // Envelope overhead with the longest locator this query can produce (offset digits grow at most to rows.length).
  const budget = byteBudget(limit, jsonBytes({ totalSize: rows.length, done: false, nextRecordsUrl: nextRecordsUrl(session, options, rows.length), records: [] }));
  const groups = start >= last ? [] : children.map((child) => childGroups(session, child));
  const records = [];
  let end = start;
  while (end < last) {
    const separator = records.length > 0 ? 1 : 0;
    const room = limit - budget.used - separator;
    const entry = room <= 0 ? null : renderRowWithin(session, type, rows[end], selection, children, groups, options.version, room);
    if (entry === null) {
      if (records.length === 0) throw recordError("LIMIT_EXCEEDED", tooLargeMessage(limit));
      break;
    }
    budget.add(entry.size + separator);
    records.push(entry.rendered);
    end += 1;
  }
  const done = end >= rows.length;
  const result = { totalSize: rows.length, done, records };
  if (!done) result.nextRecordsUrl = nextRecordsUrl(session, options, end);
  return result;
}

/** Clamp `Sforce-Query-Options: batchSize=N` into the 1–2000 window (default 2000). */
export function clampBatchSize(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_BATCH;
  return Math.min(MAX_BATCH, Math.max(MIN_BATCH, Math.floor(value)));
}

// ---------------------------------------------------------------------------------------------
// Query locator: `01g` + base64url(JSON) + `-<offset>` — self-contained, so paging is stateless
// ---------------------------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function utf8Encode(text) {
  const bytes = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

/**
 * Strict UTF-8 decoder for caller-supplied locator bytes: null (never a throw) for a truncated
 * sequence, a continuation byte that is not 10xxxxxx, a stray continuation or 0xF8+ lead byte, an
 * overlong form, a surrogate code point or a code point above U+10FFFF.
 */
function utf8Decode(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; ) {
    const byte = bytes[index];
    let code;
    let width;
    let min;
    if (byte < 0x80) {
      code = byte;
      width = 1;
      min = 0;
    } else if ((byte & 0xe0) === 0xc0) {
      code = byte & 0x1f;
      width = 2;
      min = 0x80;
    } else if ((byte & 0xf0) === 0xe0) {
      code = byte & 0x0f;
      width = 3;
      min = 0x800;
    } else if ((byte & 0xf8) === 0xf0) {
      code = byte & 0x07;
      width = 4;
      min = 0x10000;
    } else {
      return null;
    }
    if (index + width > bytes.length) return null;
    for (let offset = 1; offset < width; offset += 1) {
      const next = bytes[index + offset];
      if ((next & 0xc0) !== 0x80) return null;
      code = (code << 6) | (next & 0x3f);
    }
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    text += String.fromCodePoint(code);
    index += width;
  }
  return text;
}

function base64urlEncode(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += B64[c & 63];
  }
  return out;
}

function base64urlDecode(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    buffer = (buffer << 6) | B64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

export function encodeLocator(payload) {
  return `01g${base64urlEncode(utf8Encode(JSON.stringify(payload)))}-${payload.offset}`;
}

/** Decode a locator; null when it is not one of ours. */
export function decodeLocator(locator) {
  if (typeof locator !== "string") return null;
  const match = /^01g([A-Za-z0-9_-]+)-(\d+)$/.exec(locator);
  if (match === null) return null;
  const bytes = base64urlDecode(match[1]);
  if (bytes === null) return null;
  const text = utf8Decode(bytes);
  if (text === null) return null;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || typeof payload.q !== "string" || typeof payload.userId !== "string") return null;
  if (!Number.isInteger(payload.offset) || payload.offset !== Number(match[2]) || !Number.isInteger(payload.batchSize)) return null;
  return { q: payload.q, includeDeleted: payload.includeDeleted === true, offset: payload.offset, batchSize: clampBatchSize(payload.batchSize), userId: payload.userId };
}
