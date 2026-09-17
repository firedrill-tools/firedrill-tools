// QuickBooks query language: hand-written tokenizer and parser (no regular expressions over caller text).
// select (* | count(*) | prop[, prop]) from Entity [where cond (and cond)*] [orderby prop [asc|desc], …]
// [startposition n] [maxresults n]. Failures raise QUERY_PARSE_ERROR with QuickBooks' parser wording.

export const MAX_QUERY_LENGTH = 20000;
const MAX_CONDITIONS = 20;
const MAX_IN_VALUES = 100;
const MAX_SORT_KEYS = 3;

function isLetter(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}
function isDigit(code) {
  return code >= 48 && code <= 57;
}

/** Tokens: { type: "word" | "string" | "number" | "punct", value, column }. */
export function tokenize(text, parseFail) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    const column = i + 1;
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      i += 1;
    } else if (code === 0xfffd) {
      parseFail(`QueryParserError: Invalid character in query at line 1, column ${column}.`);
    } else if (isLetter(code)) {
      let j = i + 1;
      while (j < text.length) {
        const c = text.charCodeAt(j);
        if (isLetter(c) || isDigit(c) || c === 46) j += 1;
        else break;
      }
      tokens.push({ type: "word", value: text.slice(i, j), column });
      i = j;
    } else if (isDigit(code) || (code === 45 && i + 1 < text.length && isDigit(text.charCodeAt(i + 1)))) {
      let j = i + 1;
      while (j < text.length && (isDigit(text.charCodeAt(j)) || text.charCodeAt(j) === 46)) j += 1;
      tokens.push({ type: "number", value: text.slice(i, j), column });
      i = j;
    } else if (code === 39) {
      let value = "";
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        const c = text.charCodeAt(j);
        if (c === 92 && j + 1 < text.length) {
          value += text[j + 1];
          j += 2;
        } else if (c === 39) {
          closed = true;
          j += 1;
          break;
        } else {
          value += text[j];
          j += 1;
        }
      }
      if (!closed) parseFail(`QueryParserError: Lexical error at line 1, column ${text.length + 1}.  Encountered: <EOF> after : "'"`);
      tokens.push({ type: "string", value, column });
      i = j;
    } else {
      const two = text.slice(i, i + 2);
      if (two === "<=" || two === ">=" || two === "!=" || two === "<>") {
        tokens.push({ type: "punct", value: two, column });
        i += 2;
      } else if ("=<>(),*".includes(text[i])) {
        tokens.push({ type: "punct", value: text[i], column });
        i += 1;
      } else {
        parseFail(`QueryParserError: Lexical error at line 1, column ${column}.  Encountered: "${text[i]}"`);
      }
    }
  }
  return tokens;
}

const KEYWORDS = new Set(["select", "from", "where", "and", "or", "not", "orderby", "asc", "desc", "startposition", "maxresults", "in", "like", "count"]);

