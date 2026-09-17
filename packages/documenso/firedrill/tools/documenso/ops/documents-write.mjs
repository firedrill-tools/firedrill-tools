// documents.create, documents.update and documents.duplicate.
import { loadDocument, resolveCaller, roleAllows, who } from "../lib/caller.mjs";
import { checkMonthlyLimit, incrementUsage, insertDocument, newRecipient } from "../lib/create.mjs";
import { bad, forbidden, invalid } from "../lib/errors.mjs";
import { placement } from "../lib/fieldinput.mjs";
import { unsupportedParams } from "../lib/paging.mjs";
import { documentBase, documentBody } from "../lib/render.mjs";
import { assertBodyFits, assertDocumentFits } from "../lib/size.mjs";
import { audit, fieldsOf, nextId, putField, recipientsOf } from "../lib/store.mjs";
import { isObject } from "../lib/util.mjs";
import { DEFAULT_META, accessAuth, actionAuth, applyMeta, externalId, fileInput, recipientInput, title, visibility } from "../lib/validate.mjs";

const VISIBILITY_DENIED = "You do not have permission to set this visibility";

export function createDocument(input, context) {
  const caller = resolveCaller(context);
  const payload = isObject(input.payload) ? input.payload : bad(context, "payload is required");
  unsupportedParams(context, payload, ["folderId", "formValues", "attachments"]);
  const docTitle = title(context, payload.title);
  const docExternalId = externalId(context, payload.externalId);
  const docVisibility = payload.visibility === undefined ? "EVERYONE" : visibility(context, payload.visibility);
  const globalAccessAuth = accessAuth(context, payload.globalAccessAuth, "globalAccessAuth");
  const globalActionAuth = actionAuth(context, payload.globalActionAuth, "globalActionAuth");
  const file = fileInput(context, input.file);
  const meta = applyMeta(context, DEFAULT_META, payload.meta);
  const list = payload.recipients ?? [];
  if (!Array.isArray(list) || list.length > 25) bad(context, "recipients must be an array of at most 25 recipients");
  const parsed = list.map((item) => ({ ...recipientInput(context, item), fields: item.fields ?? [] }));
  const emails = new Set();
  let fieldTotal = 0;
  for (const p of parsed) {
    if (emails.has(p.email)) invalid(context, `Recipient already exists: ${p.email}`);
    emails.add(p.email);
    if (!Array.isArray(p.fields)) bad(context, "recipient fields must be an array");
    fieldTotal += p.fields.length;
  }
  if (fieldTotal > 200) invalid(context, "A document can have at most 200 fields");
  if (!roleAllows(caller, docVisibility)) forbidden(context, VISIBILITY_DENIED);
  checkMonthlyLimit(context, caller);
  const now = context.clock.nowUs();
  const doc = insertDocument(context, {
    teamId: caller.teamId, userId: caller.userId, title: docTitle, externalId: docExternalId, visibility: docVisibility, status: "DRAFT",
    source: "DOCUMENT", templateId: null, content: file.content, pageCount: file.pageCount, fileName: file.name, meta, globalAccessAuth,
    globalActionAuth, createdAtUs: now, updatedAtUs: now, completedAtUs: null, deletedAtUs: null, cancelReason: null,
  });
  audit(context, doc.envelopeId, "DOCUMENT_CREATED", who(caller), { title: doc.title });
  const createdRecipients = [];
  const createdFields = [];
  for (const p of parsed) {
    const recipient = newRecipient(context, "document", doc.id, p);
    createdRecipients.push(recipient);
    audit(context, doc.envelopeId, "RECIPIENT_CREATED", who(caller), { recipientId: recipient.id, recipientEmail: recipient.email, recipientRole: recipient.role });
    for (const item of p.fields) {
      const box = placement(context, item, doc.pageCount, recipient);
      const field = { id: nextId(context, "fields"), parentKind: "document", parentId: doc.id, recipientId: recipient.id, ...box, customText: "", inserted: false };
      putField(context, field);
      createdFields.push(field);
    }
  }
  assertBodyFits(context, documentBody(doc, createdRecipients, createdFields));
  incrementUsage(context, caller.teamId);
  return { envelopeId: doc.envelopeId, id: doc.id };
}

