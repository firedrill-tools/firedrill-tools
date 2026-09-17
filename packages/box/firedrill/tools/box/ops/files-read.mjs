// files.get, files.download, files.list-versions and files.restore.
import { READ, WRITE, accessOf, can, canSee, nameConflict, requireDestination, requireFile } from "../lib/access.mjs";
import { badParam, checkName, denied, notFound } from "../lib/errors.mjs";
import { offsetPage } from "../lib/listing.mjs";
import { fullFile, parseFields, select, userMini } from "../lib/render.mjs";
import { appendLog, saveMeta, scanPrefix } from "../lib/store.mjs";
import { isId, pad, rfc3339 } from "../lib/util.mjs";
import { begin, putItem } from "./common.mjs";
import { conflictFail } from "./items-write.mjs";

export function getFile(input, context) {
  const { user, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  const { file } = requireFile(context, index, user, input.file_id);
  return fullFile(index, user, file, fields);
}

/** The version row for `versionId` of `file`, or NOT_FOUND. */
export function versionOf(context, file, versionId) {
  if (!isId(versionId)) notFound(context, "file version");
  const blob = context.state.get("blobs", versionId);
  if (blob === null || blob.fileId !== file.id) notFound(context, "file version");
  const version = context.state.get("versions", `${file.id}:${pad(blob.versionNumber, 6)}`);
  if (version === null) notFound(context, "file version");
  return { version, content: blob.content };
}

export function download(input, context) {
  const { user, index } = begin(context, input);
  const { file, access } = requireFile(context, index, user, input.file_id);
  if (!can(access, ...READ)) denied(context);
  const { version, content } = versionOf(context, file, input.version ?? file.currentVersionId);
  return { file_id: file.id, version_id: version.id, name: file.name, content, size: version.size, sha1: version.sha1 };
}

const pickVersion = (full, fields) => (fields === null ? full : select(full, fields));

export function listVersions(input, context) {
  const { user, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  const { file, access } = requireFile(context, index, user, input.file_id);
  if (!can(access, ...READ)) denied(context);
  const rows = scanPrefix(context, "versions", `${file.id}:`).map((r) => r.value).filter((v) => v.id !== file.currentVersionId).reverse();
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 1000;
  const entries = offsetPage(context, rows, offset, limit, (v) => pickVersion({
    type: "file_version", id: v.id, sha1: v.sha1, name: v.name, size: v.size, created_at: rfc3339(v.createdAtUs), modified_at: rfc3339(v.createdAtUs),
    modified_by: userMini(index, v.uploaderId), trashed_at: null, purged_at: null, version_number: String(v.versionNumber),
  }, fields));
  return { total_count: rows.length, entries, offset, limit };
}

export function restore(input, context) {
  const { user, meta, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  const file = isId(input.file_id) ? index.files.get(input.file_id) : undefined;
  if (file === undefined || file.itemStatus !== "trashed" || !canSee(accessOf(index, user.id, "file", file), "file")) notFound(context, "trashed file");
  let parentId = file.parentId;
  let ownerRoot = file.ownerId;
  if (input.parent !== undefined) {
    const destination = requireDestination(context, index, user, input.parent, WRITE, "BAD_REQUEST");
    parentId = destination.parentId;
    if (parentId === "0") ownerRoot = user.id;
    if (parentId === "0" && file.ownerId !== user.id) denied(context);
  } else {
    if (!file.trashRoot) badParam(context, "parent", "The file was trashed with its folder; pass parent to restore it elsewhere");
    if (parentId !== "0") {
      const parent = index.folders.get(parentId);
      if (parent === undefined || parent.itemStatus !== "active") badParam(context, "parent", "The original parent folder is no longer available; pass parent");
      if (file.ownerId !== user.id && !can(accessOf(index, user.id, "folder", parent), ...WRITE)) denied(context);
    } else if (file.ownerId !== user.id) denied(context);
  }
  const name = input.name ?? file.name;
  if (input.name !== undefined) checkName(context, name);
  const conflict = nameConflict(index, parentId, ownerRoot, name, file.id);
  if (conflict !== null) conflictFail(context, conflict);
  const next = {
    ...file, name, parentId, itemStatus: "active", trashRoot: false, trashedAtUs: null, trashedBy: null, etag: file.etag + 1,
    sequenceId: file.sequenceId + 1, modifiedAtUs: context.clock.nowUs(), modifiedBy: user.id,
  };
  if (name !== file.name) {
    const dot = name.lastIndexOf(".");
    next.extension = dot > 0 && dot < name.length - 1 && name.length - dot - 1 <= 32 ? name.slice(dot + 1).toLowerCase() : "";
  }
  putItem(context, index, "file", next, file.parentId);
  appendLog(context, meta, { eventType: "ITEM_UNDELETE_VIA_TRASH", createdBy: user.id, sourceType: "file", sourceId: file.id, itemType: "file", itemId: file.id });
  saveMeta(context, meta);
  return fullFile(index, user, next, fields);
}

