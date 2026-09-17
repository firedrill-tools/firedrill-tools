// Manage Monitors search: documented query subset, facet counts, sort and page metadata.
import { bad, caller, checkBudget, nowSec, requireInt, scanAll } from "../lib/core.mjs";
import { parseMonitorQuery } from "../lib/mquery.mjs";
import { oneOf, text } from "../lib/text.mjs";

const TYPE_ALIASES = new Map([["metric", ["metric alert", "query alert"]], ["composite", ["composite"]], ["service", ["service check"]],
  ["log", ["log alert"]], ["event", ["event-v2 alert"]]]);
const STATUS_ORDER = new Map([["Alert", 0], ["Warn", 1], ["No Data", 2], ["OK", 3], ["Unknown", 4], ["Ignored", 5], ["Skipped", 6]]);
const SORTS = ["name,asc", "name,desc", "status,asc", "status,desc", "id,asc", "id,desc"];

/** Split into terms; a parenthesised group becomes `{ any: [terms] }` joined by OR. Quotes keep spaces. */
function tokenize(context, query) {
  const words = [];
  let i = 0;
  const readWord = () => {
    let word = "";
    while (i < query.length && query[i] !== " " && query[i] !== "(" && query[i] !== ")") {
      if (query[i] === "\"") {
        const close = query.indexOf("\"", i + 1);
        if (close < 0) bad(context, `Invalid query: unterminated quote at position ${i}`);
        word += query.slice(i + 1, close);
        i = close + 1;
      } else { word += query[i]; i += 1; }
    }
    return word;
  };
  while (i < query.length) {
    if (query[i] === " ") { i += 1; continue; }
    if (query[i] === ")") bad(context, `Invalid query: unexpected ) at position ${i}`);
    if (query[i] === "(") {
      i += 1;
      const any = [];
      for (;;) {
        while (query[i] === " ") i += 1;
        if (i >= query.length) bad(context, "Invalid query: missing )");
        if (query[i] === ")") { i += 1; break; }
        if (query[i] === "(") bad(context, `Invalid query: nested parentheses are not supported at position ${i}`);
        const word = readWord();
        if (word !== "OR") any.push(word);
      }
      if (any.length === 0) bad(context, "Invalid query: empty group");
      words.push({ any });
    } else {
      words.push({ any: [readWord()] });
    }
    if (words.length > 50) bad(context, "Invalid query: at most 50 terms are supported");
  }
  return words;
}

export function isMuted(row, now) {
  return row.options.silenced.some((entry) => entry.untilSec === null || entry.untilSec > now);
}

function termMatcher(context, term, now) {
  const colon = term.indexOf(":");
  if (colon < 0) {
    const needle = term.toLowerCase();
    return (row) => row.name.toLowerCase().includes(needle);
  }
  const key = term.slice(0, colon).toLowerCase();
  const value = term.slice(colon + 1);
  const lower = value.toLowerCase();
  if (key === "status") {
    if (!["alert", "warn", "no data", "ok"].includes(lower)) bad(context, `Invalid query: unsupported status ${value}`);
    return (row) => row.overallState.toLowerCase() === lower;
  }
  if (key === "type") {
    const types = TYPE_ALIASES.get(lower);
    if (types === undefined) bad(context, `Invalid query: unsupported type ${value}`);
    return (row) => types.includes(row.type);
  }
  if (key === "tag") return (row) => row.tags.includes(value);
  if (key === "id") return (row) => String(row.id) === value;
  if (key === "creator") return (row) => row.creatorHandle === lower;
  if (key === "priority") return (row) => String(row.priority) === value;
  if (key === "muted") {
    if (lower !== "true" && lower !== "false") bad(context, "Invalid query: muted must be true or false");
    return (row) => isMuted(row, now) === (lower === "true");
  }
  return bad(context, `Invalid query: unsupported search attribute ${key}`);
}

function facet(rows, pick) {
  const counts = new Map();
  for (const row of rows) for (const name of pick(row)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name, count]) => ({ name, count }));
}

function notifications(message) {
  const found = [];
  for (const match of message.matchAll(/@([A-Za-z0-9_.+-]{1,100}(?:@[A-Za-z0-9.-]{1,100})?)/g)) {
    if (!found.some((entry) => entry.handle === match[1])) found.push({ handle: match[1], name: match[1] });
    if (found.length >= 20) break;
  }
  return found;
}

function classify(row) {
  if (row.type === "composite") return "composite";
  if (row.type === "service check") return "custom";
  if (row.type === "log alert") return "log";
  if (row.type === "event-v2 alert") return "event";
  return "metric";
}

export function monitorsSearch(input, context) {
  caller(context);
  const query = text(context, input.query, "query", { max: 1000, noFffd: true }) ?? "";
  const page = requireInt(context, input.page, "page", 0, 100_000, 0);
  const perPage = requireInt(context, input.per_page, "per_page", 1, 1000, 30);
  const sort = oneOf(context, input.sort, "sort", SORTS, "name,asc");
  const now = nowSec(context);
  const groups = tokenize(context, query).map((group) => group.any.map((term) => termMatcher(context, term, now)));
  const rows = scanAll(context, "monitors").map((record) => record.value)
    .filter((row) => groups.every((matchers) => matchers.some((match) => match(row))));
  const [field, direction] = sort.split(",");
  const sign = direction === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const primary = field === "id" ? a.id - b.id : field === "status" ? STATUS_ORDER.get(a.overallState) - STATUS_ORDER.get(b.overallState)
      : a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0;
    return primary * sign || a.id - b.id;
  });
  const monitors = rows.slice(page * perPage, (page + 1) * perPage).map((row) => {
    const parsed = row.type === "metric alert" || row.type === "query alert" ? parseMonitorQuery(row.query) : { ok: false };
    const triggered = row.groups.map((group) => group.lastTriggeredSec).filter((ts) => ts !== null);
    return {
      id: row.id, name: row.name, query: row.query, type: row.type, status: row.overallState, tags: row.tags,
      creator: { handle: row.creatorHandle, email: row.creatorHandle, name: context.state.get("users", row.creatorHandle)?.name ?? row.creatorHandle },
      last_triggered_ts: triggered.length === 0 ? null : triggered.reduce((a, b) => (b > a ? b : a)),
      metrics: parsed.ok ? [parsed.parsed.expr.metric] : [], notifications: notifications(row.message),
      org_id: context.state.get("meta", "org")?.orgId ?? 0, classification: classify(row),
      scopes: parsed.ok && parsed.parsed.expr.scopeText !== "*" ? parsed.parsed.expr.scopeText.split(",") : [], quality_issues: [],
    };
  });
  return checkBudget(context, {
    monitors,
    counts: {
      status: facet(rows, (row) => [row.overallState.toLowerCase()]),
      type: facet(rows, (row) => [classify(row)]),
      tag: facet(rows, (row) => row.tags),
      muted: facet(rows, (row) => [isMuted(row, now) ? "true" : "false"]),
    },
    metadata: { page, page_count: Math.ceil(rows.length / perPage), per_page: perPage, total_count: rows.length },
  });
}
