// files/create_folder_v2, files/upload and files/delete_v2.
import { callerAccount } from "../lib/account.mjs";
import { failText, failUnion } from "../lib/errors.mjs";
import { fileMetadata, folderMetadata, metadataOf } from "../lib/metadata.mjs";
import { parsePath, within } from "../lib/paths.mjs";
import { contentHash } from "../lib/sha256.mjs";
import { commit, liveByRef, newEntryId, newRev, openStore, putEntry, putRevision, journal, reserveEntries } from "../lib/store.mjs";
import { parseTimestamp, timestamp, utf8Encode, utf8Size } from "../lib/util.mjs";
import { accountLinks, autorename, changed, checkQuota, checkWritePath, conflict, ensureParents, failWrite, makeFolder } from "../lib/writes.mjs";

const createShape = (reason) => ({ ".tag": "path", path: reason });
const uploadShape = (reason) => ({ ".tag": "path", path: { reason, upload_session_id: "" } });

export function createFolder(input, context) {
  const account = callerAccount(context, "files.content.write");
  let parsed = parsePath(input.path);
  if (parsed.kind !== "path") failWrite(context, createShape, "malformed_path");
  const store = openStore(context, account);
  checkWritePath(store, parsed, createShape);
  const existing = store.live.get(parsed.lower);
  if (existing !== undefined) {
    const renamedPath = input.autorename === true ? autorename(store, parsed, false) : null;
    if (renamedPath === null) failWrite(context, createShape, conflict(existing.tag));
    parsed = renamedPath;
  }
  const parent = ensureParents(store, parsed);
  const folder = makeFolder(store, parsed.lower, `${parent}/${parsed.segments[parsed.segments.length - 1]}`);
  changed(store, "added", folder);
  commit(store);
  return { metadata: folderMetadata(folder) };
}

function normalizeMode(mode) {
  if (mode === undefined || mode === "add" || mode?.[".tag"] === "add") return { tag: "add" };
  if (mode === "overwrite" || mode?.[".tag"] === "overwrite") return { tag: "overwrite" };
  return { tag: "update", rev: mode.update };
}

export function upload(input, context) {
  const account = callerAccount(context, "files.content.write");
  let parsed = parsePath(input.path);
  if (parsed.kind !== "path") failWrite(context, uploadShape, "malformed_path");
  const content = input.content;
  const size = utf8Size(content);
  const store = openStore(context, account, false);
  if (size > store.lim.uploadBytes) {
    failText(context, "PAYLOAD_TOO_LARGE", `request body is ${size} bytes; this service accepts uploads of at most ${store.lim.uploadBytes} bytes`);
  }
  const hash = contentHash(utf8Encode(content));
  if (input.content_hash !== undefined && input.content_hash !== hash) failText(context, "CONTENT_HASH_MISMATCH", "content_hash_mismatch");
  if (input.client_modified !== undefined && parseTimestamp(input.client_modified) === null) {
    failText(context, "BAD_REQUEST", 'client_modified: "' + input.client_modified + '" is not a valid timestamp');
  }
  const full = openStore(context, account);
  checkWritePath(full, parsed, uploadShape);
  const mode = normalizeMode(input.mode);
  let existing = full.live.get(parsed.lower);
  if (existing !== undefined) {
    const same = existing.tag === "file" && existing.contentHash === hash;
    const replace = existing.tag === "file" && (mode.tag === "overwrite" || (mode.tag === "update" && existing.rev === mode.rev));
    if (same && mode.tag !== "update") return fileMetadata(existing);
    if (same && replace) return fileMetadata(existing);
    if (!replace) {
      const renamedPath = input.autorename === true ? autorename(full, parsed, true) : null;
      if (renamedPath === null) failWrite(context, uploadShape, conflict(existing.tag));
      parsed = renamedPath;
      existing = undefined;
    }
  } else if (mode.tag === "update") {
    failWrite(context, uploadShape, conflict("file"));
  }
  checkQuota(full, size - (existing?.size ?? 0), () => failWrite(context, uploadShape, "insufficient_space"));
  const nowUs = context.clock.nowUs();
  const now = timestamp(nowUs);
  const display = existing !== undefined ? existing.pathDisplay : `${ensureParents(full, parsed)}/${parsed.segments[parsed.segments.length - 1]}`;
  const dead = full.dead.get(parsed.lower);
  let id = existing?.id;
  if (id === undefined && dead !== undefined && dead.tag === "file") id = dead.id;
  if (id === undefined) {
    reserveEntries(full, 1);
    id = newEntryId(full);
  }
  const entry = putEntry(full, {
    accountId: full.accountId, id, tag: "file", name: display.slice(display.lastIndexOf("/") + 1), pathLower: parsed.lower, pathDisplay: display,
    deleted: false, rev: newRev(full), size, contentHash: hash, clientModified: input.client_modified ?? now, serverModified: now,
    contentKind: "text", content,
  });
  putRevision(full, entry, false);
  journal(full, entry, "upsert");
  changed(full, existing !== undefined ? "modified" : "added", entry);
  commit(full);
  return fileMetadata(entry);
}

export function deleteEntry(input, context) {
  const account = callerAccount(context, "files.content.write");
  const parsed = parsePath(input.path, { id: true });
  if (parsed.kind === "malformed") failUnion(context, "MALFORMED_PATH", { ".tag": "path_lookup", path_lookup: { ".tag": "malformed_path" } });
  const store = openStore(context, account);
  const entry = liveByRef(store, parsed);
  if (entry === null) failUnion(context, "NOT_FOUND", { ".tag": "path_lookup", path_lookup: { ".tag": "not_found" } });
  if (input.parent_rev !== undefined && (entry.tag !== "file" || entry.rev !== input.parent_rev)) {
    failUnion(context, "CONFLICT", { ".tag": "path_write", path_write: conflict("file") });
  }
  const before = metadataOf(entry);
  const now = timestamp(context.clock.nowUs());
  const subtree = [...store.live.values()].filter((row) => within(row.pathLower, entry.pathLower));
  const ids = new Set(subtree.map((row) => row.id));
  for (const row of subtree) {
    const tomb = putEntry(store, { ...row, deleted: true, deletedAt: now });
    if (tomb.tag === "file") putRevision(store, tomb, true);
    journal(store, tomb, "delete");
  }
  for (const link of accountLinks(store)) {
    if (ids.has(link.entryId)) context.state.delete("shared_links", `${store.accountId}/${link.linkId}`);
  }
  changed(store, "deleted", entry);
  commit(store);
  return { metadata: before };
}
