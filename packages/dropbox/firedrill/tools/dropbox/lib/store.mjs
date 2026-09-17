// Per-operation view of one account's namespace: entry index (by id and by lower-case path), counters, journal and
// revisions. Loaded once per operation with bounded scans; a scan that would exceed its bound fails (never truncates).
import { counters, ensureAccount, limits, revPrefix, saveCounters } from "./account.mjs";
import { tooManyFiles } from "./errors.mjs";
import { base64Encode } from "./util.mjs";

const PAGE = 1000;

/** Scans every row of `namespace` whose row id starts with `prefix`, failing once more than `bound` rows exist. */
export function scanPrefix(context, namespace, prefix, bound, what) {
  const rows = [];
  let after = prefix;
  for (;;) {
    const page = context.state.scan(namespace, { afterRowId: after, limit: PAGE });
    for (const record of page) {
      if (!record.rowId.startsWith(prefix)) return rows;
      rows.push(record.value);
      if (rows.length > bound) tooManyFiles(context, what, bound);
    }
    if (page.length < PAGE) return rows;
    after = page[page.length - 1].rowId;
  }
}

/** Opens the operation store for an account. Loads the entry index unless `withIndex` is false. */
export function openStore(context, account, withIndex = true) {
  const store = {
    context,
    account,
    accountId: account.accountId,
    lim: limits(context),
    c: counters(context),
    dirty: false,
    byId: new Map(),
    live: new Map(),
    dead: new Map(),
  };
  if (withIndex) {
    for (const entry of scanPrefix(context, "entries", `${account.accountId}/`, store.lim.entries, "the account's entries")) {
      index(store, entry);
    }
  }
  return store;
}

function index(store, entry) {
  store.byId.set(entry.id, entry);
  if (entry.deleted) {
    const current = store.dead.get(entry.pathLower);
    if (current === undefined || String(current.deletedAt ?? "") <= String(entry.deletedAt ?? "")) store.dead.set(entry.pathLower, entry);
  } else store.live.set(entry.pathLower, entry);
}

function unindex(store, entry) {
  if (store.live.get(entry.pathLower) === entry) store.live.delete(entry.pathLower);
  if (store.dead.get(entry.pathLower) === entry) {
    store.dead.delete(entry.pathLower);
    for (const other of store.byId.values()) {
      if (other !== entry && other.deleted && other.pathLower === entry.pathLower) index(store, other);
    }
  }
}

/** Replaces an entry row (by id) and keeps the index consistent. */
export function putEntry(store, entry) {
  const previous = store.byId.get(entry.id);
  if (previous !== undefined) unindex(store, previous);
  const value = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
  index(store, value);
  ensureAccount(store.context, store.account);
  store.context.state.put("entries", `${store.accountId}/${value.id}`, value);
  return value;
}

/** Fails with too_many_files when `extra` more entry rows would exceed the bound. */
export function reserveEntries(store, extra) {
  if (store.byId.size + extra > store.lim.entries) tooManyFiles(store.context, "the account's entries", store.lim.entries);
}

export function newEntryId(store) {
  const n = store.c.nextEntry;
  store.c.nextEntry = n + 1;
  store.dirty = true;
  return entryIdFor(n);
}

/** `id:` + 22 url-safe characters encoding a counter. */
export function entryIdFor(n) {
  const bytes = new Uint8Array(16);
  let value = n;
  for (let i = 15; i >= 0 && value > 0; i -= 1) {
    bytes[i] = value % 256;
    value = Math.floor(value / 256);
  }
  return `id:${base64Encode(bytes, true)}`;
}

export function newRev(store) {
  const n = store.c.nextRev;
  store.c.nextRev = n + 1;
  store.dirty = true;
  return `${revPrefix(store.account)}${n.toString(16).padStart(8, "0")}`;
}

export function journalRowId(seq) {
  return String(seq).padStart(12, "0");
}

/** Appends a change-feed row and prunes past the retention bound. */
export function journal(store, entry, change, pathLower = entry.pathLower, pathDisplay = entry.pathDisplay) {
  const seq = store.c.nextJournal;
  store.c.nextJournal = seq + 1;
  store.dirty = true;
  store.context.state.put("journal", journalRowId(seq), {
    accountId: store.accountId,
    seq,
    entryId: entry.id,
    pathLower,
    pathDisplay,
    change,
  });
  while (store.c.nextJournal - store.c.journalFloor > store.lim.journal) {
    store.context.state.delete("journal", journalRowId(store.c.journalFloor));
    store.c.journalFloor += 1;
  }
}

/** Journal head: the sequence number of the newest change (0 when none). */
export function journalHead(store) {
  return store.c.nextJournal - 1;
}

export function commit(store) {
  if (store.dirty) saveCounters(store.context, store.c);
}

/** Sum of live file sizes (Dropbox `used`). */
export function usedBytes(store) {
  let used = 0;
  for (const entry of store.live.values()) if (entry.tag === "file") used += entry.size ?? 0;
  return used;
}

export function revisionsOf(store, entryId) {
  return scanPrefix(store.context, "revisions", `${store.accountId}/${entryId}/`, store.lim.revisions, "the file's revisions");
}

/** Finds a revision anywhere in the account (for `rev:` paths). */
export function findRevision(store, rev) {
  for (const row of scanPrefix(store.context, "revisions", `${store.accountId}/`, store.lim.revisions, "the account's revisions")) {
    if (row.rev === rev && !row.isDeleteMarker) return row;
  }
  return null;
}

export function putRevision(store, entry, isDeleteMarker) {
  const row = {
    accountId: store.accountId,
    entryId: entry.id,
    rev: isDeleteMarker ? newRev(store) : entry.rev,
    pathLower: entry.pathLower,
    pathDisplay: entry.pathDisplay,
    name: entry.name,
    size: isDeleteMarker ? 0 : entry.size,
    contentHash: entry.contentHash,
    clientModified: entry.clientModified,
    serverModified: isDeleteMarker ? entry.deletedAt : entry.serverModified,
    contentKind: entry.contentKind,
    content: isDeleteMarker ? "" : entry.content,
    isDeleteMarker,
  };
  store.context.state.put("revisions", `${store.accountId}/${entry.id}/${row.rev}`, row);
  return row;
}

/** Resolves a parsed path/id to a live entry (or null). */
export function liveByRef(store, parsed) {
  if (parsed.kind === "path") return store.live.get(parsed.lower) ?? null;
  if (parsed.kind === "id") {
    const entry = store.byId.get(parsed.id);
    return entry !== undefined && !entry.deleted ? entry : null;
  }
  return null;
}
