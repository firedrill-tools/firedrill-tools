// Synthetic Documenso public API v2 subset for Firedrill. Every operation computes from `context.state`: ids come from
// `meta/counters`, envelope ids and signing tokens from seeded randomness, timestamps from virtual time. Nothing is e-mailed,
// rendered to PDF or signed cryptographically, and no Documenso service is contacted.
import { Q, createDecoder, decoder, jsonEncoder } from "./lib/wire.mjs";
import { findDocuments, getDocument } from "./ops/documents-read.mjs";
import { createDocument, duplicateDocument, updateDocument } from "./ops/documents-write.mjs";
import { createFields, deleteField, getField } from "./ops/fields.mjs";
import { cancelEnvelope, deleteDocument, distributeDocument, envelopeAuditLog, redistributeDocument } from "./ops/lifecycle.mjs";
import { createRecipients, deleteRecipient, getRecipient, rejectRecipient, updateRecipient } from "./ops/recipients.mjs";
import { completeSigning, getSigning, workspaceContext } from "./ops/signing.mjs";
import { findTemplates, getTemplate, useTemplate } from "./ops/templates.mjs";

const PAGE = { page: Q.int, perPage: Q.int, orderByColumn: Q.str, orderByDirection: Q.str };
const json = decoder({ body: "json" });

// [operation id, handler, route id?, decoder?]
const TABLE = [
  ["documents.find", findDocuments, "document-find", decoder({ query: { query: Q.str, templateId: Q.id, source: Q.str, status: Q.str, folderId: Q.str,
    hasExpiredRecipients: Q.str, ...PAGE } })],
  ["documents.get", getDocument, "document-get", decoder({ path: { documentId: Q.id } })],
  ["documents.create", createDocument, "document-create", createDecoder],
  ["documents.update", updateDocument, "document-update", json],
  ["documents.delete", deleteDocument, "document-delete", json],
  ["documents.duplicate", duplicateDocument, "document-duplicate", json],
  ["documents.distribute", distributeDocument, "document-distribute", json],
  ["documents.redistribute", redistributeDocument, "document-redistribute", json],
  ["envelopes.cancel", cancelEnvelope, "envelope-cancel", json],
  ["envelopes.audit_log", envelopeAuditLog, "envelope-audit-log", decoder({ path: { envelopeId: Q.str }, query: PAGE })],
  ["recipients.get", getRecipient, "recipient-get", decoder({ path: { recipientId: Q.id } })],
  ["recipients.create_many", createRecipients, "recipient-create-many", json],
  ["recipients.update", updateRecipient, "recipient-update", json],
  ["recipients.delete", deleteRecipient, "recipient-delete", json],
  ["recipients.reject", rejectRecipient, "recipient-reject", decoder({ path: { recipientId: Q.id }, body: "json" })],
  ["fields.get", getField, "field-get", decoder({ path: { fieldId: Q.id } })],
  ["fields.create_many", createFields, "field-create-many", json],
  ["fields.delete", deleteField, "field-delete", json],
  ["templates.find", findTemplates, "template-find", decoder({ query: { query: Q.str, type: Q.str, page: Q.int, perPage: Q.int, folderId: Q.str } })],
  ["templates.get", getTemplate, "template-get", decoder({ path: { templateId: Q.id } })],
  ["templates.use", useTemplate, "template-use", json],
  ["signing.get", getSigning],
  ["signing.complete", completeSigning],
  ["workspace.context", workspaceContext],
];

const operations = {};
const http = {};
for (const [operationId, handler, routeId, decode] of TABLE) {
  operations[operationId] = handler;
  if (routeId !== undefined) http[routeId] = { decode, encode: jsonEncoder };
}

export default { operations, http };
