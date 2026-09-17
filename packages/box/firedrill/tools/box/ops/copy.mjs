// files.copy and folders.copy: new rows owned by the destination folder's owner, storage charged to that owner.
import { DROP, MAX_DEPTH, READ, can, depthOf, isWithin, nameConflict, requireDestination, requireFile, requireFolder } from "../lib/access.mjs";
import { badParam, checkName, denied, fail } from "../lib/errors.mjs";
import { fullFile, fullFolder, parseFields } from "../lib/render.mjs";
import { allocateId, appendLog, reserveObjects, saveMeta } from "../lib/store.mjs";
import { begin, descendants, putItem, subtreeHeight } from "./common.mjs";
import { versionOf } from "./files-read.mjs";
import { conflictFail } from "./items-write.mjs";
import { chargeOwner, writeVersion } from "./uploads.mjs";

function checkStorage(context, index, ownerId, size) {
  const owner = index.users.get(ownerId);
  if (owner !== undefined && owner.spaceUsed + size > owner.spaceAmount) fail(context, "STORAGE_LIMIT_EXCEEDED", "Account storage limit reached");
}

function copyFileRow(context, meta, index, user, source, content, version, parentId, ownerId, name, now) {
  const file = {
    ...source, id: allocateId(context, meta, "nextFileId"), name, parentId, ownerId, createdBy: user.id, modifiedBy: user.id, createdAtUs: now,
    modifiedAtUs: now, etag: 0, sequenceId: 0, itemStatus: "active", trashedAtUs: null, trashedBy: null, trashRoot: false, tags: [...source.tags],
    size: version.size, sha1: version.sha1, versionNumber: 1, commentCount: 0,
  };
  file.currentVersionId = writeVersion(context, meta, file, 1, name, content, version.size, version.sha1, user.id, now);
  putItem(context, index, "file", file);
  return file;
}

export function copyFile(input, context) {
  const { user, meta, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  const { file, access } = requireFile(context, index, user, input.file_id);
  if (!can(access, ...READ)) denied(context);
  const { version, content } = versionOf(context, file, input.version ?? file.currentVersionId);
  const destination = requireDestination(context, index, user, input.parent, DROP);
  const name = input.name ?? file.name;
  checkName(context, name);
  const conflict = nameConflict(index, destination.parentId, destination.ownerId, name);
  if (conflict !== null) conflictFail(context, conflict);
  checkStorage(context, index, destination.ownerId, version.size);
  reserveObjects(context, meta, 2);
  const now = context.clock.nowUs();
  const copy = copyFileRow(context, meta, index, user, file, content, version, destination.parentId, destination.ownerId, name, now);
  chargeOwner(context, index, destination.ownerId, version.size);
  appendLog(context, meta, { eventType: "ITEM_COPY", createdBy: user.id, sourceType: "file", sourceId: copy.id, itemType: "file", itemId: copy.id });
  saveMeta(context, meta);
  return fullFile(index, user, copy, fields);
}

export function copyFolder(input, context) {
  const { user, meta, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  if (input.folder_id === "0") badParam(context, "folder_id", "The root folder cannot be copied");
  const { folder, access } = requireFolder(context, index, user, input.folder_id);
  if (!can(access, ...READ)) denied(context);
  const destination = requireDestination(context, index, user, input.parent, DROP);
  if (destination.parentId !== "0" && isWithin(index, destination.parentId, folder.id)) {
    badParam(context, "parent", "A folder cannot be copied into itself or one of its subfolders");
  }
  const name = input.name ?? folder.name;
  checkName(context, name);
  const conflict = nameConflict(index, destination.parentId, destination.ownerId, name);
  if (conflict !== null) conflictFail(context, conflict);
  if (depthOf(index, destination.parentId) + subtreeHeight(index, folder.id) > MAX_DEPTH) {
    badParam(context, "parent", `folders can be nested at most ${MAX_DEPTH} levels deep`);
  }
  const inside = descendants(index, folder.id);
  let objects = 1;
  let bytes = 0;
  for (const child of inside) {
    objects += child.kind === "file" ? 2 : 1;
    if (child.kind === "file") bytes += child.item.size;
  }
  reserveObjects(context, meta, objects);
  checkStorage(context, index, destination.ownerId, bytes);
  const now = context.clock.nowUs();
  const mapped = new Map();
  const cloneFolder = (source, parentId, folderName) => {
    const clone = {
      ...source, id: allocateId(context, meta, "nextFolderId"), name: folderName, parentId, ownerId: destination.ownerId, createdBy: user.id,
      modifiedBy: user.id, createdAtUs: now, modifiedAtUs: now, etag: 0, sequenceId: 0, itemStatus: "active", trashedAtUs: null, trashedBy: null,
      trashRoot: false, tags: [...source.tags],
    };
    putItem(context, index, "folder", clone);
    mapped.set(source.id, clone.id);
    return clone;
  };
  const root = cloneFolder(folder, destination.parentId, name);
  for (const child of inside) {
    const parentId = mapped.get(child.item.parentId);
    if (child.kind === "folder") cloneFolder(child.item, parentId, child.item.name);
    else {
      const { version, content } = versionOf(context, child.item, child.item.currentVersionId);
      copyFileRow(context, meta, index, user, child.item, content, version, parentId, destination.ownerId, child.item.name, now);
    }
  }
  chargeOwner(context, index, destination.ownerId, bytes);
  appendLog(context, meta, { eventType: "ITEM_COPY", createdBy: user.id, sourceType: "folder", sourceId: root.id, itemType: "folder", itemId: root.id });
  saveMeta(context, meta);
  return fullFolder(index, user, root, fields);
}
