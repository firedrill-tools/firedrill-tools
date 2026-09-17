// Box resource rendering from stored rows: mini and full items, users, path collections and `fields` selection.
import { READ, VIEW, WRITE, DROP, accessOf, can, canSee, MAX_DEPTH } from "./access.mjs";
import { badParam } from "./errors.mjs";
import { rfc3339 } from "./util.mjs";

const PURGE_US = 30 * 24 * 3600 * 1000000;
const EXTRA = ["permissions", "tags", "version_number", "comment_count", "has_collaborations", "can_non_owners_invite", "tagged_message"];
const ALWAYS = ["type", "id", "etag"];

/** Parses `fields` (comma-separated) into a Set, or null when absent. */
export function parseFields(context, fields) {
  if (fields === undefined) return null;
  if (typeof fields !== "string" || fields.length > 4000) badParam(context, "fields", "fields must be a comma-separated list");
  if (fields.includes("\uFFFD")) badParam(context, "fields", "fields contains malformed characters");
  const set = new Set();
  for (const part of fields.split(",")) {
    const name = part.trim();
    if (name.length > 0 && set.size < 100) set.add(name);
  }
  return set;
}

/** Applies Box field selection: without `fields` the extras are dropped; with it only type, id, etag and those fields remain. */
export function select(full, fields) {
  const out = {};
  if (fields === null) {
    for (const [key, value] of Object.entries(full)) if (!EXTRA.includes(key)) out[key] = value;
    return out;
  }
  for (const key of Object.keys(full)) if (ALWAYS.includes(key) || fields.has(key)) out[key] = full[key];
  return out;
}

export function userMini(index, id) {
  const user = index.users.get(id);
  return { type: "user", id, name: user?.name ?? "", login: user?.login ?? "" };
}

export function folderMini(folder) {
  if (folder.root === true) return { type: "folder", id: "0", sequence_id: null, etag: null, name: "All Files" };
  return { type: "folder", id: folder.id, sequence_id: String(folder.sequenceId), etag: String(folder.etag), name: folder.name };
}

export function fileMini(file) {
  return {
    type: "file", id: file.id, file_version: { type: "file_version", id: file.currentVersionId, sha1: file.sha1 },
    sequence_id: String(file.sequenceId), etag: String(file.etag), sha1: file.sha1, name: file.name,
  };
}

export const miniOf = (kind, item) => (kind === "folder" ? folderMini(item) : fileMini(item));

/** Ancestors of `parentId` the caller can see, root first ("All Files" always leads). */
export function pathCollection(index, user, parentId) {
  const chain = [];
  let current = parentId;
  for (let depth = 0; current !== "0" && depth <= MAX_DEPTH; depth += 1) {
    const folder = index.folders.get(current);
    if (folder === undefined || !canSee(accessOf(index, user.id, "folder", folder), "folder")) break;
    chain.push(folderMini(folder));
    current = folder.parentId;
  }
  chain.push(folderMini({ root: true }));
  chain.reverse();
  return { total_count: chain.length, entries: chain };
}

/** Sum of active descendant file sizes (bounded by the object cap). */
export function folderSize(index, folderId) {
  let size = 0;
  const stack = [folderId];
  let visited = 0;
  while (stack.length > 0 && visited <= 4000) {
    const id = stack.pop();
    visited += 1;
    for (const child of index.children.get(id) ?? []) {
      if (child.item.itemStatus !== "active") continue;
      if (child.kind === "file") size += child.item.size;
      else stack.push(child.item.id);
    }
  }
  return size;
}

function itemTimes(item) {
  const trashedAt = item.itemStatus === "trashed" && typeof item.trashedAtUs === "number" ? item.trashedAtUs : null;
  return {
    created_at: rfc3339(item.createdAtUs), modified_at: rfc3339(item.modifiedAtUs),
    trashed_at: trashedAt === null ? null : rfc3339(trashedAt), purged_at: trashedAt === null ? null : rfc3339(trashedAt + PURGE_US),
    content_created_at: rfc3339(item.contentCreatedAtUs), content_modified_at: rfc3339(item.contentModifiedAtUs),
  };
}

