// State access: row ids, the shared id counter, bounded prefix scans and per-request indexes.
import { MAX_SCAN_BOUND, fail, scanBoundExceeded } from "./errors.mjs";
import { pad } from "./util.mjs";

const CHUNK = 512;

/** Data rows are keyed `{connection_id}/{id}` so one connection's rows form one contiguous row-id range. */
export const rowId = (connectionId, id) => `${connectionId}/${id}`;

/** The scan bound for the caller's workspace: `limits.max_rows_per_namespace`, never above the hard ceiling. */
export function scanBound(workspace) {
  const configured = workspace?.limits?.max_rows_per_namespace;
  return Number.isInteger(configured) && configured >= 1 ? Math.min(configured, MAX_SCAN_BOUND) : MAX_SCAN_BOUND;
}

/**
 * Reads every row of `namespace` under one connection, in row-id (creation) order. A connection holding more than
 * `bound` rows fails FAILED_PRECONDITION instead of answering from an incomplete scan.
 */
export function scanConnection(context, namespace, connectionId, bound) {
  const prefix = `${connectionId}/`;
  const out = [];
  let after = prefix;
  for (;;) {
    const rows = context.state.scan(namespace, { afterRowId: after, limit: CHUNK });
    for (const row of rows) {
      if (!row.rowId.startsWith(prefix)) return out;
      out.push(row.value);
      if (out.length > bound) scanBoundExceeded(context, namespace, bound);
    }
    if (rows.length < CHUNK) return out;
    after = rows[rows.length - 1].rowId;
  }
}

/** Reads a whole namespace (used for the small `workspaces` and `connections` namespaces). */
export function scanAll(context, namespace, bound = MAX_SCAN_BOUND) {
  const out = [];
  let after;
  for (;;) {
    const rows = context.state.scan(namespace, after === undefined ? { limit: CHUNK } : { afterRowId: after, limit: CHUNK });
    for (const row of rows) {
      out.push(row.value);
      if (out.length > bound) scanBoundExceeded(context, namespace, bound);
    }
    if (rows.length < CHUNK) return out;
    after = rows[rows.length - 1].rowId;
  }
}

/** Indexes rows by id for the duration of one request (no per-row rescans). */
export function indexById(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.id, row);
  return map;
}

export const getRow = (context, namespace, connectionId, id) => context.state.get(namespace, rowId(connectionId, id));

export const putRow = (context, namespace, row) => context.state.put(namespace, rowId(row.connection_id, row.id), row);

export const deleteRow = (context, namespace, connectionId, id) => context.state.delete(namespace, rowId(connectionId, id));

/** Ids issued at runtime: `68c8` + 14 zeros + a 6-hex-digit counter, so they sort in creation order and never collide. */
export const idFor = (n) => `68c8${"0".repeat(14)}${pad(n.toString(16), 6)}`;

/** Draws the next object id from the counter row (created lazily), writing the counter back. */
export function nextId(context) {
  const row = context.state.get("meta", "counters");
  const next = Number.isInteger(row?.next_id) && row.next_id >= 1 ? row.next_id : 1;
  // Six hex digits hold 16,777,215 ids; past that the id would no longer be 24 characters.
  if (next > 0xffffff) fail(context, "FAILED_PRECONDITION", "The simulated workspace has exhausted its id space");
  context.state.put("meta", "counters", { next_id: next + 1 });
  return idFor(next);
}
