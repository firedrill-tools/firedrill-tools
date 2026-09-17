// Shared operation plumbing: caller + guard + index, If-Match, item writes that keep the in-memory index current.
import { resolveCaller } from "../lib/access.mjs";
import { badParam, fail } from "../lib/errors.mjs";
import { guardedMeta, loadIndex } from "../lib/store.mjs";
import { parseRfc3339 } from "../lib/util.mjs";

/** Box's As-User impersonation header is not simulated: answer 400 instead of silently acting as the caller. */
export function rejectAsUser(context, input) {
  if (input !== undefined && input.as_user !== undefined) badParam(context, "As-User", "The As-User header is not supported by this synthetic service");
}

/** Identity first (401), then the over-capacity guard, then the per-operation index. */
export function begin(context, input) {
  const user = resolveCaller(context);
  rejectAsUser(context, input);
  const meta = guardedMeta(context);
  const index = loadIndex(context);
  return { user, meta, index };
}

export function checkIfMatch(context, item, ifMatch) {
  if (ifMatch === undefined) return;
  let value = ifMatch.trim();
  if (value.startsWith("W/")) value = value.slice(2);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (value !== "*" && value !== String(item.etag)) fail(context, "PRECONDITION_FAILED", "The resource has been modified. Please retrieve the resource again and retry");
}

const NAMESPACE = { folder: "folders", file: "files" };

/** Writes an item row and updates the index maps and child lists (including a parent change). */
export function putItem(context, index, kind, item, previousParentId) {
  context.state.put(NAMESPACE[kind], item.id, item);
  (kind === "folder" ? index.folders : index.files).set(item.id, item);
  const oldList = index.children.get(previousParentId ?? item.parentId) ?? [];
  const at = oldList.findIndex((c) => c.item.id === item.id && c.kind === kind);
  if (at >= 0) oldList.splice(at, 1);
  const list = index.children.get(item.parentId);
  if (list === undefined) index.children.set(item.parentId, [{ kind, item }]);
  else list.push({ kind, item });
}

export function timestampInput(context, name, value) {
  if (value === undefined) return undefined;
  const us = parseRfc3339(value);
  if (us === null) badParam(context, name, `${name} must be an RFC 3339 date-time with a time zone offset`);
  return us;
}

/** Active descendants of a folder, breadth first (bounded by the object cap through the index). */
export function descendants(index, folderId, { activeOnly = true } = {}) {
  const out = [];
  const queue = [folderId];
  for (let i = 0; i < queue.length && out.length <= 4000; i += 1) {
    for (const child of index.children.get(queue[i]) ?? []) {
      if (activeOnly && child.item.itemStatus !== "active") continue;
      out.push(child);
      if (child.kind === "folder") queue.push(child.item.id);
    }
  }
  return out;
}

/** Height of a folder subtree in folder levels (the folder itself counts 1). */
export function subtreeHeight(index, folderId) {
  let height = 1;
  let level = [folderId];
  for (let depth = 1; level.length > 0 && depth <= 70; depth += 1) {
    const next = [];
    for (const id of level) for (const child of index.children.get(id) ?? []) if (child.kind === "folder") next.push(child.item.id);
    if (next.length > 0) height = depth + 1;
    level = next;
  }
  return height;
}
