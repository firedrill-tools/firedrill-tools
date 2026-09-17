// A documented JQL subset: tokeniser, recursive-descent parser, compile-time value resolution and
// an evaluator over issue rows, plus ORDER BY. Pure: everything it needs arrives in `env`.
//
// Supported fields: project, issuetype/type, status, statusCategory, priority, assignee, reporter,
// creator, labels, sprint, parent, resolution, key/issuekey/id, summary, description, comment, text,
// created, updated, resolved/resolutiondate, duedate/due. Functions: currentUser(), openSprints(),
// futureSprints(), closedSprints(), now(), startOfDay(), endOfDay(), startOfWeek(), endOfWeek().
// Everything else fails with JqlError naming the construct.

import { compareFold, compareStrings, parseTimestamp } from "./state.mjs";
import { STATUS_CATEGORIES, RESOLUTIONS } from "./render.mjs";

export class JqlError extends Error {}

const KEYWORDS = new Set(["and", "or", "not", "in", "is", "empty", "null", "order", "by", "asc", "desc"]);
const HISTORY = new Set(["was", "changed", "during", "before", "after", "on", "from", "to"]);
const FIELD_ALIASES = Object.freeze({
  project: "project",
  issuetype: "issuetype",
  type: "issuetype",
  status: "status",
  statuscategory: "statusCategory",
  priority: "priority",
  assignee: "assignee",
  reporter: "reporter",
  creator: "creator",
  labels: "labels",
  sprint: "sprint",
  parent: "parent",
  resolution: "resolution",
  key: "key",
  issuekey: "key",
  id: "key",
  summary: "summary",
  description: "description",
  comment: "comment",
  text: "text",
  created: "created",
  createddate: "created",
  updated: "updated",
  updateddate: "updated",
  resolved: "resolved",
  resolutiondate: "resolved",
  duedate: "duedate",
  due: "duedate",
});
const SPRINT_FUNCTIONS = new Map([
  ["opensprints", "active"],
  ["futuresprints", "future"],
  ["closedsprints", "closed"],
]);
/** Caller-chosen field name → canonical field, or undefined; own properties only (`constructor`, `__proto__` miss). */
function canonicalField(name) {
  const lower = name.toLowerCase();
  return Object.hasOwn(FIELD_ALIASES, lower) ? FIELD_ALIASES[lower] : undefined;
}
const SORT_FIELDS = new Set(["created", "updated", "priority", "key", "status", "summary", "duedate", "assignee", "resolved"]);
const DATE_FORMATS = "'yyyy/MM/dd HH:mm', 'yyyy-MM-dd HH:mm', 'yyyy/MM/dd', 'yyyy-MM-dd', or a period format e.g. '-5d', '4w 2d'";
const DAY = 86_400_000;
const MAX_NESTING = 64;

// ---------------------------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------------------------

