// Gmail search-operator subset: tokenizer, parser and matcher. Pure and deterministic.
import { systemLabelByName } from "./ids.mjs";

function clip(value) {
  const text = String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export class QueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueryError";
  }
}

const SUPPORTED = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "label",
  "in",
  "is",
  "has",
  "newer_than",
  "older_than",
  "after",
  "before",
  "newer",
  "older",
  "filename",
  "rfc822msgid",
]);
const IN_VALUES = new Set(["inbox", "sent", "drafts", "draft", "trash", "spam", "starred", "important", "anywhere", "archive"]);
const IS_VALUES = new Set(["unread", "read", "starred", "unstarred", "important"]);
const HAS_VALUES = new Set(["attachment", "nouserlabels", "userlabels"]);
const DAY_MS = 86_400_000;

function readPhrase(query, start) {
  const end = query.indexOf('"', start + 1);
  if (end < 0) throw new QueryError("Invalid search query: unbalanced quote");
  return { value: query.slice(start + 1, end), next: end + 1 };
}

export function tokenize(query) {
  const tokens = [];
  let index = 0;
  while (index < query.length) {
    const character = query[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if ("(){}".includes(character)) {
      tokens.push({ kind: character });
      index += 1;
      continue;
    }
    let negate = false;
    if (character === "-") {
      negate = true;
      index += 1;
      if ("({".includes(query[index] ?? "")) {
        tokens.push({ kind: "NOT" });
        continue;
      }
    }
    let operator = null;
    let value;
    if (query[index] === '"') {
      const phrase = readPhrase(query, index);
      value = phrase.value;
      index = phrase.next;
    } else {
      let cursor = index;
      while (cursor < query.length && !/\s/.test(query[cursor]) && !")}".includes(query[cursor])) {
        if (query[cursor] === ":" && operator === null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(query.slice(index, cursor))) {
          operator = query.slice(index, cursor).toLowerCase();
          index = cursor + 1;
          cursor = index;
          if (query[index] === '"') {
            const phrase = readPhrase(query, index);
            value = phrase.value;
            index = phrase.next;
            cursor = -1;
            break;
          }
          continue;
        }
        cursor += 1;
      }
      if (cursor >= 0) {
        value = query.slice(index, cursor);
        index = cursor;
      }
    }
    if (operator === null && !negate && value === "OR") {
      tokens.push({ kind: "OR" });
      continue;
    }
    if (operator === null && !negate && value === "AND") continue;
    if (operator === null && value === "") continue;
    tokens.push({ kind: "term", operator, value, negate });
  }
  return tokens;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year, month) {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return month === 2 && leap ? 29 : MONTH_DAYS[month - 1];
}

/**
 * `after:`/`before:`/`newer:`/`older:` value → epoch ms. A calendar date must name a real day: month 01–12 and a day that
 * exists in that month (leap years honoured), one separator style throughout. It is never normalised, so `2024/13/45`,
 * `2024/00/10` or `2024/02/30` fail instead of rolling into a later real date. Dates are midnight UTC.
 */
function parseDateValue(value) {
  const ymd = /^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/.exec(value);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[3]);
    const day = Number(ymd[4]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      throw new QueryError(`Invalid search query: "${clip(value)}" is not a valid calendar date`);
    }
    // setUTCFullYear, not Date.UTC: Date.UTC maps years 0–99 to 1900–1999.
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getTime();
  }
  // Epoch seconds (Gmail's documented form); 12–13 digit values are read as epoch milliseconds.
  if (/^\d{9,13}$/.test(value)) return value.length > 11 ? Number(value) : Number(value) * 1000;
  throw new QueryError(`Unsupported date value "${clip(value)}" (use YYYY/MM/DD, YYYY-MM-DD or epoch seconds)`);
}

