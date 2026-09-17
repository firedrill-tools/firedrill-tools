// Linear, non-backtracking parsers for the URNs and Rest.li complex keys this Tool accepts from callers.

const MAX_URN = 200;
const PERSON_ID = /^[A-Za-z0-9_-]{10}$/;
const DIGITS = /^[0-9]{1,19}$/;
const ORG_DIGITS = /^[1-9][0-9]{0,11}$/;

/**
 * Parses a URN. Returns `{ type, id, urn }` (comment URNs add `activityId` and `commentId`) or null when the text is not
 * a well-formed URN of a type this Tool knows.
 */
export function parseUrn(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URN) return null;
  if (!value.startsWith("urn:li:")) return null;
  const rest = value.slice(7);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  const type = rest.slice(0, colon);
  const id = rest.slice(colon + 1);
  switch (type) {
    case "person":
      return PERSON_ID.test(id) ? { type, id, urn: value } : null;
    case "organization":
      return ORG_DIGITS.test(id) ? { type, id, urn: value } : null;
    case "share":
    case "ugcPost":
    case "activity":
      return DIGITS.test(id) ? { type, id, urn: value } : null;
    case "comment": {
      if (!id.startsWith("(urn:li:activity:") || !id.endsWith(")")) return null;
      const inner = id.slice(17, -1);
      const comma = inner.indexOf(",");
      if (comma <= 0) return null;
      const activityId = inner.slice(0, comma);
      const commentId = inner.slice(comma + 1);
      if (!DIGITS.test(activityId) || !DIGITS.test(commentId)) return null;
      return { type, id: commentId, activityId, commentId, urn: value };
    }
    default:
      return null;
  }
}

/** Looks like an URN (prefix present) even when the id part is malformed: decides INVALID_URN_ID vs INVALID_URN_TYPE. */
export function urnType(value) {
  if (typeof value !== "string" || !value.startsWith("urn:li:") || value.length > MAX_URN) return null;
  const rest = value.slice(7);
  const colon = rest.indexOf(":");
  return colon > 0 ? rest.slice(0, colon) : null;
}

export const personUrn = (personId) => `urn:li:person:${personId}`;
export const organizationUrn = (organizationId) => `urn:li:organization:${organizationId}`;
export const activityUrn = (activityId) => `urn:li:activity:${activityId}`;
export const postUrnOf = (post) => `urn:li:${post.kind}:${post.id}`;
export const commentUrn = (activityId, commentId) => `urn:li:comment:(urn:li:activity:${activityId},${commentId})`;
export const reactionId = (actor, entity) => `urn:li:reaction:(${actor},${entity})`;

/**
 * Parses a Rest.li complex key `(name:value,name:value)`, splitting only on top-level commas so nested comment URNs survive.
 * Returns a Map of name → value, or null when the text is not a well-formed key. Names are lowercase letters only.
 */
export function parseComplexKey(text) {
  if (typeof text !== "string" || text.length < 3 || text.length > 512) return null;
  if (text[0] !== "(" || text[text.length - 1] !== ")") return null;
  const body = text.slice(1, -1);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return null;
    } else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  parts.push(body.slice(start));
  if (parts.length > 4) return null;
  const map = new Map();
  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon <= 0) return null;
    const name = part.slice(0, colon);
    if (!/^[a-z]{1,20}$/i.test(name) || map.has(name)) return null;
    map.set(name, part.slice(colon + 1));
  }
  return map;
}