function tokenize(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(" || char === ")" || char === ",") {
      tokens.push({ type: char, value: char, position: index });
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let value = "";
      let cursor = index + 1;
      let closed = false;
      while (cursor < text.length) {
        const next = text[cursor];
        if (next === "\\" && cursor + 1 < text.length) {
          value += text[cursor + 1];
          cursor += 2;
          continue;
        }
        if (next === char) {
          closed = true;
          break;
        }
        value += next;
        cursor += 1;
      }
      if (!closed) throw new JqlError(`Error in the JQL Query: The quoted string '${value}' has not been completed.`);
      tokens.push({ type: "string", value, position: index });
      index = cursor + 1;
      continue;
    }
    // Sticky regexes match in place: no per-token copy of the remaining query text.
    const operatorPattern = /(!=|!~|>=|<=|=|>|<|~|&&|\|\||!)/y;
    operatorPattern.lastIndex = index;
    const operator = operatorPattern.exec(text);
    if (operator !== null) {
      const value = operator[1] === "&&" ? "and" : operator[1] === "||" ? "or" : operator[1] === "!" ? "not" : operator[1];
      tokens.push({ type: value === "and" || value === "or" || value === "not" ? "word" : "op", value, position: index });
      index += operator[1].length;
      continue;
    }
    const wordPattern = /[^\s()=!<>~,"']+/y;
    wordPattern.lastIndex = index;
    const word = wordPattern.exec(text);
    if (word === null) throw new JqlError(`Error in the JQL Query: Unexpected character '${char}' at position ${String(index + 1)}.`);
    tokens.push({ type: "word", value: word[0], position: index });
    index += word[0].length;
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser → AST
// ---------------------------------------------------------------------------------------------

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
    this.depth = 0;
  }
  /** Parentheses and NOT recurse; a caller-chosen depth must not exhaust the stack. */
  enter() {
    this.depth += 1;
    if (this.depth > MAX_NESTING) throw new JqlError(`Error in the JQL Query: The query nests parentheses or NOT more than ${String(MAX_NESTING)} levels deep.`);
  }
  peek(offset = 0) {
    return this.tokens[this.index + offset];
  }
  next() {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }
  isKeyword(token, keyword) {
    return token !== undefined && token.type === "word" && token.value.toLowerCase() === keyword;
  }
  describe(token) {
    return token === undefined ? "the end of the query" : `'${token.value}'`;
  }
  expectKeyword(keyword) {
    const token = this.next();
    if (!this.isKeyword(token, keyword)) throw new JqlError(`Error in the JQL Query: Expecting '${keyword.toUpperCase()}' but got ${this.describe(token)}.`);
  }
  parseQuery() {
    let where = null;
    if (this.peek() !== undefined && !this.isKeyword(this.peek(), "order")) where = this.parseOr();
    let orderBy = [];
    if (this.isKeyword(this.peek(), "order")) {
      this.next();
      this.expectKeyword("by");
      orderBy = this.parseOrderBy();
    }
    if (this.peek() !== undefined) throw new JqlError(`Error in the JQL Query: Expecting the end of the query but got ${this.describe(this.peek())}.`);
    return { where, orderBy };
  }
  parseOrderBy() {
    const entries = [];
    for (;;) {
      const token = this.next();
      if (token === undefined || token.type !== "word") throw new JqlError(`Error in the JQL Query: Expecting a field name after ORDER BY but got ${this.describe(token)}.`);
      let direction = "ASC";
      if (this.isKeyword(this.peek(), "asc") || this.isKeyword(this.peek(), "desc")) direction = this.next().value.toUpperCase();
      entries.push({ field: token.value, direction });
      if (this.peek() !== undefined && this.peek().type === ",") {
        this.next();
        continue;
      }
      return entries;
    }
  }
  parseOr() {
    let left = this.parseAnd();
    while (this.isKeyword(this.peek(), "or")) {
      this.next();
      left = { kind: "or", left, right: this.parseAnd() };
    }
    return left;
  }
  parseAnd() {
    let left = this.parseNot();
    while (this.isKeyword(this.peek(), "and")) {
      this.next();
      left = { kind: "and", left, right: this.parseNot() };
    }
    return left;
  }
  parseNot() {
    if (this.isKeyword(this.peek(), "not")) {
      this.next();
      this.enter();
      const operand = this.parseNot();
      this.depth -= 1;
      return { kind: "not", operand };
    }
    return this.parsePrimary();
  }
  parsePrimary() {
    const token = this.peek();
    if (token === undefined) throw new JqlError("Error in the JQL Query: Expecting a field name but got the end of the query.");
    if (token.type === "(") {
      this.next();
      this.enter();
      const inner = this.parseOr();
      const close = this.next();
      if (close === undefined || close.type !== ")") throw new JqlError(`Error in the JQL Query: Expecting ')' but got ${this.describe(close)}.`);
      this.depth -= 1;
      return inner;
    }
    return this.parseClause();
  }
  parseClause() {
    const fieldToken = this.next();
    if (fieldToken.type !== "word" && fieldToken.type !== "string") {
      throw new JqlError(`Error in the JQL Query: Expecting a field name but got ${this.describe(fieldToken)}.`);
    }
    if (fieldToken.type === "word" && KEYWORDS.has(fieldToken.value.toLowerCase())) {
      throw new JqlError(`Error in the JQL Query: Expecting a field name but got ${this.describe(fieldToken)}.`);
    }
    const field = fieldToken.value;
    const token = this.next();
    if (token === undefined) throw new JqlError(`Error in the JQL Query: Expecting an operator after '${field}' but got the end of the query.`);
    if (token.type === "word") {
      const keyword = token.value.toLowerCase();
      if (HISTORY.has(keyword)) throw new JqlError(`The JQL construct '${keyword}' is not supported by this Tool.`);
      if (keyword === "is") {
        let negated = false;
        if (this.isKeyword(this.peek(), "not")) {
          this.next();
          negated = true;
        }
        const value = this.next();
        if (!this.isKeyword(value, "empty") && !this.isKeyword(value, "null")) {
          throw new JqlError(`Error in the JQL Query: Expecting 'EMPTY' after 'IS' but got ${this.describe(value)}.`);
        }
        return { kind: "clause", field, operator: negated ? "is not" : "is", values: [{ kind: "empty" }] };
      }
      if (keyword === "not" && this.isKeyword(this.peek(), "in")) {
        this.next();
        return { kind: "clause", field, operator: "not in", values: this.parseList() };
      }
      if (keyword === "in") return { kind: "clause", field, operator: "in", values: this.parseList() };
      throw new JqlError(`Error in the JQL Query: Expecting an operator but got ${this.describe(token)}.`);
    }
    if (token.type !== "op") throw new JqlError(`Error in the JQL Query: Expecting an operator but got ${this.describe(token)}.`);
    return { kind: "clause", field, operator: token.value, values: [this.parseValue()] };
  }
  parseList() {
    if (this.peek() !== undefined && this.peek().type === "(") {
      this.next();
      const values = [];
      for (;;) {
        values.push(this.parseValue());
        const separator = this.next();
        if (separator === undefined) throw new JqlError("Error in the JQL Query: Expecting ')' but got the end of the query.");
        if (separator.type === ",") continue;
        if (separator.type === ")") return values;
        throw new JqlError(`Error in the JQL Query: Expecting ',' or ')' but got ${this.describe(separator)}.`);
      }
    }
    const single = this.parseValue();
    if (single.kind !== "function") throw new JqlError("Error in the JQL Query: Expecting '(' after 'IN' but got a single value.");
    return [single];
  }
  parseValue() {
    const token = this.next();
    if (token === undefined) throw new JqlError("Error in the JQL Query: Expecting a value but got the end of the query.");
    if (token.type === "string") return { kind: "literal", text: token.value, quoted: true };
    if (token.type !== "word") throw new JqlError(`Error in the JQL Query: Expecting a value but got ${this.describe(token)}.`);
    const lower = token.value.toLowerCase();
    if (this.peek() !== undefined && this.peek().type === "(") {
      this.next();
      const args = [];
      if (this.peek() !== undefined && this.peek().type === ")") {
        this.next();
        return { kind: "function", name: token.value, args };
      }
      for (;;) {
        const arg = this.next();
        if (arg === undefined || (arg.type !== "word" && arg.type !== "string")) throw new JqlError(`Error in the JQL Query: Invalid argument for function '${token.value}'.`);
        args.push(arg.value);
        const separator = this.next();
        if (separator !== undefined && separator.type === ",") continue;
        if (separator !== undefined && separator.type === ")") return { kind: "function", name: token.value, args };
        throw new JqlError(`Error in the JQL Query: Expecting ')' to close function '${token.value}'.`);
      }
    }
    if (lower === "empty" || lower === "null") return { kind: "empty" };
    if (KEYWORDS.has(lower)) throw new JqlError(`Error in the JQL Query: Expecting a value but got ${this.describe(token)}.`);
    return { kind: "literal", text: token.value, quoted: false };
  }
}

