// collaborations.create, collaborations.list-for-folder and collaborations.delete (folder collaborations only).
import { READ, can, requireFolder } from "../lib/access.mjs";
import { badParam, denied, fail, notFound } from "../lib/errors.mjs";
import { markerPage } from "../lib/listing.mjs";
import { folderMini, parseFields, select, userMini } from "../lib/render.mjs";
import { allocateId, appendLog, reserveObjects, saveMeta } from "../lib/store.mjs";
import { isId, rfc3339 } from "../lib/util.mjs";
import { begin } from "./common.mjs";

const ROLES = ["editor", "viewer", "previewer", "uploader", "co-owner"];
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,190}$/;

export function renderCollab(index, collab, fields = null) {
  const folder = index.folders.get(collab.itemId);
  return select({
    type: "collaboration", id: collab.id, item: folder === undefined ? { type: "folder", id: collab.itemId, sequence_id: null, etag: null, name: "" } : folderMini(folder),
    accessible_by: collab.userId === null ? null : userMini(index, collab.userId), invite_email: collab.inviteEmail, role: collab.role, status: collab.status,
    acknowledged_at: collab.acknowledgedAtUs === null ? null : rfc3339(collab.acknowledgedAtUs), created_by: userMini(index, collab.createdBy),
    created_at: rfc3339(collab.createdAtUs), modified_at: rfc3339(collab.modifiedAtUs), expires_at: null, is_access_only: false,
  }, fields);
}

const canInvite = (access, folder) => can(access, "co-owner", "owner") || (access.role === "editor" && folder.canNonOwnersInvite === true);

export function createCollaboration(input, context) {
  const { user, meta, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  if (input.item.type !== "folder") badParam(context, "item", "Only folder collaborations are supported by this synthetic service");
  if (input.accessible_by.type !== "user") badParam(context, "accessible_by", "Only user collaborations are supported by this synthetic service");
  if (!ROLES.includes(input.role)) badParam(context, "role", `role must be one of ${ROLES.join(", ")}`);
  if (input.can_view_path === true) badParam(context, "can_view_path", "can_view_path is not supported by this synthetic service");
  if (input.expires_at !== undefined) badParam(context, "expires_at", "expires_at is not supported by this synthetic service");
  const hasId = input.accessible_by.id !== undefined;
  const hasLogin = input.accessible_by.login !== undefined;
  if (hasId === hasLogin) badParam(context, "accessible_by", "Provide exactly one of accessible_by.id and accessible_by.login");
  if (input.item.id === "0") badParam(context, "item", "The root folder cannot be shared");
  const { folder, access } = requireFolder(context, index, user, input.item.id);
  if (!canInvite(access, folder)) denied(context);
  let target = null;
  let inviteEmail = null;
  if (hasId) {
    target = isId(input.accessible_by.id) ? index.users.get(input.accessible_by.id) ?? null : null;
    if (target === null) notFound(context, "user");
  } else {
    const login = input.accessible_by.login.toLowerCase();
    if (!EMAIL_RE.test(login)) badParam(context, "accessible_by", "accessible_by.login must be an email address");
    target = [...index.users.values()].find((u) => u.login === login) ?? null;
    if (target === null) inviteEmail = login;
  }
  const existing = index.byFolder.get(folder.id) ?? [];
  const already = target !== null
    ? target.id === folder.ownerId || existing.some((c) => c.userId === target.id)
    : existing.some((c) => c.inviteEmail !== null && c.inviteEmail === inviteEmail);
  if (already) fail(context, "USER_ALREADY_COLLABORATOR", "User is already a collaborator on this folder");
  reserveObjects(context, meta, 1);
  const now = context.clock.nowUs();
  const collab = {
    id: allocateId(context, meta, "nextCollabId"), itemType: "folder", itemId: folder.id, userId: target?.id ?? null, inviteEmail,
    role: input.role, status: target === null ? "pending" : "accepted", createdBy: user.id, createdAtUs: now, modifiedAtUs: now,
    acknowledgedAtUs: target === null ? null : now,
  };
  context.state.put("collaborations", collab.id, collab);
  index.collabs.set(collab.id, collab);
  const eventType = target === null ? "COLLAB_INVITE_COLLABORATOR" : "COLLAB_ADD_COLLABORATOR";
  appendLog(context, meta, { eventType, createdBy: user.id, sourceType: "collaboration", sourceId: collab.id, itemType: "folder", itemId: folder.id });
  saveMeta(context, meta);
  context.events.emit("collaboration.created", {
    collaborationId: collab.id, itemType: "folder", itemId: folder.id, role: collab.role, status: collab.status, userId: collab.userId,
    inviteEmail: collab.inviteEmail, createdBy: user.id,
  });
  return renderCollab(index, collab, fields);
}

export function listFolderCollaborations(input, context) {
  const { user, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  const { folder, access } = requireFolder(context, index, user, input.folder_id);
  if (!can(access, ...READ)) denied(context);
  const limit = input.limit ?? 100;
  const ordered = (folder.root === true ? [] : index.byFolder.get(folder.id) ?? [])
    .map((collab) => ({ collab, key: [collab.id.padStart(20, "0")] }))
    .sort((a, b) => (a.key[0] < b.key[0] ? -1 : 1));
  const page = markerPage(context, ordered, `collaborations:${folder.id}`, input.marker, limit, ({ collab }) => renderCollab(index, collab, fields));
  return { entries: page.entries, limit, next_marker: page.next_marker };
}

export function deleteCollaboration(input, context) {
  const { user, meta, index } = begin(context, input);
  const collab = isId(input.collaboration_id) ? index.collabs.get(input.collaboration_id) : undefined;
  if (collab === undefined) notFound(context, "collaboration");
  if (collab.userId !== user.id) {
    const folder = index.folders.get(collab.itemId);
    if (folder === undefined) notFound(context, "collaboration");
    const { access } = requireFolder(context, index, user, folder.id, { allowTrashed: true });
    if (!canInvite(access, folder)) denied(context);
  }
  context.state.delete("collaborations", collab.id);
  index.collabs.delete(collab.id);
  meta.objectCount = Math.max(0, meta.objectCount - 1);
  appendLog(context, meta, { eventType: "COLLAB_REMOVE_COLLABORATOR", createdBy: user.id, sourceType: "collaboration", sourceId: collab.id, itemType: "folder", itemId: collab.itemId });
  saveMeta(context, meta);
  return {};
}
