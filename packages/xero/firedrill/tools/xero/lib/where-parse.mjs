// Xero `where` expressions: hand-written tokenizer and bounded recursive-descent parser. No regular expressions over
// caller text. Limits: 2,000 characters, 50 comparisons, nesting depth 10. Errors call `fail(message)`.

const MAX_LENGTH = 2000;
const MAX_COMPARISONS = 50;
const MAX_DEPTH = 10;
const METHODS = new Set(["Contains", "StartsWith", "EndsWith"]);

const isDigit = (c) => c >= 48 && c <= 57;
const isIdentStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isIdent = (c) => isIdentStart(c) || isDigit(c);

export function tokenize(text, fail) {
  if (text.length > MAX_LENGTH) fail(`where expression exceeds ${MAX_LENGTH} characters`);
  if (text.includes("�")) fail("where expression contains an invalid character (malformed encoding)");
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i += 1;
      continue;
    }
    const start = i;
    if (isIdentStart(c)) {
      while (i < text.length && isIdent(text.charCodeAt(i))) i += 1;
      tokens.push({ t: "ident", v: text.slice(start, i), at: start });
    } else if (isDigit(c) || (c === 45 && i + 1 < text.length && isDigit(text.charCodeAt(i + 1)))) {
      i += 1;
      while (i < text.length && isDigit(text.charCodeAt(i))) i += 1;
      if (text[i] === "." && i + 1 < text.length && isDigit(text.charCodeAt(i + 1))) {
        i += 1;
        while (i < text.length && isDigit(text.charCodeAt(i))) i += 1;
      }
      const value = Number(text.slice(start, i));
      if (!Number.isFinite(value) || i - start > 24) fail(`invalid number at position ${start}`);
      tokens.push({ t: "num", v: value, at: start });
    } else if (c === 34) {
      i += 1;
      let value = "";
      for (;;) {
        if (i >= text.length) fail(`unterminated string starting at position ${start}`);
        const ch = text[i];
        if (ch === "\\") {
          const next = text[i + 1];
          if (next !== '"' && next !== "\\") fail(`invalid escape in string at position ${i}`);
          value += next;
          i += 2;
        } else if (ch === '"') {
          i += 1;
          break;
        } else {
          value += ch;
          i += 1;
        }
      }
      tokens.push({ t: "str", v: value, at: start });
    } else {
      const two = text.slice(i, i + 2);
      if (two === "==" || two === "!=" || two === ">=" || two === "<=" || two === "&&" || two === "||") {
        tokens.push({ t: "op", v: two, at: start });
        i += 2;
      } else if ("<>!().,".includes(text[i])) {
        tokens.push({ t: "op", v: text[i], at: start });
        i += 1;
      } else fail(`unexpected character '${text[i]}' at position ${start}`);
    }
  }
  return tokens;
}

/** Parse a where expression into an AST: or/and/not/cmp/method/null nodes. */
export function parseWhere(text, fail) {
  const tokens = tokenize(text, fail);
  if (tokens.length === 0) fail("where expression is empty");
  let pos = 0;
  let comparisons = 0;
  const peek = () => tokens[pos];
  const at = () => (pos < tokens.length ? tokens[pos].at : text.length);
  const isOp = (v) => pos < tokens.length && tokens[pos].t === "op" && tokens[pos].v === v;
  const isWord = (word) => pos < tokens.length && tokens[pos].t === "ident" && tokens[pos].v.toUpperCase() === word;
  const expect = (v) => {
    if (!isOp(v)) fail(`expected '${v}' at position ${at()}`);
    pos += 1;
  };

  function literal() {
    const token = peek();
    if (token === undefined) fail("expected a value at end of expression");
    if (token.t === "str") return (pos += 1), { type: "string", v: token.v };
    if (token.t === "num") return (pos += 1), { type: "number", v: token.v };
    if (token.t === "ident") {
      const word = token.v;
      if (word === "true" || word === "false") return (pos += 1), { type: "boolean", v: word === "true" };
      if (word === "null") return (pos += 1), { type: "null", v: null };
      if (word === "Guid" || word === "guid") {
        pos += 1;
        expect("(");
        const inner = peek();
        if (inner === undefined || inner.t !== "str") fail(`guid() expects a quoted value at position ${at()}`);
        pos += 1;
        expect(")");
        return { type: "guid", v: inner.v };
      }
      if (word === "DateTime") {
        pos += 1;
        expect("(");
        const parts = [];
        for (;;) {
          const n = peek();
          if (n === undefined || n.t !== "num" || !Number.isInteger(n.v) || n.v < 0) fail(`DateTime() expects integers at position ${at()}`);
          parts.push(n.v);
          pos += 1;
          if (isOp(")")) break;
          expect(",");
          if (parts.length >= 6) fail(`DateTime() takes 3 or 6 arguments (position ${at()})`);
        }
        pos += 1;
        if (parts.length !== 3 && parts.length !== 6) fail("DateTime() takes 3 or 6 arguments");
        return { type: "datetime", v: parts };
      }
    }
    return fail(`expected a value at position ${token.at}`);
  }

  function comparison() {
    const token = peek();
    if (token === undefined || token.t !== "ident") fail(`expected a field name at position ${at()}`);
    const segments = [token.v];
    pos += 1;
    while (isOp(".")) {
      pos += 1;
      const next = peek();
      if (next === undefined || next.t !== "ident") fail(`expected a name after '.' at position ${at()}`);
      segments.push(next.v);
      pos += 1;
    }
    if (isOp("(")) {
      const method = segments.pop();
      if (!METHODS.has(method) || segments.length === 0) fail(`method '${method}' is not supported (position ${token.at})`);
      pos += 1;
      const arg = peek();
      if (arg === undefined || arg.t !== "str") fail(`${method}() expects a quoted string at position ${at()}`);
      pos += 1;
      expect(")");
      comparisons += 1;
      return { kind: "method", path: segments.join("."), method, text: arg.v, at: token.at };
    }
    const op = peek();
    if (op === undefined || op.t !== "op" || !["==", "!=", ">", ">=", "<", "<="].includes(op.v)) fail(`expected a comparison operator at position ${at()}`);
    pos += 1;
    comparisons += 1;
    return { kind: "cmp", path: segments.join("."), op: op.v, value: literal(), at: token.at };
  }

  function factor(depth) {
    if (depth > MAX_DEPTH) fail(`where expression nesting exceeds ${MAX_DEPTH} levels`);
    if (comparisons > MAX_COMPARISONS) fail(`where expression exceeds ${MAX_COMPARISONS} comparisons`);
    if (isOp("!") || isWord("NOT")) {
      pos += 1;
      return { kind: "not", item: factor(depth + 1) };
    }
    if (isOp("(")) {
      pos += 1;
      const inner = expression(depth + 1);
      expect(")");
      return inner;
    }
    return comparison();
  }

  function term(depth) {
    const items = [factor(depth)];
    while (isOp("&&") || isWord("AND")) {
      pos += 1;
      items.push(factor(depth));
    }
    return items.length === 1 ? items[0] : { kind: "and", items };
  }

  function expression(depth) {
    const items = [term(depth)];
    while (isOp("||") || isWord("OR")) {
      pos += 1;
      items.push(term(depth));
    }
    return items.length === 1 ? items[0] : { kind: "or", items };
  }

  const ast = expression(0);
  if (comparisons > MAX_COMPARISONS) fail(`where expression exceeds ${MAX_COMPARISONS} comparisons`);
  if (pos < tokens.length) fail(`unexpected '${tokens[pos].v}' at position ${tokens[pos].at}`);
  return ast;
}