export function parseJql(text) {
  // The HTTP layer decodes malformed percent-encoding to U+FFFD; that is a mangled query, never a value to search for.
  const mangled = text.indexOf("�");
  if (mangled !== -1) {
    throw new JqlError(`Error in the JQL Query: The character at position ${String(mangled + 1)} is not valid (malformed character encoding).`);
  }
  return new Parser(tokenize(text)).parseQuery();
}

// ---------------------------------------------------------------------------------------------
// Value resolution helpers
// ---------------------------------------------------------------------------------------------

function unknownValue(field, value) {
  return new JqlError(`The value '${value}' does not exist for the field '${field}'.`);
}

function operatorNotSupported(field, operator) {
  return new JqlError(`The operator '${operator}' is not supported by the '${field}' field.`);
}

function requireLiteral(field, value) {
  if (value.kind === "function") throw new JqlError(`The JQL function '${value.name}' is not supported by the '${field}' field.`);
  if (value.kind === "empty") throw emptyNotSupported(field);
  return value.text;
}

/** Jira's validation for a field that has no empty state (key, status, issuetype, statusCategory, text search). */
function emptyNotSupported(field) {
  return new JqlError(`The field '${field}' does not support searching for EMPTY values.`);
}

/** Ordered comparisons (`>`, `<`, …) have no meaning against EMPTY. */
function emptyNotOrdered(field, operator) {
  return new JqlError(`The operator '${operator}' does not support searching for EMPTY values on the field '${field}'.`);
}

