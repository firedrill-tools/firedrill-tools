// documents.find and documents.get.
import { documentVisible, loadDocument, resolveCaller } from "../lib/caller.mjs";
import { bad } from "../lib/errors.mjs";
import { pageArgs, pageOf, queryText, unsupportedParams } from "../lib/paging.mjs";
import { documentBody, documentSummary } from "../lib/render.mjs";
import { assertReadable } from "../lib/size.mjs";
import { fieldsOf, recipientsOf, scanPrefix } from "../lib/store.mjs";
import { toInt } from "../lib/util.mjs";

const STATUSES = new Set(["DRAFT", "PENDING", "COMPLETED", "REJECTED", "CANCELLED"]);
const SOURCES = new Set(["DOCUMENT", "TEMPLATE"]);

export function findDocuments(input, context) {
  const caller = resolveCaller(context);
  unsupportedParams(context, input, ["folderId", "hasExpiredRecipients"]);
  const needle = queryText(context, input.query);
  const templateId = input.templateId === undefined ? null : toInt(input.templateId);
  if (input.templateId !== undefined && templateId === null) bad(context, "templateId must be a positive integer");
  if (input.source !== undefined && !SOURCES.has(input.source)) bad(context, "source must be DOCUMENT or TEMPLATE");
  if (input.status !== undefined && !STATUSES.has(input.status)) bad(context, "status must be one of DRAFT, PENDING, COMPLETED, REJECTED, CANCELLED");
  const paging = pageArgs(context, input);
  const rows = [];
  for (const { value: doc } of scanPrefix(context, "documents", "")) {
    if (doc.teamId !== caller.teamId || doc.deletedAtUs !== null) continue;
    if (input.status !== undefined && doc.status !== input.status) continue;
    if (input.source !== undefined && doc.source !== input.source) continue;
    if (templateId !== null && doc.templateId !== templateId) continue;
    const recipients = recipientsOf(context, "document", doc.id);
    if (!documentVisible(context, caller, doc, recipients)) continue;
    if (needle !== "" && !doc.title.toLowerCase().includes(needle) &&
      !recipients.some((r) => r.email.includes(needle) || r.name.toLowerCase().includes(needle))) continue;
    rows.push([doc, recipients]);
  }
  rows.sort((a, b) => b[0].createdAtUs - a[0].createdAtUs || b[0].id - a[0].id);
  if (paging.direction === "asc") rows.reverse();
  return pageOf(context, rows, paging, ([doc, recipients]) => documentSummary(context, doc, recipients));
}

export function getDocument(input, context) {
  const caller = resolveCaller(context);
  const doc = loadDocument(context, caller, input.documentId);
  return assertReadable(context, documentBody(doc, recipientsOf(context, "document", doc.id), fieldsOf(context, "document", doc.id)));
}