function parentOf(index, item) {
  if (item.parentId === "0") return folderMini({ root: true });
  const parent = index.folders.get(item.parentId);
  return parent === undefined ? null : folderMini(parent);
}

export function fullFolder(index, user, folder, fields, itemCollection) {
  if (folder.root === true) {
    return select({
      type: "folder", id: "0", sequence_id: null, etag: null, name: "All Files", description: "", size: 0,
      path_collection: { total_count: 0, entries: [] }, created_at: null, modified_at: null, trashed_at: null, purged_at: null,
      content_created_at: null, content_modified_at: null, created_by: { type: "user", id: "", name: "", login: "" }, modified_by: userMini(index, user.id),
      owned_by: userMini(index, user.id), shared_link: null, folder_upload_email: null, parent: null, item_status: "active",
      ...(itemCollection === undefined ? {} : { item_collection: itemCollection }),
      permissions: { can_download: true, can_upload: true, can_rename: false, can_delete: false, can_share: false, can_set_share_access: false, can_invite_collaborator: false },
      tags: [], has_collaborations: false, can_non_owners_invite: false,
    }, fields);
  }
  const access = accessOf(index, user.id, "folder", folder);
  const inviter = can(access, "co-owner", "owner") || (can(access, "editor") && folder.canNonOwnersInvite);
  return select({
    type: "folder", id: folder.id, sequence_id: String(folder.sequenceId), etag: String(folder.etag), name: folder.name,
    description: folder.description, size: folderSize(index, folder.id), path_collection: pathCollection(index, user, folder.parentId),
    ...itemTimes(folder), created_by: userMini(index, folder.createdBy), modified_by: userMini(index, folder.modifiedBy),
    owned_by: userMini(index, folder.ownerId), shared_link: null, folder_upload_email: null, parent: parentOf(index, folder),
    item_status: folder.itemStatus, ...(itemCollection === undefined ? {} : { item_collection: itemCollection }),
    permissions: {
      can_download: can(access, ...READ), can_upload: can(access, ...DROP), can_rename: can(access, ...WRITE), can_delete: can(access, ...WRITE),
      can_share: false, can_set_share_access: false, can_invite_collaborator: inviter,
    },
    tags: folder.tags, has_collaborations: (index.byFolder.get(folder.id) ?? []).length > 0, can_non_owners_invite: folder.canNonOwnersInvite,
  }, fields);
}

export function fullFile(index, user, file, fields) {
  const access = accessOf(index, user.id, "file", file);
  return select({
    type: "file", id: file.id, file_version: { type: "file_version", id: file.currentVersionId, sha1: file.sha1 },
    sequence_id: String(file.sequenceId), etag: String(file.etag), sha1: file.sha1, name: file.name, description: file.description,
    size: file.size, path_collection: pathCollection(index, user, file.parentId), ...itemTimes(file),
    created_by: userMini(index, file.createdBy), modified_by: userMini(index, file.modifiedBy), owned_by: userMini(index, file.ownerId),
    shared_link: null, parent: parentOf(index, file), item_status: file.itemStatus, extension: file.extension,
    permissions: {
      can_download: can(access, ...READ), can_preview: can(access, ...VIEW), can_upload: can(access, ...WRITE), can_comment: can(access, ...READ),
      can_rename: can(access, ...WRITE), can_delete: can(access, ...WRITE), can_share: false, can_set_share_access: false,
    },
    tags: file.tags, version_number: String(file.versionNumber), comment_count: file.commentCount,
  }, fields);
}

export const fullOf = (index, user, kind, item, fields) => (kind === "folder" ? fullFolder(index, user, item, fields) : fullFile(index, user, item, fields));
