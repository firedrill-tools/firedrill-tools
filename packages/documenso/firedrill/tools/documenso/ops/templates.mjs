// templates.find, templates.get and templates.use.
import { loadTemplate, parseId, resolveCaller, roleAllows, templateVisible, who } from "../lib/caller.mjs";
import { checkMonthlyLimit, incrementUsage, insertDocument, newRecipient } from "../lib/create.mjs";
import { bad, forbidden, invalid } from "../lib/errors.mjs";
import { pageArgs, pageOf, queryText, unsupportedParams } from "../lib/paging.mjs";
import { documentBody, templateBody, templateSummary } from "../lib/render.mjs";
import { assertBodyFits, assertReadable } from "../lib/size.mjs";
import { audit, fieldsOf, nextId, putField, recipientsOf, scanPrefix } from "../lib/store.mjs";
import { isObject } from "../lib/util.mjs";
import { applyMeta, email, externalId, title } from "../lib/validate.mjs";
import { distributeCore } from "./lifecycle.mjs";

const TYPES = new Set(["PRIVATE", "PUBLIC"]);
const OVERRIDE_META = ["subject", "message", "timezone", "dateFormat", "redirectUrl", "distributionMethod", "language",
  "typedSignatureEnabled", "uploadSignatureEnabled", "drawSignatureEnabled"];

export function findTemplates(input, context) {
  const caller = resolveCaller(context);
  unsupportedParams(context, input, ["folderId"]);
  const needle = queryText(context, input.query);
  if (input.type !== undefined && !TYPES.has(input.type)) bad(context, "type must be PRIVATE or PUBLIC");
  const paging = pageArgs(context, input);
  const rows = scanPrefix(context, "templates", "").map((record) => record.value)
    .filter((t) => templateVisible(caller, t) && (input.type === undefined || t.type === input.type) && (needle === "" || t.title.toLowerCase().includes(needle)));
  rows.sort((a, b) => b.createdAtUs - a.createdAtUs || b.id - a.id);
  return pageOf(context, rows, paging, (t) => templateSummary(context, t, recipientsOf(context, "template", t.id), fieldsOf(context, "template", t.id)));
}

export function getTemplate(input, context) {
  const caller = resolveCaller(context);
  const t = loadTemplate(context, caller, input.templateId);
  return assertReadable(context, templateBody(context, t, recipientsOf(context, "template", t.id), fieldsOf(context, "template", t.id)));
}

function boolInput(context, value, name) {
  if (value === undefined) return false;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return bad(context, `${name} must be a boolean`);
}

export function useTemplate(input, context) {
  const caller = resolveCaller(context);
  unsupportedParams(context, input, ["prefillFields", "customDocumentData", "folderId", "attachments"]);
  const t = loadTemplate(context, caller, input.templateId);
  if (!Array.isArray(input.recipients) || input.recipients.length > 25) bad(context, "recipients must be an array of at most 25 recipients");
  const distribute = boolInput(context, input.distributeDocument, "distributeDocument");
  const docExternalId = externalId(context, input.externalId);
  const override = input.override ?? {};
  if (!isObject(override)) bad(context, "override must be an object");
  const docTitle = override.title === undefined || override.title === null ? t.title : title(context, override.title, "override.title");
  const metaInput = {};
  for (const key of OVERRIDE_META) if (override[key] !== undefined) metaInput[key] = override[key];
  const meta = applyMeta(context, t.meta, metaInput);
  const templateRecipients = recipientsOf(context, "template", t.id);
  const byId = new Map(templateRecipients.map((r) => [r.id, r]));
  const mapped = new Map();
  for (const item of input.recipients) {
    if (!isObject(item)) bad(context, "recipient mapping must be an object");
    const id = parseId(context, item.id, "recipients.id");
    const address = email(context, item.email, "recipients.email");
    if (item.name !== undefined && item.name !== null && (typeof item.name !== "string" || item.name.length > 255)) bad(context, "recipients.name must be at most 255 characters");
    if (!byId.has(id)) invalid(context, `Recipient ${id} does not exist on this template`);
    if (mapped.has(id)) invalid(context, `Template recipient ${id} is mapped more than once`);
    mapped.set(id, { email: address, name: typeof item.name === "string" ? item.name : byId.get(id).name });
  }
  if (!roleAllows(caller, t.visibility)) forbidden(context, "You do not have permission to set this visibility");
  const emails = new Set();
  const plan = templateRecipients.map((r) => {
    const target = mapped.get(r.id) ?? { email: r.email, name: r.name };
    if (target.email === "") invalid(context, `Template recipient "${r.name || r.id}" must be mapped to an email address`);
    if (emails.has(target.email)) invalid(context, `Recipient already exists: ${target.email}`);
    emails.add(target.email);
    return [r, target];
  });
  checkMonthlyLimit(context, caller);
  const now = context.clock.nowUs();
  const doc = insertDocument(context, {
    teamId: caller.teamId, userId: caller.userId, title: docTitle, externalId: docExternalId, visibility: t.visibility, status: "DRAFT",
    source: "TEMPLATE", templateId: t.id, content: t.content, pageCount: t.pageCount, fileName: t.fileName, meta, globalAccessAuth: [],
    globalActionAuth: [], createdAtUs: now, updatedAtUs: now, completedAtUs: null, deletedAtUs: null, cancelReason: null,
  });
  audit(context, doc.envelopeId, "DOCUMENT_CREATED", who(caller), { title: doc.title, templateId: t.id });
  const ids = new Map();
  for (const [r, target] of plan) {
    const created = newRecipient(context, "document", doc.id, { ...r, email: target.email, name: target.name });
    ids.set(r.id, created.id);
  }
  for (const f of fieldsOf(context, "template", t.id)) {
    if (!ids.has(f.recipientId)) continue;
    putField(context, { ...f, id: nextId(context, "fields"), parentKind: "document", parentId: doc.id, recipientId: ids.get(f.recipientId), customText: "", inserted: false });
  }
  incrementUsage(context, caller.teamId);
  const finalDoc = distribute ? distributeCore(context, caller, doc, undefined)[0] : doc;
  return assertBodyFits(context, documentBody(finalDoc, recipientsOf(context, "document", doc.id), fieldsOf(context, "document", doc.id)));
}