function fold(value) {
  return String(value).toLowerCase();
}

const EQUALITY = new Set(["=", "!=", "in", "not in"]);
const NULLABLE = new Set(["=", "!=", "in", "not in", "is", "is not"]);
const ORDERED = new Set(["=", "!=", "in", "not in", ">", ">=", "<", "<="]);
const ORDERED_NULLABLE = new Set([...ORDERED, "is", "is not"]);
const DATES = new Set(["=", "!=", ">", ">=", "<", "<=", "is", "is not"]);
const TEXT = new Set(["~", "!~"]);
const TEXT_NULLABLE = new Set(["~", "!~", "is", "is not"]);

function listContains(set, value) {
  return value !== null && value !== undefined && set.has(value);
}

/** Predicate for `=`, `!=`, `in`, `not in`, `is`, `is not` over a scalar accessor. `!=`/`not in` exclude empties (Jira). */
function scalarPredicate(operator, resolved, get) {
  const set = new Set(resolved.filter((entry) => entry !== null));
  const wantsEmpty = resolved.some((entry) => entry === null);
  switch (operator) {
    case "=":
    case "in":
      return (issue) => {
        const value = get(issue);
        return (wantsEmpty && (value === null || value === undefined)) || listContains(set, value);
      };
    case "!=":
    case "not in":
      return (issue) => {
        const value = get(issue);
        if (value === null || value === undefined) return false;
        return !set.has(value);
      };
    case "is":
      return (issue) => get(issue) === null || get(issue) === undefined;
    case "is not":
      return (issue) => get(issue) !== null && get(issue) !== undefined;
    default:
      return () => false;
  }
}

function textTokens(text) {
  return fold(text).match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function textMatches(haystack, needle) {
  const words = textTokens(haystack);
  const terms = needle.split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return false;
  return terms.every((rawTerm) => {
    const prefix = rawTerm.endsWith("*");
    const term = textTokens(prefix ? rawTerm.slice(0, -1) : rawTerm).join("");
    if (term.length === 0) return false;
    return words.some((word) => (prefix ? word.startsWith(term) : word === term));
  });
}

function startOfUtcDay(ms) {
  return ms - (((ms % DAY) + DAY) % DAY);
}

const PERIOD_UNITS = { m: 60_000, h: 3_600_000, d: DAY, w: 7 * DAY };
const MAX_PERIOD_TERMS = 8;

/**
 * A Jira period ('-5d', '4w 2d', '1w 3d 4h 30m', '4w2d') → signed milliseconds, or `undefined` when the text is not
 * a period. Mirrors Jira's duration parser: an optional leading sign applies to the whole period, each term is 1–6
 * digits followed by one of m/h/d/w, terms are separated by optional whitespace, and units may repeat (they sum).
 * Hand-tokenised in one linear pass so caller text never drives a backtracking regular expression.
 */
function relativeMs(text) {
  const raw = text.trim();
  let index = 0;
  let sign = 1;
  if (raw[0] === "-" || raw[0] === "+") {
    sign = raw[0] === "-" ? -1 : 1;
    index = 1;
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
  }
  if (index >= raw.length) return undefined;
  let total = 0;
  let terms = 0;
  while (index < raw.length) {
    const start = index;
    while (index < raw.length && raw[index] >= "0" && raw[index] <= "9") index += 1;
    const digits = index - start;
    if (digits === 0 || digits > 6) return undefined;
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    const letter = (raw[index] ?? "").toLowerCase();
    const unit = Object.hasOwn(PERIOD_UNITS, letter) ? PERIOD_UNITS[letter] : undefined;
    if (unit === undefined) return undefined;
    index += 1;
    terms += 1;
    if (terms > MAX_PERIOD_TERMS) return undefined;
    total += Number(raw.slice(start, start + digits)) * unit;
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
  }
  return sign * total;
}

function dateError(field, value) {
  return new JqlError(`Date value '${value}' for field '${field}' is invalid. Valid formats include: ${DATE_FORMATS}.`);
}

/** A date value → `{ start, end }` (exclusive end; `exact` when the value has a time component). */
function resolveDate(field, value, env) {
  if (value.kind === "empty") throw new JqlError(`The value 'EMPTY' is not valid for the operator used on '${field}'.`);
  if (value.kind === "function") {
    const name = value.name.toLowerCase();
    const offset = value.args.length === 0 ? 0 : relativeMs(value.args[0]);
    if (value.args.length > 1 || offset === undefined) throw new JqlError(`Invalid argument for JQL function '${value.name}'.`);
    const now = env.nowMs;
    const dayStart = startOfUtcDay(now);
    const weekday = (new Date(dayStart).getUTCDay() + 6) % 7;
    const weekStart = dayStart - weekday * DAY;
    switch (name) {
      case "now":
        return { start: now + offset, end: now + offset, exact: true };
      case "startofday":
        return { start: dayStart + offset, end: dayStart + offset, exact: true };
      case "endofday":
        return { start: dayStart + DAY - 1 + offset, end: dayStart + DAY - 1 + offset, exact: true };
      case "startofweek":
        return { start: weekStart + offset, end: weekStart + offset, exact: true };
      case "endofweek":
        return { start: weekStart + 7 * DAY - 1 + offset, end: weekStart + 7 * DAY - 1 + offset, exact: true };
      default:
        throw new JqlError(`The JQL function '${value.name}' is not supported by this Tool.`);
    }
  }
  const text = value.text.trim();
  const relative = relativeMs(text);
  if (relative !== undefined) return { start: env.nowMs + relative, end: env.nowMs + relative, exact: true };
  const dateTime = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(text);
  if (dateTime === null) throw dateError(field, value.text);
  const [, year, month, day, hour, minute] = dateTime;
  // Date.UTC maps years 0–99 onto 1900–1999; setUTCFullYear keeps the year the caller wrote.
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour ?? 0), Number(minute ?? 0), 0, 0);
  const start = date.getTime();
  if (Number.isNaN(start) || date.getUTCMonth() !== Number(month) - 1 || Number(hour ?? 0) > 23 || Number(minute ?? 0) > 59) throw dateError(field, value.text);
  if (hour !== undefined) return { start, end: start, exact: true };
  return { start, end: start + DAY, exact: false };
}

