// The Drive `q` subset this Tool understands, restricted to Google Docs files: a tokenizer, a recursive-descent parser
// producing a boolean tree, and a matcher over a document view. Terms and operators follow Google's "Search for files
// and folders" guide; anything outside the documented table is a QueryError, which the handler answers as
// 400 `invalid` with `location: q`. `parents` is rejected by name because this Tool has no folders.

export class QueryError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = "QueryError";
    this.hint = hint;
  }
}

export const MAX_QUERY_LENGTH = 2048;

const TERMS = {
  name: ["contains", "=", "!="],
  fullText: ["contains"],
  mimeType: ["=", "!="],
  trashed: ["=", "!="],
  starred: ["=", "!="],
  sharedWithMe: ["=", "!="],
  modifiedTime: ["<", "<=", ">", ">=", "=", "!="],
  createdTime: ["<", "<=", ">", ">=", "=", "!="],
  viewedByMeTime: ["<", "<=", ">", ">=", "=", "!="],
};
const COLLECTION_TERMS = ["owners", "writers", "readers"];
const UNSUPPORTED_COLLECTION_TERMS = ["parents"];
const BOOLEAN_TERMS = new Set(["trashed", "starred", "sharedWithMe"]);
const TIME_TERMS = new Set(["modifiedTime", "createdTime", "viewedByMeTime"]);
const KEYWORDS = new Set(["and", "or", "not", "in", "has", "contains", "true", "false"]);
const TERM_NAMES = new Set([...Object.keys(TERMS), ...COLLECTION_TERMS, ...UNSUPPORTED_COLLECTION_TERMS]);

function tokenize(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "'") {
      let value = "";
      index += 1;
      let closed = false;
      while (index < text.length) {
        const current = text[index];
        if (current === "\\") {
          const next = text[index + 1];
          if (next === undefined) throw new QueryError("Invalid Value");
          value += next;
          index += 2;
          continue;
        }
        if (current === "'") {
          closed = true;
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      if (!closed) throw new QueryError("Invalid Value");
      tokens.push({ type: "string", value });
      continue;
    }
    if ("()=".includes(character)) {
      tokens.push({ type: "punct", value: character });
      index += 1;
      continue;
    }
    if (character === "!" && text[index + 1] === "=") {
      tokens.push({ type: "op", value: "!=" });
      index += 2;
      continue;
    }
    if (character === "<" || character === ">") {
      if (text[index + 1] === "=") {
        tokens.push({ type: "op", value: `${character}=` });
        index += 2;
      } else {
        tokens.push({ type: "op", value: character });
        index += 1;
      }
      continue;
    }
    const match = /^[A-Za-z][A-Za-z0-9_.]*/.exec(text.slice(index));
    if (match === null) throw new QueryError("Invalid Value");
    const word = match[0];
    index += word.length;
    const lower = word.toLowerCase();
    if (KEYWORDS.has(lower)) tokens.push({ type: "keyword", value: lower });
    else tokens.push({ type: "word", value: word });
  }
  return tokens;
}

