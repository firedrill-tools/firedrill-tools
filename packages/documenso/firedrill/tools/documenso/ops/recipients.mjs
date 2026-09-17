// recipients.get, recipients.create_many, recipients.update, recipients.delete and recipients.reject (plus shared rejection).
import { canManage, documentVisible, loadDocument, parseId, resolveCaller, who } from "../lib/caller.mjs";
import { EDITABLE_MESSAGES, newRecipient } from "../lib/create.mjs";
import { bad, forbidden, invalid, notFound } from "../lib/errors.mjs";
import { eventPayload, renderField, renderRecipient } from "../lib/render.mjs";
import { audit, fieldsOf, recipientsOf, removeField, removeRecipient, scanPrefix } from "../lib/store.mjs";
import { assertDocumentFits, assertReadable } from "../lib/size.mjs";
import { isObject, pad10 } from "../lib/util.mjs";
import { ACTION_ROLES, email, recipientInput } from "../lib/validate.mjs";

export function requireEditable(context, doc) {
  if (EDITABLE_MESSAGES.has(doc.status)) invalid(context, EDITABLE_MESSAGES.get(doc.status));
}

function loadRecipient(context, caller, rawId) {
  const r = context.state.get("recipients", pad10(parseId(context, rawId, "recipientId")));
  if (r === null || r.parentKind !== "document") notFound(context, "Recipient");
  const doc = context.state.get("documents", pad10(r.parentId));
  if (doc === null || !documentVisible(context, caller, doc)) notFound(context, "Recipient");
  return { r, doc };
}

const withFields = (context, r, doc) => ({
  ...renderRecipient(r, doc),
  fields: fieldsOf(context, "document", doc.id).filter((f) => f.recipientId === r.id).map((f) => renderField(f, doc)),
});

export function getRecipient(input, context) {
  const caller = resolveCaller(context);
  const { r, doc } = loadRecipient(context, caller, input.recipientId);
  return assertReadable(context, withFields(context, r, doc));
}

export function createRecipients(input, context) {
  const caller = resolveCaller(context);
  const doc = loadDocument(context, caller, input.documentId);
  const list = input.recipients;
  if (!Array.isArray(list) || list.length < 1 || list.length > 25) bad(context, "recipients must contain between 1 and 25 recipients");
  const parsed = list.map((item) => recipientInput(context, item));
  requireEditable(context, doc);
  const existing = recipientsOf(context, "document", doc.id);
  if (existing.length + parsed.length > 25) invalid(context, "A document can have at most 25 recipients");
  const emails = new Set(existing.map((r) => r.email));
  for (const p of parsed) {
    if (emails.has(p.email)) invalid(context, `Recipient already exists: ${p.email}`);
    emails.add(p.email);
  }
  const sent = doc.status === "PENDING" && doc.meta.distributionMethod === "EMAIL";
  const created = parsed.map((p) => {
    const r = newRecipient(context, "document", doc.id, p, sent ? "SENT" : "NOT_SENT");
    audit(context, doc.envelopeId, "RECIPIENT_CREATED", who(caller), { recipientId: r.id, recipientEmail: r.email, recipientRole: r.role });
    if (sent) audit(context, doc.envelopeId, "EMAIL_SENT", who(caller), { recipientId: r.id, recipientEmail: r.email, recipientRole: r.role, isResending: false });
    return r;
  });
  assertDocumentFits(context, doc.id);
  return { recipients: created.map((r) => renderRecipient(r, doc)) };
}

