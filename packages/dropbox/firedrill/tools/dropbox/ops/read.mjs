// files/get_metadata, files/download and files/list_revisions.
import { callerAccount } from "../lib/account.mjs";
import { lookupFail } from "../lib/errors.mjs";
import { metadataOf, revisionMetadata, fileMetadata } from "../lib/metadata.mjs";
import { parsePath } from "../lib/paths.mjs";
import { findRevision, liveByRef, openStore, revisionsOf } from "../lib/store.mjs";
import { asciiJson } from "../lib/util.mjs";

/** Dropbox-API-Result must fit the framework's 16 KiB response-header budget (ASCII-escaped JSON). */
const RESULT_HEADER_BUDGET = 15000;

export function getMetadata(input, context) {
  const account = callerAccount(context, "files.metadata.read");
  const parsed = parsePath(input.path, { id: true, rev: true });
  if (parsed.kind === "malformed") lookupFail(context, "path", "malformed_path");
  const store = openStore(context, account);
  if (parsed.kind === "rev") {
    const row = findRevision(store, parsed.rev);
    if (row === null) lookupFail(context, "path", "not_found");
    return revisionMetadata(row);
  }
  const live = liveByRef(store, parsed);
  if (live !== null) return metadataOf(live);
  if (input.include_deleted === true) {
    const dead = parsed.kind === "path" ? store.dead.get(parsed.lower) : store.byId.get(parsed.id);
    if (dead !== undefined && dead.deleted) return metadataOf(dead);
  }
  lookupFail(context, "path", "not_found");
}

export function download(input, context) {
  const account = callerAccount(context, "files.content.read");
  const parsed = parsePath(input.path, { id: true, rev: true });
  if (parsed.kind === "malformed") lookupFail(context, "path", "malformed_path");
  const store = openStore(context, account);
  let row;
  if (parsed.kind === "rev") {
    row = findRevision(store, parsed.rev);
    if (row === null) lookupFail(context, "path", "not_found");
    row = { ...row, id: row.entryId };
  } else {
    const entry = liveByRef(store, parsed);
    if (entry === null) lookupFail(context, "path", "not_found");
    if (entry.tag !== "file") lookupFail(context, "path", "not_file");
    row = entry;
    if (input.rev !== undefined) {
      const version = revisionsOf(store, entry.id).find((r) => r.rev === input.rev && !r.isDeleteMarker);
      if (version === undefined) lookupFail(context, "path", "not_found");
      row = { ...version, id: entry.id };
    }
  }
  const metadata = fileMetadata(row);
  if (asciiJson(metadata).length > RESULT_HEADER_BUDGET) {
    context.fail({ code: "BAD_REQUEST", message: `the file's metadata is longer than the ${RESULT_HEADER_BUDGET}-byte Dropbox-API-Result header this service can send; read it with files/get_metadata` });
  }
  return { metadata, content_kind: row.contentKind, content: row.content };
}

export function listRevisions(input, context) {
  const account = callerAccount(context, "files.content.read");
  const parsed = parsePath(input.path, { id: true });
  if (parsed.kind === "malformed") lookupFail(context, "path", "malformed_path");
  const store = openStore(context, account);
  let entry = liveByRef(store, parsed);
  if (entry === null) {
    const dead = parsed.kind === "path" ? store.dead.get(parsed.lower) : store.byId.get(parsed.id);
    if (dead === undefined) lookupFail(context, "path", "not_found");
    entry = dead;
  }
  if (entry.tag !== "file") lookupFail(context, "path", "not_file");
  const limit = input.limit ?? 10;
  const versions = revisionsOf(store, entry.id)
    .filter((row) => !row.isDeleteMarker)
    .sort((a, b) => (a.rev < b.rev ? 1 : a.rev > b.rev ? -1 : 0));
  const result = { is_deleted: entry.deleted === true, entries: versions.slice(0, limit).map(revisionMetadata) };
  if (entry.deleted === true && entry.deletedAt !== undefined) result.server_deleted = entry.deletedAt;
  return result;
}