function datePredicate(field, operator, values, env, get) {
  if (!DATES.has(operator)) throw operatorNotSupported(field, operator);
  if (operator === "is" || (operator === "=" && values[0].kind === "empty")) return (issue) => get(issue) === null;
  if (operator === "is not" || (operator === "!=" && values[0].kind === "empty")) return (issue) => get(issue) !== null;
  if (values[0].kind === "empty") throw emptyNotOrdered(field, operator);
  const range = resolveDate(field, values[0], env);
  return (issue) => {
    const ms = get(issue);
    if (ms === null) return false;
    switch (operator) {
      case "=":
        return range.exact ? ms === range.start : ms >= range.start && ms < range.end;
      case "!=":
        return range.exact ? ms !== range.start : ms < range.start || ms >= range.end;
      case ">":
        return ms > range.start;
      case ">=":
        return ms >= range.start;
      case "<":
        return ms < range.start;
      case "<=":
        return ms <= range.start;
      default:
        return false;
    }
  };
}

function timestampOf(value) {
  const ms = parseTimestamp(value);
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------------------------
// Field compilation
// ---------------------------------------------------------------------------------------------

function resolveUser(field, value, env) {
  if (value.kind === "empty") return null;
  if (value.kind === "function") {
    if (value.name.toLowerCase() === "currentuser" && value.args.length === 0) return env.currentUserId;
    throw new JqlError(`The JQL function '${value.name}' is not supported by this Tool.`);
  }
  const text = value.text;
  const user =
    env.users.find((row) => row.accountId === text) ??
    env.users.find((row) => fold(row.displayName) === fold(text)) ??
    env.users.find((row) => typeof row.emailAddress === "string" && row.emailAddress.length > 0 && fold(row.emailAddress) === fold(text));
  if (user === undefined) throw unknownValue(field, text);
  return user.accountId;
}

function resolveSprints(field, value, env) {
  if (value.kind === "empty") return [null];
  if (value.kind === "function") {
    // A Map, not an object literal: `constructor()` or `__proto__()` must miss, never resolve to an inherited member.
    const state = SPRINT_FUNCTIONS.get(value.name.toLowerCase());
    if (state === undefined || value.args.length > 0) throw new JqlError(`The JQL function '${value.name}' is not supported by this Tool.`);
    const ids = env.sprints.filter((sprint) => sprint.state === state).map((sprint) => sprint.id);
    return ids.length === 0 ? ["__none__"] : ids;
  }
  const text = value.text;
  const sprint = env.sprints.find((row) => row.id === text) ?? env.sprints.find((row) => fold(row.name) === fold(text));
  if (sprint === undefined) throw unknownValue(field, text);
  return [sprint.id];
}

function resolveIssueRef(field, value, env) {
  if (value.kind === "empty") return null;
  const text = requireLiteral(field, value);
  const issue = env.issueByKey(text) ?? env.issueById(text);
  if (issue === null) throw unknownValue(field, text);
  return issue;
}

function keyParts(key) {
  const match = /^([A-Z][A-Z0-9_]*)-(\d+)$/i.exec(key);
  return match === null ? null : { project: match[1].toUpperCase(), number: Number(match[2]) };
}

function compileClause(clause, env) {
  const canonical = canonicalField(clause.field);
  if (canonical === undefined) throw new JqlError(`Field '${clause.field}' does not exist or you do not have permission to view it.`);
  const { operator, values } = clause;
  const field = clause.field;
  switch (canonical) {
    case "project": {
      // Jira: project supports IS/IS NOT and EMPTY; every issue has a project, so EMPTY matches nothing.
      if (!NULLABLE.has(operator)) throw operatorNotSupported(field, operator);
      const ids = values.map((value) => {
        if (value.kind === "empty") return null;
        const text = requireLiteral(field, value);
        const project = env.projects.find((row) => fold(row.key) === fold(text) || row.id === text || fold(row.name) === fold(text));
        if (project === undefined) throw unknownValue(field, text);
        return project.id;
      });
      return scalarPredicate(operator, ids, (issue) => issue.projectId);
    }
    case "issuetype": {
      if (!EQUALITY.has(operator)) throw operatorNotSupported(field, operator);
      const ids = values.map((value) => {
        const text = requireLiteral(field, value);
        const type = env.issueTypes.find((row) => row.id === text || fold(row.name) === fold(text));
        if (type === undefined) throw unknownValue(field, text);
        return type.id;
      });
      return scalarPredicate(operator, ids, (issue) => issue.issueTypeId);
    }
    case "status": {
      if (!EQUALITY.has(operator)) throw operatorNotSupported(field, operator);
      const ids = values.flatMap((value) => {
        const text = requireLiteral(field, value);
        const matches = env.statuses.filter((row) => row.id === text || fold(row.name) === fold(text)).map((row) => row.id);
        if (matches.length === 0) throw unknownValue(field, text);
        return matches;
      });
      return scalarPredicate(operator, ids, (issue) => issue.statusId);
    }
    case "statusCategory": {
      if (!EQUALITY.has(operator)) throw operatorNotSupported(field, operator);
      const ids = values.map((value) => {
        const text = requireLiteral(field, value);
        const category = Object.values(STATUS_CATEGORIES).find(
          (row) => String(row.id) === text || fold(row.key) === fold(text) || fold(row.name) === fold(text),
        );
        if (category === undefined) throw unknownValue(field, text);
        return category.id;
      });
      return scalarPredicate(operator, ids, (issue) => env.statusCategoryOf(issue.statusId));
    }
    case "priority": {
      if (!ORDERED_NULLABLE.has(operator)) throw operatorNotSupported(field, operator);
      const ordered = [...env.priorities].sort((left, right) => Number(left.id) - Number(right.id));
      const rank = (id) => {
        const index = ordered.findIndex((row) => row.id === id);
        return index === -1 ? 0 : ordered.length - index;
      };
      const comparison = !EQUALITY.has(operator) && operator !== "is" && operator !== "is not";
      const ids = values.map((value) => {
        if (value.kind === "empty") {
          if (comparison) throw emptyNotOrdered(field, operator);
          return null;
        }
        const text = requireLiteral(field, value);
        const priority = ordered.find((row) => row.id === text || fold(row.name) === fold(text));
        if (priority === undefined) throw unknownValue(field, text);
        return priority.id;
      });
      if (!comparison) return scalarPredicate(operator, ids, (issue) => issue.priorityId);
      const target = rank(ids[0]);
      return (issue) => {
        const own = rank(issue.priorityId);
        return operator === ">" ? own > target : operator === ">=" ? own >= target : operator === "<" ? own < target : own <= target;
      };
    }
    case "assignee":
    case "reporter":
    case "creator": {
      if (!NULLABLE.has(operator)) throw operatorNotSupported(field, operator);
      const ids = values.map((value) => resolveUser(field, value, env));
      const key = { assignee: "assigneeAccountId", reporter: "reporterAccountId", creator: "creatorAccountId" }[canonical];
      return scalarPredicate(operator, ids, (issue) => issue[key]);
    }
    case "labels": {
      if (!NULLABLE.has(operator)) throw operatorNotSupported(field, operator);
      const labels = values.map((value) => (value.kind === "empty" ? null : requireLiteral(field, value)));
      const set = new Set(labels.filter((label) => label !== null));
      switch (operator) {
        case "=":
        case "in":
          return (issue) => issue.labels.some((label) => set.has(label)) || (labels.includes(null) && issue.labels.length === 0);
        case "!=":
        case "not in":
          return (issue) => issue.labels.length > 0 && !issue.labels.some((label) => set.has(label));
        case "is":
          return (issue) => issue.labels.length === 0;
        default:
          return (issue) => issue.labels.length > 0;
      }
    }
    case "sprint": {
      if (!NULLABLE.has(operator)) throw operatorNotSupported(field, operator);
      const ids = values.flatMap((value) => resolveSprints(field, value, env));
      return scalarPredicate(operator, ids, (issue) => issue.sprintId);
    }
    case "parent": {
      if (!NULLABLE.has(operator)) throw operatorNotSupported(field, operator);
      const ids = values.map((value) => {
        const issue = resolveIssueRef(field, value, env);
        return issue === null ? null : issue.id;
      });
      return scalarPredicate(operator, ids, (issue) => issue.parentId);
    }
    case "resolution": {
      if (!NULLABLE.has(operator)) throw operatorNotSupported(field, operator);
      const ids = values.map((value) => {
        if (value.kind === "empty") return null;
        const text = requireLiteral(field, value);
        if (fold(text) === "unresolved") return null;
        const resolution = RESOLUTIONS.find((row) => row.id === text || fold(row.name) === fold(text));
        if (resolution === undefined) throw unknownValue(field, text);
        return resolution.id;
      });
      return scalarPredicate(operator, ids, (issue) => issue.resolutionId);
    }
    case "key": {
      // Jira: issue key supports = != > >= < <= IN NOT IN and has no empty state, so EMPTY/NULL in any
      // position (`key = EMPTY`, `key in (SFR-1, null)`, `key > null`) is a validation error, never a match.
      if (!ORDERED.has(operator)) throw operatorNotSupported(field, operator);
      if (values.some((value) => value.kind === "empty")) throw emptyNotSupported(field);
      const refs = values.map((value) => resolveIssueRef(field, value, env));
      if (EQUALITY.has(operator)) return scalarPredicate(operator, refs.map((ref) => ref.id), (issue) => issue.id);
      const target = keyParts(refs[0].key);
      return (issue) => {
        const own = keyParts(issue.key);
        if (own === null || target === null || own.project !== target.project) return false;
        return operator === ">" ? own.number > target.number : operator === ">=" ? own.number >= target.number : operator === "<" ? own.number < target.number : own.number <= target.number;
      };
    }
    case "summary":
    case "description":
    case "comment":
    case "text": {
      // Jira: summary and description also support IS/IS NOT EMPTY; comment and text search do not.
      const nullable = canonical === "summary" || canonical === "description";
      if (!(nullable ? TEXT_NULLABLE : TEXT).has(operator)) throw operatorNotSupported(field, operator);
      if (operator === "is" || operator === "is not") {
        const blank = canonical === "summary" ? (issue) => issue.summary.trim().length === 0 : (issue) => env.descriptionText(issue).length === 0;
        return operator === "is" ? blank : (issue) => !blank(issue);
      }
      const needle = requireLiteral(field, values[0]);
      const source = {
        summary: (issue) => issue.summary,
        description: (issue) => env.descriptionText(issue),
        comment: (issue) => env.commentText(issue),
        text: (issue) => `${issue.summary}\n${env.descriptionText(issue)}\n${env.commentText(issue)}`,
      }[canonical];
      return (issue) => (operator === "~" ? textMatches(source(issue), needle) : !textMatches(source(issue), needle));
    }
    case "created":
      return datePredicate(field, operator, values, env, (issue) => timestampOf(issue.created));
    case "updated":
      return datePredicate(field, operator, values, env, (issue) => timestampOf(issue.updated));
    case "resolved":
      return datePredicate(field, operator, values, env, (issue) => (issue.resolutionDate === null ? null : timestampOf(issue.resolutionDate)));
    case "duedate":
      return datePredicate(field, operator, values, env, (issue) => (issue.dueDate === null ? null : timestampOf(`${issue.dueDate}T00:00:00.000Z`)));
    default:
      throw new JqlError(`Field '${field}' does not exist or you do not have permission to view it.`);
  }
}

function compileNode(node, env) {
  switch (node.kind) {
    case "and": {
      const left = compileNode(node.left, env);
      const right = compileNode(node.right, env);
      return (issue) => left(issue) && right(issue);
    }
    case "or": {
      const left = compileNode(node.left, env);
      const right = compileNode(node.right, env);
      return (issue) => left(issue) || right(issue);
    }
    case "not": {
      const operand = compileNode(node.operand, env);
      return (issue) => !operand(issue);
    }
    default:
      return compileClause(node, env);
  }
}

// ---------------------------------------------------------------------------------------------
// ORDER BY
// ---------------------------------------------------------------------------------------------

function compareNullable(left, right, compare) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return compare(left, right);
}