export function updateDocument(input, context) {
  const caller = resolveCaller(context);
  const doc = loadDocument(context, caller, input.documentId);
  const data = input.data ?? {};
  const next = { ...doc };
  const actor = who(caller);
  let changed = false;
  if (data.title !== undefined) {
    const value = title(context, data.title);
    if (value !== doc.title) {
      if (doc.status !== "DRAFT") invalid(context, "Document title can only be changed while the document is a draft");
      audit(context, doc.envelopeId, "DOCUMENT_TITLE_UPDATED", actor, { from: doc.title, to: value });
      next.title = value;
      changed = true;
    }
  }
  if (data.externalId !== undefined) {
    next.externalId = externalId(context, data.externalId);
    changed = changed || next.externalId !== doc.externalId;
  }
  if (data.visibility !== undefined) {
    const value = visibility(context, data.visibility);
    if (!roleAllows(caller, value)) forbidden(context, VISIBILITY_DENIED);
    if (value !== doc.visibility) {
      audit(context, doc.envelopeId, "DOCUMENT_VISIBILITY_UPDATED", actor, { from: doc.visibility, to: value });
      next.visibility = value;
      changed = true;
    }
  }
  if (data.globalAccessAuth !== undefined) next.globalAccessAuth = accessAuth(context, data.globalAccessAuth, "globalAccessAuth");
  if (data.globalActionAuth !== undefined) next.globalActionAuth = actionAuth(context, data.globalActionAuth, "globalActionAuth");
  if (input.meta !== undefined && input.meta !== null) {
    if (doc.status !== "DRAFT") invalid(context, "Document settings can only be changed while the document is a draft");
    next.meta = applyMeta(context, doc.meta, input.meta);
    const keys = Object.keys(next.meta).filter((key) => next.meta[key] !== doc.meta[key]);
    if (keys.length > 0) {
      audit(context, doc.envelopeId, "DOCUMENT_META_UPDATED", actor, { changed: keys.join(",") });
      changed = true;
    }
  }
  changed = changed || JSON.stringify([next.globalAccessAuth, next.globalActionAuth]) !== JSON.stringify([doc.globalAccessAuth, doc.globalActionAuth]);
  if (changed) {
    next.updatedAtUs = context.clock.nowUs();
    context.state.put("documents", String(doc.id).padStart(10, "0"), next);
    assertDocumentFits(context, doc.id);
  }
  return documentBase(changed ? next : doc);
}

export function duplicateDocument(input, context) {
  const caller = resolveCaller(context);
  const doc = loadDocument(context, caller, input.documentId);
  const recipients = recipientsOf(context, "document", doc.id);
  const fields = fieldsOf(context, "document", doc.id);
  checkMonthlyLimit(context, caller);
  const now = context.clock.nowUs();
  const copy = insertDocument(context, {
    teamId: doc.teamId, userId: caller.userId, title: doc.title, externalId: null, visibility: doc.visibility, status: "DRAFT", source: "DOCUMENT",
    templateId: null, content: doc.content, pageCount: doc.pageCount, fileName: doc.fileName, meta: { ...doc.meta },
    globalAccessAuth: [...doc.globalAccessAuth], globalActionAuth: [...doc.globalActionAuth], createdAtUs: now, updatedAtUs: now,
    completedAtUs: null, deletedAtUs: null, cancelReason: null,
  });
  audit(context, copy.envelopeId, "DOCUMENT_CREATED", who(caller), { title: copy.title, duplicatedFrom: doc.id });
  const ids = new Map();
  for (const r of recipients) ids.set(r.id, newRecipient(context, "document", copy.id, r).id);
  for (const f of fields) {
    if (!ids.has(f.recipientId)) continue;
    putField(context, { ...f, id: nextId(context, "fields"), parentId: copy.id, recipientId: ids.get(f.recipientId), customText: "", inserted: false });
  }
  incrementUsage(context, caller.teamId);
  return { id: copy.envelopeId, documentId: copy.id };
}
