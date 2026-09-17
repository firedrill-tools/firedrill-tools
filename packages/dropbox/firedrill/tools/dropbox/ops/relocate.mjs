// files/move_v2 and files/copy_v2 (RelocationError unions).
import { callerAccount } from "../lib/account.mjs";
import { failUnion } from "../lib/errors.mjs";
import { metadataOf } from "../lib/metadata.mjs";
import { nameOf, parsePath, within } from "../lib/paths.mjs";
import { commit, journal, liveByRef, newEntryId, newRev, openStore, putEntry, putRevision, reserveEntries } from "../lib/store.mjs";
import { timestamp } from "../lib/util.mjs";
import { accountLinks, autorename, changed, checkQuota, checkWritePath, conflict, ensureParents, failWrite } from "../lib/writes.mjs";

const fromShape = (reason) => ({ ".tag": "from_lookup", from_lookup: reason });
const toShape = (reason) => ({ ".tag": "to", to: reason });

function prepare(input, context, isCopy) {
  const account = callerAccount(context, "files.content.write");
  const from = parsePath(input.from_path, { id: true });
  if (from.kind === "malformed") failWrite(context, fromShape, "malformed_path");
  let to = parsePath(input.to_path);
  if (to.kind !== "path") failWrite(context, toShape, "malformed_path");
  const store = openStore(context, account);
  const source = liveByRef(store, from);
  if (source === null) failWrite(context, fromShape, "not_found");
  if (to.display === source.pathDisplay) failUnion(context, "DUPLICATED_OR_NESTED_PATHS", { ".tag": "duplicated_or_nested_paths" });
  if (to.lower !== source.pathLower && within(to.lower, source.pathLower)) {
    failUnion(context, "CANT_MOVE_FOLDER_INTO_ITSELF", { ".tag": "cant_move_folder_into_itself" });
  }
  checkWritePath(store, to, toShape);
  const existing = store.live.get(to.lower);
  if (existing !== undefined && (isCopy || existing !== source)) {
    const renamedPath = input.autorename === true ? autorename(store, to, source.tag === "file") : null;
    if (renamedPath === null) failWrite(context, toShape, conflict(existing.tag));
    to = renamedPath;
  }
  const subtree = [...store.live.values()]
    .filter((row) => within(row.pathLower, source.pathLower))
    .sort((a, b) => (a.pathLower < b.pathLower ? -1 : a.pathLower > b.pathLower ? 1 : 0));
  return { store, source, to, subtree };
}

function destination(store, to) {
  return `${ensureParents(store, to)}/${to.segments[to.segments.length - 1]}`;
}

export function move(input, context) {
  const { store, source, to, subtree } = prepare(input, context, false);
  const rootDisplay = destination(store, to);
  const moved = new Map();
  for (const row of subtree) {
    journal(store, row, "delete");
    const pathLower = to.lower + row.pathLower.slice(source.pathLower.length);
    const pathDisplay = rootDisplay + row.pathDisplay.slice(source.pathDisplay.length);
    const entry = putEntry(store, { ...row, pathLower, pathDisplay, name: nameOf(pathDisplay) });
    journal(store, entry, "upsert");
    moved.set(entry.id, entry);
  }
  for (const link of accountLinks(store)) {
    const entry = moved.get(link.entryId);
    if (entry !== undefined) context.state.put("shared_links", `${store.accountId}/${link.linkId}`, { ...link, pathLower: entry.pathLower, name: entry.name });
  }
  const root = moved.get(source.id);
  changed(store, "moved", root, { previous_path_lower: source.pathLower });
  commit(store);
  return { metadata: metadataOf(root) };
}

export function copy(input, context) {
  const { store, source, to, subtree } = prepare(input, context, true);
  let bytes = 0;
  for (const row of subtree) if (row.tag === "file") bytes += row.size ?? 0;
  checkQuota(store, bytes, () => failUnion(context, "INSUFFICIENT_SPACE", { ".tag": "insufficient_quota" }));
  reserveEntries(store, subtree.length);
  const rootDisplay = destination(store, to);
  const now = timestamp(context.clock.nowUs());
  let root = null;
  for (const row of subtree) {
    const pathDisplay = rootDisplay + row.pathDisplay.slice(source.pathDisplay.length);
    const value = { ...row, id: newEntryId(store), pathLower: to.lower + row.pathLower.slice(source.pathLower.length), pathDisplay, name: nameOf(pathDisplay) };
    if (row.tag === "file") {
      value.rev = newRev(store);
      value.serverModified = now;
    }
    const entry = putEntry(store, value);
    if (entry.tag === "file") putRevision(store, entry, false);
    journal(store, entry, "upsert");
    if (row === source) root = entry;
  }
  changed(store, "added", root);
  commit(store);
  return { metadata: metadataOf(root) };
}
