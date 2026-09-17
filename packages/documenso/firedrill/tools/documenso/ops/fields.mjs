// fields.get, fields.create_many and fields.delete.
import { documentVisible, loadDocument, parseId, resolveCaller, who } from "../lib/caller.mjs";
import { bad, invalid, notFound } from "../lib/errors.mjs";
import { placement } from "../lib/fieldinput.mjs";
import { renderField } from "../lib/render.mjs";
import { audit, fieldsOf, nextId, putField, recipientsOf, removeField } from "../lib/store.mjs";
import { assertDocumentFits } from "../lib/size.mjs";
import { isObject, pad10 } from "../lib/util.mjs";
import { requireEditable } from "./recipients.mjs";

function loadField(context, caller, rawId) {
  const f = context.state.get("fields", pad10(parseId(context, rawId, "fieldId")));
  if (f === null || f.parentKind !== "document") notFound(context, "Field");
  const doc = context.state.get("documents", pad10(f.parentId));
  if (doc === null || !documentVisible(context, caller, doc)) notFound(context, "Field");
  return { f, doc };
}

export function getField(input, context) {
  const caller = resolveCaller(context);
  const { f, doc } = loadField(context, caller, input.fieldId);
  return renderField(f, doc);
}

export function createFields(input, context) {
  const caller = resolveCaller(context);
  const doc = loadDocument(context, caller, input.documentId);
  const list = input.fields;
  if (!Array.isArray(list) || list.length < 1 || list.length > 100) bad(context, "fields must contain between 1 and 100 fields");
  requireEditable(context, doc);
  const recipients = new Map(recipientsOf(context, "document", doc.id).map((r) => [r.id, r]));
  if (fieldsOf(context, "document", doc.id).length + list.length > 200) invalid(context, "A document can have at most 200 fields");
  const created = [];
  for (const item of list) {
    if (!isObject(item)) bad(context, "field must be an object");
    const recipientId = parseId(context, item.recipientId, "recipientId");
    const recipient = recipients.get(recipientId);
    if (recipient === undefined) invalid(context, `Recipient ${recipientId} is not a recipient of this document`);
    const box = placement(context, item, doc.pageCount, recipient);
    if (recipient.signingStatus !== "NOT_SIGNED") invalid(context, "Cannot add fields for a recipient who has already signed or rejected");
    const field = { id: nextId(context, "fields"), parentKind: "document", parentId: doc.id, recipientId, ...box, customText: "", inserted: false };
    putField(context, field);
    audit(context, doc.envelopeId, "FIELD_CREATED", who(caller), { fieldId: field.id, fieldType: field.type, recipientId });
    created.push(field);
  }
  assertDocumentFits(context, doc.id);
  return { fields: created.map((f) => renderField(f, doc)) };
}

export function deleteField(input, context) {
  const caller = resolveCaller(context);
  const { f, doc } = loadField(context, caller, input.fieldId);
  requireEditable(context, doc);
  if (f.inserted) invalid(context, "Cannot delete a field that has already been filled in");
  const recipient = context.state.get("recipients", pad10(f.recipientId));
  if (recipient !== null && recipient.signingStatus !== "NOT_SIGNED") invalid(context, "Cannot delete a field of a recipient who has already signed or rejected");
  removeField(context, f);
  audit(context, doc.envelopeId, "FIELD_DELETED", who(caller), { fieldId: f.id, fieldType: f.type });
  return { success: true };
}