export function updateRecipient(input, context) {
  const caller = resolveCaller(context);
  const doc = loadDocument(context, caller, input.documentId);
  if (!isObject(input.recipient)) bad(context, "recipient is required");
  const id = parseId(context, input.recipient.id, "recipient.id");
  const patch = recipientInput(context, input.recipient, { partial: true });
  const r = context.state.get("recipients", pad10(id));
  if (r === null) notFound(context, "Recipient");
  if (r.parentKind !== "document" || r.parentId !== doc.id) invalid(context, "Recipient does not belong to this document");
  requireEditable(context, doc);
  if (r.signingStatus !== "NOT_SIGNED") invalid(context, "Cannot update a recipient that has already signed or rejected");
  if (patch.email !== undefined && patch.email !== r.email &&
    recipientsOf(context, "document", doc.id).some((o) => o.id !== r.id && o.email === patch.email)) {
    invalid(context, `Recipient already exists: ${patch.email}`);
  }
  const next = { ...r };
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) next[key] = value;
  context.state.put("recipients", pad10(r.id), next);
  audit(context, doc.envelopeId, "RECIPIENT_UPDATED", who(caller), { recipientId: r.id, recipientEmail: next.email, recipientRole: next.role });
  assertDocumentFits(context, doc.id);
  return withFields(context, next, doc);
}

export function deleteRecipient(input, context) {
  const caller = resolveCaller(context);
  const { r, doc } = loadRecipient(context, caller, input.recipientId);
  requireEditable(context, doc);
  if (r.signingStatus !== "NOT_SIGNED") invalid(context, "Cannot remove a recipient that has already signed or rejected");
  if (doc.status === "PENDING" && ACTION_ROLES.has(r.role) && !recipientsOf(context, "document", doc.id)
    .some((o) => o.id !== r.id && ACTION_ROLES.has(o.role) && o.signingStatus === "NOT_SIGNED")) {
    invalid(context, "Cannot remove the last pending recipient of a sent document");
  }
  for (const f of fieldsOf(context, "document", doc.id)) if (f.recipientId === r.id) removeField(context, f);
  removeRecipient(context, r);
  audit(context, doc.envelopeId, "RECIPIENT_DELETED", who(caller), { recipientId: r.id, recipientEmail: r.email, recipientRole: r.role });
  return { success: true };
}

export function rejectionReason(context, value) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 500) bad(context, "reason must be between 1 and 500 characters");
  return value;
}

export function checkCanReject(context, doc, r) {
  if (doc.status !== "PENDING") invalid(context, "Document is not pending");
  if (!ACTION_ROLES.has(r.role)) invalid(context, "CC recipients cannot reject a document");
  if (r.signingStatus !== "NOT_SIGNED") invalid(context, "Recipient has already signed or rejected this document");
}

/** Marks the recipient and the document REJECTED, audits and emits document.rejected. */
export function rejectCore(context, doc, r, reason, actor) {
  const now = context.clock.nowUs();
  const rejected = { ...r, signingStatus: "REJECTED", rejectionReason: reason };
  context.state.put("recipients", pad10(r.id), rejected);
  const next = { ...doc, status: "REJECTED", updatedAtUs: now };
  context.state.put("documents", pad10(doc.id), next);
  audit(context, doc.envelopeId, "DOCUMENT_RECIPIENT_REJECTED", actor, { recipientId: r.id, recipientEmail: r.email, reason });
  const recipients = recipientsOf(context, "document", doc.id).map((o) => (o.id === r.id ? rejected : o));
  assertDocumentFits(context, doc.id);
  context.events.emit("document.rejected", { ...eventPayload(next, recipients), rejectedRecipientId: r.id, reason });
  return next;
}

export function rejectRecipient(input, context) {
  const caller = resolveCaller(context);
  const reason = rejectionReason(context, input.reason);
  const { r, doc } = loadRecipient(context, caller, input.recipientId);
  if (doc.envelopeId !== input.envelopeId) notFound(context, "Recipient");
  if (!canManage(caller, doc)) forbidden(context, "You do not have permission to reject on behalf of this recipient");
  let actor = who(caller);
  if (input.actAsEmail !== undefined && input.actAsEmail !== null) {
    const address = email(context, input.actAsEmail, "actAsEmail");
    const member = scanPrefix(context, "team-members", `${pad10(doc.teamId)}/`)
      .map((record) => context.state.get("users", pad10(record.value.userId)))
      .find((user) => user !== null && user.email === address);
    if (member === undefined) invalid(context, "actAsEmail must belong to a member of this team");
    actor = { name: member.name, email: member.email, userId: member.id };
  }
  checkCanReject(context, doc, r);
  rejectCore(context, doc, r, reason, actor);
  return { success: true };
}