function sortKey(field, env) {
  switch (field) {
    case "created":
      return { get: (issue) => timestampOf(issue.created), compare: (a, b) => a - b };
    case "updated":
      return { get: (issue) => timestampOf(issue.updated), compare: (a, b) => a - b };
    case "resolved":
      return { get: (issue) => (issue.resolutionDate === null ? null : timestampOf(issue.resolutionDate)), compare: (a, b) => a - b };
    case "duedate":
      return { get: (issue) => (issue.dueDate === null ? null : timestampOf(`${issue.dueDate}T00:00:00.000Z`)), compare: (a, b) => a - b };
    case "priority": {
      const ordered = [...env.priorities].sort((left, right) => Number(left.id) - Number(right.id));
      return { get: (issue) => ordered.length - ordered.findIndex((row) => row.id === issue.priorityId), compare: (a, b) => a - b };
    }
    case "key":
      return {
        get: (issue) => keyParts(issue.key) ?? { project: issue.key, number: 0 },
        compare: (a, b) => compareStrings(a.project, b.project) || a.number - b.number,
      };
    case "status":
      return { get: (issue) => env.statusName(issue.statusId), compare: compareFold };
    case "summary":
      return { get: (issue) => issue.summary, compare: compareFold };
    case "assignee":
      return { get: (issue) => (issue.assigneeAccountId === null ? null : env.userName(issue.assigneeAccountId)), compare: compareFold };
    default:
      return null;
  }
}

