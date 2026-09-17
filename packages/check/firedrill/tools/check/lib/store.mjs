// Bounded state scans: a namespace holding more rows than the scan bound fails INTERNAL_ERROR instead of truncating.
// The bound is 10000 rows; a `meta/limits` row may lower it so the bound can be exercised without seeding 10000 rows.
export const BOUND = 10000;

/** The scan bound in force: `meta/limits.maxRows` when it is an integer in 1…BOUND, else BOUND. */
export function scanBound(context) {
  const row = context.state.get("meta", "limits");
  const value = row === null ? undefined : row.maxRows;
  return Number.isSafeInteger(value) && value >= 1 && value <= BOUND ? value : BOUND;
}

export function scanAll(context, namespace) {
  const bound = scanBound(context);
  const rows = context.state.scan(namespace, { limit: bound });
  if (rows.length === bound && context.state.scan(namespace, { afterRowId: rows[rows.length - 1].rowId, limit: 1 }).length > 0) {
    context.fail({ code: "INTERNAL_ERROR", message: `state exceeds the supported bound of ${bound} rows` });
  }
  return rows.map((row) => row.value);
}

/** UTF-8 byte length of the JSON encoding of `value`, counted from code points. */
export function jsonBytes(value) {
  const text = JSON.stringify(value);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Map of id → row for the rows of a namespace. */
export function indexById(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.id, row);
  return map;
}