/** `newer_than:`/`older_than:` value → span in ms. 0–9999 units; longer numbers are refused, never wrapped. */
function parseSpan(value) {
  const match = /^(\d{1,4})([dmy])$/.exec(value);
  if (!match) throw new QueryError(`Unsupported duration "${clip(value)}" (use Nd, Nm or Ny with N from 0 to 9999)`);
  const amount = Number(match[1]);
  const unit = match[2] === "d" ? DAY_MS : match[2] === "m" ? 30 * DAY_MS : 365 * DAY_MS;
  return amount * unit;
}

function validateTerm(term) {
  const { operator, value } = term;
  if (operator === null) return term;
  if (!SUPPORTED.has(operator)) throw new QueryError(`Unsupported search operator "${clip(operator)}:"`);
  const lower = value.toLowerCase();
  if (operator === "in" && !IN_VALUES.has(lower)) throw new QueryError(`Unsupported search value "in:${clip(value)}"`);
  if (operator === "is" && !IS_VALUES.has(lower)) throw new QueryError(`Unsupported search value "is:${clip(value)}"`);
  if (operator === "has" && !HAS_VALUES.has(lower)) throw new QueryError(`Unsupported search value "has:${clip(value)}"`);
  if (operator === "newer_than" || operator === "older_than") return { ...term, spanMs: parseSpan(lower) };
  if (["after", "before", "newer", "older"].includes(operator)) return { ...term, timeMs: parseDateValue(value) };
  if (value === "") throw new QueryError(`Search operator "${operator}:" requires a value`);
  return term;
}

function parseGroup(tokens, position, closer) {
  const items = [];
  let cursor = position;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token.kind === closer) return { node: { type: "and", items }, next: cursor + 1 };
    if (token.kind === ")" || token.kind === "}") throw new QueryError("Invalid search query: unbalanced group");
    if (token.kind === "OR") {
      const previous = items.pop();
      if (previous === undefined) throw new QueryError("Invalid search query: OR needs two terms");
      const right = parseUnit(tokens, cursor + 1);
      cursor = right.next;
      items.push(previous.type === "or" ? { type: "or", items: [...previous.items, right.node] } : { type: "or", items: [previous, right.node] });
      continue;
    }
    const unit = parseUnit(tokens, cursor);
    items.push(unit.node);
    cursor = unit.next;
  }
  if (closer !== undefined) throw new QueryError("Invalid search query: unbalanced group");
  return { node: { type: "and", items }, next: cursor };
}

function parseUnit(tokens, position) {
  const token = tokens[position];
  if (token === undefined) throw new QueryError("Invalid search query: dangling operator");
  if (token.kind === "NOT") {
    const inner = parseUnit(tokens, position + 1);
    return { node: { type: "not", item: inner.node }, next: inner.next };
  }
  if (token.kind === "(") return parseGroup(tokens, position + 1, ")");
  if (token.kind === "{") {
    const group = parseGroup(tokens, position + 1, "}");
    return { node: { type: "or", items: group.node.items }, next: group.next };
  }
  if (token.kind === "term") {
    const term = validateTerm({ type: "term", operator: token.operator, value: token.value });
    return { node: token.negate ? { type: "not", item: term } : term, next: position + 1 };
  }
  throw new QueryError("Invalid search query");
}

/** Parse a query; throws QueryError for unbalanced syntax or unsupported operators/values. */
export function parseQuery(query) {
  if (query === undefined || query === null) return { type: "and", items: [] };
  if (typeof query !== "string") throw new QueryError("Search query must be a string");
  if (query.length > 2048) throw new QueryError("Search query exceeds 2048 characters");
  // U+FFFD is what the HTTP layer's lenient query decoding leaves behind for malformed percent-encoding (%E0%A4%A):
  // refuse the corrupted search rather than run it and match nothing. A correctly encoded U+FFFD is refused too.
  if (query.includes("\uFFFD")) {
    throw new QueryError("Invalid search query: contains U+FFFD (malformed percent-encoding or invalid UTF-8)");
  }
  return parseGroup(tokenize(query), 0, undefined).node;
}