/** Parses a query string into a boolean tree; throws QueryError on anything outside the documented grammar. */
export function parseQuery(text) {
  if (typeof text !== "string") throw new QueryError("Invalid Value");
  if (text.length > MAX_QUERY_LENGTH) throw new QueryError("Invalid Value");
  // U+FFFD only reaches here when the request's percent-encoding was malformed (the transport decodes leniently), so
  // the expression is corrupt: refuse it instead of searching for a replacement character.
  if (text.includes("\uFFFD")) throw new QueryError("Invalid Value");
  const tokens = tokenize(text);
  if (tokens.length === 0) throw new QueryError("Invalid Value");
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const expect = (type, value) => {
    const token = take();
    if (token === undefined || token.type !== type || (value !== undefined && token.value !== value)) {
      throw new QueryError("Invalid Value");
    }
    return token;
  };
  const isKeyword = (value) => peek() !== undefined && peek().type === "keyword" && peek().value === value;

  const parseClause = () => {
    const token = take();
    if (token === undefined) throw new QueryError("Invalid Value");
    if (token.type === "string") {
      expect("keyword", "in");
      const term = expect("word").value;
      if (UNSUPPORTED_COLLECTION_TERMS.includes(term)) {
        throw new QueryError(
          "Invalid Value",
          "This Tool has no folders, so the parents collection is not searchable; remove the parents term.",
        );
      }
      if (!COLLECTION_TERMS.includes(term)) throw new QueryError("Invalid Value");
      return { kind: "in", term, value: token.value };
    }
    if (token.type !== "word") throw new QueryError("Invalid Value");
    const term = token.value;
    if (UNSUPPORTED_COLLECTION_TERMS.includes(term)) {
      throw new QueryError("Invalid Value", "This Tool has no folders, so the parents term is not supported.");
    }
    if (!TERM_NAMES.has(term) || COLLECTION_TERMS.includes(term)) throw new QueryError("Invalid Value");
    const operatorToken = take();
    if (operatorToken === undefined) throw new QueryError("Invalid Value");
    let operator;
    if (operatorToken.type === "keyword" && operatorToken.value === "contains") operator = "contains";
    else if (operatorToken.type === "op") operator = operatorToken.value;
    else if (operatorToken.type === "punct" && operatorToken.value === "=") operator = "=";
    else throw new QueryError("Invalid Value");
    if (!TERMS[term].includes(operator)) throw new QueryError("Invalid Value");
    const valueToken = take();
    if (valueToken === undefined) throw new QueryError("Invalid Value");
    let value;
    if (BOOLEAN_TERMS.has(term)) {
      if (valueToken.type === "keyword" && (valueToken.value === "true" || valueToken.value === "false")) {
        value = valueToken.value === "true";
      } else if (valueToken.type === "string" && (valueToken.value === "true" || valueToken.value === "false")) {
        value = valueToken.value === "true";
      } else throw new QueryError("Invalid Value");
    } else {
      if (valueToken.type !== "string") throw new QueryError("Invalid Value");
      value = valueToken.value;
      if (TIME_TERMS.has(term)) {
        const parsed = parseQueryTime(value);
        if (parsed === undefined) throw new QueryError("Invalid Value");
        value = parsed;
      }
    }
    return { kind: "compare", term, operator, value };
  };

  const parseNot = () => {
    if (isKeyword("not")) {
      take();
      return { kind: "not", operand: parseNot() };
    }
    if (peek() !== undefined && peek().type === "punct" && peek().value === "(") {
      take();
      const inner = parseOr();
      expect("punct", ")");
      return inner;
    }
    return parseClause();
  };
  const parseAnd = () => {
    const operands = [parseNot()];
    while (isKeyword("and")) {
      take();
      operands.push(parseNot());
    }
    return operands.length === 1 ? operands[0] : { kind: "and", operands };
  };
  const parseOr = () => {
    const operands = [parseAnd()];
    while (isKeyword("or")) {
      take();
      operands.push(parseAnd());
    }
    return operands.length === 1 ? operands[0] : { kind: "or", operands };
  };

  const tree = parseOr();
  if (position !== tokens.length) throw new QueryError("Invalid Value");
  return tree;
}

/** RFC 3339 or date-only value → epoch milliseconds; undefined when malformed. */
export function parseQueryTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return undefined;
  let text = value;
  if (text.length === 10) text = `${text}T00:00:00Z`;
  else if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) text = `${text}Z`;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Google's `name contains` matches at the start of a word, not anywhere in the string. */
function wordPrefixMatch(haystack, needle) {
  const text = haystack.toLowerCase();
  const phrase = needle.toLowerCase().trim();
  if (phrase.length === 0) return true;
  let from = 0;
  for (;;) {
    const index = text.indexOf(phrase, from);
    if (index < 0) return false;
    if (index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1])) return true;
    from = index + 1;
  }
}

function compareValues(operator, left, right) {
  switch (operator) {
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    default:
      return false;
  }
}

/**
 * Evaluates a parsed tree against a view:
 * `{ name, description, mimeType, trashed, starred, sharedWithMe, modifiedTime, createdTime, viewedByMeTime (epoch ms
 * or undefined), ownerEmail, roleRank(email), text() }`.
 */
export function matchQuery(tree, view) {
  switch (tree.kind) {
    case "and":
      return tree.operands.every((operand) => matchQuery(operand, view));
    case "or":
      return tree.operands.some((operand) => matchQuery(operand, view));
    case "not":
      return !matchQuery(tree.operand, view);
    case "in": {
      const email = tree.value.trim().toLowerCase();
      if (tree.term === "owners") return view.ownerEmail === email;
      const rank = view.roleRank(email);
      if (tree.term === "writers") return rank >= 3;
      return rank >= 1;
    }
    case "compare": {
      const { term, operator, value } = tree;
      if (term === "name") {
        if (operator === "contains") return wordPrefixMatch(view.name, value);
        return compareValues(operator, view.name, value);
      }
      if (term === "fullText") {
        const phrase = value.replace(/^"(.*)"$/s, "$1").toLowerCase();
        return `${view.name}\n${view.description ?? ""}\n${view.text()}`.toLowerCase().includes(phrase);
      }
      if (term === "mimeType") return compareValues(operator, view.mimeType, value);
      if (term === "trashed") return compareValues(operator, view.trashed, value);
      if (term === "starred") return compareValues(operator, view.starred, value);
      if (term === "sharedWithMe") return compareValues(operator, view.sharedWithMe, value);
      const time = view[term];
      if (time === undefined) return operator === "!=";
      return compareValues(operator, time, value);
    }
    default:
      return false;
  }
}
