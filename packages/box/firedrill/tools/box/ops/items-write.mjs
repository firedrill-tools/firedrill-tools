// folders.create, folders.update / files.update (rename, describe, tag, move) and folders.delete / files.delete (trash).
import { MAX_DEPTH, WRITE, DROP, can, depthOf, isWithin, nameConflict, requireDestination, requireFile, requireFolder } from "../lib/access.mjs";
import { badParam, checkName, denied, fail } from "../lib/errors.mjs";
import { fullFile, fullFolder, miniOf, parseFields } from "../lib/render.mjs";
import { allocateId, appendLog, reserveObjects, saveMeta } from "../lib/store.mjs";
import { extensionOf } from "../lib/util.mjs";
import { begin, checkIfMatch, descendants, putItem, subtreeHeight } from "./common.mjs";

export function conflictFail(context, conflict, asArray = false) {
  const mini = miniOf(conflict.kind, conflict.item);
  fail(context, "ITEM_NAME_IN_USE", "Item with the same name already exists", { conflicts: asArray ? [mini] : mini });
}

export function createFolder(input, context) {
  const { user, meta, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  const destination = requireDestination(context, index, user, input.parent, DROP);
  checkName(context, input.name);
  const conflict = nameConflict(index, destination.parentId, destination.ownerId, input.name);
  if (conflict !== null) conflictFail(context, conflict);
  if (depthOf(index, destination.parentId) + 1 > MAX_DEPTH) badParam(context, "parent", `folders can be nested at most ${MAX_DEPTH} levels deep`);
  reserveObjects(context, meta, 1);
  const now = context.clock.nowUs();
  const folder = {
    id: allocateId(context, meta, "nextFolderId"), name: input.name, description: "", parentId: destination.parentId, ownerId: destination.ownerId,
    createdBy: user.id, modifiedBy: user.id, createdAtUs: now, modifiedAtUs: now, contentCreatedAtUs: now, contentModifiedAtUs: now,
    etag: 0, sequenceId: 0, itemStatus: "active", trashedAtUs: null, trashedBy: null, trashRoot: false, tags: [], canNonOwnersInvite: true,
  };
  putItem(context, index, "folder", folder);
  appendLog(context, meta, { eventType: "ITEM_CREATE", createdBy: user.id, sourceType: "folder", sourceId: folder.id, itemType: "folder", itemId: folder.id });
  saveMeta(context, meta);
  return fullFolder(index, user, folder, fields, { total_count: 0, entries: [], offset: 0, limit: 100, order: [{ by: "type", direction: "ASC" }, { by: "name", direction: "ASC" }] });
}

function updateItem(kind, input, context) {
  const { user, meta, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  const id = kind === "folder" ? input.folder_id : input.file_id;
  if (kind === "folder" && id === "0") denied(context);
  const { item, access } = kind === "folder"
    ? (({ folder, access: a }) => ({ item: folder, access: a }))(requireFolder(context, index, user, id))
    : (({ file, access: a }) => ({ item: file, access: a }))(requireFile(context, index, user, id));
  checkIfMatch(context, item, input.if_match);
  if (!can(access, ...WRITE)) denied(context);
  const next = { ...item };
  if (input.name !== undefined && input.name !== item.name) {
    checkName(context, input.name);
    next.name = input.name;
  }
  if (input.description !== undefined) next.description = input.description;
  if (input.tags !== undefined) next.tags = [...input.tags];
  if (input.can_non_owners_invite !== undefined) {
    if (item.ownerId !== user.id && access.role !== "co-owner") denied(context);
    next.canNonOwnersInvite = input.can_non_owners_invite;
  }
  if (input.parent !== undefined && input.parent?.id !== item.parentId) {
    const destination = requireDestination(context, index, user, input.parent, WRITE, "BAD_REQUEST");
    if (destination.parentId === "0" && item.ownerId !== user.id) denied(context);
    if (kind === "folder" && destination.parentId !== "0" && isWithin(index, destination.parentId, item.id)) {
      badParam(context, "parent", "A folder cannot be moved into itself or one of its subfolders");
    }
    if (kind === "folder" && depthOf(index, destination.parentId) + subtreeHeight(index, item.id) > MAX_DEPTH) {
      badParam(context, "parent", `folders can be nested at most ${MAX_DEPTH} levels deep`);
    }
    next.parentId = destination.parentId;
  }
  const renamed = next.name !== item.name;
  const moved = next.parentId !== item.parentId;
  if (renamed || moved) {
    const conflict = nameConflict(index, next.parentId, next.parentId === "0" ? item.ownerId : undefined, next.name, item.id);
    if (conflict !== null) conflictFail(context, conflict);
  }
  const changed = renamed || moved || next.description !== item.description || JSON.stringify(next.tags) !== JSON.stringify(item.tags)
    || next.canNonOwnersInvite !== item.canNonOwnersInvite;
  if (!changed) return kind === "folder" ? fullFolder(index, user, item, fields) : fullFile(index, user, item, fields);
  if (kind === "file" && renamed) next.extension = extensionOf(next.name);
  Object.assign(next, { etag: item.etag + 1, sequenceId: item.sequenceId + 1, modifiedAtUs: context.clock.nowUs(), modifiedBy: user.id });
  putItem(context, index, kind, next, item.parentId);
  const eventType = moved ? "ITEM_MOVE" : renamed ? "ITEM_RENAME" : "ITEM_MODIFY";
  appendLog(context, meta, { eventType, createdBy: user.id, sourceType: kind, sourceId: item.id, itemType: kind, itemId: item.id });
  saveMeta(context, meta);
  return kind === "folder" ? fullFolder(index, user, next, fields) : fullFile(index, user, next, fields);
}

export const updateFolder = (input, context) => updateItem("folder", input, context);
export const updateFile = (input, context) => updateItem("file", input, context);

function trashItem(kind, input, context) {
  const { user, meta, index } = begin(context, input);
  const id = kind === "folder" ? input.folder_id : input.file_id;
  if (kind === "folder" && id === "0") denied(context);
  const { item, access } = kind === "folder"
    ? (({ folder, access: a }) => ({ item: folder, access: a }))(requireFolder(context, index, user, id))
    : (({ file, access: a }) => ({ item: file, access: a }))(requireFile(context, index, user, id));
  checkIfMatch(context, item, input.if_match);
  if (!can(access, ...WRITE)) denied(context);
  const now = context.clock.nowUs();
  const inside = kind === "folder" ? descendants(index, item.id) : [];
  if (inside.length > 0 && input.recursive !== true) fail(context, "FOLDER_NOT_EMPTY", "Folder is not empty; pass recursive=true to delete it with its contents");
  for (const child of inside) {
    putItem(context, index, child.kind, { ...child.item, itemStatus: "trashed", trashRoot: false, trashedAtUs: now, trashedBy: user.id });
  }
  const next = { ...item, itemStatus: "trashed", trashRoot: true, trashedAtUs: now, trashedBy: user.id, etag: item.etag + 1, sequenceId: item.sequenceId + 1 };
  putItem(context, index, kind, next);
  appendLog(context, meta, { eventType: "ITEM_TRASH", createdBy: user.id, sourceType: kind, sourceId: item.id, itemType: kind, itemId: item.id });
  saveMeta(context, meta);
  context.events.emit("item.trashed", {
    itemType: kind, itemId: item.id, name: item.name, parentId: item.parentId, ownerId: item.ownerId, trashedBy: user.id, descendantCount: inside.length,
  });
  return {};
}

export const deleteFolder = (input, context) => trashItem("folder", input, context);
export const deleteFile = (input, context) => trashItem("file", input, context);
