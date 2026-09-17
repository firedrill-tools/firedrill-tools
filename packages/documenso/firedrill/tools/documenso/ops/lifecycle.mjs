// documents.delete, documents.distribute, documents.redistribute, envelopes.cancel and envelopes.audit_log.
import { canManage, loadDocument, loadEnvelopeDocument, parseId, resolveCaller, who } from "../lib/caller.mjs";
import { bad, forbidden, invalid } from "../lib/errors.mjs";
import { pageArgs, pageOf } from "../lib/paging.mjs";
import { auditLogBody, documentSummary, eventPayload } from "../lib/render.mjs";
import { audit, fieldsOf, recipientsOf, removeField, removeRecipient, scanPrefix } from "../lib/store.mjs";
import { assertDocumentFits } from "../lib/size.mjs";
import { pad10 } from "../lib/util.mjs";
import { ACTION_ROLES, applyMeta } from "../lib/validate.mjs";

export function deleteDocument(input, context) {
  const caller = resolveCaller(context);
  const doc = loadDocument(context, caller, input.documentId);
  if (!canManage(caller, doc)) forbidden(context, "You do not have permission to delete this document");
  if (doc.status === "DRAFT") {
    for (const r of recipientsOf(context, "document", doc.id)) removeRecipient(context, r);
    for (const f of fieldsOf(context, "document", doc.id)) removeField(context, f);
    for (const record of scanPrefix(context, "audit-logs", `${doc.envelopeId}/`)) context.state.delete("audit-logs", record.rowId);
    context.state.delete("envelope-ids", doc.envelopeId);
    context.state.delete("documents", pad10(doc.id));
  } else {
    const now = context.clock.nowUs();
    const next = { ...doc, deletedAtUs: now, updatedAtUs: now, status: doc.status === "PENDING" ? "CANCELLED" : doc.status };
    audit(context, doc.envelopeId, "DOCUMENT_DELETED", who(caller), { previousStatus: doc.status });
    context.state.put("documents", pad10(doc.id), next);
  }
  return { success: true };
}

/** DRAFT → PENDING: validates recipients and signature fields, marks recipients sent (EMAIL), audits and emits document.sent. */
export function distributeCore(context, caller, doc, metaInput) {
  if (doc.status !== "DRAFT") invalid(context, "Document is not a draft");
  const meta = applyMeta(context, doc.meta, metaInput, { allowSigningOrder: false });
  const recipients = recipientsOf(context, "document", doc.id);
  if (recipients.length === 0) invalid(context, "Document has no recipients");
  if (!recipients.some((r) => ACTION_ROLES.has(r.role))) invalid(context, "Document must have at least one signer, approver or viewer");
  const fields = fieldsOf(context, "document", doc.id);
  for (const signer of recipients.filter((r) => r.role === "SIGNER")) {
    if (!fields.some((f) => f.recipientId === signer.id && f.type === "SIGNATURE")) invalid(context, "Signers must have at least one signature field");
  }
  const now = context.clock.nowUs();
  const next = { ...doc, meta, status: "PENDING", updatedAtUs: now };
  context.state.put("documents", pad10(doc.id), next);
  audit(context, doc.envelopeId, "DOCUMENT_SENT", who(caller), { distributionMethod: meta.distributionMethod });
  const sent = recipients.map((r) => {
    if (meta.distributionMethod !== "EMAIL") return r;
    const row = { ...r, sendStatus: "SENT" };
    context.state.put("recipients", pad10(r.id), row);
    audit(context, doc.envelopeId, "EMAIL_SENT", who(caller), { recipientId: r.id, recipientEmail: r.email, recipientRole: r.role, isResending: false });
    return row;
  });
  assertDocumentFits(context, doc.id);
  context.events.emit("document.sent", { ...eventPayload(next, sent), distributionMethod: meta.distributionMethod });
  return [next, sent];
}

export function distributeDocument(input, context) {
  const caller = resolveCaller(context);
  const doc = loadDocument(context, caller, input.documentId);
  const [next, recipients] = distributeCore(context, caller, doc, input.meta);
  return documentSummary(context, next, recipients);
}

export function redistributeDocument(input, context) {
  const caller = resolveCaller(context);
  const doc = loadDocument(context, caller, input.documentId);
  const list = input.recipients;
  if (!Array.isArray(list) || list.length < 1 || list.length > 25) bad(context, "recipients must list between 1 and 25 recipient ids");
  const ids = [...new Set(list.map((value) => parseId(context, value, "recipients")))];
  if (doc.status !== "PENDING") invalid(context, "Document is not pending");
  if (doc.meta.distributionMethod !== "EMAIL") invalid(context, "Document is not distributed by email");
  for (const id of ids) {
    const r = context.state.get("recipients", pad10(id));
    if (r === null || r.parentKind !== "document" || r.parentId !== doc.id) invalid(context, `Recipient ${id} is not a recipient of this document`);
    if (r.signingStatus !== "NOT_SIGNED") invalid(context, `Recipient ${id} has already completed this document`);
    if (r.role === "CC") invalid(context, `Recipient ${id} is a CC recipient and receives no signing request`);
    context.state.put("recipients", pad10(id), { ...r, sendStatus: "SENT" });
    audit(context, doc.envelopeId, "EMAIL_SENT", who(caller), { recipientId: r.id, recipientEmail: r.email, recipientRole: r.role, isResending: true });
  }
  return { success: true };
}

export function cancelEnvelope(input, context) {
  const caller = resolveCaller(context);
  const reason = input.reason ?? null;
  if (reason !== null && (typeof reason !== "string" || reason.length > 500)) bad(context, "reason must be at most 500 characters");
  const doc = loadEnvelopeDocument(context, caller, input.envelopeId);
  if (!canManage(caller, doc)) forbidden(context, "You do not have permission to cancel this document");
  if (doc.status !== "PENDING") invalid(context, "Only pending documents can be cancelled");
  context.state.put("documents", pad10(doc.id), { ...doc, status: "CANCELLED", cancelReason: reason, updatedAtUs: context.clock.nowUs() });
  audit(context, doc.envelopeId, "DOCUMENT_CANCELLED", who(caller), { reason });
  return { success: true };
}

export function envelopeAuditLog(input, context) {
  const caller = resolveCaller(context);
  const paging = pageArgs(context, input);
  const doc = loadEnvelopeDocument(context, caller, input.envelopeId);
  const rows = scanPrefix(context, "audit-logs", `${doc.envelopeId}/`).map((record) => record.value);
  if (paging.direction === "desc") rows.reverse();
  return pageOf(context, rows, paging, auditLogBody);
}
