// files.upload and files.upload-version: UTF-8 text content up to 256 KiB, SHA-1 computed over the bytes.
import { DROP, WRITE, can, nameConflict, requireDestination, requireFile } from "../lib/access.mjs";
import { checkName, denied, fail } from "../lib/errors.mjs";
import { fullFile, parseFields } from "../lib/render.mjs";
import { sha1Hex } from "../lib/sha1.mjs";
import { allocateId, appendLog, reserveObjects, saveMeta } from "../lib/store.mjs";
import { extensionOf, pad, utf8Encode } from "../lib/util.mjs";
import { begin, checkIfMatch, putItem, timestampInput } from "./common.mjs";
import { conflictFail } from "./items-write.mjs";

export const CONTENT_CAP = 262144;

/** Size, per-file limit and quota checks for content charged to `ownerId`; returns { bytes, size }. */
export function checkContent(context, index, ownerId, content) {
  const bytes = utf8Encode(content);
  const owner = index.users.get(ownerId);
  if (bytes.length > CONTENT_CAP || (owner !== undefined && bytes.length > owner.maxUploadSize)) {
    fail(context, "FILE_SIZE_LIMIT_EXCEEDED", "File size exceeds the folder owner's file size limit");
  }
  if (owner !== undefined && owner.spaceUsed + bytes.length > owner.spaceAmount) {
    fail(context, "STORAGE_LIMIT_EXCEEDED", "Account storage limit reached");
  }
  return { bytes, size: bytes.length };
}

export function chargeOwner(context, index, ownerId, size) {
  const owner = index.users.get(ownerId);
  if (owner === undefined) return;
  const next = { ...owner, spaceUsed: owner.spaceUsed + size };
  context.state.put("users", ownerId, next);
  index.users.set(ownerId, next);
}

/** Writes a version row and its content blob. */
export function writeVersion(context, meta, file, versionNumber, name, content, size, sha1, uploaderId, now) {
  const versionId = allocateId(context, meta, "nextVersionId");
  context.state.put("versions", `${file.id}:${pad(versionNumber, 6)}`, {
    id: versionId, fileId: file.id, versionNumber, name, size, sha1, uploaderId, createdAtUs: now,
  });
  context.state.put("blobs", versionId, { fileId: file.id, versionNumber, content });
  return versionId;
}

export function uploadFile(input, context) {
  const { user, meta, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  const destination = requireDestination(context, index, user, input.parent, DROP);
  checkName(context, input.name);
  const createdAt = timestampInput(context, "content_created_at", input.content_created_at);
  const modifiedAt = timestampInput(context, "content_modified_at", input.content_modified_at);
  const conflict = nameConflict(index, destination.parentId, destination.ownerId, input.name);
  if (conflict !== null) conflictFail(context, conflict, true);
  const { bytes, size } = checkContent(context, index, destination.ownerId, input.content);
  reserveObjects(context, meta, 2);
  const now = context.clock.nowUs();
  const sha1 = sha1Hex(bytes);
  const file = {
    id: allocateId(context, meta, "nextFileId"), name: input.name, description: "", parentId: destination.parentId, ownerId: destination.ownerId,
    createdBy: user.id, modifiedBy: user.id, createdAtUs: now, modifiedAtUs: now, contentCreatedAtUs: createdAt ?? now,
    contentModifiedAtUs: modifiedAt ?? now, etag: 0, sequenceId: 0, itemStatus: "active", trashedAtUs: null, trashedBy: null, trashRoot: false,
    tags: [], extension: extensionOf(input.name), size, sha1, currentVersionId: "", versionNumber: 1, commentCount: 0,
  };
  file.currentVersionId = writeVersion(context, meta, file, 1, file.name, input.content, size, sha1, user.id, now);
  putItem(context, index, "file", file);
  chargeOwner(context, index, destination.ownerId, size);
  appendLog(context, meta, { eventType: "ITEM_UPLOAD", createdBy: user.id, sourceType: "file", sourceId: file.id, itemType: "file", itemId: file.id });
  saveMeta(context, meta);
  context.events.emit("file.uploaded", {
    fileId: file.id, versionId: file.currentVersionId, parentId: file.parentId, name: file.name, size, sha1, ownerId: file.ownerId, uploadedBy: user.id, isNewVersion: false,
  });
  return { total_count: 1, entries: [fullFile(index, user, file, fields)] };
}

export function uploadVersion(input, context) {
  const { user, meta, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  const { file, access } = requireFile(context, index, user, input.file_id);
  checkIfMatch(context, file, input.if_match);
  if (!can(access, ...WRITE)) denied(context);
  const name = input.name ?? file.name;
  if (name !== file.name) {
    checkName(context, name);
    const conflict = nameConflict(index, file.parentId, file.ownerId, name, file.id);
    if (conflict !== null) conflictFail(context, conflict, true);
  }
  const modifiedAt = timestampInput(context, "content_modified_at", input.content_modified_at);
  const { bytes, size } = checkContent(context, index, file.ownerId, input.content);
  reserveObjects(context, meta, 1);
  const now = context.clock.nowUs();
  const sha1 = sha1Hex(bytes);
  const versionNumber = file.versionNumber + 1;
  const versionId = writeVersion(context, meta, file, versionNumber, name, input.content, size, sha1, user.id, now);
  const next = {
    ...file, name, extension: extensionOf(name), size, sha1, currentVersionId: versionId, versionNumber, etag: file.etag + 1,
    sequenceId: file.sequenceId + 1, modifiedAtUs: now, modifiedBy: user.id, contentModifiedAtUs: modifiedAt ?? now,
  };
  putItem(context, index, "file", next);
  chargeOwner(context, index, file.ownerId, size);
  appendLog(context, meta, { eventType: "ITEM_UPLOAD", createdBy: user.id, sourceType: "file", sourceId: file.id, itemType: "file", itemId: file.id });
  saveMeta(context, meta);
  context.events.emit("file.uploaded", {
    fileId: file.id, versionId, parentId: file.parentId, name, size, sha1, ownerId: file.ownerId, uploadedBy: user.id, isNewVersion: true,
  });
  return { total_count: 1, entries: [fullFile(index, user, next, fields)] };
}
