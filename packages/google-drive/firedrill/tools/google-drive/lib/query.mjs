// Drive `q` grammar: a tokenizer, a recursive-descent parser producing a boolean tree, and a matcher over a file view.
// Terms, operators and keywords follow Google's "Search for files and folders" guide; anything outside the documented
// table is a QueryError (the handler answers 400 `invalid`, location `q`). Pure functions only.

export class QueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueryError";
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
  visibility: ["=", "!="],
  "shortcutDetails.targetId": ["=", "!="],
};
const COLLECTION_TERMS = ["parents", "owners", "writers", "readers"];
const HAS_TERMS = ["properties", "appProperties"];
const BOOLEAN_TERMS = new Set(["trashed", "starred", "sharedWithMe"]);
const TIME_TERMS = new Set(["modifiedTime", "createdTime", "viewedByMeTime"]);
const VISIBILITIES = new Set(["anyoneCanFind", "anyoneWithLink", "domainCanFind", "domainWithLink", "limited"]);
const KEYWORDS = new Set(["and", "or", "not", "in", "has", "contains", "true", "false", "key", "value"]);
const TERM_NAMES = new Set([...Object.keys(TERMS), ...COLLECTION_TERMS, ...HAS_TERMS]);

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
    if ("()={}".includes(character)) {
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
  const tokens = tokenize(text);
  if (tokens.length === 0) throw new QueryError("Invalid Value");
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const expect = (type, value) => {
    const token = take();
    if (token === undefined || token.type !== type || (value !== undefined && token.value !== value)) throw new QueryError("Invalid Value");
    return token;
  };
  const isKeyword = (value) => peek() !== undefined && peek().type === "keyword" && peek().value === value;

  const parseClause = () => {
    const token = take();
    if (token === undefined) throw new QueryError("Invalid Value");
    if (token.type === "string") {
      expect("keyword", "in");
      const term = expect("word").value;
      if (!COLLECTION_TERMS.includes(term)) throw new QueryError("Invalid Value");
      return { kind: "in", term, value: token.value };
    }
    if (token.type !== "word") throw new QueryError("Invalid Value");
    const term = token.value;
    if (!TERM_NAMES.has(term) || COLLECTION_TERMS.includes(term)) throw new QueryError("Invalid Value");
    if (HAS_TERMS.includes(term)) {
      expect("keyword", "has");
      expect("punct", "{");
      expect("keyword", "key");
      expect("punct", "=");
      const key = expect("string").value;
      expect("keyword", "and");
      expect("keyword", "value");
      expect("punct", "=");
      const value = expect("string").value;
      expect("punct", "}");
      return { kind: "has", term, key, value };
    }
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
      if (valueToken.type === "keyword" && (valueToken.value === "true" || valueToken.value === "false")) value = valueToken.value === "true";
      else if (valueToken.type === "string" && (valueToken.value === "true" || valueToken.value === "false")) value = valueToken.value === "true";
      else throw new QueryError("Invalid Value");
    } else {
      if (valueToken.type !== "string") throw new QueryError("Invalid Value");
      value = valueToken.value;
      if (TIME_TERMS.has(term)) {
        const parsed = parseQueryTime(value);
        if (parsed === undefined) throw new QueryError("Invalid Value");
        value = parsed;
      }
      if (term === "visibility" && !VISIBILITIES.has(value)) throw new QueryError("Invalid Value");
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
 * Evaluates a parsed tree against a view: `{ name, description, mimeType, trashed, starred, sharedWithMe, modifiedTime,
 * createdTime, viewedByMeTime (ms or undefined), parentId, ownerEmail, visibility, shortcutTargetId, properties,
 * appProperties, text(), roleOf(email) }`. Time terms compare epoch milliseconds; a missing time never matches.
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
      const value = tree.value;
      if (tree.term === "parents") return view.parentId !== undefined && (value === view.parentId || (value === "root" && view.parentIsRoot));
      const email = value.trim().toLowerCase();
      if (tree.term === "owners") return view.ownerEmail === email;
      const role = view.roleOf(email);
      if (tree.term === "writers") return role >= 3;
      return role >= 1;
    }
    case "has": {
      const map = tree.term === "properties" ? view.properties : view.appProperties;
      return map !== undefined && map[tree.key] === tree.value;
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
      if (term === "visibility") return compareValues(operator, view.visibility, value);
      if (term === "shortcutDetails.targetId") return compareValues(operator, view.shortcutTargetId ?? "", value);
      const time = view[term];
      if (time === undefined) return operator === "!=";
      return compareValues(operator, time, value);
    }
    default:
      return false;
  }
}
