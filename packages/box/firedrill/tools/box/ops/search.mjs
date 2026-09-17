// search.query: terms, "quoted phrases", AND / OR / NOT over name, description, file content, comments and tags.
import { accessOf, canSee, isWithin } from "../lib/access.mjs";
import { badParam } from "../lib/errors.mjs";
import { offsetPage } from "../lib/listing.mjs";
import { fullOf, parseFields } from "../lib/render.mjs";
import { scanAll } from "../lib/store.mjs";
import { hasReplacement, isId, parseRfc3339 } from "../lib/util.mjs";
import { begin } from "./common.mjs";

const MAX_TERMS = 20;
const ALL_TYPES = ["name", "description", "file_content", "comments", "tag"];

/** Parses the query into OR-separated clauses of { not, text } terms. */
export function parseQuery(context, query) {
  if (query.trim().length === 0) badParam(context, "query", "query must not be empty");
  if (hasReplacement(query)) badParam(context, "query", "query contains malformed characters");
  if (query.includes("(") || query.includes(")")) badParam(context, "query", "parentheses are not supported in search queries");
  const tokens = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
    } else if (ch === '"') {
      const end = query.indexOf('"', i + 1);
      if (end < 0) badParam(context, "query", "unterminated quoted phrase");
      const phrase = query.slice(i + 1, end).trim();
      if (phrase.length > 0) tokens.push({ kind: "term", text: phrase.toLowerCase() });
      i = end + 1;
    } else {
      let end = i;
      while (end < query.length && !" \t\n\r\"".includes(query[end])) end += 1;
      const word = query.slice(i, end);
      tokens.push(word === "AND" || word === "OR" || word === "NOT" ? { kind: word } : { kind: "term", text: word.toLowerCase() });
      i = end;
    }
  }
  const clauses = [[]];
  let terms = 0;
  let pendingNot = false;
  let expectTerm = true;
  for (const token of tokens) {
    if (token.kind === "term") {
      clauses[clauses.length - 1].push({ not: pendingNot, text: token.text });
      terms += 1;
      pendingNot = false;
      expectTerm = false;
    } else if (token.kind === "NOT") {
      if (pendingNot) badParam(context, "query", "NOT must be followed by a term");
      pendingNot = true;
      expectTerm = true;
    } else {
      if (expectTerm) badParam(context, "query", `${token.kind} must be placed between terms`);
      if (token.kind === "OR") clauses.push([]);
      expectTerm = true;
    }
  }
  if (expectTerm || terms === 0) badParam(context, "query", "query ends with an operator or has no terms");
  if (terms > MAX_TERMS) badParam(context, "query", `query supports at most ${MAX_TERMS} terms`);
  return clauses;
}

function range(context, name, value) {
  if (value === undefined) return null;
  const comma = value.indexOf(",");
  if (comma < 0 || value.indexOf(",", comma + 1) >= 0) badParam(context, name, `${name} must be "from,to"`);
  const side = (text) => {
    if (text.length === 0) return null;
    const us = parseRfc3339(text);
    if (us === null) badParam(context, name, `${name} dates must be RFC 3339 with a time zone offset`);
    return us;
  };
  return [side(value.slice(0, comma)), side(value.slice(comma + 1))];
}

const inRange = (bounds, us) => bounds === null || ((bounds[0] === null || us >= bounds[0]) && (bounds[1] === null || us <= bounds[1]));

export function search(input, context) {
  const { user, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  const clauses = parseQuery(context, input.query);
  const types = new Set(input.content_types ?? ALL_TYPES);
  for (const name of ["file_extensions", "ancestor_folder_ids"]) {
    if ((input[name] ?? []).some(hasReplacement)) badParam(context, name, `${name} contains malformed characters`);
  }
  const created = range(context, "created_at_range", input.created_at_range);
  const updated = range(context, "updated_at_range", input.updated_at_range);
  if (input.direction !== undefined && input.sort !== "modified_at") badParam(context, "direction", "direction requires sort=modified_at");
  for (const id of input.owner_user_ids ?? []) if (!isId(id)) badParam(context, "owner_user_ids", "owner_user_ids must be user ids");
  const owners = input.owner_user_ids === undefined ? null : new Set(input.owner_user_ids);
  const extensions = input.file_extensions === undefined ? null : new Set(input.file_extensions.map((e) => e.toLowerCase()));
  const ancestors = input.ancestor_folder_ids === undefined ? null : input.ancestor_folder_ids.filter((id) => {
    const folder = isId(id) ? index.folders.get(id) : undefined;
    return folder !== undefined && canSee(accessOf(index, user.id, "folder", folder), "folder");
  });
  const trash = input.trash_content ?? "non_trashed_only";
  const commentsByFile = new Map();
  if (types.has("comments")) {
    for (const { value } of scanAll(context, "comments")) commentsByFile.set(value.fileId, `${commentsByFile.get(value.fileId) ?? ""}\n${value.message.toLowerCase()}`);
  }
  const results = [];
  for (const [kind, map] of [["folder", index.folders], ["file", index.files]]) {
    if (input.type !== undefined && input.type !== kind) continue;
    for (const item of map.values()) {
      if (trash === "non_trashed_only" ? item.itemStatus !== "active" : trash === "trashed_only" ? item.itemStatus !== "trashed" : false) continue;
      if (extensions !== null && (kind !== "file" || !extensions.has(item.extension))) continue;
      if (owners !== null && !owners.has(item.ownerId)) continue;
      if (!inRange(created, item.createdAtUs) || !inRange(updated, item.modifiedAtUs)) continue;
      if (ancestors !== null && !ancestors.some((a) => a !== item.id && isWithin(index, item.parentId, a))) continue;
      if (!canSee(accessOf(index, user.id, kind, item), kind)) continue;
      const hay = new Map();
      const text = (type) => {
        if (!hay.has(type)) {
          let value = "";
          if (type === "name") value = item.name.toLowerCase();
          else if (type === "description") value = item.description.toLowerCase();
          else if (type === "tag") value = item.tags.join("\n").toLowerCase();
          else if (type === "comments") value = kind === "file" ? commentsByFile.get(item.id) ?? "" : "";
          else if (kind === "file") value = (context.state.get("blobs", item.currentVersionId)?.content ?? "").toLowerCase();
          hay.set(type, value);
        }
        return hay.get(type);
      };
      const hits = (term) => [...types].some((type) => text(type).includes(term.text));
      let score = -1;
      for (const clause of clauses) {
        if (clause.every((term) => hits(term) !== term.not)) {
          score = Math.max(score, clause.filter((t) => !t.not && types.has("name") && text("name").includes(t.text)).length);
        }
      }
      if (score >= 0) results.push({ kind, item, score });
    }
  }
  const byId = (a, b) => (a.item.id.padStart(20, "0") < b.item.id.padStart(20, "0") ? -1 : 1);
  if (input.sort === "modified_at") {
    const sign = (input.direction ?? "DESC") === "ASC" ? 1 : -1;
    results.sort((a, b) => (a.item.modifiedAtUs - b.item.modifiedAtUs) * sign || byId(a, b));
  } else {
    results.sort((a, b) => b.score - a.score || b.item.modifiedAtUs - a.item.modifiedAtUs || byId(a, b));
  }
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 30;
  const entries = offsetPage(context, results, offset, limit, ({ kind, item }) => fullOf(index, user, kind, item, fields));
  return { type: "search_results_items", total_count: results.length, limit, offset, entries };
}