function compileOrder(entries, env) {
  const keys = (entries.length === 0 ? [{ field: "created", direction: "DESC" }] : entries).map((entry) => {
    const canonical = canonicalField(entry.field);
    if (canonical === undefined || !SORT_FIELDS.has(canonical)) throw new JqlError(`Not able to sort using field '${entry.field}'.`);
    return { ...sortKey(canonical, env), sign: entry.direction === "DESC" ? -1 : 1 };
  });
  return (left, right) => {
    for (const key of keys) {
      const a = key.get(left);
      const b = key.get(right);
      const nulls = a === null || b === null ? compareNullable(a, b, () => 0) : 0;
      if (nulls !== 0) return nulls;
      if (a !== null && b !== null) {
        const result = key.compare(a, b);
        if (result !== 0) return result * key.sign;
      }
    }
    return Number(left.id) - Number(right.id);
  };
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** Whitespace-normalised query text (the identity a page token is bound to). */
export function normalizeJql(text) {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Compile a query against `env` → `{ predicate, comparator }`. Throws JqlError for anything outside
 * the documented subset; value resolution happens here, before any issue is evaluated.
 */
export function compileJql(text, env) {
  const ast = parseJql(text);
  const predicate = ast.where === null ? () => true : compileNode(ast.where, env);
  const comparator = compileOrder(ast.orderBy, env);
  return { predicate, comparator };
}
