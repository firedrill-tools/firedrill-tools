// Bounded state access. Every scan is capped by `meta/limits.maxRows` (default and ceiling 10000); a scan that would
// exceed it fails INTERNAL_SERVER_ERROR instead of returning a silently truncated result.
const CEILING = 10000;

export function maxRows(context) {
  const row = context.state.get("meta", "limits");
  const value = row !== null ? row.maxRows : undefined;
  return Number.isSafeInteger(value) && value >= 1 && value <= CEILING ? value : CEILING;
}

function overflow(context, bound) {
  context.fail({ code: "INTERNAL_SERVER_ERROR", message: `state exceeds the supported bound of ${bound} rows` });
}

/** All row values of a namespace, in rowId order. */
export function scanAll(context, namespace) {
  const bound = maxRows(context);
  const rows = context.state.scan(namespace, { limit: Math.min(bound + 1, CEILING) });
  if (rows.length > bound) overflow(context, bound);
  if (rows.length === CEILING && context.state.scan(namespace, { afterRowId: rows[rows.length - 1].rowId, limit: 1 }).length > 0) {
    overflow(context, bound);
  }
  return rows.map((row) => row.value);
}

/** Row values whose rowId starts with `<prefix>:`, in rowId order. */
export function scanChildren(context, namespace, prefix) {
  const bound = maxRows(context);
  const start = `${prefix}:`;
  const rows = context.state.scan(namespace, { afterRowId: start, limit: Math.min(bound + 1, CEILING) });
  const matched = [];
  for (const row of rows) {
    if (!row.rowId.startsWith(start)) break;
    matched.push(row);
  }
  if (matched.length > bound) overflow(context, bound);
  if (matched.length === CEILING) {
    const more = context.state.scan(namespace, { afterRowId: matched[matched.length - 1].rowId, limit: 1 });
    if (more.length > 0 && more[0].rowId.startsWith(start)) overflow(context, bound);
  }
  return matched.map((entry) => entry.value);
}

export const accountRowId = (recipientId, accountId) => `${recipientId}:${accountId}`;
export const paymentRowId = (batchId, paymentId) => `${batchId}:${paymentId}`;

/** UTF-8 byte length of a JSON value's encoding, without TextEncoder. */
export function jsonBytes(value) {
  const text = JSON.stringify(value);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
