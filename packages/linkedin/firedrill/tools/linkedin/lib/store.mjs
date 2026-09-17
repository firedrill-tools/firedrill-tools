// Bounded state access: prefix scans that fail instead of truncating, virtual time and LinkedIn-style ids.
import { fail } from "./errors.mjs";

const BATCH = 1000;
const DEFAULT_MAX = 5000;

export function maxScanRows(context) {
  const limits = context.state.get("meta", "limits");
  const value = limits?.maxScanRows;
  return Number.isInteger(value) && value >= 1 && value <= 10000 ? value : DEFAULT_MAX;
}

function overBound(context, max) {
  fail(context, "INTERNAL_SERVER_ERROR", `state exceeds the supported bound of ${max} rows`);
}

/** All rows of a namespace whose row id starts with `prefix` (empty prefix = whole namespace), in row-id order. */
export function scanPrefix(context, namespace, prefix = "") {
  const max = maxScanRows(context);
  const rows = [];
  let after = prefix === "" ? undefined : prefix;
  for (;;) {
    const batch = context.state.scan(namespace, after === undefined ? { limit: BATCH } : { afterRowId: after, limit: BATCH });
    const records = Array.isArray(batch) ? batch : (batch?.records ?? []);
    for (const record of records) {
      if (prefix !== "" && !record.rowId.startsWith(prefix)) return rows;
      rows.push(record);
      if (rows.length > max) overBound(context, max);
    }
    if (records.length < BATCH) return rows;
    after = records[records.length - 1].rowId;
  }
}

export const scanValues = (context, namespace, prefix = "") => scanPrefix(context, namespace, prefix).map((record) => record.value);

export const nowMs = (context) => Math.floor(context.clock.nowUs() / 1000);

/** Next LinkedIn-style id: creation time in the high bits, a per-world sequence in the low 22 bits. */
export function nextId(context) {
  const counters = context.state.get("meta", "counters") ?? { seq: 0 };
  const seq = (Number.isInteger(counters.seq) ? counters.seq : 0) + 1;
  context.state.put("meta", "counters", { seq });
  const id = (BigInt(Math.max(0, nowMs(context))) << 22n) | BigInt(seq & 0x3fffff);
  return id.toString();
}

/** Writes only when the stored value would change (replays do not spend the mutation budget). */
export function putIfChanged(context, namespace, rowId, value) {
  const current = context.state.get(namespace, rowId);
  if (current !== null && JSON.stringify(current) === JSON.stringify(value)) return false;
  context.state.put(namespace, rowId, value);
  return true;
}
