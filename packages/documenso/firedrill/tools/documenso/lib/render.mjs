// Documenso API v2 JSON bodies computed from stored rows.
import { iso, isoOrNull, pad10 } from "./util.mjs";

const suffix = (parent) => parent.envelopeId.slice("envelope_".length);
export const envelopeItemId = (parent) => `envelope_item_${suffix(parent)}`;

export function userMini(context, userId) {
  const user = context.state.get("users", pad10(userId));
  return { id: userId, name: user?.name ?? "Deleted user", email: user?.email ?? "deleted-user@example.com" };
}

export function teamMini(context, teamId) {
  return { id: teamId, url: context.state.get("teams", pad10(teamId))?.url ?? "unknown-team" };
}

export function renderRecipient(r, parent) {
  const isDoc = r.parentKind === "document";
  return {
    envelopeId: parent.envelopeId, role: r.role, readStatus: r.readStatus, signingStatus: r.signingStatus, sendStatus: r.sendStatus, id: r.id,
    documentId: isDoc ? r.parentId : null, templateId: isDoc ? null : r.parentId, email: r.email, name: r.name, token: r.token,
    documentDeletedAt: isDoc ? isoOrNull(parent.deletedAtUs) : null, expired: null, signedAt: isoOrNull(r.signedAtUs),
    authOptions: { accessAuth: [...r.accessAuth], actionAuth: [...r.actionAuth] }, signingOrder: r.signingOrder, rejectionReason: r.rejectionReason,
  };
}

export function renderField(f, parent) {
  const isDoc = f.parentKind === "document";
  return {
    envelopeId: parent.envelopeId, envelopeItemId: envelopeItemId(parent), type: f.type, id: f.id, secondaryId: `field_${pad10(f.id)}`,
    documentId: isDoc ? f.parentId : null, templateId: isDoc ? null : f.parentId, recipientId: f.recipientId, page: f.page,
    positionX: f.positionX, positionY: f.positionY, width: f.width, height: f.height, customText: f.customText, inserted: f.inserted,
    fieldMeta: f.fieldMeta === null ? null : { ...f.fieldMeta },
  };
}

export const renderMeta = (parent) => ({
  id: `meta_${suffix(parent)}`, ...parent.meta, allowDictateNextSigner: false, emailSettings: null, emailReplyTo: null, emailId: null,
});

export function documentBase(doc) {
  return {
    visibility: doc.visibility, status: doc.status, source: doc.source, id: doc.id, externalId: doc.externalId, userId: doc.userId,
    authOptions: { globalAccessAuth: [...doc.globalAccessAuth], globalActionAuth: [...doc.globalActionAuth] }, formValues: null, title: doc.title,
    createdAt: iso(doc.createdAtUs), updatedAt: iso(doc.updatedAtUs), completedAt: isoOrNull(doc.completedAtUs), deletedAt: isoOrNull(doc.deletedAtUs),
    teamId: doc.teamId, folderId: null, envelopeId: doc.envelopeId, internalVersion: 1, templateId: doc.templateId,
  };
}

export function documentSummary(context, doc, recipients) {
  return { ...documentBase(doc), user: userMini(context, doc.userId), recipients: recipients.map((r) => renderRecipient(r, doc)), team: teamMini(context, doc.teamId) };
}

const documentData = (parent) => ({
  type: "BYTES", id: `data_${suffix(parent)}`, data: parent.content, initialData: parent.content, envelopeItemId: envelopeItemId(parent),
});

export function documentBody(doc, recipients, fields) {
  return {
    ...documentBase(doc), documentDataId: `data_${suffix(doc)}`, documentData: documentData(doc), documentMeta: renderMeta(doc),
    envelopeItems: [{ id: envelopeItemId(doc), title: doc.fileName, order: 1 }], folder: null,
    recipients: recipients.map((r) => renderRecipient(r, doc)), fields: fields.map((f) => renderField(f, doc)),
  };
}

export function templateSummary(context, t, recipients, fields) {
  return {
    type: t.type, visibility: t.visibility, id: t.id, externalId: t.externalId, title: t.title, userId: t.userId, teamId: t.teamId,
    authOptions: { globalAccessAuth: [], globalActionAuth: [] }, createdAt: iso(t.createdAtUs), updatedAt: iso(t.updatedAtUs),
    publicTitle: t.publicTitle, publicDescription: t.publicDescription, folderId: null, envelopeId: t.envelopeId,
    templateDocumentDataId: `data_${suffix(t)}`, templateMeta: renderMeta(t), directLink: null, team: teamMini(context, t.teamId),
    recipients: recipients.map((r) => renderRecipient(r, t)), fields: fields.map((f) => renderField(f, t)),
  };
}

export function templateBody(context, t, recipients, fields) {
  return {
    ...templateSummary(context, t, recipients, fields), templateDocumentData: documentData(t), user: userMini(context, t.userId),
    envelopeItems: [{ id: envelopeItemId(t), title: t.fileName, order: 1 }],
  };
}

export const auditLogBody = (row) => ({
  id: row.id, createdAt: iso(row.createdAtUs), envelopeId: row.envelopeId, type: row.type, data: { ...row.data }, name: row.name, email: row.email,
  userId: row.userId, userAgent: null, ipAddress: null,
});

/** Webhook-like event payload (top of the provider's webhook `payload`). */
export const eventPayload = (doc, recipients) => ({
  id: doc.id, envelopeId: doc.envelopeId, title: doc.title, status: doc.status, teamId: doc.teamId, completedAt: isoOrNull(doc.completedAtUs),
  recipients: recipients.slice(0, 25).map((r) => ({ id: r.id, email: r.email, role: r.role, signingStatus: r.signingStatus })),
});
