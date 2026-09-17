// GitHub issue-search qualifier subset for `GET /search/issues` / `search_issues`. Parsing is pure; matching
// runs over issue/pull views supplied by the behavior module. Unknown qualifiers are rejected (documented).
import { parseDate, timestampMs } from "./ids.mjs";

const SUPPORTED = new Set([
  "repo",
  "is",
  "type",
  "state",
  "author",
  "assignee",
  "label",
  "no",
  "in",
  "created",
  "updated",
  "closed",
  "comments",
]);

export class SearchError extends Error {
  constructor(message) {
    super(message);
    this.name = "SearchError";
  }
}

function tokenize(query) {
  const tokens = [];
  let current = "";
  let quoted = false;
  for (const character of query) {
    if (character === '"') {
      quoted = !quoted;
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

function parseDateRange(value, name) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const toMs = (text, end) => {
    if (!day.test(text)) throw new SearchError(`Invalid date in "${name}:${value}"`);
    const ms = parseDate(`${text}T${end ? "23:59:59" : "00:00:00"}Z`) ?? Number.NaN;
    if (Number.isNaN(ms)) throw new SearchError(`Invalid date in "${name}:${value}"`);
    return ms;
  };
  if (value.startsWith(">=")) return { from: toMs(value.slice(2), false) };
  if (value.startsWith("<=")) return { to: toMs(value.slice(2), true) };
  if (value.startsWith(">")) return { from: toMs(value.slice(1), true) + 1 };
  if (value.startsWith("<")) return { to: toMs(value.slice(1), false) - 1 };
  const range = value.split("..");
  if (range.length === 2) return { from: toMs(range[0], false), to: toMs(range[1], true) };
  return { from: toMs(value, false), to: toMs(value, true) };
}

function parseCountRange(value, name) {
  const integer = /^\d{1,9}$/;
  if (value.startsWith(">=") && integer.test(value.slice(2))) return { min: Number(value.slice(2)) };
  if (value.startsWith("<=") && integer.test(value.slice(2))) return { max: Number(value.slice(2)) };
  if (value.startsWith(">") && integer.test(value.slice(1))) return { min: Number(value.slice(1)) + 1 };
  if (value.startsWith("<") && integer.test(value.slice(1))) return { max: Number(value.slice(1)) - 1 };
  const range = value.split("..");
  if (range.length === 2 && integer.test(range[0]) && integer.test(range[1])) {
    return { min: Number(range[0]), max: Number(range[1]) };
  }
  if (integer.test(value)) return { min: Number(value), max: Number(value) };
  throw new SearchError(`Invalid number in "${name}:${value}"`);
}

/** Parse a query string into a filter description; throws SearchError for unsupported syntax. */
export function parseQuery(query, me) {
  const filter = {
    repos: [],
    kind: undefined,
    state: undefined,
    merged: undefined,
    draft: undefined,
    authors: [],
    notAuthors: [],
    assignees: [],
    notAssignees: [],
    labels: [],
    notLabels: [],
    noAssignee: false,
    noLabel: false,
    fields: new Set(),
    created: undefined,
    updated: undefined,
    closed: undefined,
    comments: undefined,
    terms: [],
  };
  for (const token of tokenize(query)) {
    const negated = token.startsWith("-");
    const body = negated ? token.slice(1) : token;
    const colon = body.indexOf(":");
    if (colon <= 0) {
      if (negated) throw new SearchError(`Unsupported qualifier "${token}"`);
      filter.terms.push(body.toLowerCase());
      continue;
    }
    const name = body.slice(0, colon).toLowerCase();
    const value = body.slice(colon + 1);
    if (!SUPPORTED.has(name) || value.length === 0) throw new SearchError(`Unsupported qualifier "${token}"`);
    const lower = value.toLowerCase();
    const resolved = lower === "@me" ? me.toLowerCase() : lower;
    switch (name) {
      case "repo":
        if (negated) throw new SearchError(`Unsupported qualifier "${token}"`);
        filter.repos.push(lower);
        break;
      case "type":
        if (negated || (lower !== "issue" && lower !== "pr")) throw new SearchError(`Unsupported qualifier "${token}"`);
        filter.kind = lower;
        break;
      case "state":
        if (negated || (lower !== "open" && lower !== "closed")) throw new SearchError(`Unsupported qualifier "${token}"`);
        filter.state = lower;
        break;
      case "is":
        if (lower === "issue" || lower === "pr") filter.kind = negated ? (lower === "issue" ? "pr" : "issue") : lower;
        else if (lower === "open" || lower === "closed") {
          filter.state = negated ? (lower === "open" ? "closed" : "open") : lower;
        } else if (lower === "merged") filter.merged = !negated;
        else if (lower === "unmerged") filter.merged = negated;
        else if (lower === "draft") filter.draft = !negated;
        else throw new SearchError(`Unsupported qualifier "${token}"`);
        break;
      case "author":
        (negated ? filter.notAuthors : filter.authors).push(resolved);
        break;
      case "assignee":
        (negated ? filter.notAssignees : filter.assignees).push(resolved);
        break;
      case "label":
        (negated ? filter.notLabels : filter.labels).push(lower);
        break;
      case "no":
        if (negated) throw new SearchError(`Unsupported qualifier "${token}"`);
        if (lower === "assignee") filter.noAssignee = true;
        else if (lower === "label") filter.noLabel = true;
        else throw new SearchError(`Unsupported qualifier "${token}"`);
        break;
      case "in":
        if (negated || !["title", "body", "comments"].includes(lower)) throw new SearchError(`Unsupported qualifier "${token}"`);
        filter.fields.add(lower);
        break;
      case "created":
      case "updated":
      case "closed":
        if (negated) throw new SearchError(`Unsupported qualifier "${token}"`);
        filter[name] = parseDateRange(value, name);
        break;
      case "comments":
        if (negated) throw new SearchError(`Unsupported qualifier "${token}"`);
        filter.comments = parseCountRange(value, name);
        break;
      default:
        throw new SearchError(`Unsupported qualifier "${token}"`);
    }
  }
  if (filter.fields.size === 0) {
    filter.fields.add("title");
    filter.fields.add("body");
  }
  return filter;
}

function inRange(range, value) {
  if (range === undefined) return true;
  const ms = timestampMs(value ?? "");
  if (Number.isNaN(ms)) return false;
  if (range.from !== undefined && ms < range.from) return false;
  if (range.to !== undefined && ms > range.to) return false;
  return true;
}

/**
 * Match one candidate `{ kind: "issue"|"pr", repo (full_name lower), state, merged, draft, user, assignees,
 * labels, title, body, comments (count), commentText, created_at, updated_at, closed_at }`.
 * Returns a score (> 0) or 0 when it does not match.
 */
export function scoreCandidate(filter, candidate) {
  if (filter.repos.length > 0 && !filter.repos.includes(candidate.repo)) return 0;
  if (filter.kind !== undefined && filter.kind !== candidate.kind) return 0;
  if (filter.state !== undefined && filter.state !== candidate.state) return 0;
  if (filter.merged !== undefined && (candidate.kind !== "pr" || candidate.merged !== filter.merged)) return 0;
  if (filter.draft !== undefined && (candidate.kind !== "pr" || candidate.draft !== filter.draft)) return 0;
  const user = candidate.user.toLowerCase();
  if (filter.authors.length > 0 && !filter.authors.includes(user)) return 0;
  if (filter.notAuthors.includes(user)) return 0;
  const assignees = candidate.assignees.map((login) => login.toLowerCase());
  if (filter.noAssignee && assignees.length > 0) return 0;
  for (const wanted of filter.assignees) if (!assignees.includes(wanted)) return 0;
  for (const unwanted of filter.notAssignees) if (assignees.includes(unwanted)) return 0;
  const labels = candidate.labels.map((name) => name.toLowerCase());
  if (filter.noLabel && labels.length > 0) return 0;
  for (const wanted of filter.labels) if (!labels.includes(wanted)) return 0;
  for (const unwanted of filter.notLabels) if (labels.includes(unwanted)) return 0;
  if (!inRange(filter.created, candidate.created_at)) return 0;
  if (!inRange(filter.updated, candidate.updated_at)) return 0;
  if (filter.closed !== undefined && (candidate.closed_at === null || !inRange(filter.closed, candidate.closed_at))) return 0;
  if (filter.comments !== undefined) {
    if (filter.comments.min !== undefined && candidate.comments < filter.comments.min) return 0;
    if (filter.comments.max !== undefined && candidate.comments > filter.comments.max) return 0;
  }
  const haystacks = [];
  if (filter.fields.has("title")) haystacks.push(candidate.title.toLowerCase());
  if (filter.fields.has("body")) haystacks.push(candidate.body.toLowerCase());
  if (filter.fields.has("comments")) haystacks.push(candidate.commentText.toLowerCase());
  let score = 1;
  const title = candidate.title.toLowerCase();
  for (const term of filter.terms) {
    if (!haystacks.some((text) => text.includes(term))) return 0;
    score += 10;
    if (new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(title)) score += 5;
  }
  if (candidate.state === "open") score += 1;
  if (candidate.kind === "pr" && candidate.reviews > 0) score += 1;
  return score;
}
