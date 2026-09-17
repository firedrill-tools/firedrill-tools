// State access: the per-operation index (Maps built once from bounded scans), id counters, object cap and event log.
import { OBJECT_CAP, fail, overCap } from "./errors.mjs";
import { pad } from "./util.mjs";

export const EVENT_RETENTION = 1000;
const DEFAULT_META = {
  nextFolderId: 310000000100, nextFileId: 910000000100, nextVersionId: 1210000000100, nextCommentId: 5100100,
  nextCollabId: 8800100, nextStreamPosition: 1, firstStreamPosition: 1, objectCount: 0,
};
const ID_NAMESPACE = { nextFolderId: "folders", nextFileId: "files", nextVersionId: "blobs", nextCommentId: "comments", nextCollabId: "collaborations" };

/** Reads a whole namespace; more rows than the object cap means results could be incomplete, so fail instead. */
export function scanAll(context, namespace, bound = OBJECT_CAP) {
  const rows = context.state.scan(namespace, { limit: bound + 1 });
  if (rows.length > bound) overCap(context);
  return rows;
}

/** Scans rows whose id starts with `prefix`, completely, in row-id order. */
export function scanPrefix(context, namespace, prefix, bound = OBJECT_CAP) {
  const out = [];
  let after = prefix;
  for (;;) {
    const rows = context.state.scan(namespace, { afterRowId: after, limit: 256 });
    for (const row of rows) {
      if (!row.rowId.startsWith(prefix)) return out;
      out.push(row);
      if (out.length > bound) overCap(context);
    }
    if (rows.length < 256) return out;
    after = rows[rows.length - 1].rowId;
  }
}

export function readMeta(context) {
  const row = context.state.get("meta", "counters");
  return { ...DEFAULT_META, ...(row ?? {}) };
}

/** Over-capacity guard run by every operation except users.get-me, before any scan. */
export function guardedMeta(context) {
  const meta = readMeta(context);
  if (meta.objectCount > OBJECT_CAP) overCap(context);
  return meta;
}

export const saveMeta = (context, meta) => context.state.put("meta", "counters", meta);

export function reserveObjects(context, meta, count) {
  if (meta.objectCount + count > OBJECT_CAP) overCap(context);
  meta.objectCount += count;
}

export function allocateId(context, meta, key) {
  let id = meta[key];
  const namespace = ID_NAMESPACE[key];
  for (let guard = 0; guard <= OBJECT_CAP + 1 && context.state.get(namespace, String(id)) !== null; guard += 1) id += 1;
  meta[key] = id + 1;
  return String(id);
}

/** Loads users, folders, files and collaborations into Maps and derives the child and role indexes. */
export function loadIndex(context) {
  const users = new Map(scanAll(context, "users").map((r) => [r.rowId, r.value]));
  const folders = new Map(scanAll(context, "folders").map((r) => [r.rowId, r.value]));
  const files = new Map(scanAll(context, "files").map((r) => [r.rowId, r.value]));
  const collabs = new Map(scanAll(context, "collaborations").map((r) => [r.rowId, r.value]));
  const children = new Map();
  const addChild = (kind, item) => {
    const list = children.get(item.parentId);
    if (list === undefined) children.set(item.parentId, [{ kind, item }]);
    else list.push({ kind, item });
  };
  for (const folder of folders.values()) addChild("folder", folder);
  for (const file of files.values()) addChild("file", file);
  const roles = new Map();
  const byFolder = new Map();
  for (const collab of collabs.values()) {
    const list = byFolder.get(collab.itemId);
    if (list === undefined) byFolder.set(collab.itemId, [collab]);
    else list.push(collab);
    if (collab.status === "accepted" && collab.userId !== null) {
      const key = `${collab.itemId}:${collab.userId}`;
      if (!roles.has(key) || RANK[collab.role] > RANK[roles.get(key)]) roles.set(key, collab.role);
    }
  }
  return { users, folders, files, collabs, children, roles, byFolder };
}

export const RANK = { previewer: 1, uploader: 2, viewer: 3, editor: 4, "co-owner": 5, owner: 6 };

export const eventId = (position) => `00000000-0000-4000-8000-${pad(position, 12)}`;

/** Appends to the retained user event stream (latest 1,000 positions). */
export function appendLog(context, meta, entry) {
  const position = meta.nextStreamPosition;
  context.state.put("event-log", pad(position, 12), {
    position, eventId: eventId(position), createdAtUs: context.clock.nowUs(), ...entry,
  });
  meta.nextStreamPosition = position + 1;
  if (meta.firstStreamPosition > position) meta.firstStreamPosition = position;
  while (meta.nextStreamPosition - meta.firstStreamPosition > EVENT_RETENTION) {
    context.state.delete("event-log", pad(meta.firstStreamPosition, 12));
    meta.firstStreamPosition += 1;
  }
}

export function requireIntegerRange(context, name, value, min, max) {
  if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
    fail(context, "BAD_REQUEST", `Invalid value for ${name}`, { errors: [{ reason: "invalid_parameter", name, message: `${name} must be between ${min} and ${max}` }] });
  }
}
