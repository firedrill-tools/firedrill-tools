// files/restore: writes a new revision whose content equals an earlier one (also un-deletes a deleted file).
import { callerAccount } from "../lib/account.mjs";
import { failUnion } from "../lib/errors.mjs";
import { fileMetadata } from "../lib/metadata.mjs";
import { nameOf, parsePath } from "../lib/paths.mjs";
import { commit, journal, newRev, openStore, putEntry, putRevision, revisionsOf } from "../lib/store.mjs";
import { timestamp } from "../lib/util.mjs";
import { changed, checkQuota, checkWritePath, conflict, ensureParents, failWrite } from "../lib/writes.mjs";

const lookupShape = (reason) => ({ ".tag": "path_lookup", path_lookup: reason });
const writeShape = (reason) => ({ ".tag": "path_write", path_write: reason });

export function restore(input, context) {
  const account = callerAccount(context, "files.content.write");
  const parsed = parsePath(input.path);
  if (parsed.kind !== "path") failWrite(context, lookupShape, "malformed_path");
  const store = openStore(context, account);
  const live = store.live.get(parsed.lower);
  if (live !== undefined && live.tag === "folder") failWrite(context, writeShape, conflict("folder"));
  const dead = store.dead.get(parsed.lower);
  const target = live ?? (dead !== undefined && dead.tag === "file" ? dead : undefined);
  if (target === undefined) failWrite(context, lookupShape, "not_found");
  const version = revisionsOf(store, target.id).find((row) => row.rev === input.rev && !row.isDeleteMarker);
  if (version === undefined) failUnion(context, "INVALID_REVISION", { ".tag": "invalid_revision" });
  checkWritePath(store, parsed, writeShape);
  checkQuota(store, version.size - (live?.size ?? 0), () => failWrite(context, writeShape, "insufficient_space"));
  const pathDisplay = live !== undefined ? live.pathDisplay : `${ensureParents(store, parsed)}/${nameOf(target.pathDisplay)}`;
  const entry = putEntry(store, {
    ...target,
    pathLower: parsed.lower,
    pathDisplay,
    name: nameOf(pathDisplay),
    deleted: false,
    deletedAt: undefined,
    rev: newRev(store),
    size: version.size,
    contentHash: version.contentHash,
    clientModified: version.clientModified,
    serverModified: timestamp(context.clock.nowUs()),
    contentKind: version.contentKind,
    content: version.content,
  });
  putRevision(store, entry, false);
  journal(store, entry, "upsert");
  changed(store, "restored", entry);
  commit(store);
  return fileMetadata(entry);
}