/** Parse query text into { entity, select, where, order, start, max }. */
export function parseQuery(text, parseFail) {
  if (typeof text !== "string" || text.trim().length === 0) parseFail("QueryParserError: Encountered \"<EOF>\" at line 1, column 1.");
  if (text.length > MAX_QUERY_LENGTH) parseFail(`QueryParserError: Query exceeds the supported length of ${MAX_QUERY_LENGTH} characters.`);
  const mangled = text.indexOf("\uFFFD");
  if (mangled >= 0) parseFail(`QueryParserError: Invalid character in query at line 1, column ${mangled + 1}.`);
  const tokens = tokenize(text, parseFail);
  let at = 0;
  const peek = () => tokens[at];
  const lower = (token) => (token !== undefined && token.type === "word" ? token.value.toLowerCase() : null);
  const unexpected = (token) => {
    if (token === undefined) return parseFail(`QueryParserError: Encountered " <EOF> "" at line 1, column ${text.length + 1}.`);
    const kind = token.type === "string" ? "<STRING>" : token.type === "number" ? "<INTEGER>" : token.type === "word" ? "<IDENTIFIER>" : token.value;
    return parseFail(`QueryParserError: Encountered " ${kind} "${token.value.slice(0, 64)} "" at line 1, column ${token.column}.`);
  };
  const expectWord = (word) => {
    const token = peek();
    if (lower(token) !== word) unexpected(token);
    at += 1;
  };
  const expectPunct = (value) => {
    const token = peek();
    if (token === undefined || token.type !== "punct" || token.value !== value) unexpected(token);
    at += 1;
  };
  const property = () => {
    const token = peek();
    if (token === undefined || token.type !== "word" || KEYWORDS.has(token.value.toLowerCase())) unexpected(token);
    at += 1;
    return token.value;
  };
  const integer = () => {
    const token = peek();
    if (token === undefined || token.type !== "number" || !isAllDigits(token.value) || token.value.length > 9) unexpected(token);
    at += 1;
    return Number(token.value);
  };

  expectWord("select");
  let select;
  const first = peek();
  if (first !== undefined && first.type === "punct" && first.value === "*") {
    at += 1;
    select = { kind: "all" };
  } else if (lower(first) === "count") {
    at += 1;
    expectPunct("(");
    expectPunct("*");
    expectPunct(")");
    select = { kind: "count" };
  } else {
    const fields = [property()];
    while (peek() !== undefined && peek().type === "punct" && peek().value === ",") {
      at += 1;
      fields.push(property());
      if (fields.length > 100) unexpected(peek());
    }
    select = { kind: "fields", fields };
  }
  expectWord("from");
  const entityToken = peek();
  if (entityToken === undefined || entityToken.type !== "word" || KEYWORDS.has(entityToken.value.toLowerCase())) unexpected(entityToken);
  at += 1;
  const where = [];
  if (lower(peek()) === "where") {
    at += 1;
    where.push(condition());
    while (lower(peek()) === "and") {
      at += 1;
      if (where.length >= MAX_CONDITIONS) parseFail(`QueryParserError: A query supports at most ${MAX_CONDITIONS} conditions.`);
      where.push(condition());
    }
  }
  const order = [];
  if (lower(peek()) === "orderby") {
    at += 1;
    for (;;) {
      const prop = property();
      let dir = "asc";
      if (lower(peek()) === "asc" || lower(peek()) === "desc") {
        dir = lower(peek());
        at += 1;
      }
      order.push({ prop, dir });
      if (peek() === undefined || peek().type !== "punct" || peek().value !== ",") break;
      at += 1;
      if (order.length >= MAX_SORT_KEYS) parseFail(`QueryParserError: A query supports at most ${MAX_SORT_KEYS} sort keys.`);
    }
  }
  let start = 1;
  let max = 100;
  if (lower(peek()) === "startposition") {
    at += 1;
    start = integer();
    if (start < 1) parseFail("QueryParserError: STARTPOSITION must be 1 or greater.");
  }
  if (lower(peek()) === "maxresults") {
    at += 1;
    max = integer();
    if (max < 1 || max > 1000) parseFail("QueryParserError: MAXRESULTS must be between 1 and 1000.");
  }
  if (at < tokens.length) unexpected(peek());
  return { entity: entityToken.value, select, where, order, start, max };

  function condition() {
    const prop = property();
    const token = peek();
    const word = lower(token);
    if (word === "in") {
      at += 1;
      expectPunct("(");
      const values = [literal()];
      while (peek() !== undefined && peek().type === "punct" && peek().value === ",") {
        at += 1;
        if (values.length >= MAX_IN_VALUES) parseFail(`QueryParserError: IN supports at most ${MAX_IN_VALUES} values.`);
        values.push(literal());
      }
      expectPunct(")");
      return { prop, op: "in", values };
    }
    if (word === "like") {
      at += 1;
      return { prop, op: "like", values: [literal()] };
    }
    if (token === undefined || token.type !== "punct" || !["=", "<", ">", "<=", ">="].includes(token.value)) unexpected(token);
    at += 1;
    return { prop, op: token.value, values: [literal()] };
  }

  function literal() {
    const token = peek();
    if (token === undefined) unexpected(token);
    if (token.type === "string" || token.type === "number") {
      at += 1;
      return { kind: token.type, value: token.value };
    }
    const word = lower(token);
    if (word === "true" || word === "false") {
      at += 1;
      return { kind: "bool", value: word === "true" };
    }
    return unexpected(token);
  }
}

function isAllDigits(text) {
  for (let i = 0; i < text.length; i += 1) if (!isDigit(text.charCodeAt(i))) return false;
  return text.length > 0;
}
