// files/list_folder, files/list_folder/continue and files/list_folder/get_latest_cursor.
// A listing pages a snapshot ordered by path_lower (resuming after the last returned path), then — like Dropbox —
// the same cursor returns only the changes recorded in the journal since the snapshot.
import { callerAccount } from "../lib/account.mjs";
import { failText, failUnion, lookupFail } from "../lib/errors.mjs";
import { decodeCursor, encodeCursor, isBool, isInt, isStr } from "../lib/cursor.mjs";
import { deletedMetadata, metadataOf } from "../lib/metadata.mjs";
import { nameOf, parsePath } from "../lib/paths.mjs";
import { journalHead, journalRowId, openStore } from "../lib/store.mjs";
import { jsonSize } from "../lib/util.mjs";

export const PAGE_BUDGET = 900_000 - 16_000;

export function inScope(pathLower, folder, recursive) {
  if (folder === "") return recursive || pathLower.lastIndexOf("/") === 0;
  if (recursive && pathLower === folder) return true;
  if (!pathLower.startsWith(`${folder}/`)) return false;
  return recursive || !pathLower.slice(folder.length + 1).includes("/");
}

/** Resolves the listed folder: root, a folder path or a folder id. */
function listedFolder(context, store, pathValue) {
  const parsed = parsePath(pathValue, { root: true, id: true });
  if (parsed.kind === "malformed") lookupFail(context, "path", "malformed_path");
  if (parsed.kind === "root") return "";
  const entry = parsed.kind === "path" ? store.live.get(parsed.lower) : store.byId.get(parsed.id);
  if (entry === undefined || entry.deleted) lookupFail(context, "path", "not_found");
  if (entry.tag !== "folder") lookupFail(context, "path", "not_folder");
  return entry.pathLower;
}

function snapshotPage(store, cursor) {
  const rows = [];
  for (const entry of store.live.values()) {
    if (inScope(entry.pathLower, cursor.p, cursor.r) && (cursor.o === null || entry.pathLower > cursor.o)) rows.push(entry);
  }
  if (cursor.d) {
    for (const entry of store.dead.values()) {
      if (store.live.has(entry.pathLower)) continue;
      if (inScope(entry.pathLower, cursor.p, cursor.r) && (cursor.o === null || entry.pathLower > cursor.o)) rows.push(entry);
    }
  }
  rows.sort((a, b) => (a.pathLower < b.pathLower ? -1 : a.pathLower > b.pathLower ? 1 : 0));
  const entries = [];
  let used = 0;
  for (const entry of rows) {
    const metadata = metadataOf(entry);
    const size = jsonSize(metadata) + 1;
    if (entries.length >= cursor.l || used + size > PAGE_BUDGET) break;
    used += size;
    entries.push(metadata);
  }
  const hasMore = entries.length < rows.length;
  const next = hasMore ? { ...cursor, o: entries[entries.length - 1].path_lower } : { ...cursor, s: 0, o: null };
  return { entries, cursor: encodeCursor(next), has_more: hasMore };
}

function changesPage(context, store, cursor) {
  if (cursor.j + 1 < store.c.journalFloor) failUnion(context, "RESET", { ".tag": "reset" });
  const head = journalHead(store);
  const rows = cursor.j >= head ? [] : context.state.scan("journal", { afterRowId: journalRowId(cursor.j), limit: store.lim.journal + 1 });
  const latest = new Map();
  let consumed = cursor.j;
  let used = 0;
  let hasMore = false;
  for (const record of rows) {
    const row = record.value;
    if (row.accountId === store.accountId && inScope(row.pathLower, cursor.p, cursor.r) && !latest.has(row.pathLower)) {
      const live = store.live.get(row.pathLower);
      const metadata = live !== undefined ? metadataOf(live) : deletedMetadata({ name: nameOf(row.pathDisplay), pathLower: row.pathLower, pathDisplay: row.pathDisplay });
      const size = jsonSize(metadata) + 1;
      if (latest.size >= cursor.l || used + size > PAGE_BUDGET) {
        hasMore = true;
        break;
      }
      used += size;
      latest.set(row.pathLower, metadata);
    }
    consumed = row.seq;
  }
  if (!hasMore) consumed = Math.max(consumed, head);
  // A path changed several times appears once, with its current state (Dropbox collapses changes the same way).
  return { entries: [...latest.values()], cursor: encodeCursor({ ...cursor, s: 0, o: null, j: consumed }), has_more: hasMore };
}

export function listFolder(input, context) {
  const account = callerAccount(context, "files.metadata.read");
  const store = openStore(context, account);
  const folder = listedFolder(context, store, input.path);
  const cursor = { v: 1, k: "lf", a: account.accountId, p: folder, r: input.recursive === true, d: input.include_deleted === true, j: journalHead(store), o: null, l: input.limit ?? 500, s: 1 };
  return snapshotPage(store, cursor);
}

export function listFolderContinue(input, context) {
  const account = callerAccount(context, "files.metadata.read");
  const cursor = decodeCursor(input.cursor, "lf", account.accountId);
  const valid = cursor !== null && isStr(cursor.p) && isBool(cursor.r) && isBool(cursor.d) && isInt(cursor.j) &&
    (cursor.o === null || isStr(cursor.o)) && isInt(cursor.l, 1, 2000) && (cursor.s === 0 || cursor.s === 1);
  if (!valid) failText(context, "BAD_REQUEST", 'Invalid "cursor" parameter');
  const store = openStore(context, account);
  if (cursor.p !== "") {
    const folder = store.live.get(cursor.p);
    if (folder === undefined || folder.tag !== "folder") lookupFail(context, "path", "not_found");
  }
  return cursor.s === 1 ? snapshotPage(store, cursor) : changesPage(context, store, cursor);
}

export function listFolderGetLatestCursor(input, context) {
  const account = callerAccount(context, "files.metadata.read");
  const store = openStore(context, account);
  const folder = listedFolder(context, store, input.path);
  const cursor = { v: 1, k: "lf", a: account.accountId, p: folder, r: input.recursive === true, d: input.include_deleted === true, j: journalHead(store), o: null, l: input.limit ?? 500, s: 0 };
  return { cursor: encodeCursor(cursor) };
}
