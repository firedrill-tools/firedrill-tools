// Caller identity and Box item permissions (ownership plus accepted collaboration roles inherited down the tree).
import { denied, fail, notFound, trashed } from "./errors.mjs";
import { RANK, scanAll } from "./store.mjs";
import { isId } from "./util.mjs";

export const DEFAULT_USER_ID = "20001";
export const MAX_DEPTH = 64;

/** `userId` wins over `login`; no identity attributes means the default seeded user. */
export function resolveCaller(context) {
  const attributes = context.actor.attributes ?? {};
  const unauthorized = () => fail(context, "UNAUTHORIZED", "Unauthorized: the access token does not map to an active user");
  let user = null;
  if (typeof attributes.userId === "string") {
    if (!isId(attributes.userId)) unauthorized();
    user = context.state.get("users", attributes.userId);
  } else if (typeof attributes.login === "string") {
    const login = attributes.login.toLowerCase();
    user = scanAll(context, "users").map((r) => r.value).find((u) => u.login === login) ?? null;
  } else {
    user = context.state.get("users", DEFAULT_USER_ID);
    if (user === null) user = scanAll(context, "users").map((r) => r.value).find((u) => u.status === "active") ?? null;
  }
  if (user === null || user.status !== "active") unauthorized();
  return user;
}

/** Effective access of `uid` on an item: { role, directRole } (role null when none). */
export function accessOf(index, uid, kind, item) {
  if (item.ownerId === uid) return { role: "owner", directRole: "owner" };
  let best = null;
  let directRole = null;
  let folderId = kind === "folder" ? item.id : item.parentId;
  for (let depth = 0; folderId !== "0" && depth <= MAX_DEPTH; depth += 1) {
    const folder = index.folders.get(folderId);
    if (folder === undefined) break;
    if (folder.ownerId === uid) return { role: "owner", directRole };
    const role = index.roles.get(`${folderId}:${uid}`);
    if (role !== undefined) {
      if (kind === "folder" && depth === 0) directRole = role;
      if (best === null || RANK[role] > RANK[best]) best = role;
    }
    folderId = folder.parentId;
  }
  return { role: best, directRole };
}

export function canSee(access, kind) {
  if (access.role === null) return false;
  if (access.role === "uploader") return kind === "folder" && access.directRole === "uploader";
  return true;
}

export const can = (access, ...roles) => roles.includes(access.role);
export const VIEW = ["previewer", "viewer", "editor", "co-owner", "owner"];
export const READ = ["viewer", "editor", "co-owner", "owner"];
export const WRITE = ["editor", "co-owner", "owner"];
export const DROP = ["uploader", "editor", "co-owner", "owner"];

export const ROOT = Object.freeze({ id: "0", root: true });

/** Resolves a folder id for the caller: "0" is the caller's virtual root. */
export function requireFolder(context, index, user, folderId, { allowTrashed = false } = {}) {
  if (folderId === "0") return { folder: ROOT, access: { role: "owner", directRole: "owner" } };
  const folder = isId(folderId) ? index.folders.get(folderId) : undefined;
  if (folder === undefined) notFound(context, "folder");
  const access = accessOf(index, user.id, "folder", folder);
  if (!canSee(access, "folder")) notFound(context, "folder");
  if (!allowTrashed && folder.itemStatus !== "active") trashed(context);
  return { folder, access };
}

export function requireFile(context, index, user, fileId, { allowTrashed = false } = {}) {
  const file = isId(fileId) ? index.files.get(fileId) : undefined;
  if (file === undefined) notFound(context, "file");
  const access = accessOf(index, user.id, "file", file);
  if (!canSee(access, "file")) notFound(context, "file");
  if (!allowTrashed && file.itemStatus !== "active") trashed(context);
  return { file, access };
}

/** A destination folder for create/upload/copy/move; returns the folder and the owner new items are charged to. */
export function requireDestination(context, index, user, parent, roles, trashedCode = "TRASHED") {
  const parentId = parent?.id;
  if (typeof parentId !== "string") fail(context, "BAD_REQUEST", "parent.id is required", { errors: [{ reason: "missing_parameter", name: "parent", message: "parent.id is required" }] });
  if (parentId === "0") return { folder: ROOT, ownerId: user.id, parentId };
  const { folder, access } = requireFolder(context, index, user, parentId, { allowTrashed: true });
  if (folder.itemStatus !== "active") {
    if (trashedCode === "TRASHED") trashed(context);
    fail(context, "BAD_REQUEST", "The destination folder is in the trash");
  }
  if (!can(access, ...roles)) denied(context);
  return { folder, ownerId: folder.ownerId, parentId };
}

/** Active siblings under `parentId` (root: only those owned by `rootOwnerId`) whose name matches case-insensitively. */
export function nameConflict(index, parentId, rootOwnerId, name, excludeId) {
  const lower = name.toLowerCase();
  for (const child of index.children.get(parentId) ?? []) {
    if (child.item.itemStatus !== "active" || child.item.id === excludeId) continue;
    if (parentId === "0" && child.item.ownerId !== rootOwnerId) continue;
    if (child.item.name.toLowerCase() === lower) return child;
  }
  return null;
}

/** True when `candidateId` is `folderId` or inside it. */
export function isWithin(index, candidateId, folderId) {
  let current = candidateId;
  for (let depth = 0; current !== "0" && depth <= MAX_DEPTH + 1; depth += 1) {
    if (current === folderId) return true;
    const folder = index.folders.get(current);
    if (folder === undefined) return false;
    current = folder.parentId;
  }
  return false;
}

export function depthOf(index, folderId) {
  let depth = 0;
  let current = folderId;
  while (current !== "0" && depth <= MAX_DEPTH + 1) {
    const folder = index.folders.get(current);
    if (folder === undefined) break;
    depth += 1;
    current = folder.parentId;
  }
  return depth;
}
