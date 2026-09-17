// folders.get and folders.list-items (including the "trash" pseudo-folder).
import { VIEW, can, requireFolder } from "../lib/access.mjs";
import { badParam, denied } from "../lib/errors.mjs";
import { folderEntries, markerPage, offsetPage, orderEntries, trashEntries } from "../lib/listing.mjs";
import { fullFolder, fullOf, miniOf, parseFields } from "../lib/render.mjs";
import { begin } from "./common.mjs";

function trashRender(index, user, fields) {
  return ({ kind, item }) => {
    if (fields !== null) return fullOf(index, user, kind, item, fields);
    const full = fullOf(index, user, kind, item, null);
    return { ...miniOf(kind, item), trashed_at: full.trashed_at, purged_at: full.purged_at, item_status: full.item_status };
  };
}

function collection(context, index, user, folderId, input, fields, forGet) {
  const sort = input.sort;
  const direction = input.direction ?? "ASC";
  const limit = input.limit ?? 100;
  const render = folderId === "trash" ? trashRender(index, user, fields) : ({ kind, item }) => (fields === null || forGet ? miniOf(kind, item) : fullOf(index, user, kind, item, fields));
  if (input.usemarker === true) {
    if (input.offset !== undefined) badParam(context, "offset", "offset cannot be combined with marker-based paging");
    if (sort !== undefined || input.direction !== undefined) badParam(context, "sort", "sort and direction are not supported with marker-based paging");
    const ordered = folderId === "trash" ? trashEntries(index, user) : orderEntries(index, folderEntries(index, user, folderId));
    const page = markerPage(context, ordered, folderId, input.marker, limit, render);
    return { entries: page.entries, limit, next_marker: page.next_marker };
  }
  if (input.marker !== undefined) badParam(context, "marker", "marker requires usemarker=true");
  const ordered = folderId === "trash" ? trashEntries(index, user) : orderEntries(index, folderEntries(index, user, folderId), sort ?? "name", direction);
  const offset = input.offset ?? 0;
  const entries = offsetPage(context, ordered, offset, limit, render);
  const order = folderId === "trash" ? [{ by: "trashed_at", direction: "DESC" }] : [{ by: "type", direction: "ASC" }, { by: sort ?? "name", direction }];
  return { total_count: ordered.length, entries, offset, limit, order };
}

export function getFolder(input, context) {
  const { user, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  const { folder, access } = requireFolder(context, index, user, input.folder_id);
  if (!can(access, ...VIEW)) denied(context);
  const wantsCollection = fields === null || fields.has("item_collection");
  const itemCollection = wantsCollection ? collection(context, index, user, folder.id, input, null, true) : undefined;
  return fullFolder(index, user, folder, fields, itemCollection);
}

export function listItems(input, context) {
  const { user, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  if (input.folder_id === "trash") return collection(context, index, user, "trash", input, fields, false);
  const { folder, access } = requireFolder(context, index, user, input.folder_id);
  if (!can(access, ...VIEW)) denied(context);
  return collection(context, index, user, folder.id, input, fields, false);
}

