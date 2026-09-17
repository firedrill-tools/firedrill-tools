// search.messages query grammar: whitespace-separated terms, "quoted phrases", -negation and a documented
// modifier subset. Pure functions; the behavior module supplies the environment (handles, membership, pins).
import { isoDay, tsSeconds } from "./ids.mjs";

export class SearchError extends Error {}

const MODIFIER = /^(-?)([a-z_]+):(.*)$/s;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

/** Split on whitespace while keeping double-quoted phrases together. */
function tokenize(query) {
  const tokens = [];
  let current = "";
  let quoted = false;
  for (const character of query) {
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (current.length > 0) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function unquote(value) {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/**
 * Parse a query into bare terms and modifiers. Throws SearchError for modifiers outside the subset,
 * which the handler reports as INVALID_ARGUMENTS (Slack would treat them as text; documented deviation).
 */
export function parseQuery(query) {
  const terms = [];
  const modifiers = [];
  for (const token of tokenize(query)) {
    const match = token.startsWith('"') ? null : MODIFIER.exec(token);
    if (match === null) {
      const negate = token.startsWith("-") && token.length > 1 && !token.startsWith('-"');
      const raw = negate ? token.slice(1) : token.startsWith('-"') ? token.slice(1) : token;
      const text = unquote(raw).toLowerCase();
      if (text.length > 0) terms.push({ text, negate: negate || token.startsWith('-"'), phrase: raw.startsWith('"') });
      continue;
    }
    const negate = match[1] === "-";
    const op = match[2];
    const value = unquote(match[3]);
    switch (op) {
      case "in":
      case "from": {
        if (value.length === 0) throw new SearchError(`Search modifier "${op}:" needs a value`);
        modifiers.push({ op, value, negate });
        break;
      }
      case "is": {
        if (value !== "thread") throw new SearchError(`Unsupported search modifier "is:${value}"`);
        modifiers.push({ op, value, negate });
        break;
      }
      case "has": {
        const emoji = /^:([a-z0-9_+-]{1,100}):$/.exec(value);
        if (value === "pin" || value === "reaction") modifiers.push({ op, value, negate });
        else if (emoji !== null) modifiers.push({ op: "has-emoji", value: emoji[1], negate });
        else throw new SearchError(`Unsupported search modifier "has:${value}"`);
        break;
      }
      case "before":
      case "after":
      case "on": {
        if (!DAY.test(value)) throw new SearchError(`Search modifier "${op}:" needs a YYYY-MM-DD date`);
        modifiers.push({ op, value, negate });
        break;
      }
      case "during": {
        if (!MONTH.test(value)) throw new SearchError(`Search modifier "during:" needs a YYYY-MM month`);
        modifiers.push({ op, value, negate });
        break;
      }
      default:
        throw new SearchError(`Unsupported search modifier "${op}:"`);
    }
  }
  return { terms, modifiers };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `message` match the parsed query? Returns null for no match, otherwise a deterministic integer score:
 * 10 per matching bare term, +5 when the term is a whole word, +1 when the message is a thread parent or plain post.
 *
 * `env`: { conversation, actorId, authorHandle(userId) → handle|null, partnerHandle(conversation) → handle|null,
 *          isPinned(message) → boolean }
 */
export function scoreMessage(parsed, message, env) {
  const text = String(message.text ?? "");
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of parsed.terms) {
    const present = lower.includes(term.text);
    if (term.negate ? present : !present) return null;
    if (!term.negate) {
      score += 10;
      if (new RegExp(`(^|[^a-z0-9_])${escapeRegExp(term.text)}($|[^a-z0-9_])`, "i").test(text)) score += 5;
    }
  }
  for (const modifier of parsed.modifiers) {
    let matched;
    switch (modifier.op) {
      case "in":
        matched = conversationMatches(env.conversation, modifier.value, env);
        break;
      case "from":
        matched = authorMatches(message, modifier.value, env);
        break;
      case "is":
        matched = typeof message.thread_ts === "string";
        break;
      case "has":
        matched = modifier.value === "pin" ? env.isPinned(message) : Array.isArray(message.reactions) && message.reactions.length > 0;
        break;
      case "has-emoji":
        matched = Array.isArray(message.reactions) && message.reactions.some((reaction) => reaction.name === modifier.value);
        break;
      case "before":
        matched = isoDay(tsSeconds(message.ts)) < modifier.value;
        break;
      case "after":
        matched = isoDay(tsSeconds(message.ts)) > modifier.value;
        break;
      case "on":
        matched = isoDay(tsSeconds(message.ts)) === modifier.value;
        break;
      case "during":
        matched = isoDay(tsSeconds(message.ts)).startsWith(`${modifier.value}-`);
        break;
      default:
        matched = false;
    }
    if (modifier.negate ? matched : !matched) return null;
  }
  const isReply = typeof message.thread_ts === "string" && message.thread_ts !== message.ts;
  return score + (isReply ? 0 : 1);
}

function conversationMatches(conversation, value, env) {
  const channelRef = /^<#([A-Z0-9]+)(?:\|[^>]*)?>$/.exec(value);
  if (channelRef !== null) return conversation.id === channelRef[1];
  if (value.startsWith("@")) {
    return conversation.is_im === true && env.partnerHandle(conversation) === value.slice(1).toLowerCase();
  }
  const name = value.startsWith("#") ? value.slice(1) : value;
  return conversation.id === name || conversation.name === name.toLowerCase();
}

function authorMatches(message, value, env) {
  if (value === "me") return message.user === env.actorId;
  const userRef = /^<@([A-Z0-9]+)(?:\|[^>]*)?>$/.exec(value);
  if (userRef !== null) return message.user === userRef[1];
  const handle = (value.startsWith("@") ? value.slice(1) : value).toLowerCase();
  return message.user === handle || env.authorHandle(message.user) === handle;
}
