// The deliberately tiny, documented Apps Script expression grammar. No caller JavaScript is ever evaluated.
//
// A function body must be exactly one `return <expr>;` statement, where <expr> is a chain of at most 8 terms
// joined by `+`, `-`, `*` or `/`. A term is a JSON literal (a numeric literal may carry a leading minus, so
// `return -1;` and `2 - -3` are valid; `+1`, `- 1` and `--1` are not JSON and are script errors), a parameter
// reference (`p1`…`p10`, or the declared parameter names) or one of the built-ins contactCount(), groupCount()
// and scriptTitle().
//
// Anything else — including any parse failure — is reported as a ScriptError, which is what the real API does
// for a runtime exception: HTTP 200 carrying an ExecutionError.

const MAX_TERMS = 8;
const MAX_SOURCE = 16384;
const MAX_RESULT_BYTES = 65536;

export class ScriptError extends Error {}

const scriptError = (message) => {
  throw new ScriptError(message);
};

/** Extracts the body of `name` from a source file using the same linear scan as the function set. */
export function extractBody(source, name) {
  if (typeof source !== "string" || source.length > MAX_SOURCE) return null;
  const marker = `function ${name}`;
  let index = 0;
  for (;;) {
    const at = source.indexOf(marker, index);
    if (at < 0) return null;
    index = at + marker.length;
    let cursor = index;
    while (cursor < source.length && (source[cursor] === " " || source[cursor] === "\t")) cursor += 1;
    if (source[cursor] !== "(") continue;
    const close = source.indexOf(")", cursor);
    if (close < 0) return null;
    const params = source
      .slice(cursor + 1, close)
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && part.length <= 80)
      .slice(0, 10);
    const open = source.indexOf("{", close);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return { params, body: source.slice(open + 1, i) };
      }
    }
    return null;
  }
}

/** Evaluates the one supported statement. Throws ScriptError for everything outside the grammar. */
export function evaluate(functionName, body, params, args, builtins) {
  const text = body.trim();
  if (text.length === 0) return null;
  if (!text.startsWith("return")) scriptError(`Exception: unsupported statement in ${functionName}`);
  let rest = text.slice("return".length);
  if (rest.length > 0 && /[A-Za-z0-9_$]/.test(rest[0])) scriptError(`Exception: unsupported statement in ${functionName}`);
  rest = rest.trim();
  if (rest.endsWith(";")) rest = rest.slice(0, -1).trim();
  if (rest.includes(";")) scriptError(`Exception: unsupported statement in ${functionName}`);
  if (rest.length === 0) return null;
  if (rest.length > 4096) scriptError(`Exception: expression too long in ${functionName}`);

  const terms = splitTerms(rest, functionName);
  let value = resolveTerm(terms[0].text, functionName, params, args, builtins);
  for (let i = 1; i < terms.length; i += 1) {
    const operand = resolveTerm(terms[i].text, functionName, params, args, builtins);
    value = apply(terms[i].operator, value, operand, functionName);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    scriptError(`Exception: non-finite numeric result in ${functionName}`);
  }
  const encoded = JSON.stringify(value === undefined ? null : value);
  if (typeof encoded === "string" && encoded.length > MAX_RESULT_BYTES) {
    scriptError(`Exception: result of ${functionName} is larger than the supported bound`);
  }
  return value === undefined ? null : value;
}

/** Splits an expression into operator-separated terms, respecting quoted strings. Linear in the input length. */
function splitTerms(text, functionName) {
  const terms = [];
  let current = "";
  let operator = "+";
  let index = 0;
  let depth = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      current += ch;
      index += 1;
      let closed = false;
      while (index < text.length) {
        current += text[index];
        if (text[index] === "\\") {
          index += 1;
          if (index < text.length) current += text[index];
          index += 1;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) scriptError(`Exception: unterminated string in ${functionName}`);
      continue;
    }
    if (ch === "[" || ch === "{" || ch === "(") depth += 1;
    else if (ch === "]" || ch === "}" || ch === ")") depth -= 1;
    if (depth === 0 && (ch === "+" || ch === "-" || ch === "*" || ch === "/")) {
      // A minus with no term text before it is the sign of the literal that follows (`-1`, `2 - -3`), not an
      // operator; it is kept on the term so JSON.parse sees `-1`. A second sign (`--1`) is an ordinary operator
      // and leaves a bare `-` term, which resolveTerm rejects as an unsupported expression.
      if (ch === "-" && current.trim().length === 0) {
        current = "-";
        index += 1;
        continue;
      }
      terms.push({ operator, text: current.trim() });
      if (terms.length > MAX_TERMS) scriptError(`Exception: expression in ${functionName} has more than ${MAX_TERMS} terms`);
      operator = ch;
      current = "";
      index += 1;
      continue;
    }
    current += ch;
    index += 1;
  }
  terms.push({ operator, text: current.trim() });
  if (terms.length > MAX_TERMS) scriptError(`Exception: expression in ${functionName} has more than ${MAX_TERMS} terms`);
  for (const term of terms) if (term.text.length === 0) scriptError(`Exception: unsupported statement in ${functionName}`);
  return terms;
}

const PARAM_RE = /^p([1-9]|10)$/;

function resolveTerm(text, functionName, params, args, builtins) {
  if (text === "contactCount()" || text === "groupCount()" || text === "scriptTitle()") {
    return builtins[text.slice(0, -2)]();
  }
  const positional = PARAM_RE.exec(text);
  if (positional !== null) {
    const index = Number(positional[1]) - 1;
    return index < args.length ? args[index] : null;
  }
  const named = params.indexOf(text);
  if (named >= 0) return named < args.length ? args[named] : null;
  if (/^[A-Za-z_$]/.test(text)) scriptError(`Exception: unsupported identifier "${text.slice(0, 60)}" in ${functionName}`);
  try {
    return JSON.parse(text.replace(/'/g, '"'));
  } catch {
    return scriptError(`Exception: unsupported expression in ${functionName}`);
  }
}

function apply(operator, left, right, functionName) {
  if (operator === "+") {
    if (typeof left === "string" || typeof right === "string") {
      const result = `${stringify(left)}${stringify(right)}`;
      if (result.length > MAX_RESULT_BYTES) scriptError(`Exception: result of ${functionName} is larger than the supported bound`);
      return result;
    }
    return finite(numeric(left, functionName) + numeric(right, functionName), functionName);
  }
  const a = numeric(left, functionName);
  const b = numeric(right, functionName);
  if (operator === "-") return finite(a - b, functionName);
  if (operator === "*") return finite(a * b, functionName);
  if (b === 0) scriptError(`Exception: division by zero in ${functionName}`);
  return finite(a / b, functionName);
}

/** Every arithmetic result must stay a finite JSON number; overflow (1e308 * 10) is a script exception, never a 5xx. */
function finite(value, functionName) {
  if (!Number.isFinite(value)) scriptError(`Exception: non-finite numeric result in ${functionName}`);
  return value;
}

const stringify = (value) => (value === null ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value));

function numeric(value, functionName) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return scriptError(`Exception: arithmetic on a non-numeric value in ${functionName}`);
}
