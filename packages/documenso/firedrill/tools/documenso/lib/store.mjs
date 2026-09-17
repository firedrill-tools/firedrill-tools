// State access: bounded prefix scans (fail, never truncate), id counters, parent/child indexes and audit rows.
import { fail } from "./errors.mjs";
import { pad10 } from "./util.mjs";

const DEFAULT_MAX_SCAN_ROWS = 5000;
const BATCH = 1000;

export function maxScanRows(context) {
  const n = context.state.get("meta", "limits")?.maxScanRows;
  return Number.isSafeInteger(n) && n >= 1 && n <= 10000 ? n : DEFAULT_MAX_SCAN_ROWS;
}

/** Every row whose id starts with `prefix` ("" = whole namespace); more than `maxScanRows` rows fails UNKNOWN_ERROR. */
export function scanPrefix(context, namespace, prefix) {
  const bound = maxScanRows(context);
  const out = [];
  let after = prefix === "" ? undefined : prefix;
  for (;;) {
    const limit = Math.min(BATCH, bound + 1 - out.length);
    const batch = context.state.scan(namespace, after === undefined ? { limit } : { afterRowId: after, limit });
    for (const record of batch) {
      if (prefix !== "" && !record.rowId.startsWith(prefix)) return out;
      out.push(record);
      if (out.length > bound) fail(context, "UNKNOWN_ERROR", `state exceeds the supported bound of ${bound} rows`);
    }
    if (batch.length < limit) return out;
    after = batch[batch.length - 1].rowId;
  }
}

/** The first row with `prefix`, or null (a single-row read that never hits the scan bound). */
export function firstWithPrefix(context, namespace, prefix) {
  const [record] = context.state.scan(namespace, { afterRowId: prefix, limit: 1 });
  return record !== undefined && record.rowId.startsWith(prefix) ? record : null;
}

export function nextId(context, key) {
  const counters = context.state.get("meta", "counters") ?? { documents: 0, templates: 0, recipients: 0, fields: 0, auditLogs: 0 };
  const value = (Number.isSafeInteger(counters[key]) ? counters[key] : 0) + 1;
  context.state.put("meta", "counters", { ...counters, [key]: value });
  return value;
}

export const parentPrefix = (kind, id) => `${kind === "document" ? "D" : "T"}${pad10(id)}/`;

export function recipientsOf(context, kind, id) {
  const out = [];
  for (const record of scanPrefix(context, "recipient-index", parentPrefix(kind, id))) {
    const row = context.state.get("recipients", pad10(record.value.recipientId));
    if (row !== null) out.push(row);
  }
  return out;
}

export function fieldsOf(context, kind, id) {
  const out = [];
  for (const record of scanPrefix(context, "field-index", parentPrefix(kind, id))) {
    const row = context.state.get("fields", pad10(record.value.fieldId));
    if (row !== null) out.push(row);
  }
  return out;
}

export function putRecipient(context, recipient) {
  context.state.put("recipients", pad10(recipient.id), recipient);
  context.state.put("recipient-index", `${parentPrefix(recipient.parentKind, recipient.parentId)}${pad10(recipient.id)}`, { recipientId: recipient.id });
  context.state.put("recipient-tokens", recipient.token, { recipientId: recipient.id });
}

export function removeRecipient(context, recipient) {
  context.state.delete("recipients", pad10(recipient.id));
  context.state.delete("recipient-index", `${parentPrefix(recipient.parentKind, recipient.parentId)}${pad10(recipient.id)}`);
  context.state.delete("recipient-tokens", recipient.token);
}

export function putField(context, field) {
  context.state.put("fields", pad10(field.id), field);
  context.state.put("field-index", `${parentPrefix(field.parentKind, field.parentId)}${pad10(field.id)}`, { fieldId: field.id });
}

export function removeField(context, field) {
  context.state.delete("fields", pad10(field.id));
  context.state.delete("field-index", `${parentPrefix(field.parentKind, field.parentId)}${pad10(field.id)}`);
}

/** Appends one audit-log row for an envelope. `who` is { name, email, userId } or null for system entries. */
export function audit(context, envelopeId, type, who, data = {}) {
  const seq = nextId(context, "auditLogs");
  context.state.put("audit-logs", `${envelopeId}/${pad10(seq)}`, {
    id: `audit_${seq}`, createdAtUs: context.clock.nowUs(), envelopeId, type,
    name: who?.name ?? null, email: who?.email ?? null, userId: who?.userId ?? null, data,
  });
}