/** True when the query explicitly reaches into TRASH/SPAM (so the default exclusion is lifted). */
export function reachesTrashOrSpam(node) {
  if (node.type === "term") {
    const value = node.value.toLowerCase();
    if (node.operator === "in") return ["trash", "spam", "anywhere"].includes(value);
    if (node.operator === "label") return value === "trash" || value === "spam";
    return false;
  }
  if (node.type === "not") return false;
  return node.items.some((item) => reachesTrashOrSpam(item));
}

function includes(haystack, needle) {
  return String(haystack).toLowerCase().includes(needle);
}

function hasUserLabel(message) {
  return message.labelIds.some((id) => id.startsWith("Label_"));
}

function termMatches(term, message, context) {
  const value = term.value;
  const lower = value.toLowerCase();
  const labels = message.labelIds;
  const headers = message.headers;
  const time = Number(message.internalDate);
  switch (term.operator) {
    case null:
      return includes(
        [headers.subject, message.snippet, message.body.text, headers.from, headers.fromName ?? "", headers.to.join(" "), headers.cc.join(" ")].join("\n"),
        lower,
      );
    case "from":
      return includes(`${headers.from} ${headers.fromName ?? ""}`, lower);
    case "to":
      return includes(headers.to.join(" "), lower);
    case "cc":
      return includes(headers.cc.join(" "), lower);
    case "bcc":
      return includes(headers.bcc.join(" "), lower);
    case "subject":
      return includes(headers.subject, lower);
    case "label": {
      const id = context.resolveLabel(value);
      return id !== null && labels.includes(id);
    }
    case "in":
      if (lower === "anywhere") return true;
      if (lower === "archive") return !labels.includes("INBOX") && !labels.includes("TRASH") && !labels.includes("SPAM") && !labels.includes("DRAFT");
      return labels.includes(systemLabelByName(lower));
    case "is":
      if (lower === "read") return !labels.includes("UNREAD");
      if (lower === "unstarred") return !labels.includes("STARRED");
      return labels.includes(systemLabelByName(lower));
    case "has":
      if (lower === "attachment") return message.attachments.length > 0;
      if (lower === "nouserlabels") return !hasUserLabel(message);
      return hasUserLabel(message);
    case "newer_than":
      return time >= context.nowMs - term.spanMs;
    case "older_than":
      return time < context.nowMs - term.spanMs;
    case "after":
    case "newer":
      return time >= term.timeMs;
    case "before":
    case "older":
      return time < term.timeMs;
    case "filename":
      return message.attachments.some((attachment) => includes(attachment.filename, lower));
    case "rfc822msgid": {
      const wanted = value.startsWith("<") ? value : `<${value}>`;
      return headers.messageId === wanted;
    }
    default:
      throw new QueryError(`Unsupported search operator "${clip(term.operator)}:"`);
  }
}

/** Evaluate a parsed query against one stored message. `context` = { nowMs, resolveLabel(nameOrId) }. */
export function matchMessage(node, message, context) {
  switch (node.type) {
    case "and":
      return node.items.every((item) => matchMessage(item, message, context));
    case "or":
      return node.items.some((item) => matchMessage(item, message, context));
    case "not":
      return !matchMessage(node.item, message, context);
    default:
      return termMatches(node, message, context);
  }
}

/** Build the `label:` resolver for one mailbox from its user label rows. */
export function labelResolver(userLabels) {
  return (token) => {
    const lower = String(token).toLowerCase();
    const system = systemLabelByName(lower);
    if (system !== null) return system;
    for (const label of userLabels) {
      if (label.id.toLowerCase() === lower) return label.id;
      const name = label.name.toLowerCase();
      if (name === lower || name.replace(/[\s/]+/g, "-") === lower) return label.id;
    }
    return null;
  };
}
