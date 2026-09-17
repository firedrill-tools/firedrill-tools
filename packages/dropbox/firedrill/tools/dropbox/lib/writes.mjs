// Shared write rules: WriteError unions, ancestor checks, implicit parent folders, autorename, quota and events.
import { failUnion, tooManyFiles } from "./errors.mjs";
import { depth, disallowedName, nameOf, parsePath, renamed } from "./paths.mjs";
import { journal, newEntryId, putEntry, reserveEntries, scanPrefix, usedBytes } from "./store.mjs";

const REASON_CODE = new Map([
  ["conflict", "CONFLICT"],
  ["disallowed_name", "DISALLOWED_NAME"],
  ["insufficient_space", "INSUFFICIENT_SPACE"],
  ["malformed_path", "MALFORMED_PATH"],
  ["not_found", "NOT_FOUND"],
  ["not_file", "NOT_FILE"],
  ["not_folder", "NOT_FOLDER"],
]);

/** Fails with a WriteError/LookupError `reason` wrapped by the route's `shape`. */
export function failWrite(context, shape, reason) {
  const value = typeof reason === "string" ? { ".tag": reason } : reason;
  failUnion(context, REASON_CODE.get(value[".tag"]), shape(value));
}

export const conflict = (kind) => ({ ".tag": "conflict", conflict: { ".tag": kind } });

/** Name, depth and ancestor rules for a destination path (a parsed `path`). */
export function checkWritePath(store, parsed, shape) {
  const name = parsed.segments[parsed.segments.length - 1];
  if (disallowedName(name)) failWrite(store.context, shape, "disallowed_name");
  if (depth(parsed.display) > store.lim.depth) tooManyFiles(store.context, "the folder depth", store.lim.depth);
  const lowerSegments = parsed.lower.slice(1).split("/");
  let prefix = "";
  for (let i = 0; i < lowerSegments.length - 1; i += 1) {
    prefix += `/${lowerSegments[i]}`;
    const live = store.live.get(prefix);
    if (live !== undefined && live.tag === "file") failWrite(store.context, shape, conflict("file_ancestor"));
  }
}

/** Creates (or revives) a folder row at an exact lower/display path and journals it. */
export function makeFolder(store, pathLower, pathDisplay) {
  const dead = store.dead.get(pathLower);
  let id;
  if (dead !== undefined && dead.tag === "folder") id = dead.id;
  else {
    reserveEntries(store, 1);
    id = newEntryId(store);
  }
  const entry = putEntry(store, { accountId: store.accountId, id, tag: "folder", name: nameOf(pathDisplay), pathLower, pathDisplay, deleted: false });
  journal(store, entry, "upsert");
  return entry;
}

/** Creates missing ancestor folders; returns the display path of the parent (existing folders keep their casing). */
export function ensureParents(store, parsed) {
  const lowerSegments = parsed.lower.slice(1).split("/");
  let lowerPrefix = "";
  let display = "";
  for (let i = 0; i < parsed.segments.length - 1; i += 1) {
    lowerPrefix += `/${lowerSegments[i]}`;
    const live = store.live.get(lowerPrefix);
    if (live !== undefined) {
      display = live.pathDisplay;
      continue;
    }
    display = `${display}/${parsed.segments[i]}`;
    makeFolder(store, lowerPrefix, display);
  }
  return display;
}

/** First free "name (n)" sibling path, as a parsed path, or null after 1,000 attempts. */
export function autorename(store, parsed, isFile) {
  for (let n = 1; n <= 1000; n += 1) {
    const candidate = parsePath(renamed(parsed.display, n, isFile));
    if (candidate.kind !== "path") return null;
    if (!store.live.has(candidate.lower)) return candidate;
  }
  return null;
}

/** Fails when adding `delta` bytes would exceed the account's allocation. */
export function checkQuota(store, delta, fail) {
  if (delta > 0 && usedBytes(store) + delta > store.account.allocated) fail();
}

export function accountLinks(store) {
  return scanPrefix(store.context, "shared_links", `${store.accountId}/`, store.lim.links, "the account's shared links");
}

export function changed(store, change, entry, extra = {}) {
  const payload = { account_id: store.accountId, change, id: entry.id, path_lower: entry.pathLower, ...extra };
  if (entry.tag === "file" && entry.rev !== undefined) payload.rev = entry.rev;
  store.context.events.emit("files.changed", payload);
}
