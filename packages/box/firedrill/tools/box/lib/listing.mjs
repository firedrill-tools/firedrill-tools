// Ordered listings and pagination (offset and marker), cut by count and by encoded UTF-8 size.
import { accessOf, canSee } from "./access.mjs";
import { badParam, fail } from "./errors.mjs";
import { decodeMarker, encodeMarker } from "./marker.mjs";
import { folderSize } from "./render.mjs";
import { jsonBytes } from "./util.mjs";

export const PAGE_BUDGET = 900000;

export function compareKeys(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    if (typeof a[i] === "number" && typeof b[i] === "number") return a[i] < b[i] ? -1 : 1;
    return String(a[i]) < String(b[i]) ? -1 : 1;
  }
  return 0;
}

/** Active items the caller sees in a folder; root "0" adds folders shared with the caller whose parent they cannot see. */
export function folderEntries(index, user, folderId) {
  const out = [];
  if (folderId === "0") {
    for (const child of index.children.get("0") ?? []) {
      if (child.item.ownerId === user.id && child.item.itemStatus === "active") out.push(child);
    }
    const seen = new Set();
    for (const [key] of index.roles) {
      const colon = key.indexOf(":");
      if (key.slice(colon + 1) !== user.id) continue;
      const folder = index.folders.get(key.slice(0, colon));
      if (folder === undefined || folder.itemStatus !== "active" || folder.ownerId === user.id || seen.has(folder.id)) continue;
      const parent = folder.parentId === "0" ? undefined : index.folders.get(folder.parentId);
      const parentVisible = parent !== undefined && canSee(accessOf(index, user.id, "folder", parent), "folder");
      if (!parentVisible && canSee(accessOf(index, user.id, "folder", folder), "folder")) {
        seen.add(folder.id);
        out.push({ kind: "folder", item: folder });
      }
    }
    return out;
  }
  for (const child of index.children.get(folderId) ?? []) {
    if (child.item.itemStatus !== "active") continue;
    if (canSee(accessOf(index, user.id, child.kind, child.item), child.kind)) out.push(child);
  }
  return out;
}

/** Items the caller deleted directly (owned), newest first. */
export function trashEntries(index, user) {
  const out = [];
  for (const [kind, map] of [["folder", index.folders], ["file", index.files]]) {
    for (const item of map.values()) if (item.ownerId === user.id && item.itemStatus === "trashed" && item.trashRoot) out.push({ kind, item });
  }
  return out.map((e) => ({ ...e, key: [-(e.item.trashedAtUs ?? 0), e.item.id] })).sort((a, b) => compareKeys(a.key, b.key));
}

/** Folders first, then the sort field (name case-insensitive by default), then id. */
export function orderEntries(index, entries, sort = "name", direction = "ASC") {
  const sign = direction === "DESC" ? -1 : 1;
  const valueOf = ({ kind, item }) => {
    if (sort === "id") return item.id.padStart(20, "0");
    if (sort === "date") return item.modifiedAtUs;
    if (sort === "size") return kind === "file" ? item.size : folderSize(index, item.id);
    return item.name.toLowerCase();
  };
  const keyed = entries.map((e) => ({ ...e, key: [e.kind === "folder" ? 0 : 1, valueOf(e), e.item.id.padStart(20, "0")] }));
  return keyed.sort((a, b) => {
    if (a.key[0] !== b.key[0]) return a.key[0] - b.key[0];
    const c = compareKeys([a.key[1]], [b.key[1]]) * sign;
    return c !== 0 ? c : compareKeys([a.key[2]], [b.key[2]]);
  });
}

/** Offset page; a page over the byte budget fails instead of being cut silently. */
export function offsetPage(context, ordered, offset, limit, render) {
  const entries = [];
  let bytes = 0;
  for (const entry of ordered.slice(offset, offset + limit)) {
    const rendered = render(entry);
    bytes += jsonBytes(rendered) + 1;
    if (bytes > PAGE_BUDGET) badParam(context, "limit", "requested page too large; lower limit");
    entries.push(rendered);
  }
  return entries;
}

/** Marker page over `ordered` (each with `key`); the marker is scoped and fully validated. */
export function markerPage(context, ordered, scope, marker, limit, render) {
  let start = 0;
  if (marker !== undefined) {
    const value = decodeMarker(marker);
    const template = ordered[0]?.key;
    const valid = value !== null && value.v === 1 && value.f === scope && Array.isArray(value.k)
      && (template === undefined || (value.k.length === template.length && value.k.every((part, i) => typeof part === typeof template[i])))
      && value.k.every((part) => (typeof part === "string" && part.length <= 1024) || Number.isSafeInteger(part));
    if (!valid) badParam(context, "marker", "Invalid marker");
    start = ordered.findIndex((entry) => compareKeys(entry.key, value.k) > 0);
    if (start < 0) start = ordered.length;
  }
  const entries = [];
  let bytes = 0;
  let index = start;
  for (; index < ordered.length && entries.length < limit; index += 1) {
    const rendered = render(ordered[index]);
    const size = jsonBytes(rendered) + 1;
    if (bytes + size > PAGE_BUDGET) {
      if (entries.length === 0) fail(context, "BAD_REQUEST", "a single entry exceeds the response size budget");
      break;
    }
    bytes += size;
    entries.push(rendered);
  }
  const nextMarker = index < ordered.length ? encodeMarker({ v: 1, f: scope, k: ordered[index - 1].key }) : null;
  return { entries, next_marker: nextMarker };
}
