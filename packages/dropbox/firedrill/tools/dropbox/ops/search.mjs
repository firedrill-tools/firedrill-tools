// files/search_v2 and files/search/continue_v2. Tokenised, case- and accent-insensitive prefix matching over names and
// the text content of text files (a documented approximation of Dropbox search). Matching is linear in the text size.
import { callerAccount } from "../lib/account.mjs";
import { failText, failUnion, lookupFail } from "../lib/errors.mjs";
import { decodeCursor, encodeCursor, isBool, isInt, isStr } from "../lib/cursor.mjs";
import { categoryOf, metadataOf } from "../lib/metadata.mjs";
import { extensionOf, parsePath } from "../lib/paths.mjs";
import { openStore } from "../lib/store.mjs";
import { jsonSize, parseTimestamp, tagOf } from "../lib/util.mjs";
import { PAGE_BUDGET } from "./list.mjs";

const CATEGORIES = ["image", "document", "pdf", "spreadsheet", "presentation", "audio", "video", "folder", "paper", "others"];
const fold = (text) => text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
const words = (text) => fold(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);

function compareKeys(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function folderOf(context, store, value) {
  const parsed = parsePath(value ?? "", { root: true });
  if (parsed.kind === "malformed") lookupFail(context, "path", "malformed_path");
  if (parsed.kind === "root") return "";
  const entry = store.live.get(parsed.lower);
  if (entry === undefined) lookupFail(context, "path", "not_found");
  if (entry.tag !== "folder") lookupFail(context, "path", "not_folder");
  return entry.pathLower;
}

function run(store, query) {
  const tokens = words(query.q);
  const extensions = new Set(query.ex.map((e) => e.toLowerCase().replace(/^\./, "")));
  const categories = new Set(query.ca);
  const pool = query.fs === "deleted" ? [...store.dead.values()].filter((e) => !store.live.has(e.pathLower)) : [...store.live.values()];
  const hits = [];
  for (const entry of pool) {
    if (query.p !== "" && !entry.pathLower.startsWith(`${query.p}/`)) continue;
    if (extensions.size > 0 && (entry.tag !== "file" || !extensions.has(extensionOf(entry.name)))) continue;
    if (categories.size > 0 && !categories.has(categoryOf(entry))) continue;
    const nameWords = words(entry.name);
    const nameHit = tokens.every((t) => nameWords.some((w) => w.startsWith(t)));
    let contentHit = false;
    if (!query.fo && entry.tag === "file" && !entry.deleted && entry.contentKind === "text") {
      const haystack = ` ${words(entry.content).join(" ")}`;
      contentHit = tokens.every((t) => haystack.includes(` ${t}`));
    }
    if (!nameHit && !contentHit) continue;
    const matchType = nameHit && contentHit ? "filename_and_content" : nameHit ? "filename" : "file_content";
    const key = query.ob === "last_modified_time"
      ? [-(parseTimestamp(entry.serverModified ?? "") ?? 0), 0, entry.pathLower]
      : [nameHit ? 0 : 1, Math.max(0, nameWords.length - tokens.length), entry.pathLower];
    hits.push({ entry, matchType, key });
  }
  return hits.sort((a, b) => compareKeys(a.key, b.key));
}

function page(store, query) {
  const hits = run(store, query).filter((hit) => query.last === null || compareKeys(hit.key, query.last) > 0);
  const matches = [];
  let used = 0;
  let last = null;
  for (const hit of hits) {
    const match = { match_type: { ".tag": hit.matchType }, metadata: { ".tag": "metadata", metadata: metadataOf(hit.entry) } };
    const size = jsonSize(match) + 1;
    if (matches.length >= query.m || used + size > PAGE_BUDGET) break;
    used += size;
    matches.push(match);
    last = hit.key;
  }
  const hasMore = matches.length < hits.length;
  const result = { matches, has_more: hasMore };
  if (hasMore) result.cursor = encodeCursor({ ...query, last });
  return result;
}

export function search(input, context) {
  const account = callerAccount(context, "files.metadata.read");
  const query = input.query;
  const tokens = words(query);
  if (query.includes(String.fromCharCode(0xfffd)) || tokens.length === 0 || tokens.length > 32) {
    failUnion(context, "INVALID_ARGUMENT", { ".tag": "invalid_argument" }, "invalid_argument: the query must contain 1 to 32 words");
  }
  const options = input.options ?? {};
  const store = openStore(context, account);
  const folder = folderOf(context, store, options.path);
  return page(store, {
    v: 1, k: "sr", a: account.accountId, q: query, p: folder, m: options.max_results ?? 100, ob: tagOf(options.order_by) ?? "relevance",
    fs: tagOf(options.file_status) ?? "active", fo: options.filename_only === true, ex: options.file_extensions ?? [], ca: (options.file_categories ?? []).map(tagOf), last: null,
  });
}

export function searchContinue(input, context) {
  const account = callerAccount(context, "files.metadata.read");
  const q = decodeCursor(input.cursor, "sr", account.accountId);
  const valid = q !== null && isStr(q.q, 1000) && q.q.length > 0 && isStr(q.p) && isInt(q.m, 1, 1000) &&
    (q.ob === "relevance" || q.ob === "last_modified_time") && (q.fs === "active" || q.fs === "deleted") && isBool(q.fo) &&
    Array.isArray(q.ex) && q.ex.length <= 100 && q.ex.every((e) => isStr(e, 255)) &&
    Array.isArray(q.ca) && q.ca.length <= 10 && q.ca.every((c) => CATEGORIES.includes(c)) &&
    Array.isArray(q.last) && q.last.length === 3 && Number.isSafeInteger(q.last[0]) && Number.isSafeInteger(q.last[1]) && isStr(q.last[2]) &&
    words(q.q).length > 0 && words(q.q).length <= 32;
  if (!valid) failText(context, "BAD_REQUEST", 'Invalid "cursor" parameter');
  const store = openStore(context, account);
  if (q.p !== "") {
    const folder = store.live.get(q.p);
    if (folder === undefined || folder.tag !== "folder") lookupFail(context, "path", "not_found");
  }
  return page(store, q);
}
